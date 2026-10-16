<?php

namespace App\Economy;

use App\Enums\LedgerType;
use App\Enums\MatchStatus;
use App\Models\Auction;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\Offer;
use App\Models\Property;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Único lugar (junto con AuctionService y MatchService) que mueve dinero o cambia dueños. Todo es DE UNA PARTIDA. Reglas:
 *  - Todo en una transacción; los bloqueos se toman siempre en el mismo orden: partida (compartido) -> propiedad -> jugadores
 *    (por id). Así dos operaciones nunca se esperan en círculo (deadlock), y cerrar la partida (que toma la partida en
 *    exclusiva) nunca se cruza con una compra a medias.
 *  - Cada cambio de dinero escribe un movimiento en el libro; dinero del jugador en la partida = suma de sus movimientos.
 *  - El ingreso es AUTOMÁTICO y se liquida de forma perezosa: antes de cualquier cambio de dinero o de propiedades se acredita
 *    ingreso x días de juego transcurridos desde `last_settled_at` (ver Accrual). No hay botón de cobro ni tope de acumulación.
 *  - El evento en tiempo real sale DESPUÉS de confirmar y, si Reverb está caído, no rompe la operación.
 */
class EconomyService
{
    // ------------------------------------------------------------------ bloqueos y liquidación

    /**
     * La partida en juego, con bloqueo COMPARTIDO (lo primero que toma toda operación de juego).
     *
     * @throws GameException si no existe o no está en juego (o ya pasó su hora de cierre)
     */
    public function liveMatch(int $matchId, ?CarbonInterface $now = null): GameMatch
    {
        $match = GameMatch::query()->sharedLock()->find($matchId) ?? throw GameException::matchNotFound();
        if (! $match->isLive($now ?? now())) {
            throw GameException::matchNotRunning();
        }

        return $match;
    }

    /** El jugador (que no se fue de la partida), bloqueado para escribir. @throws GameException */
    public function lockPlayer(int $matchId, int $userId): MatchPlayer
    {
        return MatchPlayer::query()->where('match_id', $matchId)->where('user_id', $userId)->whereNull('left_at')->lockForUpdate()->first()
            ?? throw GameException::notInMatch();
    }

    /**
     * Acredita el ingreso de todas las propiedades del jugador desde su última liquidación hasta `$now` (nunca más allá de la
     * hora de cierre de la partida) y deja el reloj de liquidación al día. `$player` tiene que estar bloqueado. Idempotente:
     * repetirla en el mismo instante no paga nada. Devuelve lo acreditado y actualiza `$player` en memoria.
     */
    public function settleIncome(GameMatch $match, MatchPlayer $player, ?CarbonInterface $now = null): int
    {
        $until = $this->settleUntil($match, $now ?? now());
        $since = $player->last_settled_at ?? $match->started_at;
        $seconds = Accrual::seconds($since, $until);
        if ($seconds <= 0) {
            return 0;
        }

        ['amount' => $amount, 'carry' => $carry] = $this->accrue($match, $this->ownedRows($match->id, $player->user_id), $player->income_carry, $since, $until);

        $cash = $player->cash + $amount;
        DB::table('match_players')->where('id', $player->id)->update([
            'cash' => $cash, 'income_carry' => $carry, 'last_settled_at' => $until->toDateTimeString(), 'updated_at' => $until->toDateTimeString(),
        ]);
        if ($amount > 0) {
            LedgerEntry::forceCreate([
                'match_id' => $match->id, 'user_id' => $player->user_id, 'type' => LedgerType::Cobro, 'amount' => $amount, 'balance_after' => $cash,
            ]);
        }
        $player->forceFill(['cash' => $cash, 'income_carry' => $carry, 'last_settled_at' => $until])->syncOriginal();
        // Banco: las cuotas de los días de juego que pasaron se cobran acá, con el ingreso ya acreditado y el jugador bloqueado.
        app(LoanService::class)->charge($match, $player, $until);

        return $amount;
    }

