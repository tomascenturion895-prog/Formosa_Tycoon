<?php

namespace App\Economy;

use App\Enums\MatchStatus;
use App\Models\GameMatch;
use App\Models\MatchPlayer;
use Illuminate\Support\Facades\DB;

/**
 * Lectura de salas y partidas para el panel de moderación. SOLO LEE: no cambia nada y no emite avisos.
 *
 * Qué muestra y qué no: apodo, antigüedad de la cuenta, estadísticas de juego, dinero y propiedades dentro de la partida,
 * estado en la sala (entró, salió, abandonó) y el chat de la sala. NO muestra correo, contraseña ni IP: un moderador necesita
 * saber quién es el jugador en el juego, no sus datos personales.
 */
class RoomInspector
{
    /** Filtros de la lista: clave de la URL => estados incluidos (null = todos). */
    public const FILTERS = [
        'activas' => ['lobby', 'running'],
        'terminadas' => ['finished'],
        'vencidas' => ['expired'],
        'todas' => null,
    ];

    /** Mensajes de chat de la sala que muestra la ficha (los más recientes). */
    public const CHAT_LIMIT = 60;

    public function __construct(private readonly EconomyService $economy) {}

    /**
     * Lista de partidas, las más nuevas primero.
     *
     * @return list<array<string, mixed>>
     */
    public function rooms(string $filter = 'activas', ?string $search = null, int $limit = 100): array
    {
        // array_key_exists y no `??`: 'todas' vale null a propósito (sin filtro de estado).
        $states = array_key_exists($filter, self::FILTERS) ? self::FILTERS[$filter] : self::FILTERS['activas'];

        $query = GameMatch::query()->join('users', 'users.id', '=', 'matches.creator_id');
        if ($states !== null) {
            $query->whereIn('matches.status', $states);
        }
        $search = $search === null ? '' : trim($search);
        if ($search !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_substr($search, 0, 60)).'%';
            $query->where(fn ($q) => $q->where('matches.code', 'like', $like)->orWhere('matches.name', 'like', $like)->orWhere('users.name', 'like', $like));
        }
        $rows = $query->orderByDesc('matches.id')->limit(max(1, min(200, $limit)))
            ->get(['matches.*', 'users.name as creator_name']);

        $counts = MatchPlayer::whereIn('match_id', $rows->pluck('id'))->whereNull('left_at')->groupBy('match_id')
            ->selectRaw('match_id, COUNT(*) AS n')->pluck('n', 'match_id');

