<?php

namespace App\Formosa;

use App\Enums\PropertyKind;

/** Precio e ingreso base de una propiedad según su tipo y superficie. Todo en pesos enteros. */
final class Pricing
{
    /** @return array{price: int, income: int} */
    public static function for(PropertyKind $kind, ?float $areaM2): array
    {
        $cfg = config("formosa.kinds.{$kind->value}");
        $limits = config('formosa.area_factor');
        $step = max(1, (int) config('formosa.price_step'));

        $factor = 1.0;
        if ($areaM2 !== null && $areaM2 > 0) {
            $factor = min($limits['max'], max($limits['min'], $areaM2 / $cfg['typical_area']));
        }

        $price = (int) (round($cfg['base_price'] * $factor / $step) * $step);
        $price = max($step, $price); // nunca gratis
        $income = (int) round($price * $cfg['rate_per_day']);

        return ['price' => $price, 'income' => $income];
    }
}
