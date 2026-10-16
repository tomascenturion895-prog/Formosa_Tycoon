<?php

namespace App\Economy;

use App\Enums\LedgerType;
use App\Enums\MatchStatus;
use App\Formosa\TextClean;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\User;
use Carbon\Carbon;
use Carbon\CarbonInterface;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Ciclo de vida de las partidas: crear sala, unirse, salir, iniciar, cerrar y vencer salas.
 *
 *  - Un jugador solo puede estar en UNA partida activa (lobby o en juego): lo garantiza el índice único de
 *    match_players.active_user_id, no solo el código.
 *  - Toda transición toma la partida EN EXCLUSIVA (lockForUpdate) antes que nada; las compras y pujas la toman compartida.
 *  - Los estados solo avanzan: lobby -> running -> finished (o lobby -> expired). Nada vuelve atrás.
 *  - El cierre es perezoso e idempotente: lo puede pedir el comando `matches:tick`, una lectura o una acción; solo el primero cierra.
 *  - Los avisos en vivo salen después de confirmar.
 */
class MatchService
{
    private const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L: se dicta por voz o chat

    public function __construct(private readonly EconomyService $economy, private readonly AuctionService $auctions, private readonly OfferService $offers) {}

    // ------------------------------------------------------------------ sala

    /**
     * Crea una sala y mete a quien la crea. `$capacity` null = el cupo por defecto.
     *
     * @throws GameException
     */
    public function create(User $user, ?string $name, ?int $capacity = null, bool $public = true): GameMatch
    {
        $cfg = config('formosa.match');
        $capacity ??= (int) $cfg['default_capacity'];
        if ($capacity < (int) $cfg['min_capacity'] || $capacity > (int) $cfg['max_capacity']) {
            throw GameException::invalidCapacity((int) $cfg['min_capacity'], (int) $cfg['max_capacity']);
        }
        $name = TextClean::line($name, (int) $cfg['name_max']) ?? 'Sala de '.$user->name;
        $this->assertFree($user);

        for ($attempt = 1; ; $attempt++) {
            try {
                $match = DB::transaction(function () use ($user, $cfg, $capacity, $name, $public) {
                    $now = now();
                    $match = new GameMatch;
                    $match->forceFill([
                        'code' => $this->newCode(), 'name' => $name, 'is_public' => $public, 'status' => MatchStatus::Lobby,
                        'capacity' => $capacity, 'min_players' => max(1, min((int) $cfg['min_players'], $capacity)), 'creator_id' => $user->id,
                        'start_cash' => (int) $cfg['start_cash'], 'minutes_per_day' => (int) $cfg['minutes_per_day'], 'duration_minutes' => (int) $cfg['duration_minutes'],
                        'lobby_expires_at' => $now->copy()->addMinutes((int) $cfg['lobby_ttl_minutes'])->startOfSecond(),
                    ])->save();
                    $this->addPlayer($match->id, $user->id, $now);

                    return $match;
                }, attempts: 3);
                break;
            } catch (UniqueConstraintViolationException $e) {
                $this->assertFree($user); // la base frenó un segundo "crear" simultáneo del mismo jugador
                if ($attempt >= 5) {
                    throw $e;
                }
            }
        }

        Announcer::lobby($match, 1, true);

        return $match;
    }

