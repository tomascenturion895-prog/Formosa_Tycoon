<?php

namespace App\Economy;

/** Reglas puras de los préstamos (sin base de datos), para poder probarlas solas. Todo en enteros: nada de decimales. */
final class LoanRules
{
    /** Parte de capital que se devuelve cada día: el capital dividido el plazo, redondeado hacia arriba. */
    public static function dailyPrincipal(int $principal, int $termDays): int
    {
        return max(1, intdiv($principal + max(1, $termDays) - 1, max(1, $termDays)));
    }

    /** Interés de un día sobre el capital pendiente (redondeado hacia arriba, mínimo 1 si hay capital). */
    public static function interest(int $balance, int $ratePct): int
    {
        return $balance <= 0 ? 0 : max(1, intdiv($balance * $ratePct + 99, 100));
    }

    /** Recargo diario por mora sobre lo atrasado (redondeado hacia abajo). */
    public static function surcharge(int $arrears, int $latePct): int
    {
        return intdiv(max(0, $arrears) * max(0, $latePct), 100);
    }

    /** Lo máximo que se puede pedir: un porcentaje del patrimonio YA descontada la deuda (nunca negativo). */
    public static function maxNew(int $netWorth, int $maxSharePct): int
    {
        return max(0, intdiv(max(0, $netWorth) * $maxSharePct, 100));
    }

    /**
     * Qué pasa en UN día de juego. `$day` = número de día del préstamo (1 = el primero). El último día del plazo (y los siguientes)
     * se devuelve todo el capital que quede. `$available` = efectivo libre del jugador. Se cobra en orden: lo atrasado (con su
     * recargo), el interés y el capital; lo que no alcanza queda como mora, y el capital del día sale del saldo aunque no se
     * pague (pasa a mora).
     *
     * @return array{interest: int, principal: int, surcharge: int, due: int, paid: int, paid_interest: int, balance: int, arrears: int}
     */
    public static function day(int $balance, int $arrears, int $dailyPrincipal, int $termDays, int $day, int $ratePct, int $latePct, int $available): array
    {
        $interest = self::interest($balance, $ratePct);
        $principal = $day >= $termDays ? $balance : min($balance, $dailyPrincipal);
        $surcharge = self::surcharge($arrears, $latePct);
        $owedArrears = $arrears + $surcharge;
        $due = $owedArrears + $interest + $principal;
        $paid = max(0, min($available, $due));

        $left = $paid;
        $toArrears = min($left, $owedArrears);
        $left -= $toArrears;
        $toInterest = min($left, $interest);

        return [
            'interest' => $interest, 'principal' => $principal, 'surcharge' => $surcharge, 'due' => $due, 'paid' => $paid,
            'paid_interest' => $toInterest, 'balance' => $balance - $principal, 'arrears' => $due - $paid,
        ];
    }

    /**
     * Pago anticipado: va primero a lo atrasado y después al capital. `$amount` null = todo lo que se pueda (hasta la deuda).
     *
     * @return array{paid: int, balance: int, arrears: int}
     */
    public static function prepay(int $balance, int $arrears, ?int $amount, int $available): array
    {
        $pay = min($available, $arrears + $balance, $amount ?? PHP_INT_MAX);
        $pay = max(0, $pay);
        $toArrears = min($pay, $arrears);

        return ['paid' => $pay, 'balance' => $balance - ($pay - $toArrears), 'arrears' => $arrears - $toArrears];
    }

    /** Número de días de juego completos desde `$takenAt` hasta `$until` (segundos enteros). */
    public static function daysElapsed(int $secondsSinceTaken, int $secondsPerDay): int
    {
        return max(0, intdiv(max(0, $secondsSinceTaken), max(1, $secondsPerDay)));
    }
}
