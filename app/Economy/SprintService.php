<?php

namespace App\Economy;

use App\Enums\MatchStatus;
use App\Models\GameMatch;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Sprint final (los últimos minutos de la partida): ingreso extra (ver MatchEvents::sprint), una subasta relámpago por tramo y
 * descuento para quienes van últimos. Todo se deduce del reloj y de la partida: no hay tablas propias.
 */
class SprintService
{
    public function __construct(private readonly AuctionService $auctions) {}

    /** ¿Está en marcha el sprint de la partida en el instante `$ts` (segundos Unix; por defecto ahora)? */
    public function isOn(GameMatch $match, ?int $ts = null): bool
    {
        $w = $this->window($match);

        return $w !== null && ($ts ??= now()->getTimestamp()) >= $w['start'] && $ts < $w['end'];
    }

    /** @return array{start: int, end: int}|null */
    public function window(GameMatch $match): ?array
    {
        if ($match->started_at === null) {
            return null;
        }
        $s = MatchEvents::sprint($match->started_at->getTimestamp(), $match->duration_minutes * 60);

        return $s ? ['start' => $s['start'], 'end' => $s['end']] : null;
    }

    /** Descuento (en %) de compra que tiene el jugador ahora: 0 fuera del sprint o si no va en el último tercio del ranking. */
    public function discountPct(GameMatch $match, int $userId, ?array $standings = null): int
    {
        $pct = (int) config('formosa.sprint.comeback_pct');
        if ($pct <= 0 || ! $this->isOn($match)) {
            return 0;
        }

        return $this->trailing($match, $userId, $standings) ? $pct : 0;
    }

    /** Precio que paga el jugador por algo que vale `$price` (con el descuento de remontada si le toca). */
    public function price(GameMatch $match, int $userId, int $price): int
    {
        return AuctionRules::discounted($price, $this->discountPct($match, $userId));
    }

    /** ¿Va entre los últimos del ranking (el tercio de abajo, redondeado hacia arriba, con al menos 2 jugadores)? */
    public function trailing(GameMatch $match, int $userId, ?array $standings = null): bool
    {
        $rows = array_values(array_filter($standings ?? app(EconomyService::class)->standings($match), fn ($r) => ! $r['abandoned']));
        $n = count($rows);
        if ($n < 2) {
            return false;
        }
        foreach ($rows as $i => $r) {
            if ($r['user_id'] === $userId) {
                return $i >= $n - (int) ceil($n / 3);
            }
        }

        return false;
    }

    /**
     * Una pasada del reloj: en cada partida con el sprint en marcha abre la subasta relámpago del tramo actual (una sola vez por
     * tramo, aunque corran varios relojes a la vez) mientras dé tiempo a que termine antes del cierre de la partida.
     *
     * @return int subastas relámpago abiertas
     */
    public function tick(): int
    {
        $cfg = config('formosa.sprint');
        if (! ($cfg['enabled'] ?? false)) {
            return 0;
        }
        $now = now();
        $opened = 0;
        $horizon = $now->copy()->addSeconds((int) $cfg['seconds'])->toDateTimeString();
        $matches = GameMatch::where('status', MatchStatus::Running->value)->where('ends_at', '>', $now->toDateTimeString())->where('ends_at', '<=', $horizon)->get();
        foreach ($matches as $m) {
            $w = $this->window($m);
            $ts = $now->getTimestamp();
            if ($w === null || $ts < $w['start'] || $ts + (int) $cfg['flash_seconds'] > $w['end']) {
                continue;
            }
            $slot = intdiv($ts - $w['start'], max(1, (int) $cfg['flash_interval']));
            if (! Cache::add("flash:{$m->id}:{$slot}", 1, 3600)) {
                continue; // este tramo ya tuvo su relámpago
            }
            $id = $this->pick($m, $slot);
            if ($id !== null && $this->auctions->openFlash($m->id, $id) !== null) {
                $opened++;
            }
        }

        return $opened;
    }

    /** Propiedad libre (sin dueño ni subasta en curso) que sale a remate en el tramo `$slot`: siempre la misma para el mismo estado. */
    private function pick(GameMatch $match, int $slot): ?int
    {
        $free = fn () => DB::table('properties as p')
            ->leftJoin('match_properties as mp', fn ($j) => $j->on('mp.property_id', '=', 'p.id')->where('mp.match_id', $match->id))
            ->leftJoin('auctions as a', fn ($j) => $j->on('a.property_id', '=', 'p.id')->where('a.match_id', $match->id)->whereNotNull('a.active_property_id'))
            ->whereNull('mp.owner_id')->whereNull('a.id');
        $count = $free()->count();
        if ($count === 0) {
            return null;
        }
        $offset = crc32("{$match->id}:flash:{$slot}") % $count;
        $id = $free()->orderBy('p.id')->offset($offset)->limit(1)->value('p.id');

        return $id === null ? null : (int) $id;
    }
}