    /**
     * Entra a una sala abierta por su código. Repetir el pedido estando ya en esa sala no es un error.
     *
     * @throws GameException
     */
    public function join(User $user, string $code): GameMatch
    {
        $code = strtoupper(trim($code));
        if (($active = $this->current($user)) !== null) {
            if ($active->code === $code) {
                return $active;
            }
            throw GameException::alreadyInMatch($active->id);
        }

        try {
            [$match, $players] = DB::transaction(function () use ($user, $code) {
                $match = GameMatch::query()->where('code', $code)->lockForUpdate()->first() ?? throw GameException::codeNotFound();
                if ($match->status !== MatchStatus::Lobby) {
                    return [$match, null];
                }
                $now = now();
                if ($match->lobby_expires_at->lessThanOrEqualTo($now)) {
                    $this->expireLocked($match);

                    return [$match->refresh(), null];
                }
                $count = MatchPlayer::where('match_id', $match->id)->whereNull('left_at')->count();
                if ($count >= $match->capacity) {
                    throw GameException::matchFull();
                }
                $this->addPlayer($match->id, $user->id, $now);

                return [$match, $count + 1];
            }, attempts: 3);
        } catch (UniqueConstraintViolationException) {
            $active = $this->current($user);
            throw $active !== null ? GameException::alreadyInMatch($active->id) : GameException::matchNotOpen();
        }

        if ($players === null) {
            if ($match->status === MatchStatus::Expired) {
                Announcer::lobby($match, 0, false);
            }
            throw GameException::matchNotOpen();
        }

        Announcer::players($match->id, 'joined', ['user_id' => $user->id, 'name' => $user->name, 'players' => $players]);
        Announcer::lobby($match, $players, true);
        RoomNotices::player($match->id, $user->name, 'joined');

        return $match;
    }

    /**
     * Sale de la partida. En la sala: se va sin más (si era quien la creó, pasa al jugador que lleva más tiempo; sin nadie, la sala vence).
     * En juego: ABANDONA y pierde: sus propiedades quedan libres, sus subastas se cancelan y cuenta como último, sin puntos.
     *
     * @return array{status: string, abandoned: bool}
     *
     * @throws GameException
     */
    public function leave(User $user, int $matchId): array
    {
        $out = DB::transaction(function () use ($user, $matchId) {
            $match = GameMatch::query()->lockForUpdate()->find($matchId) ?? throw GameException::matchNotFound();
            $player = MatchPlayer::query()->where('match_id', $matchId)->where('user_id', $user->id)->whereNull('left_at')->lockForUpdate()->first()
                ?? throw GameException::notInMatch();
            $now = now();

            if ($match->status === MatchStatus::Lobby) {
                MatchPlayer::where('id', $player->id)->delete();
                $rest = MatchPlayer::where('match_id', $matchId)->whereNull('left_at')->orderBy('id')->get(['user_id']);
                if ($rest->isEmpty()) {
                    $this->expireLocked($match);
                } elseif ($match->creator_id === $user->id) {
                    DB::table('matches')->where('id', $matchId)->update(['creator_id' => $rest->first()->user_id, 'updated_at' => $now->toDateTimeString()]);
                }

                return ['kind' => 'lobby', 'players' => $rest->count(), 'freed' => [], 'cancelled' => [], 'remaining' => $rest->count()];
            }
            if ($match->status !== MatchStatus::Running) {
                throw GameException::matchNotRunning();
            }
            if ($match->ends_at->lessThanOrEqualTo($now)) {
                return ['kind' => 'due', 'players' => 0, 'freed' => [], 'cancelled' => [], 'remaining' => 0]; // ya terminó: se cierra normal, no cuenta como abandono
            }

            $cancelled = $this->auctions->cancelActive($matchId, $user->id);
            $cancelledOffers = $this->offers->cancelActive($matchId, $user->id);
            app(LoanService::class)->cancelFor($matchId, $user->id);
            $freed = DB::table('match_properties')->where('match_id', $matchId)->where('owner_id', $user->id)->pluck('property_id')->map(fn ($id) => (int) $id)->all();
            DB::table('match_properties')->where('match_id', $matchId)->where('owner_id', $user->id)->delete();
            DB::table('match_players')->where('id', $player->id)->update([
                'left_at' => $now->toDateTimeString(), 'abandoned' => true, 'active_user_id' => null, 'updated_at' => $now->toDateTimeString(),
            ]);
            $remaining = MatchPlayer::where('match_id', $matchId)->whereNull('left_at')->count();

            return ['kind' => 'running', 'players' => $remaining, 'freed' => $freed, 'cancelled' => $cancelled, 'cancelled_offers' => $cancelledOffers, 'remaining' => $remaining];
        }, attempts: 3);

        $match = GameMatch::findOrFail($matchId);
        if ($out['kind'] === 'lobby') {
            Announcer::players($matchId, 'left', ['user_id' => $user->id, 'name' => $user->name, 'players' => $out['players']]);
            Announcer::lobby($match, $out['players'], $match->status === MatchStatus::Lobby);
            if ($out['players'] > 0) {
                RoomNotices::player($matchId, $user->name, 'left'); // si no quedó nadie, la sala vence y no hay a quién avisar
            }

            return ['status' => $match->status->value, 'abandoned' => false];
        }
        if ($out['kind'] === 'due') {
            $this->finish($matchId);

            return ['status' => GameMatch::findOrFail($matchId)->status->value, 'abandoned' => false];
        }

        foreach ($out['freed'] as $propertyId) {
            Announcer::owner($matchId, $propertyId, null, null);
        }
        foreach ($out['cancelled'] as $auction) {
            Announcer::auction($auction);
        }
        foreach ($out['cancelled_offers'] ?? [] as $offer) {
            Announcer::offer($offer);
        }
        Announcer::players($matchId, 'abandoned', ['user_id' => $user->id, 'name' => $user->name, 'players' => $out['players']]);
        RoomNotices::player($matchId, $user->name, 'abandoned');
        if ($out['remaining'] === 0) {
            $this->finish($matchId, force: true); // se fueron todos: no tiene sentido seguir
        }

        return ['status' => GameMatch::findOrFail($matchId)->status->value, 'abandoned' => true];
    }

