<?php

namespace App\Economy;

use App\Enums\LedgerType;
use App\Models\Auction;
use App\Models\LedgerEntry;
use App\Models\Offer;
use App\Models\Property;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Mejora una propiedad propia (nivel 0 -> 1 -> 2 con rama). Reglas de precio e ingreso: ver Upgrades.
 * Bloqueos en el mismo orden que EconomyService::sell: partida (compartida) -> propiedad -> jugador. Todo en una transacción.
 * Idempotente por `Idempotency-Key` (la repetición devuelve lo mismo sin cobrar) y, sin clave, por el propio estado:
 * solo se sube al nivel siguiente, así un doble clic no cobra dos veces.
 */
class UpgradeService
{
    public function __construct(private readonly EconomyService $economy) {}

    /**
     * @return array{property_id: int, level: int, branch: ?string, cost: int, balance: int, collected: int, income_per_day: int, replayed: bool}
     *
     * @throws GameException
     */
    public function upgrade(User $user, int $matchId, int $propertyId, int $toLevel, ?string $branch, ?string $idempotencyKey = null): array
    {
        if ($idempotencyKey !== null && ($replay = $this->replay($matchId, $user, $idempotencyKey, $propertyId))) {
            return $replay;
        }

        try {
            return DB::transaction(fn () => $this->apply($user, $matchId, $propertyId, $toLevel, $branch, $idempotencyKey), attempts: 3);
        } catch (QueryException $e) {
            // Dos pedidos con la misma clave a la vez: el índice único frenó al segundo, que recibe el resultado del primero.
            if ($idempotencyKey !== null && ($replay = $this->replay($matchId, $user, $idempotencyKey, $propertyId))) {
                return $replay;
            }
            throw $idempotencyKey !== null ? GameException::keyReused() : $e;
        }
    }

    private function apply(User $user, int $matchId, int $propertyId, int $toLevel, ?string $branch, ?string $key): array
    {
        $match = $this->economy->liveMatch($matchId);
        $property = Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
        $row = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->lockForUpdate()->first();
        if ($row === null || (int) $row->owner_id !== $user->id) {
            throw GameException::notYours();
        }
        if (Auction::where('match_id', $matchId)->where('active_property_id', $propertyId)->exists()) {
            throw GameException::busyForUpgrade(offer: false);
        }
        if (Offer::where('match_id', $matchId)->where('active_property_id', $propertyId)->exists()) {
            throw GameException::busyForUpgrade(offer: true);
        }
        if ($toLevel !== (int) $row->level + 1) {
            throw GameException::upgradeUnavailable();
        }
        if ($toLevel === 1 ? $branch !== null : ! in_array($branch, ['a', 'b'], true)) {
            throw GameException::invalidBranch();
        }

        $player = $this->economy->lockPlayer($matchId, $user->id);
        $collected = $this->economy->settleIncome($match, $player);
        $owned = DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')
            ->where('mp.match_id', $matchId)->where('mp.owner_id', $user->id)->get(['p.kind', 'mp.level', 'mp.branch'])
            ->map(fn ($r) => ['kind' => $r->kind, 'level' => (int) $r->level, 'branch' => $r->branch])->all();
        $cost = Upgrades::cost((int) $property->price, $toLevel, $branch, Upgrades::hasDiscount($owned));
        if ($player->available() < $cost) {
            throw GameException::insufficientFunds($cost, $player->available());
        }

        $cash = $player->cash - $cost;
        $now = now()->toDateTimeString();
        DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => $now]);
        DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)
            ->update(['level' => $toLevel, 'branch' => $branch, 'upgrade_paid' => (int) $row->upgrade_paid + $cost]);
        LedgerEntry::forceCreate([
            'match_id' => $matchId, 'user_id' => $user->id, 'type' => LedgerType::Mejora, 'amount' => -$cost, 'balance_after' => $cash,
            'property_id' => $propertyId, 'idempotency_key' => $key,
        ]);

        return [
            'property_id' => $propertyId, 'level' => $toLevel, 'branch' => $branch, 'cost' => $cost, 'balance' => $cash, 'collected' => $collected,
            'income_per_day' => $this->economy->incomePerDay($matchId, $user->id), 'replayed' => false,
        ];
    }

    /** Si esta clave ya hizo una mejora, devuelve lo que pasó (sin volver a cobrar). @throws GameException si la clave es de otra propiedad */
    private function replay(int $matchId, User $user, string $key, int $propertyId): ?array
    {
        $entry = LedgerEntry::where('match_id', $matchId)->where('user_id', $user->id)->where('idempotency_key', $key)->where('type', LedgerType::Mejora)->first();
        if (! $entry) {
            return null;
        }
        if ((int) $entry->property_id !== $propertyId) {
            throw GameException::keyReused();
        }
        $row = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->first();

        return [
            'property_id' => $propertyId, 'level' => (int) ($row->level ?? 0), 'branch' => $row->branch ?? null, 'cost' => abs((int) $entry->amount),
            'balance' => (int) DB::table('match_players')->where('match_id', $matchId)->where('user_id', $user->id)->value('cash'),
            'collected' => 0, 'income_per_day' => $this->economy->incomePerDay($matchId, $user->id), 'replayed' => true,
        ];
    }
}
