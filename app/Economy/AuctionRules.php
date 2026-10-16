<?php

namespace App\Economy;

use Carbon\CarbonInterface;

/** Reglas puras de la subasta (sin base de datos), para poder probarlas solas. Todo en enteros: nada de decimales. */
final class AuctionRules
{
    /** @return array{0: int, 1: int} [porcentaje mínimo, piso en pesos] tomados de la configuración. */
    public static function configured(): array
    {
        return [(int) config('formosa.auction.min_increment_pct'), (int) config('formosa.auction.min_increment')];
    }

    /** Cuánto hay que subir como mínimo sobre la puja actual: el mayor entre el piso y el porcentaje (redondeado hacia arriba). */
    public static function minIncrement(int $current, int $pct, int $floor): int
    {
        return max($floor, intdiv($current * $pct + 99, 100));
    }

    public static function minNextBid(int $current, int $pct, int $floor): int
    {
        return $current + self::minIncrement($current, $pct, $floor);
    }

    /**
     * Anti-francotirador: una puja en los últimos `window` segundos empuja el cierre a `now + extend`,
     * hasta `maxExtensions` veces. Devuelve el nuevo cierre, o null si no corresponde extender.
     */
    public static function extendedEnd(CarbonInterface $endsAt, CarbonInterface $now, int $extensions, int $window, int $extend, int $maxExtensions): ?CarbonInterface
    {
        if ($extensions >= $maxExtensions || $now->greaterThanOrEqualTo($endsAt)) {
            return null;
        }
        if ($now->diffInSeconds($endsAt, true) > $window) {
            return null;
        }
        $candidate = $now->copy()->addSeconds($extend);

        return $candidate->greaterThan($endsAt) ? $candidate : null;
    }

    /**
     * Lo mínimo que hay que ofertar ahora en una oferta entre jugadores: el piso del dueño si todavía no hay ninguna, o la actual
     * más el incremento. Nunca más que el "comprá ya" (ofertar eso o más cierra la venta al precio de "comprá ya").
     */
    public static function offerMinNext(?int $current, int $minPrice, int $buyNow): int
    {
        $next = $current === null ? $minPrice : self::minNextBid($current, ...self::configured());

        return min($next, $buyNow);
    }

    /** Lo que se queda el banco de una venta entre jugadores (porcentaje entero, redondeado hacia abajo) y lo que cobra el dueño. @return array{fee: int, net: int} */
    public static function offerSplit(int $price, int $feePct): array
    {
        $fee = intdiv($price * max(0, $feePct), 100);

        return ['fee' => $fee, 'net' => $price - $fee];
    }

    /** Precio con `$pct` % de descuento (entero, al menos 1). */
    public static function discounted(int $price, int $pct): int
    {
        return $pct <= 0 ? $price : max(1, intdiv($price * (100 - min(100, $pct)), 100));
    }
}