    /**
     * Inicia la partida (solo quien creó la sala). Todos los jugadores reciben el MISMO dinero inicial y el reloj de juego parte de este instante.
     *
     * @throws GameException
     */
    public function start(User $user, int $matchId): GameMatch
    {
        [$match, $players] = DB::transaction(function () use ($user, $matchId) {
            $match = GameMatch::query()->lockForUpdate()->find($matchId) ?? throw GameException::matchNotFound();
            if ($match->creator_id !== $user->id) {
                throw GameException::notCreator();
            }
            if ($match->status !== MatchStatus::Lobby) {
                throw GameException::matchNotOpen();
            }
            $now = now();
            if ($match->lobby_expires_at->lessThanOrEqualTo($now)) {
                $this->expireLocked($match);

                return [$match->refresh(), null];
            }
            $players = MatchPlayer::where('match_id', $matchId)->whereNull('left_at')->orderBy('id')->lockForUpdate()->get();
            if ($players->count() < $match->min_players) {
                throw GameException::notEnoughPlayers($match->min_players);
            }

            $startedAt = $now->copy()->startOfSecond();
            DB::table('matches')->where('id', $matchId)->update([
                'status' => MatchStatus::Running->value, 'started_at' => $startedAt->toDateTimeString(),
                'ends_at' => $startedAt->copy()->addMinutes($match->duration_minutes)->toDateTimeString(), 'updated_at' => $startedAt->toDateTimeString(),
            ]);
            foreach ($players as $p) {
                DB::table('match_players')->where('id', $p->id)->update([
                    'cash' => $match->start_cash, 'last_settled_at' => $startedAt->toDateTimeString(), 'updated_at' => $startedAt->toDateTimeString(),
                ]);
                LedgerEntry::forceCreate([
                    'match_id' => $matchId, 'user_id' => $p->user_id, 'type' => LedgerType::Alta, 'amount' => $match->start_cash,
                    'balance_after' => $match->start_cash, 'idempotency_key' => 'alta',
                ]);
            }

            return [$match->refresh(), $players->count()];
        }, attempts: 3);

        if ($players === null) {
            Announcer::lobby($match, 0, false);
            throw GameException::matchNotOpen();
        }

        Announcer::started($match);
        Announcer::lobby($match, $players, false);
        RoomNotices::started($match);

        return $match;
    }

