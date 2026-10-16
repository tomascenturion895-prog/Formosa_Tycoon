<?php

namespace App\Economy;

use App\Enums\MatchStatus;
use App\Events\ChatMessageSent;
use App\Models\ChatMessage;
use App\Models\GameMatch;
use App\Models\MatchPlayer;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Chat de jugadores, en DOS canales que no se mezclan:
 *  - GLOBAL (`$matchId` null): charla libre entre todos los jugadores. Lectura pública, escribe quien tiene sesión.
 *  - SALA (`$matchId` = la partida): solo para quienes juegan (o jugaron) esa partida. Además de lo que escriben las personas,
 *    lleva los avisos automáticos del juego (`system()`: compras, entradas y salidas, tiempo, fin).
 *
 * Un mensaje = una fila que solo se agrega. Quién escribe lo decide la sesión (nunca el pedido).
 *
 * Fallas previstas:
 *  - El mismo envío llega dos veces (doble toque, reintento de red): la clave del navegador lo hace idempotente.
 *  - Reverb caído: el mensaje queda guardado igual; los navegadores lo leen al reconectar o por la lectura periódica.
 *  - Inundación: límite por jugador en la ruta + rechazo del mismo texto repetido dentro de una ventana corta (por canal).
 *  - Un aviso de sistema que falla NUNCA rompe la operación del juego que lo originó (`system()` no lanza).
 */
class ChatService
{
    public function __construct(private readonly ModerationService $moderation) {}

    // ------------------------------------------------------------------ acceso a una sala

    /** ¿Juega o jugó esa partida? (quien salió de la sala de espera ya no figura; quien abandonó en juego sí.) */
    public function isMember(int $userId, int $matchId): bool
    {
        return MatchPlayer::query()->where('match_id', $matchId)->where('user_id', $userId)->exists();
    }

    /**
     * ¿Puede recibir los avisos EN VIVO de la sala? Solo quien sigue en ella; terminada la partida, cualquiera que haya jugado
     * (para releer el cierre). Quien abandonó deja de recibir lo que pasa, aunque puede leer el historial.
     */
    public function canListen(int $userId, int $matchId): bool
    {
        $row = MatchPlayer::query()->where('match_id', $matchId)->where('user_id', $userId)->first(['left_at']);
        if (! $row) {
            return false;
        }
        if ($row->left_at === null) {
            return true;
        }
        $status = GameMatch::query()->whereKey($matchId)->value('status');

        return $status !== null && ! in_array($status instanceof MatchStatus ? $status->value : $status, [MatchStatus::Lobby->value, MatchStatus::Running->value], true);
    }

    /**
     * Comprueba que `$user` puede LEER la sala (404 si no existe, 403 si no es de la partida) y devuelve la partida.
     *
     * @throws GameException
     */
    public function readableRoom(User $user, int $matchId): GameMatch
    {
        $match = GameMatch::query()->find($matchId) ?? throw GameException::matchNotFound();
        if (! $this->isMember($user->id, $matchId)) {
            throw GameException::notInMatch();
        }

        return $match;
    }

    /** ¿Se puede escribir en la sala? Sí mientras la partida está en la sala de espera o en juego y el jugador no se fue. */
    public function writable(User $user, GameMatch $match): bool
    {
        if (! in_array($match->status, [MatchStatus::Lobby, MatchStatus::Running], true)) {
            return false;
        }

        return MatchPlayer::query()->where('match_id', $match->id)->where('user_id', $user->id)->whereNull('left_at')->exists();
    }

    // ------------------------------------------------------------------ escribir

