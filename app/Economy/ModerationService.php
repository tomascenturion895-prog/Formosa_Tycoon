<?php

namespace App\Economy;

use App\Enums\MatchStatus;
use App\Events\ChatMessageHidden;
use App\Events\ChatMessageSent;
use App\Models\ChatMessage;
use App\Models\ChatMute;
use App\Models\ChatReport;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Moderación del chat: reportes, mensajes ocultos y silencios.
 *
 * Quién puede qué (lo exige la ruta con el middleware `moderador`, y acá se vuelve a comprobar):
 *  - Cualquier jugador con sesión: reportar un mensaje ajeno (una vez por mensaje).
 *  - Moderadores: ocultar, restaurar, descartar reportes, silenciar y levantar silencios.
 *
 * Reglas para que el sistema no se use para censurar:
 *  - El ocultado automático solo cuenta reportes de cuentas con antigüedad mínima, nunca toca mensajes de moderadores
 *    y no se repite sobre un mensaje que un moderador ya revisó (restauró o descartó).
 *  - Toda decisión de un moderador (y el ocultado automático) queda en `moderation_log`, con copia del texto.
 *
 * Todo es idempotente: repetir una acción (doble clic, reintento) no cambia el resultado ni vuelve a avisar.
 * Los avisos en vivo se emiten después de guardar y dentro de rescue(): si Reverb falla, la decisión no se pierde.
 */
class ModerationService
{
    /**
     * Reporte de un jugador. Con N reportes de cuentas "con antigüedad" distintas el mensaje se oculta solo, hasta que un moderador lo revise.
     *
     * @return array{replayed: bool, hidden: bool}
     *
     * @throws GameException
     */
    public function report(User $reporter, int $messageId, string $reason): array
    {
        $message = ChatMessage::query()->find($messageId);
        if (! $message || $message->hidden_at !== null || $message->isSystem()) {
            throw GameException::messageNotFound(); // un mensaje oculto ya no existe para el público; los avisos del juego no se reportan
        }
        if ($message->match_id !== null && ! app(ChatService::class)->isMember($reporter->id, $message->match_id)) {
            throw GameException::messageNotFound(); // lo de una sala no existe para quien no la juega (ni se confirma que existe)
        }
        if ($message->user_id === $reporter->id) {
            throw GameException::ownReport();
        }

        try {
            ChatReport::forceCreate(['message_id' => $messageId, 'reporter_id' => $reporter->id, 'reason' => $reason]);
            $replayed = false;
        } catch (UniqueConstraintViolationException) {
            $replayed = true; // ya lo había reportado: no suma
        }

        $hidden = false;
        $threshold = (int) config('formosa.chat.auto_hide_reports');
        if (! $replayed && $threshold > 0 && $message->reviewed_at === null && ! User::query()->whereKey($message->user_id)->where('role', 'moderador')->exists()) {
            if ($this->eligibleReports($messageId) >= $threshold && $this->hideRow($messageId, null, 'reportes')) {
                $hidden = true;
                $this->log(null, 'auto_ocultar', $messageId, $message->user_id, $message->body);
            }
        }

        return ['replayed' => $replayed, 'hidden' => $hidden];
    }

    /** Oculta un mensaje (moderador). Si estaba oculto por reportes, pasa a ser decisión del moderador. Los reportes abiertos quedan resueltos. */
    public function hide(User $moderator, int $messageId): bool
    {
        $this->requireModerator($moderator);
        $message = $this->requireMessage($messageId);

        $changed = $this->hideRow($messageId, $moderator->id, 'moderador');
        if (! $changed) {
            // Ya estaba oculto: si lo ocultaron los reportes, ahora lo confirma una persona (y deja de poder restaurarse solo por reportes).
            $changed = DB::table('chat_messages')->where('id', $messageId)->where('hidden_reason', 'reportes')
                ->update(['hidden_by' => $moderator->id, 'hidden_reason' => 'moderador']) > 0;
        }
        DB::table('chat_messages')->where('id', $messageId)->update(['reviewed_at' => now()->toDateTimeString()]);
        $this->closeReports($messageId, 'resuelto', $moderator->id);
        if ($changed) {
            $this->log($moderator->id, 'ocultar', $messageId, $message->user_id, $message->body);
        }

        return $changed;
    }