    // ------------------------------------------------------------------ cierre

    /**
     * Cierra la partida: liquida el ingreso hasta la hora de fin, cancela lo que quede abierto, calcula patrimonio, puestos y
     * puntos, y suma al ranking global. Idempotente: si ya está cerrada (o todavía no toca), no hace nada y devuelve null.
     * `$force` cierra antes de la hora (solo cuando no queda nadie jugando).
     */
    public function finish(int $matchId, bool $force = false): ?GameMatch
    {
        $match = GameMatch::find($matchId);
        if (! $match || $match->status !== MatchStatus::Running || (! $force && $match->ends_at->greaterThan(now()))) {
            return null;
        }
        // Las subastas que SÍ vencieron antes del fin se cobran; las que seguían abiertas al terminar se cancelan abajo.
        $this->auctions->settleDue(100, $matchId);
        $this->guard(fn () => $this->offers->settleDue(100, $matchId));

        $cancelled = [];
        $cancelledOffers = [];
        $done = DB::transaction(function () use ($matchId, $force, &$cancelled, &$cancelledOffers) {
            $match = GameMatch::query()->lockForUpdate()->find($matchId);
            if ($match->status !== MatchStatus::Running || (! $force && $match->ends_at->greaterThan(now()))) {
                return false;
            }
            $now = now();
            $cancelled = $this->auctions->cancelActive($matchId);
            $cancelledOffers = $this->offers->cancelActive($matchId);

            $players = MatchPlayer::where('match_id', $matchId)->orderBy('id')->lockForUpdate()->get();
            $assets = DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')->where('mp.match_id', $matchId)
                ->groupBy('mp.owner_id')->selectRaw('mp.owner_id, COUNT(*) AS n, SUM(p.price) AS assets')->get()->keyBy('owner_id');

            $finishers = [];
            foreach ($players as $p) {
                if ($p->left_at !== null) {
                    continue;
                }
                $this->economy->settleIncome($match, $p, $now); // hasta ends_at, nunca después
                $a = $assets->get($p->user_id);
                $debt = app(LoanService::class)->debtOf($matchId, $p->user_id); // después de cobrar las cuotas hasta el cierre
                $finishers[] = ['user_id' => $p->user_id, 'net_worth' => $p->cash + (int) ($a->assets ?? 0) - $debt, 'properties' => (int) ($a->n ?? 0)];
            }
            $scores = MatchScoring::score($finishers);
            $byUser = collect($finishers)->keyBy('user_id');
            $lastRank = count($finishers) + 1; // quienes abandonaron: último puesto, sin puntos

            $stamp = $now->toDateTimeString();
            foreach ($players as $p) {
                if (isset($scores[$p->user_id])) {
                    $s = $scores[$p->user_id];
                    $f = $byUser[$p->user_id];
                    $update = ['final_rank' => $s['rank'], 'final_net_worth' => max(0, $f['net_worth']), 'final_properties' => $f['properties'], 'points_awarded' => $s['points']];
                } else {
                    $update = ['final_rank' => $lastRank, 'final_net_worth' => $p->cash, 'final_properties' => 0, 'points_awarded' => 0];
                }
                DB::table('match_players')->where('id', $p->id)->update($update + ['active_user_id' => null, 'updated_at' => $stamp]);
            }
            // Ranking global: sumas atómicas en la base, en orden de id (sin cruces entre partidas que cierran a la vez).
            foreach ($players->sortBy('user_id') as $p) {
                $s = $scores[$p->user_id] ?? null;
                DB::table('users')->where('id', $p->user_id)->update([
                    'rank_points' => DB::raw('rank_points + '.(int) ($s['points'] ?? 0)),
                    'matches_played' => DB::raw('matches_played + 1'),
                    'matches_won' => DB::raw('matches_won + '.(($s['rank'] ?? 0) === 1 ? 1 : 0)),
                ]);
            }
            DB::table('matches')->where('id', $matchId)->update(['status' => MatchStatus::Finished->value, 'finished_at' => $stamp, 'updated_at' => $stamp]);

            return true;
        }, attempts: 3);

        if (! $done) {
            return null;
        }
        foreach ($cancelled as $auction) {
            Announcer::auction($auction);
        }
        foreach ($cancelledOffers as $offer) {
            Announcer::offer($offer);
        }
        $match = GameMatch::findOrFail($matchId);
        Announcer::finished($match);
        RoomNotices::finished($matchId);

        return $match;
    }