    /**
     * @return array{message: array<string, mixed>, replayed: bool}
     *
     * @throws GameException
     */
    public function send(User $user, string $raw, string $key, ?int $matchId = null): array
    {
        $cfg = config('formosa.chat');
        $max = (int) $cfg['max_length'];

        if ($matchId !== null) {
            $match = $this->readableRoom($user, $matchId);
            if (! $this->writable($user, $match)) {
                throw GameException::roomReadOnly();
            }
        }

        $body = ChatRules::clean($raw);
        if ($body === null || $body === '') {
            throw GameException::emptyMessage();
        }
        if (mb_strlen($body) > $max) {
            throw GameException::messageTooLong($max);
        }

        if (! $user->isModerator() && ($until = $this->moderation->mutedUntil($user->id))) { // un moderador nunca queda silenciado (p. ej. si lo ascendieron con un silencio vigente); un silencio vale en ambos canales
            throw GameException::muted(Carbon::parse($until)->getTimestampMs());
        }

        // Reintento del mismo envío: se devuelve lo que ya se guardó, sin volver a avisar a nadie.
        if ($existing = $this->byKey($user->id, $key)) {
            return ['message' => $this->replay($existing, $body, $user->name, $matchId), 'replayed' => true];
        }

        $window = (int) $cfg['repeat_seconds'];
        if ($window > 0 && $this->scope(ChatMessage::query(), $matchId)->where('user_id', $user->id)->where('body', $body)
            ->where('created_at', '>=', now()->subSeconds($window)->toDateTimeString())->exists()) {
            throw GameException::repeatedMessage($window);
        }

        try {
            $message = ChatMessage::forceCreate(['match_id' => $matchId, 'kind' => 'usuario', 'user_id' => $user->id, 'client_key' => $key, 'body' => $body]);
        } catch (UniqueConstraintViolationException) {
            // Dos envíos con la misma clave a la vez: perdió la carrera, así que el otro ya lo guardó.
            $existing = $this->byKey($user->id, $key) ?? throw GameException::chatKeyReused();

            return ['message' => $this->replay($existing, $body, $user->name, $matchId), 'replayed' => true];
        }

        $public = $this->fresh($message)->toPublic($user->name);
        rescue(fn () => event(new ChatMessageSent($public)), report: true); // guardado ya: si Reverb falla, no se pierde nada

        return ['message' => $public, 'replayed' => false];
    }

    /**
     * Aviso automático del juego en el chat de una sala. NUNCA lanza: si algo falla se registra y el juego sigue.
     * `$eventKey` hace que un aviso salga UNA sola vez por sala aunque lo pidan dos procesos a la vez (inicio, fin, "quedan 10 min").
     * Devuelve el mensaje, o null si ya existía o no se pudo guardar.
     *
     * @return array<string, mixed>|null
     */
    public function system(int $matchId, string $text, ?string $eventKey = null): ?array
    {
        try {
            $body = mb_substr((string) ChatRules::clean($text), 0, (int) config('formosa.chat.max_length'));
            if ($body === '') {
                return null;
            }
            try {
                $message = ChatMessage::forceCreate([
                    'match_id' => $matchId, 'kind' => 'sistema', 'user_id' => null,
                    'client_key' => 'sys-'.bin2hex(random_bytes(12)), 'event_key' => $eventKey, 'body' => $body,
                ]);
            } catch (UniqueConstraintViolationException) {
                return null; // ese aviso ya salió
            }
            $public = $this->fresh($message)->toPublic(null);
            rescue(fn () => event(new ChatMessageSent($public)), report: true);

            return $public;
        } catch (Throwable $e) {
            report($e);

            return null;
        }
    }

    // ------------------------------------------------------------------ leer

    /**
     * Mensajes del canal para mostrar, del más viejo al más nuevo. `$matchId` null = global.
     * Sin `$after`: los últimos `history`. Con `$after`: los que vinieron después (para ponerse al día tras una caída).
     *
     * @return list<array<string, mixed>>
     */
    public function recent(int $after = 0, ?int $matchId = null): array
    {
        $cfg = config('formosa.chat');
        $query = DB::table('chat_messages')
            ->leftJoin('users', 'users.id', '=', 'chat_messages.user_id') // los avisos de sistema no tienen autor
            ->whereNull('chat_messages.hidden_at') // lo oculto no se muestra a nadie
            ->select(['chat_messages.id', 'chat_messages.kind', 'chat_messages.match_id', 'chat_messages.user_id', 'users.name AS user', 'chat_messages.body', 'chat_messages.created_at']);
        $matchId === null ? $query->whereNull('chat_messages.match_id') : $query->where('chat_messages.match_id', $matchId);

        if ($after > 0) {
            $rows = $query->where('chat_messages.id', '>', $after)->orderBy('chat_messages.id')->limit((int) $cfg['per_read'])->get();
        } else {
            $rows = $query->orderByDesc('chat_messages.id')->limit((int) $cfg['history'])->get()->reverse()->values();
        }

        return $rows->map(fn ($r) => ChatMessage::shape($r->id, $r->kind, $r->match_id, $r->user_id, $r->user, $r->body, Carbon::parse($r->created_at)->getTimestampMs()))->all();
    }

