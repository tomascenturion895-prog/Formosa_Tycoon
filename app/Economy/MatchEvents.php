<?php

namespace App\Economy;

use App\Models\GameMatch;

/**
 * Calendario de eventos de una partida. Pura y DETERMINISTA: depende solo del id de la partida y de sus tiempos, así que no se
 * guarda nada y siempre da lo mismo (para todos los jugadores y en cada lectura).
 *
 * Un evento es { key, label, kind, zone, pct, text, start, end } con `start`/`end` en segundos Unix. Dentro de [start, end) las
 * propiedades de `kind` (null = todas) que estén en la `zone` (null = toda la ciudad) rinden (1 + pct) veces.
 * El sprint final es un evento más: key 'sprint', sin tipo ni zona.
 */
final class MatchEvents
{
    /**
     * @param  list<string>|null  $zones  zonas elegibles (claves de Combos::zoneKey); null o vacío = eventos de toda la ciudad
     * @return list<array{key: string, label: string, kind: string|null, zone: string|null, pct: float, text: string, start: int, end: int}>
     */
    public static function schedule(int $matchId, int $startedAt, int $secondsPerDay, int $durationSeconds, ?array $zones = null): array
    {
        $cfg = config('formosa.events');
        if (! ($cfg['enabled'] ?? false) || $secondsPerDay <= 0) {
            return [];
        }

        $types = $cfg['types'];
        // Los tipos se ordenan por un hash del id de la partida: otro orden en cada partida, el mismo siempre para una.
        $keys = array_keys($types);
        usort($keys, fn ($a, $b) => crc32("{$matchId}:{$a}") <=> crc32("{$matchId}:{$b}") ?: strcmp($a, $b));
        $count = min((int) $cfg['per_match'], count($keys));

        $first = (int) $cfg['first_day'] * $secondsPerDay;
        $length = (int) $cfg['duration_days'] * $secondsPerDay;
        $room = $durationSeconds - $first;
        if ($count <= 0 || $room < $length) {
            return [];
        }
        $slot = intdiv($room, $count);
        if ($slot < $length) {
            $count = max(1, intdiv($room, $length));
            $slot = intdiv($room, $count);
        }
        $jitterRange = max(1, $slot - $length + 1); // el evento cabe entero dentro de su tramo

        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $key = $keys[$i];
            $offset = $first + $i * $slot + (crc32("{$matchId}:slot:{$i}") % $jitterRange);
            $t = $types[$key];
            $out[] = [
                'key' => $key, 'label' => $t['label'], 'kind' => $t['kind'], 'pct' => (float) $t['pct'], 'text' => $t['text'],
                'zone' => $zones ? $zones[crc32("{$matchId}:zone:{$key}") % count($zones)] : null,
                'start' => $startedAt + $offset, 'end' => $startedAt + $offset + $length,
            ];
        }