    /** Vuelve a mostrar un mensaje oculto (por reportes o por un moderador). Sus reportes abiertos se descartan y no se oculta solo otra vez. */
    public function restore(User $moderator, int $messageId): bool
    {
        $this->requireModerator($moderator);
        $message = $this->requireMessage($messageId);

        $changed = $this->unhide($messageId, $moderator->id);
        if ($changed) {
            $this->log($moderator->id, 'restaurar', $messageId, $message->user_id, $message->body);
        }

        return $changed;
    }

    /** Descarta los reportes abiertos de un mensaje. Si estaba oculto SOLO por esos reportes, vuelve a mostrarse. */
    public function dismiss(User $moderator, int $messageId): int
    {
        $this->requireModerator($moderator);
        $message = $this->requireMessage($messageId);

        $this->unhideIfAuto($messageId, $moderator->id);
        DB::table('chat_messages')->where('id', $messageId)->update(['reviewed_at' => now()->toDateTimeString()]);
        $n = $this->closeReports($messageId, 'descartado', $moderator->id);
        if ($n > 0) {
            $this->log($moderator->id, 'descartar', $messageId, $message->user_id, $message->body);
        }

        return $n;
    }

    /**
     * Silencia a un jugador. No se puede silenciar a un moderador ni a uno mismo. Devuelve cuándo vence.
     *
     * @throws GameException
     */
    public function mute(User $moderator, int $userId, int $minutes, ?string $reason = null): string
    {
        $this->requireModerator($moderator);
        if (! in_array($minutes, config('formosa.chat.mute_minutes'), true)) {
            throw GameException::invalidDuration();
        }
        $target = User::query()->find($userId) ?? throw GameException::userNotFound();
        if ($target->id === $moderator->id || $target->isModerator()) {
            throw GameException::invalidTarget();
        }

        $until = now()->addMinutes($minutes);
        $reason = $reason !== null ? (mb_substr(trim($reason), 0, 120) ?: null) : null;
        ChatMute::forceCreate(['user_id' => $target->id, 'muted_by' => $moderator->id, 'reason' => $reason, 'expires_at' => $until->toDateTimeString()]);
        $this->log($moderator->id, 'silenciar', null, $target->id, "{$minutes} min".($reason ? ": {$reason}" : ''));

        return $until->toDateTimeString();
    }

    /** Levanta los silencios vigentes de un jugador. Devuelve cuántos levantó. */
    public function unmute(User $moderator, int $userId): int
    {
        $this->requireModerator($moderator);

        $n = DB::table('chat_mutes')->where('user_id', $userId)->whereNull('lifted_at')->where('expires_at', '>', now()->toDateTimeString())
            ->update(['lifted_at' => now()->toDateTimeString(), 'lifted_by' => $moderator->id]);
        if ($n > 0) {
            $this->log($moderator->id, 'levantar_silencio', null, $userId, null);
        }

        return $n;
    }

    /** Hasta cuándo está silenciado el jugador (fecha-hora del servidor), o null si puede escribir. */
    public function mutedUntil(int $userId): ?string
    {
        $until = DB::table('chat_mutes')->where('user_id', $userId)->whereNull('lifted_at')
            ->where('expires_at', '>', now()->toDateTimeString())->max('expires_at');

        return $until === null ? null : (string) $until;
    }

    /**
     * Cierra una sala trabada, solo en los dos casos en que el reloj lo haría igual:
     *  - sala abierta (todavía sin iniciar): se vence y libera a sus jugadores, aunque no haya llegado su hora;
     *  - partida en juego cuya hora de fin ya pasó: se cierra como siempre (puestos, puntos y ranking).
     * Una partida en juego a la que todavía le queda tiempo no se toca: terminarla antes cambiaría el ranking de todos.
     * Devuelve 'vencida' o 'terminada'. Queda en el registro de moderación.
     *
     * @throws GameException
     */
    public function closeRoom(User $moderator, int $matchId): string
    {
        $this->requireModerator($moderator);
        $match = GameMatch::query()->find($matchId) ?? throw GameException::roomNotFound();
        $matches = app(MatchService::class);

        if ($match->status === MatchStatus::Lobby) {
            $done = $matches->expire($matchId, true);
            $result = 'vencida';
        } elseif ($match->status === MatchStatus::Running && $match->ends_at->lessThanOrEqualTo(now())) {
            $done = $matches->finish($matchId) !== null;
            $result = 'terminada';
        } else {
            $done = false;
            $result = '';
        }
        $done || throw GameException::cannotClose();

        $this->log($moderator->id, 'cerrar_sala', null, null, "Sala #{$match->id} «{$match->name}» ({$match->code}): {$result}");

        return $result;
    }