    /** Vence la sala si nadie la inició a tiempo. Idempotente. `$force` la vence antes de hora (lo usa un moderador). */
    public function expire(int $matchId, bool $force = false): bool
    {
        $match = DB::transaction(function () use ($matchId, $force) {
            $match = GameMatch::query()->lockForUpdate()->find($matchId);
            if (! $match || $match->status !== MatchStatus::Lobby || (! $force && $match->lobby_expires_at->greaterThan(now()))) {
                return null;
            }
            $this->expireLocked($match);

            return $match->refresh();
        }, attempts: 3);
        if ($match) {
            Announcer::lobby($match, 0, false);
            Announcer::players($match->id, 'expired');
        }

        return $match !== null;
    }

    /**
     * Una pasada del reloj de partidas (la corre `matches:tick` cada minuto y `juego:reloj` cada segundo): vence salas,
     * cierra partidas cuyo tiempo se cumplió y cierra subastas vencidas.
     *
     * @return array{expired: int, finished: int, auctions: int}
     */
    public function tick(): array
    {
        $now = now()->toDateTimeString();
        $expired = 0;
        foreach (GameMatch::where('status', MatchStatus::Lobby->value)->where('lobby_expires_at', '<=', $now)->orderBy('id')->limit(100)->pluck('id') as $id) {
            $expired += $this->guard(fn () => $this->expire($id)) ? 1 : 0;
        }
        $finished = 0;
        foreach (GameMatch::where('status', MatchStatus::Running->value)->where('ends_at', '<=', $now)->orderBy('ends_at')->limit(100)->pluck('id') as $id) {
            $finished += $this->guard(fn () => $this->finish($id) !== null) ? 1 : 0;
        }
        $auctions = $this->guard(fn () => $this->auctions->settleDue()) ?: 0;
        $this->guard(fn () => $this->offers->settleDue());
        $this->guard(fn () => app(LoanService::class)->chargeDue());
        $this->guard(fn () => app(SprintService::class)->tick());
        $this->guard(fn () => $this->timeNotices());

        return ['expired' => $expired, 'finished' => $finished, 'auctions' => (int) $auctions];
    }

    /**
     * Avisos "Quedan 10 / 5 minutos" en el chat de las salas en juego. Cada uno sale una sola vez por partida (clave de evento
     * única en la base, aunque corran a la vez `juego:reloj` y `matches:tick`) y solo dentro de una ventana de 2 minutos: si el
     * reloj estuvo caído y se retoma tarde, no se avisa algo que ya pasó. Una partida más corta que el aviso no lo recibe.
     */
    public function timeNotices(): void
    {
        $steps = array_map('intval', (array) config('formosa.chat.time_notices_minutes'));
        if ($steps === []) {
            return;
        }
        $now = now();
        $horizon = $now->copy()->addMinutes(max($steps))->toDateTimeString();
        $matches = GameMatch::where('status', MatchStatus::Running->value)->where('ends_at', '>', $now->toDateTimeString())->where('ends_at', '<=', $horizon)->get();
        foreach ($matches as $m) {
            $left = $m->ends_at->getTimestamp() - $now->getTimestamp();
            foreach ($steps as $minutes) {
                if ($m->duration_minutes > $minutes && $left <= $minutes * 60 && $left > max(0, $minutes - 2) * 60) {
                    RoomNotices::timeLeft($m->id, $minutes);
                }
            }
        }
    }

    // ------------------------------------------------------------------ lectura