    // ------------------------------------------------------------------ retención

    /**
     * Borra los mensajes más viejos que `$days` días (de todos los canales: una sala terminada se conserva hasta ahí) y pone
     * TOPE POR CANAL: el global deja como mucho `$maxRows` filas y cada sala `$roomMaxRows` (0 = sin tope), así que una sala
     * ruidosa no empuja afuera al global ni al revés. De a tandas, para no bloquear la tabla. Devuelve cuántos borró.
     */
    public function prune(int $days, int $batch = 1000, int $maxRows = 0, ?int $roomMaxRows = null): int
    {
        $total = $this->deleteWhere(fn ($q) => $q->where('created_at', '<', now()->subDays(max(1, $days))->toDateTimeString()), $batch);

        if ($maxRows > 0) {
            // El id más bajo del global que se conserva: el que está `$maxRows` posiciones desde el final.
            $floor = DB::table('chat_messages')->whereNull('match_id')->orderByDesc('id')->offset($maxRows - 1)->limit(1)->value('id');
            if ($floor !== null) {
                $total += $this->deleteWhere(fn ($q) => $q->whereNull('match_id')->where('id', '<', $floor), $batch);
            }
        }

        $roomMax = $roomMaxRows ?? (int) config('formosa.chat.room_max_rows');
        if ($roomMax > 0) {
            $big = DB::table('chat_messages')->whereNotNull('match_id')->groupBy('match_id')->havingRaw('COUNT(*) > ?', [$roomMax])->pluck('match_id');
            foreach ($big as $matchId) {
                $floor = DB::table('chat_messages')->where('match_id', $matchId)->orderByDesc('id')->offset($roomMax - 1)->limit(1)->value('id');
                if ($floor !== null) {
                    $total += $this->deleteWhere(fn ($q) => $q->where('match_id', $matchId)->where('id', '<', $floor), $batch);
                }
            }
        }

        return $total;
    }

    private function deleteWhere(\Closure $scope, int $batch): int
    {
        $total = 0;
        do {
            $ids = $scope(DB::table('chat_messages'))->orderBy('id')->limit($batch)->pluck('id');
            $n = $ids->isEmpty() ? 0 : DB::table('chat_messages')->whereIn('id', $ids)->delete();
            $total += $n;
        } while ($n === $batch);

        return $total;
    }

    // ------------------------------------------------------------------ internos

    /** Limita una consulta de ChatMessage al canal (global = sin partida). */
    private function scope($query, ?int $matchId)
    {
        return $matchId === null ? $query->whereNull('match_id') : $query->where('match_id', $matchId);
    }

    private function byKey(int $userId, string $key): ?ChatMessage
    {
        return ChatMessage::query()->where('user_id', $userId)->where('client_key', $key)->first();
    }

    /** @return array<string, mixed> */
    private function replay(ChatMessage $existing, string $body, string $userName, ?int $matchId): array
    {
        // Misma clave con otro texto, o con otro canal: no es un reintento.
        if ($existing->body !== $body || $existing->match_id !== $matchId) {
            throw GameException::chatKeyReused();
        }

        return $existing->toPublic($userName);
    }

    private function fresh(ChatMessage $message): ChatMessage
    {
        return ChatMessage::query()->findOrFail($message->id); // created_at tal como quedó en la base
    }
}