    /** Anota que se cambió el rol de un jugador (lo usa el comando `moderador:asignar`). */
    public function logRole(int $userId, string $role): void
    {
        $this->log(null, 'rol', null, $userId, $role);
    }

    /**
     * Cola de revisión: mensajes con reportes abiertos u ocultos hace poco (los más reportados primero) y silencios vigentes.
     *
     * @return array{reports: list<array<string, mixed>>, mutes: list<array<string, mixed>>}
     */
    public function queue(int $limit = 50): array
    {
        $open = DB::table('chat_reports')->where('status', 'abierto')->groupBy('message_id')->selectRaw('message_id, COUNT(*) AS n');
        $rows = DB::table('chat_messages')
            ->join('users', 'users.id', '=', 'chat_messages.user_id')
            ->leftJoinSub($open, 'r', 'r.message_id', '=', 'chat_messages.id')
            ->where(fn ($q) => $q->whereNotNull('r.n')->orWhereNotNull('chat_messages.hidden_at'))
            ->orderByRaw('COALESCE(r.n, 0) DESC')->orderByDesc('chat_messages.id')
            ->limit($limit)
            ->get(['chat_messages.id', 'chat_messages.match_id', 'chat_messages.user_id', 'users.name AS author', 'chat_messages.body', 'chat_messages.hidden_at', 'chat_messages.hidden_reason', 'chat_messages.created_at', DB::raw('COALESCE(r.n, 0) AS reports')]);

        $ids = $rows->pluck('id');
        $reasons = DB::table('chat_reports')->where('status', 'abierto')->whereIn('message_id', $ids)
            ->groupBy('message_id', 'reason')->selectRaw('message_id, reason, COUNT(*) AS n')->get()->groupBy('message_id');
        $fresh = DB::table('chat_reports')->join('users', 'users.id', '=', 'chat_reports.reporter_id')
            ->where('chat_reports.status', 'abierto')->whereIn('chat_reports.message_id', $ids)
            ->where('users.created_at', '>', $this->accountCutoff())
            ->groupBy('chat_reports.message_id')->selectRaw('chat_reports.message_id AS message_id, COUNT(*) AS n')->pluck('n', 'message_id');

        $reports = $rows->map(fn ($r) => [
            'id' => (int) $r->id,
            'match_id' => $r->match_id === null ? null : (int) $r->match_id, // null = chat global
            'user_id' => (int) $r->user_id,
            'author' => $r->author,
            'body' => $r->body,
            'hidden' => $r->hidden_at !== null,
            'hidden_reason' => $r->hidden_reason,
            'at' => $r->created_at,
            'reports' => (int) $r->reports,
            'new_accounts' => (int) ($fresh[$r->id] ?? 0), // reportes de cuentas nuevas: señal de que alguien arma cuentas para censurar
            'reasons' => ($reasons[$r->id] ?? collect())->mapWithKeys(fn ($x) => [$x->reason => (int) $x->n])->all(),
        ])->all();

        $mutes = DB::table('chat_mutes')
            ->join('users', 'users.id', '=', 'chat_mutes.user_id')
            ->join('users AS mods', 'mods.id', '=', 'chat_mutes.muted_by')
            ->whereNull('chat_mutes.lifted_at')->where('chat_mutes.expires_at', '>', now()->toDateTimeString())
            ->orderBy('chat_mutes.expires_at')->limit($limit)
            ->get(['chat_mutes.user_id', 'users.name AS player', 'mods.name AS moderator', 'chat_mutes.reason', 'chat_mutes.expires_at'])
            ->map(fn ($m) => (array) $m)->all();

        return ['reports' => $reports, 'mutes' => $mutes];
    }

    // ------------------------------------------------------------------------------------------------ interno

    private function requireModerator(User $user): void
    {
        abort_unless($user->isModerator(), 403, 'Solo para moderadores.');
    }