    /** Acredita el ingreso pendiente de CADA jugador que tiene esta propiedad en una partida en juego (antes de cambiarle el ingreso). */
    public function settleOwnersOf(int $propertyId): int
    {
        return DB::transaction(function () use ($propertyId) {
            $rows = DB::table('match_properties as mp')->join('matches as m', 'm.id', '=', 'mp.match_id')
                ->where('mp.property_id', $propertyId)->where('m.status', MatchStatus::Running->value)
                ->orderBy('mp.match_id')->orderBy('mp.owner_id')->get(['mp.match_id', 'mp.owner_id']);
            $total = 0;
            foreach ($rows as $r) {
                $match = GameMatch::query()->sharedLock()->find($r->match_id);
                $player = MatchPlayer::query()->where('match_id', $r->match_id)->where('user_id', $r->owner_id)->whereNull('left_at')->lockForUpdate()->first();
                if ($match && $player) {
                    $total += $this->settleIncome($match, $player);
                }
            }

            return $total;
        }, attempts: 3);
    }

    /** Hasta cuándo cuenta el ingreso: ahora, pero nunca después del cierre, y en segundos enteros (la base no guarda fracciones). */
    private function settleUntil(GameMatch $match, CarbonInterface $now): CarbonInterface
    {
        $until = $match->ends_at !== null && $now->greaterThan($match->ends_at) ? $match->ends_at : $now;

        return $until->copy()->startOfSecond();
    }

    /** Ingreso por día de juego de lo que el jugador tiene en la partida AHORA: propiedades, eventos activos y combos. */
    public function incomePerDay(int $matchId, int $userId): int
    {
        return $this->combos(GameMatch::findOrFail($matchId), $userId)['total'];
    }

    /**
     * Ingreso base, bonus y combos activos de un jugador en el instante `$ts` (por defecto ahora). Los eventos de la partida se aplican
     * primero a cada propiedad según su tipo y los combos se calculan sobre eso (ver Combos y MatchEvents).
     *
     * @return array{base: int, bonus: int, total: int, zones: list<array<string, mixed>>, variety: bool, variety_bonus: int}
     */
    public function combos(GameMatch $match, int $userId, ?int $ts = null): array
    {
        return $this->evaluateAt($match, $this->ownedRows($match->id, $userId), $ts ?? now()->getTimestamp());
    }

    /**
     * Lo que tiene un jugador, con `base` = ingreso por día de lista y su mejora (la fila final de ingreso la arma evaluateAt).
     *
     * @return list<array{id: int, kind: string, lat: float, lng: float, base: int, price: int, level: int, branch: ?string, upgrade_paid: int}>
     */
    private function ownedRows(int $matchId, int $userId): array
    {
        return DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')
            ->where('mp.match_id', $matchId)->where('mp.owner_id', $userId)
            ->get(['p.id', 'p.kind', 'p.lat', 'p.lng', 'p.price', 'p.income_per_day', 'mp.level', 'mp.branch', 'mp.upgrade_paid'])
            ->map(fn ($r) => $this->ownedRow($r))->all();
    }

    private function ownedRow(object $r): array
    {
        return [
            'id' => (int) $r->id, 'kind' => $r->kind, 'lat' => (float) $r->lat, 'lng' => (float) $r->lng, 'base' => (int) $r->income_per_day,
            'price' => (int) $r->price, 'level' => (int) $r->level, 'branch' => $r->branch, 'upgrade_paid' => (int) $r->upgrade_paid,
        ];
    }

    /**
     * Combos del jugador en `$ts`. Cada fila rinde su ingreso de lista por el multiplicador de los eventos activos, mejorada y neta de
     * mantenimiento (ver Upgrades::rowIncome), y los combos se calculan sobre eso.
     */
    private function evaluateAt(GameMatch $match, array $rows, int $ts, ?array $schedule = null): array
    {
        $active = MatchEvents::active($schedule ?? MatchEvents::forMatch($match), $ts);
        $rows = array_map(function ($r) use ($active) {
            $factor = $active === [] ? 1.0 : MatchEvents::factor($active, $r['kind'], Combos::zoneKey($r['lat'], $r['lng']));

            return [
                'income' => Upgrades::rowIncome($r['kind'], $r['base'], $r['level'], $r['branch'], $factor),
                'weight' => Upgrades::zoneWeight($r['kind'], $r['level'], $r['branch']),
            ] + $r;
        }, $rows);

        return Combos::evaluate($rows);
    }