        return $out;
    }

    public static function forMatch(GameMatch $match): array
    {
        if ($match->started_at === null) {
            return [];
        }

        $start = $match->started_at->getTimestamp();
        $zones = config('formosa.events.enabled') && config('formosa.events.zonal') ? self::zonesFor($match->id) : null;
        $events = self::schedule($match->id, $start, $match->secondsPerDay(), $match->duration_minutes * 60, $zones);
        $sprint = self::sprint($start, $match->duration_minutes * 60);

        return $sprint ? [...$events, $sprint] : $events;
    }

    /**
     * El sprint final como evento (ingreso extra en toda la ciudad), o null si está apagado o la partida es demasiado corta
     * (tiene que durar al menos el triple del sprint, para que no sea casi toda la partida).
     *
     * @return array{key: string, label: string, kind: null, zone: null, pct: float, text: string, start: int, end: int}|null
     */
    public static function sprint(int $startedAt, int $durationSeconds): ?array
    {
        $cfg = config('formosa.sprint');
        $len = (int) ($cfg['seconds'] ?? 0);
        if (! ($cfg['enabled'] ?? false) || $len <= 0 || $durationSeconds < 3 * $len) {
            return null;
        }
        $pct = (float) $cfg['income_pct'];

        return [
            'key' => 'sprint', 'label' => 'Sprint final', 'kind' => null, 'zone' => null, 'pct' => $pct,
            'text' => 'Todo rinde '.($pct >= 1 ? 'x'.(1 + $pct) : '+'.round($pct * 100).' %').'.',
            'start' => $startedAt + $durationSeconds - $len, 'end' => $startedAt + $durationSeconds,
        ];
    }

    /** Zonas con propiedades suficientes para ser sede de un evento, ordenadas. Lectura única por partida (queda en caché). @return list<string> */
    public static function zonesFor(int $matchId): array
    {
        $cache = \Illuminate\Support\Facades\Cache::store();
        if (is_array($hit = $cache->get("match-zones:{$matchId}"))) {
            return $hit;
        }
        $rows = \Illuminate\Support\Facades\DB::table('properties')->get(['lat', 'lng'])->map(fn ($r) => ['lat' => (float) $r->lat, 'lng' => (float) $r->lng])->all();
        $zones = self::zonesFromRows($rows);
        if ($zones !== []) {
            $cache->put("match-zones:{$matchId}", $zones, 86400); // una lista vacía no se guarda: se recalcula
        }

        return $zones;
    }

    /**
     * @param  list<array{lat: float, lng: float}>  $rows
     * @return list<string>
     */
    public static function zonesFromRows(array $rows, ?int $minProps = null): array
    {
        $minProps ??= (int) config('formosa.events.zone_min_props');
        $count = [];
        foreach ($rows as $r) {
            $z = Combos::zoneKey((float) $r['lat'], (float) $r['lng']);
            $count[$z] = ($count[$z] ?? 0) + 1;
        }
        $zones = array_keys(array_filter($count, fn ($n) => $n >= $minProps));
        sort($zones, SORT_STRING);

        return array_map('strval', $zones);
    }

    /** Límites [oeste, sur, este, norte] de una zona (la inversa de Combos::zoneKey). @return array{0: float, 1: float, 2: float, 3: float} */
    public static function zoneBounds(string $zone): array
    {
        [$i, $j] = array_map('intval', explode(':', $zone));
        $deg = (float) config('formosa.combos.zone_deg');

        return [round($j * $deg, 6), round($i * $deg, 6), round(($j + 1) * $deg, 6), round(($i + 1) * $deg, 6)];
    }

    /** Eventos que están vigentes en el instante `$ts`. */
    public static function active(array $schedule, int $ts): array
    {
        return array_values(array_filter($schedule, fn ($e) => $ts >= $e['start'] && $ts < $e['end']));
    }

    /** Multiplicador de una propiedad (`$kind`, en la zona `$zone`) con los eventos vigentes `$active`: 1 + suma de los que la tocan. */
    public static function factor(array $active, string $kind, string $zone): float
    {
        $f = 1.0;
        foreach ($active as $e) {
            if (($e['kind'] === null || $e['kind'] === $kind) && ($e['zone'] === null || $e['zone'] === $zone)) {
                $f += $e['pct'];
            }
        }

        return max(0.0, $f);
    }

    /** Instantes (segundos Unix) estrictamente entre `$from` y `$to` donde cambia algún multiplicador, ordenados y sin repetir. */
    public static function boundaries(array $schedule, int $from, int $to): array
    {
        $b = [];
        foreach ($schedule as $e) {
            foreach ([$e['start'], $e['end']] as $t) {
                if ($t > $from && $t < $to) {
                    $b[$t] = true;
                }
            }
        }
        $b = array_keys($b);
        sort($b);

        return $b;
    }

    /**
     * Lo que ve el jugador: los eventos activos y el próximo si ya fue anunciado (faltan `announce_days` días o menos).
     * Tiempos en milisegundos.
     *
     * @return array{active: list<array<string, mixed>>, next: array<string, mixed>|null}
     */
    public static function view(GameMatch $match, int $ts): array
    {
        $schedule = self::forMatch($match);
        $announce = (int) config('formosa.events.announce_days') * $match->secondsPerDay();
        $ms = fn (array $e) => ['key' => $e['key'], 'label' => $e['label'], 'kind' => $e['kind'], 'pct' => $e['pct'], 'text' => $e['text'], 'start' => $e['start'] * 1000, 'end' => $e['end'] * 1000]
            + ['zone' => $e['zone'], 'bounds' => $e['zone'] !== null ? self::zoneBounds($e['zone']) : null];

        $active = [];
        $next = null;
        foreach ($schedule as $e) {
            if ($ts >= $e['start'] && $ts < $e['end']) {
                $active[] = $ms($e);
            } elseif ($e['key'] !== 'sprint' && $e['start'] > $ts && $e['start'] - $ts <= $announce && $next === null) {
                $next = $ms($e);
            }
        }

        return ['active' => $active, 'next' => $next];
    }
}