    /** La partida activa del jugador (sala o en juego), o null. Aplica los vencimientos pendientes (sala vencida, partida terminada). */
    public function current(User $user): ?GameMatch
    {
        $row = MatchPlayer::where('user_id', $user->id)->whereNotNull('active_user_id')->first(['match_id']);
        if (! $row) {
            return null;
        }

        return $this->fresh($row->match_id);
    }

    /** Lee una partida aplicando los vencimientos pendientes. Devuelve la partida actualizada. */
    public function fresh(int $matchId): ?GameMatch
    {
        $match = GameMatch::find($matchId);
        if (! $match) {
            return null;
        }
        if ($match->status === MatchStatus::Lobby && $match->lobby_expires_at->lessThanOrEqualTo(now())) {
            $this->expire($matchId);
        } elseif ($match->status === MatchStatus::Running && $match->ends_at->lessThanOrEqualTo(now())) {
            $this->finish($matchId);
        } else {
            return $match;
        }

        return GameMatch::find($matchId);
    }

    /**
     * Salas abiertas (públicas, en la sala, sin vencer), las más nuevas primero.
     *
     * @return list<array<string, mixed>>
     */
    public function openRooms(int $limit = 50): array
    {
        $rows = GameMatch::query()->where('status', MatchStatus::Lobby->value)->where('is_public', true)
            ->where('lobby_expires_at', '>', now()->toDateTimeString())
            ->join('users', 'users.id', '=', 'matches.creator_id')
            ->orderByDesc('matches.id')->limit($limit)
            ->get(['matches.*', 'users.name as creator_name']);
        $counts = MatchPlayer::whereIn('match_id', $rows->pluck('id'))->whereNull('left_at')->groupBy('match_id')
            ->selectRaw('match_id, COUNT(*) AS n')->pluck('n', 'match_id');

        return $rows->map(fn (GameMatch $m) => $m->toPublic((int) ($counts[$m->id] ?? 0)) + ['creator' => $m->creator_name])->all();
    }

    /**
     * Estado completo de la partida para el jugador: partida y reloj, lo suyo y los demás jugadores.
     *
     * @return array<string, mixed>
     *
     * @throws GameException
     */
    public function state(User $user, GameMatch $match): array
    {
        $isPlayer = MatchPlayer::where('match_id', $match->id)->where('user_id', $user->id)->exists();
        if (! $isPlayer) {
            throw GameException::notInMatch();
        }

        if ($match->status === MatchStatus::Lobby) {
            $players = MatchPlayer::where('match_id', $match->id)->join('users', 'users.id', '=', 'match_players.user_id')
                ->orderBy('match_players.id')->get(['users.id as user_id', 'users.name', 'match_players.joined_at'])
                ->map(fn ($p) => ['user_id' => (int) $p->user_id, 'name' => $p->name, 'is_creator' => (int) $p->user_id === $match->creator_id, 'joined_at' => Carbon::parse($p->joined_at)->getTimestampMs()])->all();

            return ['match' => $match->toPublic(count($players)), 'me' => null, 'players' => $players, 'owners_version' => OwnersVersion::current($match->id)];
        }

        $standings = $this->economy->standings($match);
        $players = array_map(fn ($r) => [
            'user_id' => $r['user_id'], 'name' => $r['name'], 'properties' => $r['properties'], 'net_worth' => $r['net_worth'],
            'income_per_day' => $r['income_per_day'], 'rank' => $r['rank'], 'abandoned' => $r['abandoned'], 'is_creator' => $r['user_id'] === $match->creator_id,
        ], $standings);

        $me = $this->economy->snapshot($user, $match);

        return [
            'match' => $match->toPublic(count($players)),
            'me' => $me,
            'players' => $players,
            'owners_version' => OwnersVersion::current($match->id),
        ];
    }

