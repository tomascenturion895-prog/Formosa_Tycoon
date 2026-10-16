<?php

namespace App\Economy;

use Carbon\CarbonInterface;

/**
 * Ingreso de las propiedades, calculado "perezosamente" y por DÍA DE JUEGO: no hay procesos corriendo de fondo, solo
 * (ingreso por día × días de juego transcurridos). Un día de juego dura `secondsPerDay` segundos reales.
 *
 * Aritmética entera y EXACTA: lo que no completa un peso se guarda como `carry` (pesos-segundo, siempre < secondsPerDay) y se
 * suma en la próxima liquidación. Así liquidar muchas veces da el mismo total que liquidar una sola vez, y repetir la
 * liquidación en el mismo instante no paga nada de más (idempotente).
 */
final class Accrual
{
    /**
     * @return array{amount: int, carry: int} pesos a acreditar y resto a guardar
     */
    public static function settle(int $incomePerDay, int $carry, int $seconds, int $secondsPerDay): array
    {
        $seconds = max(0, $seconds);
        $secondsPerDay = max(1, $secondsPerDay);
        $total = $carry + $incomePerDay * $seconds;

        return ['amount' => intdiv($total, $secondsPerDay), 'carry' => $total % $secondsPerDay];
    }

    /** Segundos enteros entre dos instantes (nunca negativos: un reloj raro no resta plata). */
    public static function seconds(?CarbonInterface $since, CarbonInterface $until): int
    {
        if ($since === null) {
            return 0;
        }

        return (int) max(0, $since->diffInSeconds($until, false));
    }
}