        return $rows->map(fn (GameMatch $m) => [
            'id' => $m->id,
            'code' => $m->code,
            'name' => $m->name,
            'status' => $m->status->value,
            'is_public' => $m->is_public,
            'creator' => $m->creator_name,
            'players' => (int) ($counts[$m->id] ?? 0),
            'capacity' => $m->capacity,
            'created_at' => $m->created_at,
            'started_at' => $m->started_at,
            'ends_at' => $m->ends_at,
            'finished_at' => $m->finished_at,
        ])->all();
    }

    /**
     * Cuántas partidas hay en cada estado, para los contadores del panel.
     *
     * @return array<string, int>
     */
    public function counts(): array
    {
        $by = GameMatch::query()->groupBy('status')->selectRaw('status, COUNT(*) AS n')->pluck('n', 'status');
        $n = fn (string ...$s) => (int) collect($s)->sum(fn ($k) => $by[$k] ?? 0);

        return [
            'activas' => $n('lobby', 'running'),
            'terminadas' => $n('finished'),
            'vencidas' => $n('expired'),
            'todas' => $n(...MatchStatus::values()),
        ];
    }

    /**
     * Ficha completa de una partida: datos, jugadores con su situación y chat de la sala. Null si no existe.
     *
     * @return array<string, mixed>|null
     */
    public function room(int $matchId): ?array
    {
        $match = GameMatch::query()->join('users', 'users.id', '=', 'matches.creator_id')
            ->where('matches.id', $matchId)->first(['matches.*', 'users.name as creator_name']);
        if (! $match) {
            return null;
        }

        return [
            'match' => $this->summary($match),
            'players' => $this->players($match),
            'chat' => $this->chat($match->id),
        ];
    }

    /** @return array<string, mixed> */
    private function summary(GameMatch $match): array
    {
        $live = $match->status === MatchStatus::Running;
        $perDay = max(1, $match->minutes_per_day);

        return [
            'id' => $match->id,
            'code' => $match->code,
            'name' => $match->name,
            'status' => $match->status->value,
            'is_public' => $match->is_public,
            'creator' => $match->creator_name,
            'creator_id' => $match->creator_id,
            'capacity' => $match->capacity,
            'min_players' => $match->min_players,
            'start_cash' => $match->start_cash,
            'duration_minutes' => $match->duration_minutes,
            'days_total' => intdiv($match->duration_minutes, $perDay),
            // Cerrable por un moderador: sala abierta, o partida en juego cuya hora de fin ya pasó (ver ModerationService::closeRoom).
            'can_close' => $match->status === MatchStatus::Lobby || ($live && $match->ends_at->lessThanOrEqualTo(now())),
            'overdue' => $live && $match->ends_at->lessThanOrEqualTo(now()),
            'game_day' => $live || $match->status === MatchStatus::Finished ? $match->gameDay() : null,
            'created_at' => $match->created_at,
            'lobby_expires_at' => $match->status === MatchStatus::Lobby ? $match->lobby_expires_at : null,
            'started_at' => $match->started_at,
            'ends_at' => $match->ends_at,
            'finished_at' => $match->finished_at,
        ];
    }

    /**
     * Jugadores de la partida: lo que tienen en ella (patrimonio, propiedades, ingreso) y quiénes son en el juego.
     *
     * @return list<array<string, mixed>>
     */
    private function players(GameMatch $match): array
    {
        $rows = MatchPlayer::query()->where('match_id', $match->id)->join('users', 'users.id', '=', 'match_players.user_id')
            ->orderBy('match_players.joined_at')->orderBy('match_players.id')
            ->get(['match_players.*', 'users.name as user_name', 'users.role as user_role', 'users.created_at as user_since', 'users.rank_points', 'users.matches_played', 'users.matches_won']);
        if ($rows->isEmpty()) {
            return [];
        }

        // Dinero y propiedades en vivo: la misma lectura que usa el juego (no liquida nada).
        $standings = collect($this->economy->standings($match))->keyBy('user_id');
        $ids = $rows->pluck('user_id');
        $muted = DB::table('chat_mutes')->whereIn('user_id', $ids)->whereNull('lifted_at')->where('expires_at', '>', now()->toDateTimeString())
            ->pluck('expires_at', 'user_id');
        $said = DB::table('chat_messages')->where('match_id', $match->id)->where('kind', 'usuario')->whereIn('user_id', $ids)
            ->groupBy('user_id')->selectRaw('user_id, COUNT(*) AS n')->pluck('n', 'user_id');
        $hidden = DB::table('chat_messages')->where('match_id', $match->id)->where('kind', 'usuario')->whereNotNull('hidden_at')->whereIn('user_id', $ids)
            ->groupBy('user_id')->selectRaw('user_id, COUNT(*) AS n')->pluck('n', 'user_id');

        return $rows->map(function ($p) use ($standings, $muted, $said, $hidden, $match) {
            $s = $standings->get($p->user_id) ?? [];
            $left = $p->left_at !== null;

            return [
                'user_id' => (int) $p->user_id,
                'name' => $p->user_name,
                'is_moderator' => $p->user_role === 'moderador',
                'is_creator' => (int) $p->user_id === (int) $match->creator_id,
                'account_since' => $p->user_since,
                'rank_points' => (int) $p->rank_points,
                'matches_played' => (int) $p->matches_played,
                'matches_won' => (int) $p->matches_won,
                'joined_at' => $p->joined_at,
                'left_at' => $p->left_at,
                'abandoned' => (bool) $p->abandoned,
                'in_room' => ! $left,
                'cash' => (int) ($s['cash'] ?? $p->cash),
                'reserved' => (int) ($s['reserved'] ?? $p->reserved),
                'properties' => (int) ($s['properties'] ?? 0),
                'assets' => (int) ($s['assets'] ?? 0),
                'net_worth' => (int) ($s['net_worth'] ?? $p->cash),
                'income_per_day' => (int) ($s['income_per_day'] ?? 0),
                'rank' => $s['rank'] ?? null,
                'final_rank' => $p->final_rank,
                'final_net_worth' => $p->final_net_worth,
                'points_awarded' => $p->points_awarded,
                'muted_until' => $muted[$p->user_id] ?? null,
                'messages' => (int) ($said[$p->user_id] ?? 0),
                'hidden_messages' => (int) ($hidden[$p->user_id] ?? 0),
            ];
        })->all();
    }

    /**
     * Últimos mensajes de la sala, del más viejo al más nuevo. Incluye los ocultos (marcados) y los avisos del juego (marcados).
     *
     * @return array{messages: list<array<string, mixed>>, total: int}
     */
    private function chat(int $matchId): array
    {
        $total = (int) DB::table('chat_messages')->where('match_id', $matchId)->where('kind', 'usuario')->count();
        $rows = DB::table('chat_messages')->join('users', 'users.id', '=', 'chat_messages.user_id')
            ->where('chat_messages.match_id', $matchId)->where('chat_messages.kind', 'usuario')
            ->orderByDesc('chat_messages.id')->limit(self::CHAT_LIMIT)
            ->get(['chat_messages.id', 'chat_messages.user_id', 'users.name as author', 'chat_messages.body', 'chat_messages.hidden_at', 'chat_messages.hidden_reason', 'chat_messages.created_at']);

        $reports = DB::table('chat_reports')->where('status', 'abierto')->whereIn('message_id', $rows->pluck('id'))
            ->groupBy('message_id')->selectRaw('message_id, COUNT(*) AS n')->pluck('n', 'message_id');

        return [
            'total' => $total,
            'messages' => $rows->reverse()->values()->map(fn ($r) => [
                'id' => (int) $r->id,
                'user_id' => (int) $r->user_id,
                'author' => $r->author,
                'body' => $r->body,
                'hidden' => $r->hidden_at !== null,
                'hidden_reason' => $r->hidden_reason,
                'reports' => (int) ($reports[$r->id] ?? 0),
                'at' => $r->created_at,
            ])->all(),
        ];
    }
}