    /**
     * Resultado de una partida terminada: puestos, patrimonio y puntos de cada jugador.
     *
     * @return array<string, mixed>
     *
     * @throws GameException
     */
    public function result(GameMatch $match): array
    {
        if ($match->status !== MatchStatus::Finished) {
            throw GameException::matchNotFinished();
        }
        $players = MatchPlayer::where('match_id', $match->id)->join('users', 'users.id', '=', 'match_players.user_id')
            ->orderBy('match_players.final_rank')->orderByDesc('match_players.final_net_worth')->orderBy('match_players.user_id')
            ->get(['users.id as user_id', 'users.name', 'match_players.final_rank', 'match_players.final_net_worth', 'match_players.final_properties', 'match_players.points_awarded', 'match_players.abandoned'])
            ->map(fn ($p) => [
                'rank' => (int) $p->final_rank, 'user_id' => (int) $p->user_id, 'name' => $p->name, 'net_worth' => (int) $p->final_net_worth,
                'properties' => (int) $p->final_properties, 'points' => (int) $p->points_awarded, 'abandoned' => (bool) $p->abandoned,
            ])->all();

        return ['match' => $match->toPublic(count($players)), 'players' => $players];
    }

    /**
     * Partidas terminadas del jugador, la más reciente primero.
     *
     * @return list<array<string, mixed>>
     */
    public function history(User $user): array
    {
        $limit = (int) config('formosa.match.history');
        $rows = MatchPlayer::where('match_players.user_id', $user->id)->join('matches', 'matches.id', '=', 'match_players.match_id')
            ->where('matches.status', MatchStatus::Finished->value)
            ->orderByDesc('matches.finished_at')->orderByDesc('matches.id')->limit($limit)
            ->get(['matches.id', 'matches.code', 'matches.name', 'matches.finished_at', 'match_players.final_rank', 'match_players.final_net_worth', 'match_players.final_properties', 'match_players.points_awarded', 'match_players.abandoned']);
        $counts = MatchPlayer::whereIn('match_id', $rows->pluck('id'))->groupBy('match_id')->selectRaw('match_id, COUNT(*) AS n')->pluck('n', 'match_id');

        return $rows->map(fn ($r) => [
            'match_id' => (int) $r->id, 'code' => $r->code, 'name' => $r->name, 'finished_at' => Carbon::parse($r->finished_at)->getTimestampMs(),
            'players' => (int) ($counts[$r->id] ?? 0), 'rank' => (int) $r->final_rank, 'net_worth' => (int) $r->final_net_worth,
            'properties' => (int) $r->final_properties, 'points' => (int) $r->points_awarded, 'abandoned' => (bool) $r->abandoned,
        ])->all();
    }

    // ------------------------------------------------------------------ internos

    /** @throws GameException si el jugador ya está en una partida activa (aplicando los vencimientos pendientes antes) */
    private function assertFree(User $user): void
    {
        if (($active = $this->current($user)) !== null) {
            throw GameException::alreadyInMatch($active->id);
        }
    }

    private function addPlayer(int $matchId, int $userId, CarbonInterface $now): void
    {
        MatchPlayer::forceCreate([
            'match_id' => $matchId, 'user_id' => $userId, 'active_user_id' => $userId, 'joined_at' => $now->toDateTimeString(),
        ]);
    }

    /** Vence la sala (ya bloqueada) y libera a sus jugadores para que puedan entrar a otra. */
    private function expireLocked(GameMatch $match): void
    {
        $stamp = now()->toDateTimeString();
        DB::table('matches')->where('id', $match->id)->update(['status' => MatchStatus::Expired->value, 'updated_at' => $stamp]);
        DB::table('match_players')->where('match_id', $match->id)->update(['active_user_id' => null, 'updated_at' => $stamp]);
    }

    private function newCode(): string
    {
        $alphabet = self::CODE_ALPHABET;
        $code = '';
        for ($i = 0; $i < 6; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return $code;
    }

    /** Un problema en una partida no frena a las demás: se registra y se reintenta en la próxima pasada. */
    private function guard(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (\Throwable $e) {
            report($e);

            return false;
        }
    }
}