    /**
     * Pesos que rinden `$rows` entre `$since` y `$until` y resto a guardar. Parte el tiempo donde empieza o termina un evento
     * (el ingreso por día cambia ahí), y arrastra el resto entre tramos: liquidar de a poco da lo mismo que liquidar de una vez.
     *
     * @return array{amount: int, carry: int}
     */
    private function accrue(GameMatch $match, array $rows, int $carry, CarbonInterface $since, CarbonInterface $until): array
    {
        $from = $since->getTimestamp();
        $to = $until->getTimestamp();
        $schedule = MatchEvents::forMatch($match);
        $cuts = [$from, ...MatchEvents::boundaries($schedule, $from, $to), max($from, $to)];

        $amount = 0;
        for ($i = 0; $i < count($cuts) - 1; $i++) {
            $rate = $this->evaluateAt($match, $rows, $cuts[$i], $schedule)['total'];
            $r = Accrual::settle($rate, $carry, $cuts[$i + 1] - $cuts[$i], $match->secondsPerDay());
            $amount += $r['amount'];
            $carry = $r['carry'];
        }

        return ['amount' => $amount, 'carry' => $carry];
    }

    // ------------------------------------------------------------------ compra y venta

    /**
     * Compra directa de una propiedad libre. Si dos jugadores la piden a la vez, gana el que toma primero el
     * bloqueo y el otro recibe GameException::taken() (con la subasta activa, el choque se resuelve antes, en AuctionService).
     *
     * @throws GameException
     */
    public function buy(User $user, int $matchId, int $propertyId, ?string $idempotencyKey = null): PurchaseResult
    {
        if ($idempotencyKey !== null && ($replay = $this->replay($matchId, $user, $idempotencyKey, LedgerType::Compra, $propertyId))) {
            return $replay;
        }

        try {
            $result = DB::transaction(function () use ($user, $matchId, $propertyId, $idempotencyKey) {
                $match = $this->liveMatch($matchId);
                $property = Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
                $owner = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->value('owner_id');
                if ($owner !== null) {
                    throw GameException::taken((int) $owner === $user->id);
                }
                // Una propiedad en disputa o subasta solo se obtiene por AuctionService: la compra directa no puede saltearla.
                if (Auction::where('match_id', $matchId)->where('active_property_id', $property->id)->exists()) {
                    throw GameException::inAuction();
                }

                $player = $this->lockPlayer($matchId, $user->id);
                $this->settleIncome($match, $player);
                $price = app(SprintService::class)->price($match, $user->id, (int) $property->price); // remontada del sprint final
                if ($player->available() < $price) {
                    throw GameException::insufficientFunds($price, $player->available());
                }

                $cash = $player->cash - $price;
                $now = now()->toDateTimeString();
                DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => $now]);
                // No se toca updated_at de la propiedad: el ETag de la geometría del mapa depende de él y solo debe cambiar al re-importar.
                DB::table('match_properties')->insert([
                    'match_id' => $matchId, 'property_id' => $property->id, 'owner_id' => $user->id, 'bought_at' => $now, 'price_paid' => $price,
                ]);
                LedgerEntry::forceCreate([
                    'match_id' => $matchId, 'user_id' => $user->id, 'type' => LedgerType::Compra, 'amount' => -$price,
                    'balance_after' => $cash, 'property_id' => $property->id, 'idempotency_key' => $idempotencyKey,
                ]);

                return new PurchaseResult($property->id, $price, $cash);
            }, attempts: 3);
        } catch (QueryException|GameException $e) {
            // Reintentos simultáneos con la misma clave: el que llegó segundo ve la propiedad ya suya (o el índice único
            // lo frena). No es un error: se le devuelve el mismo resultado que al primero.
            $sameBuyer = $e instanceof QueryException || $e->errorCode === 'ya_es_tuya';
            if ($sameBuyer && $idempotencyKey !== null && ($replay = $this->replay($matchId, $user, $idempotencyKey, LedgerType::Compra, $propertyId))) {
                return $replay;
            }
            if ($e instanceof QueryException) {
                throw GameException::taken(false); // la clave primaria (partida, propiedad) frenó una compra simultánea de otro jugador
            }
            throw $e;
        }

        Announcer::owner($matchId, $result->propertyId, $user->id, $user->name);
        RoomNotices::purchase($matchId, $user->name, $result->propertyId, $result->price, actorId: $user->id);

        return $result;
    }

    /**
     * Vende una propiedad propia al banco por una fracción de su precio de lista. Antes se acredita el ingreso pendiente
     * (así vender nunca hace perder ingresos ya ganados). La propiedad queda libre para cualquiera EN ESA PARTIDA.
     *
     * @return array{property_id: int, refund: int, collected: int, balance: int, replayed: bool}
     *
     * @throws GameException
     */
    public function sell(User $user, int $matchId, int $propertyId, ?string $idempotencyKey = null): array
    {
        if ($idempotencyKey !== null) {
            $prior = LedgerEntry::where('match_id', $matchId)->where('user_id', $user->id)->where('idempotency_key', $idempotencyKey)->where('type', LedgerType::Venta)->first();
            if ($prior) {
                if ((int) $prior->property_id !== $propertyId) {
                    throw GameException::keyReused();
                }

                return ['property_id' => $propertyId, 'refund' => (int) $prior->amount, 'collected' => 0, 'balance' => $this->cashOf($matchId, $user->id), 'replayed' => true];
            }
        }
        $ratio = (float) config('formosa.economy.sell_ratio');

        $result = DB::transaction(function () use ($user, $matchId, $propertyId, $idempotencyKey, $ratio) {
            $match = $this->liveMatch($matchId);
            $property = Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
            $owner = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->value('owner_id');
            if ($owner === null || (int) $owner !== $user->id) {
                throw GameException::notYours();
            }
            if (Auction::where('match_id', $matchId)->where('active_property_id', $property->id)->exists()) {
                throw GameException::inAuction();
            }
            // En oferta entre jugadores: hay que retirarla antes (si no, el banco le compraría algo que ya está prometido).
            if (Offer::where('match_id', $matchId)->where('active_property_id', $property->id)->exists()) {
                throw GameException::inOffer();
            }

            $player = $this->lockPlayer($matchId, $user->id);
            $collected = $this->settleIncome($match, $player);

            $refund = max(1, intdiv($property->price * (int) round($ratio * 1000), 1000));
            $cash = $player->cash + $refund;
            DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => now()->toDateTimeString()]);
            DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $property->id)->delete();
            LedgerEntry::forceCreate([
                'match_id' => $matchId, 'user_id' => $user->id, 'type' => LedgerType::Venta, 'amount' => $refund, 'balance_after' => $cash,
                'property_id' => $property->id, 'idempotency_key' => $idempotencyKey,
            ]);

            return ['property_id' => $property->id, 'refund' => $refund, 'collected' => $collected, 'balance' => $cash, 'replayed' => false];
        }, attempts: 3);

        Announcer::owner($matchId, $propertyId, null, null);
        RoomNotices::sale($matchId, $user->name, $propertyId, $result['refund'], actorId: $user->id);

        return $result;
    }

    // ------------------------------------------------------------------ lectura (nunca escribe)

    /**
     * Posiciones de TODOS los jugadores de la partida, ordenadas por patrimonio (efectivo + precio de lista de sus propiedades - deuda con el banco).
     * Es una lectura: el ingreso pendiente se suma en memoria, sin liquidar. Los que abandonaron van al final y sin puesto.
     *
     * @return list<array{user_id: int, name: string, cash: int, reserved: int, debt: int, properties: int, assets: int, net_worth: int, income_per_day: int, abandoned: bool, rank: int|null}>
     */
    public function standings(GameMatch $match, ?CarbonInterface $now = null): array
    {
        $now ??= now();
        $players = MatchPlayer::query()->where('match_id', $match->id)->join('users', 'users.id', '=', 'match_players.user_id')
            ->get(['match_players.*', 'users.name as user_name']);
        // Una sola lectura de todo lo que tiene cada uno; el ingreso incluye los combos (se calcula en memoria).
        $owned = DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')->where('mp.match_id', $match->id)
            ->get(['mp.owner_id', 'p.id', 'p.kind', 'p.lat', 'p.lng', 'p.price', 'p.income_per_day', 'mp.level', 'mp.branch', 'mp.upgrade_paid'])->groupBy('owner_id');

        $running = $match->status === MatchStatus::Running;
        $until = $running ? $this->settleUntil($match, $now) : null;
        $schedule = MatchEvents::forMatch($match);
        $debts = app(LoanService::class)->debtsByUser($match->id);

        $rows = [];
        foreach ($players as $p) {
            $mine = $owned->get($p->user_id, collect());
            $ownedRows = $mine->map(fn ($r) => $this->ownedRow($r))->all();
            $income = $this->evaluateAt($match, $ownedRows, ($until ?? $now)->getTimestamp(), $schedule)['total'];
            $cash = $p->cash;
            if ($running && $p->left_at === null) {
                $cash += $this->accrue($match, $ownedRows, $p->income_carry, $p->last_settled_at ?? $match->started_at, $until)['amount'];
            }
            $assets = (int) $mine->sum(fn ($r) => Upgrades::assetValue((int) $r->price, (int) $r->upgrade_paid));
            $debt = $debts[$p->user_id] ?? 0;
            $rows[] = [
                'user_id' => (int) $p->user_id, 'name' => $p->user_name, 'cash' => $cash, 'reserved' => $p->reserved, 'debt' => $debt,
                'properties' => $mine->count(), 'assets' => $assets, 'net_worth' => $cash + $assets - $debt, 'income_per_day' => $income,
                'abandoned' => $p->abandoned, 'rank' => null,
            ];
        }
        usort($rows, fn ($x, $y) => ($x['abandoned'] <=> $y['abandoned']) ?: ($y['net_worth'] <=> $x['net_worth']) ?: ($x['user_id'] <=> $y['user_id']));
        foreach ($rows as $i => &$r) {
            if (! $r['abandoned']) {
                // Puesto "de competición": los empatados comparten número y el siguiente se salta (1, 1, 3).
                $r['rank'] = $i > 0 && $rows[$i - 1]['net_worth'] === $r['net_worth'] && ! $rows[$i - 1]['abandoned'] ? $rows[$i - 1]['rank'] : $i + 1;
            }
        }
        unset($r);

        return $rows;
    }

    /**
     * Estado propio del jugador en la partida, para pantalla. Es una lectura: el ingreso pendiente se suma en memoria.
     *
     * @return array<string, mixed>
     *
     * @throws GameException si no juega esta partida
     */
    public function snapshot(User $user, GameMatch $match, ?CarbonInterface $now = null): array
    {
        $standings = $this->standings($match, $now);
        $mine = collect($standings)->firstWhere('user_id', $user->id) ?? throw GameException::notInMatch();

        $rows = collect($this->ownedRows($match->id, $user->id));
        $discount = Upgrades::hasDiscount($rows->all());
        $dates = DB::table('match_properties')->where('match_id', $match->id)->where('owner_id', $user->id)->pluck('bought_at', 'property_id');
        $paid = DB::table('match_properties')->where('match_id', $match->id)->where('owner_id', $user->id)->pluck('price_paid', 'property_id');
        $properties = $rows->sortBy('id')->values()->map(fn ($r) => [
            'id' => $r['id'], 'kind' => $r['kind'], 'price' => $r['price'], 'income_per_day' => $r['base'],
            'price_paid' => (int) $paid[$r['id']], 'bought_at' => \Carbon\Carbon::parse($dates[$r['id']])->getTimestampMs(),
            'level' => $r['level'], 'branch' => $r['branch'], 'upgrade_paid' => $r['upgrade_paid'],
            'weight' => Upgrades::zoneWeight($r['kind'], $r['level'], $r['branch']),
            'label' => $r['level'] > 0 ? Upgrades::option($r['kind'], $r['level'], $r['branch'])['label'] : null,
        ] + Upgrades::breakdown($r['kind'], $r['base'], $r['level'], $r['branch']) + [
            'upgrade' => Upgrades::next($r['kind'], $r['level'], $r['branch'], $r['base'], $r['price'], $discount),
        ])->all();

        return [
            'cash' => $mine['cash'],
            'reserved' => $mine['reserved'],
            'debt' => $mine['debt'],
            'comeback_pct' => app(SprintService::class)->discountPct($match, $user->id, $standings),
            'available' => $mine['cash'] - $mine['reserved'],
            'income_per_day' => $mine['income_per_day'],
            'combos' => $this->combos($match, $user->id),
            'assets' => $mine['assets'],
            'net_worth' => $mine['net_worth'],
            'rank' => $mine['rank'],
            'abandoned' => $mine['abandoned'],
            'properties' => $properties,
        ];
    }

    private function cashOf(int $matchId, int $userId): int
    {
        return (int) MatchPlayer::where('match_id', $matchId)->where('user_id', $userId)->value('cash');
    }

    private function replay(int $matchId, User $user, string $key, LedgerType $type, int $propertyId): ?PurchaseResult
    {
        $entry = LedgerEntry::where('match_id', $matchId)->where('user_id', $user->id)->where('idempotency_key', $key)->where('type', $type)->first();
        if (! $entry) {
            return null;
        }
        // Una clave sirve para UNA compra: usarla con otra propiedad es un error, no una repetición.
        if ((int) $entry->property_id !== $propertyId) {
            throw GameException::keyReused();
        }

        return new PurchaseResult((int) $entry->property_id, abs($entry->amount), $this->cashOf($matchId, $user->id), replayed: true);
    }
}
