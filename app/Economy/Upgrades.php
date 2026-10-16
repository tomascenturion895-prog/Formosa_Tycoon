<?php

namespace App\Economy;

use InvalidArgumentException;

/**
 * Reglas de las mejoras de propiedades. Pura (sin base de datos): todo sale de config('formosa.upgrades').
 * Nivel 0 = sin mejora, 1 = "Reformada", 2 = especialización con rama 'a' o 'b' (no se deshace).
 * Ingreso de una fila = bruto (ingreso de lista x (1 + boost) x factor de eventos) - mantenimiento (fijo, sobre el ingreso de lista), mínimo 0.
 */
final class Upgrades
{
    /** @return array{label: string, cost_pct: float, boost: float, maint: float} @throws InvalidArgumentException */
    public static function option(string $kind, int $level, ?string $branch): array
    {
        $cfg = config('formosa.upgrades');
        $labels = $cfg['labels'][$kind] ?? throw new InvalidArgumentException("Tipo desconocido: {$kind}");
        if ($level === 1 && $branch === null) {
            return ['label' => $labels['n1']] + $cfg['levels'][1];
        }
        if ($level === 2 && $branch !== null && isset($cfg['levels'][2][$branch])) {
            return ['label' => $labels[$branch]] + $cfg['levels'][2][$branch];
        }
        throw new InvalidArgumentException("Mejora inexistente: nivel {$level}, rama ".var_export($branch, true));
    }

    /** Ingreso por día de la fila, ya neto del mantenimiento. */
    public static function rowIncome(string $kind, int $base, int $level, ?string $branch, float $eventFactor): int
    {
        if ($level === 0) {
            return (int) floor($base * $eventFactor);
        }
        $o = self::option($kind, $level, $branch);
        $factor = self::dampenFactor($kind, $level, $branch, $eventFactor);
        $gross = (int) floor(floor($base * (1 + $o['boost'])) * $factor);

        return max(0, $gross - (int) floor($base * $o['maint']));
    }

    /** Desglose por día de lista (sin eventos): bruto, mantenimiento y neto. @return array{gross: int, maintenance: int, net: int} */
    public static function breakdown(string $kind, int $base, int $level, ?string $branch): array
    {
        if ($level === 0) {
            return ['gross' => $base, 'maintenance' => 0, 'net' => $base];
        }
        $o = self::option($kind, $level, $branch);

        return ['gross' => (int) floor($base * (1 + $o['boost'])), 'maintenance' => (int) floor($base * $o['maint']), 'net' => self::rowIncome($kind, $base, $level, $branch, 1.0)];
    }

    /** El Mayorista (comercio, nivel 2, rama b) recibe solo una fracción de las caídas por eventos; las subas no se tocan. */
    public static function dampenFactor(string $kind, int $level, ?string $branch, float $factor): float
    {
        if ($kind === 'comercio' && $level === 2 && $branch === 'b' && $factor < 1.0) {
            return 1 - (1 - $factor) * (float) config('formosa.upgrades.dampen_down');
        }

        return $factor;
    }

    /** Pesos que cuesta subir a `$toLevel` (el nivel 2 se paga encima del 1). */
    public static function cost(int $price, int $toLevel, ?string $branch, bool $discount): int
    {
        $cost = (int) floor($price * self::option('casa', $toLevel, $branch)['cost_pct']);

        return $discount ? (int) floor($cost * (1 - (float) config('formosa.upgrades.discount'))) : $cost;
    }

    /** Cuántas propiedades cuenta esta para el combo de zona. */
    public static function zoneWeight(string $kind, int $level, ?string $branch): int
    {
        return $kind === 'casa' && $level === 2 && $branch === 'b' ? 2 : 1;
    }

    /** @param  list<array{kind: string, level: int, branch: ?string}>  $ownedRows */
    public static function hasDiscount(array $ownedRows): bool
    {
        foreach ($ownedRows as $r) {
            if ($r['kind'] === 'supermercado' && (int) $r['level'] === 2 && ($r['branch'] ?? null) === 'b') {
                return true;
            }
        }

        return false;
    }

    /** Lo que vale la propiedad para el patrimonio: precio de lista más la parte reconocida de lo invertido. */
    public static function assetValue(int $price, int $upgradePaid): int
    {
        return $price + (int) floor($upgradePaid * (float) config('formosa.upgrades.net_worth_ratio'));
    }

    /** Días de juego que tarda en recuperarse subir de (`$fromLevel`, `$fromBranch`) a (`$toLevel`, `$branch`), sin eventos ni combos. INF si no suma. */
    public static function paybackDays(string $kind, int $toLevel, ?string $branch, int $base, int $price, bool $discount, int $fromLevel, ?string $fromBranch): float
    {
        $gain = self::rowIncome($kind, $base, $toLevel, $branch, 1.0) - self::rowIncome($kind, $base, $fromLevel, $fromBranch, 1.0);
        if ($gain <= 0) {
            return INF;
        }

        return self::cost($price, $toLevel, $branch, $discount) / $gain;
    }

    /**
     * Opciones que ofrece el panel desde el estado actual.
     *
     * @return list<array{level: int, branch: ?string, label: string, cost: int, gross: int, maintenance: int, net: int, payback_days: float|null}>
     */
    public static function next(string $kind, int $level, ?string $branch, int $base, int $price, bool $discount): array
    {
        $targets = match ($level) {
            0 => [[1, null]],
            1 => [[2, 'a'], [2, 'b']],
            default => [],
        };
        $out = [];
        foreach ($targets as [$to, $b]) {
            $o = self::option($kind, $to, $b);
            $out[] = [
                'level' => $to, 'branch' => $b, 'label' => $o['label'],
                'cost' => self::cost($price, $to, $b, $discount),
                'gross' => (int) floor($base * (1 + $o['boost'])),
                'maintenance' => (int) floor($base * $o['maint']),
                'net' => self::rowIncome($kind, $base, $to, $b, 1.0),
                'payback_days' => is_finite($days = self::paybackDays($kind, $to, $b, $base, $price, $discount, $level, $branch)) ? $days : null, // sin ganancia: nulo (INF no se codifica en JSON)
            ];
        }

        return $out;
    }
}
