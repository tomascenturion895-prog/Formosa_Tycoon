<?php

namespace App\Economy;

/**
 * Puestos y puntos de una partida terminada. Reglas puras (sin base de datos), para poder probarlas solas.
 *
 *  - Se ordena por patrimonio (efectivo + precio de lista de las propiedades), de mayor a menor. Solo cuentan quienes terminan.
 *  - Empate: comparten el mismo puesto ("de competición": 1, 1, 3) y reparten los puntos de los puestos que ocupan
 *    (promedio hacia abajo). Ej.: empate en el 1.º con puntos 100 y 60 -> 80 cada uno; el siguiente es 3.º.
 *  - Bonus: `property_bonus` punto(s) por propiedad al final, hasta `property_bonus_cap` propiedades.
 */
final class MatchScoring
{
    /**
     * @param  list<array{user_id: int, net_worth: int, properties: int}>  $finishers
     * @param  array{places: array<int, int>, other: int, property_bonus: int, property_bonus_cap: int}|null  $cfg  por defecto, config('formosa.match.points')
     * @return array<int, array{rank: int, points: int, bonus: int}> por user_id
     */
    public static function score(array $finishers, ?array $cfg = null): array
    {
        $cfg ??= config('formosa.match.points');
        usort($finishers, fn ($a, $b) => ($b['net_worth'] <=> $a['net_worth']) ?: ($a['user_id'] <=> $b['user_id']));

        $out = [];
        $n = count($finishers);
        for ($i = 0; $i < $n;) {
            $j = $i;
            while ($j + 1 < $n && $finishers[$j + 1]['net_worth'] === $finishers[$i]['net_worth']) {
                $j++;
            }
            $sum = 0;
            for ($pos = $i + 1; $pos <= $j + 1; $pos++) {
                $sum += $cfg['places'][$pos] ?? $cfg['other'];
            }
            $share = intdiv($sum, $j - $i + 1);
            for ($k = $i; $k <= $j; $k++) {
                $bonus = min($finishers[$k]['properties'], $cfg['property_bonus_cap']) * $cfg['property_bonus'];
                $out[$finishers[$k]['user_id']] = ['rank' => $i + 1, 'points' => $share + $bonus, 'bonus' => $bonus];
            }
            $i = $j + 1;
        }

        return $out;
    }
}