    private function requireMessage(int $messageId): ChatMessage
    {
        $message = ChatMessage::query()->find($messageId);
        if (! $message || $message->isSystem()) {
            throw GameException::messageNotFound(); // un aviso del juego no se oculta ni se modera
        }

        return $message;
    }

    private function accountCutoff(): string
    {
        return now()->subHours((int) config('formosa.chat.auto_hide_min_age_hours'))->toDateTimeString();
    }

    /** Reportes abiertos de cuentas con la antigüedad mínima (las únicas que cuentan para ocultar solo). */
    private function eligibleReports(int $messageId): int
    {
        return DB::table('chat_reports')->join('users', 'users.id', '=', 'chat_reports.reporter_id')
            ->where('chat_reports.message_id', $messageId)->where('chat_reports.status', 'abierto')
            ->where('users.created_at', '<=', $this->accountCutoff())->count();
    }

    /** Oculta si estaba visible (una sola vez, aunque lleguen dos pedidos a la vez) y avisa en vivo. */
    private function hideRow(int $messageId, ?int $by, string $reason): bool
    {
        $n = DB::table('chat_messages')->where('id', $messageId)->whereNull('hidden_at')
            ->update(['hidden_at' => now()->toDateTimeString(), 'hidden_by' => $by, 'hidden_reason' => $reason]);
        if ($n > 0) {
            $matchId = DB::table('chat_messages')->where('id', $messageId)->value('match_id'); // sale por el canal del mensaje (global o sala)
            rescue(fn () => event(new ChatMessageHidden($messageId, $matchId === null ? null : (int) $matchId)), report: true);
        }

        return $n > 0;
    }

    /** Muestra de nuevo un mensaje oculto, lo marca como revisado y descarta sus reportes abiertos. */
    private function unhide(int $messageId, int $by): bool
    {
        $n = DB::table('chat_messages')->where('id', $messageId)->whereNotNull('hidden_at')
            ->update(['hidden_at' => null, 'hidden_by' => null, 'hidden_reason' => null, 'reviewed_at' => now()->toDateTimeString()]);
        DB::table('chat_messages')->where('id', $messageId)->whereNull('reviewed_at')->update(['reviewed_at' => now()->toDateTimeString()]);
        $this->closeReports($messageId, 'descartado', $by);

        if ($n > 0) {
            $public = $this->publicMessage($messageId);
            rescue(fn () => event(new ChatMessageSent($public)), report: true); // el cliente lo vuelve a ubicar por su número
        }

        return $n > 0;
    }

    /** Si el mensaje estaba oculto solo por reportes (nadie lo decidió), "descartar" lo devuelve a la vista. */
    private function unhideIfAuto(int $messageId, int $by): void
    {
        $auto = DB::table('chat_messages')->where('id', $messageId)->where('hidden_reason', 'reportes')->exists();
        if ($auto) {
            $this->unhide($messageId, $by);
        }
    }

    private function closeReports(int $messageId, string $status, int $by): int
    {
        return DB::table('chat_reports')->where('message_id', $messageId)->where('status', 'abierto')
            ->update(['status' => $status, 'resolved_by' => $by, 'resolved_at' => now()->toDateTimeString()]);
    }

    private function log(?int $actorId, string $action, ?int $messageId, ?int $targetUserId, ?string $detail): void
    {
        DB::table('moderation_log')->insert([
            'actor_id' => $actorId, 'action' => $action, 'message_id' => $messageId, 'target_user_id' => $targetUserId,
            'detail' => $detail !== null ? mb_substr($detail, 0, 400) : null, 'created_at' => now()->toDateTimeString(),
        ]);
    }

    /** @return array<string, mixed> */
    private function publicMessage(int $messageId): array
    {
        $r = DB::table('chat_messages')->join('users', 'users.id', '=', 'chat_messages.user_id')
            ->where('chat_messages.id', $messageId)->first(['chat_messages.id', 'chat_messages.kind', 'chat_messages.match_id', 'chat_messages.user_id', 'users.name AS user', 'chat_messages.body', 'chat_messages.created_at']);

        return ChatMessage::shape($r->id, $r->kind, $r->match_id, $r->user_id, $r->user, $r->body, Carbon::parse($r->created_at)->getTimestampMs());
    }
}
