<?php

namespace App\Economy;

/**
 * Bonus de ingreso por combos. Pura (sin base de datos): recibe las propiedades de UN jugador y devuelve cuánto rinden.
 * Cada fila: ['id' => int, 'kind' => string, 'lat' => float, 'lng' => float, 'income' => int]. Todo en pesos enteros.
 * El cliente tiene una copia de la misma cuenta (resources/js/map/combos.js): si cambia una, cambia la otra.
 */
final class Combos
{
    /** Clave de la celda de la grilla ("zona") donde cae un punto. */
    public static function zoneKey(float $lat, float $lng, ?float $deg = null): string
    {
        $deg ??= (float) config('formosa.combos.zone_deg');

        return floor(round($lat / $deg, 6)).':'.floor(round($lng / $deg, 6));
    }

    /** Porcentaje del escalón más alto alcanzado con $count propiedades en la zona (0 si no llega al primero). */
    public static function zonePct(int $count, ?array $tiers = null): float
    {
        $pct = 0.0;
        foreach ($tiers ?? config('formosa.combos.zone_tiers') as $need => $p) {
            if ($count >= (int) $need) {
                $pct = max($pct, (float) $p);
            }
        }

        return $pct;
    }

    /**
     * @param  list<array{id: int, kind: string, lat: float|string, lng: float|string, income: int}>  $rows
     * @return array{base: int, bonus: int, total: int, zones: list<array{zone: string, count: int, pct: float, bonus: int, ids: list<int>}>, variety: bool, variety_bonus: int}
     */
    public static function evaluate(array $rows): array
    {
        $cfg = config('formosa.combos');
        $base = 0;
        $byZone = [];
        $kinds = [];
        foreach ($rows as $r) {
            $base += (int) $r['income'];
            $kinds[$r['kind']] = true;
            $z = self::zoneKey((float) $r['lat'], (float) $r['lng'], (float) $cfg['zone_deg']);
            $byZone[$z]['income'] = ($byZone[$z]['income'] ?? 0) + (int) $r['income'];
            $byZone[$z]['ids'][] = (int) $r['id'];
        }

        $zones = [];
        $bonus = 0;
        foreach ($byZone as $z => $g) {
            $count = count($g['ids']);
            $pct = self::zonePct($count, $cfg['zone_tiers']);
            if ($pct <= 0) {
                continue;
            }
            $b = (int) floor($g['income'] * $pct);
            $bonus += $b;
            $zones[] = ['zone' => (string) $z, 'count' => $count, 'pct' => $pct, 'bonus' => $b, 'ids' => $g['ids']];
        }
        usort($zones, fn ($a, $b) => $b['bonus'] <=> $a['bonus'] ?: strcmp($a['zone'], $b['zone']));

        $variety = count(array_intersect(array_keys($kinds), ['casa', 'comercio', 'supermercado', 'hotel'])) === 4;
        $varietyBonus = $variety ? (int) floor($base * (float) $cfg['variety']) : 0;
        $bonus += $varietyBonus;

        return ['base' => $base, 'bonus' => $bonus, 'total' => $base + $bonus, 'zones' => $zones, 'variety' => $variety, 'variety_bonus' => $varietyBonus];
    }
}
