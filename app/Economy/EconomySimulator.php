<?php

namespace App\Economy;

/**
 * Simula partidas de 40 minutos con jugadores ficticios para calibrar la economía ANTES de tener jugadores reales.
 * Usa la misma aritmética de ingresos que el juego (Accrual) y la misma regla de puntos (MatchScoring).
 * Determinista: misma semilla, mismo resultado.
 *
 * Estrategias (cada una actúa cada tantos segundos REALES; el día de juego dura `secondsPerDay`):
 *  - inactivo:     no hace nada (referencia: el piso del patrimonio).
 *  - pasivo:       compra casas con todo su dinero al empezar y nunca más vuelve (no reinvierte).
 *  - casas:        reinvierte seguido, pero solo compra casas.
 *  - reinvertidor: reinvierte seguido en lo que más rinde y pueda pagar (sube a comercios, supermercados y hoteles apenas puede).
 *  - mixto:        reinvierte seguido pero compra un poco de todo al azar y guarda siempre una reserva de efectivo.
 *
 * Sin subastas: gana el primero que llega (los desempates del azar los resuelve la semilla). La contienda real por los pocos
 * supermercados y hoteles hace la partida más dura que lo simulado para quien llega tarde.
 */
final class EconomySimulator
{
    /** Cada cuántos segundos reales actúa cada estrategia (con ±20 % de variación) y cómo compra. */
    public const STRATEGIES = [
        'inactivo' => ['every' => null],
        'pasivo' => ['every' => null, 'once' => true],
        'casas' => ['every' => 45],
        'reinvertidor' => ['every' => 30],
        'mixto' => ['every' => 60, 'reserve' => 0.10],
    ];

    /**
     * Juega UNA partida.
     *
     * @param  list<array{price: int, income: int, kind: string}>  $properties
     * @param  list<string>  $seats  estrategia de cada jugador (en el orden de las sillas)
     * @param  array{start_cash?: int, seconds_per_day?: int, duration_seconds?: int, sell_ratio?: float, seed?: int, points?: array|null}  $opts
     * @return array{players: list<array<string, mixed>>, free: int, timeline: array<int, list<int>>}
     */
    public static function match(array $properties, array $seats, array $opts = []): array
    {
        $startCash = $opts['start_cash'] ?? 60000;
        $spd = $opts['seconds_per_day'] ?? 120;
        $duration = $opts['duration_seconds'] ?? 2400;
        mt_srand($opts['seed'] ?? 1);

        $props = array_values($properties);
        $n = count($props);
        // Índices libres por tipo, ordenados por precio (para comprar "lo más barato" o "uno al azar" sin recorrer todo).
        $byKind = [];
        foreach ($props as $i => $p) {
            $byKind[$p['kind']][] = $i;
        }
        foreach ($byKind as &$list) {
            usort($list, fn ($a, $b) => ($props[$a]['price'] <=> $props[$b]['price']) ?: $a <=> $b);
        }
        unset($list);
        $taken = array_fill(0, $n, false);
        $cursor = array_fill_keys(array_keys($byKind), 0); // primer índice posiblemente libre de cada lista (ordenada por precio)
        $kindOrder = self::kindsByRate($props);
        // Mismas reglas que el juego: eventos de la partida (calendario por semilla) y combos de zona/variedad.
        // Sin lat/lng (datos de prueba) cada propiedad cae en su propia zona, así que no hay combos de zona.
        foreach ($props as $i => &$prop) {
            $prop['lat'] ??= -26.0 - $i * 0.01;
            $prop['lng'] ??= -58.0;
        }
        unset($prop);
        $ctx = [
            'props' => $props, 'spd' => $spd,
            'events' => ($opts['events'] ?? true) ? MatchEvents::schedule((int) ($opts['seed'] ?? 1), 0, $spd, $duration, config('formosa.events.zonal') ? MatchEvents::zonesFromRows($props) : null) : [],
            'combos' => (bool) ($opts['combos'] ?? true),
        ];

        $players = [];
        foreach ($seats as $seat => $strategy) {
            $players[$seat] = ['strategy' => $strategy, 'cash' => $startCash, 'carry' => 0, 'last' => 0, 'income' => 0, 'owned' => [], 'assets' => 0];
        }

        // Calendario de acciones: (segundo, silla). Cada estrategia tiene su ritmo, con algo de variación.
        $events = [];
        foreach ($players as $seat => $pl) {
            $cfg = self::STRATEGIES[$pl['strategy']] ?? throw new \InvalidArgumentException("Estrategia desconocida: {$pl['strategy']}");
            if ($pl['strategy'] === 'inactivo') {
                continue;
            }
            if ($cfg['once'] ?? false) {
                $events[] = [mt_rand(0, 5), $seat];

                continue;
            }
            $t = mt_rand(0, $cfg['every']);
            while ($t < $duration) {
                $events[] = [$t, $seat];
                $t += (int) round($cfg['every'] * (0.8 + mt_rand(0, 40) / 100));
            }
        }
        usort($events, fn ($a, $b) => $a <=> $b);

        $sample = array_unique([0, ...array_map(fn ($d) => $d * $spd, range(1, intdiv($duration, $spd)))]);
        $timeline = [];
        $nextSample = 0;
        $record = function (int $t) use (&$players, &$timeline, $ctx, $spd) {
            $timeline[intdiv($t, $spd)] = array_map(fn ($pl) => self::worth($pl, $t, $ctx), $players);
        };

        foreach ($events as [$t, $seat]) {
            while ($nextSample < count($sample) && array_values($sample)[$nextSample] <= $t) {
                $record(array_values($sample)[$nextSample]);
                $nextSample++;
            }
            $pl = &$players[$seat];
            self::settle($pl, $t, $ctx);
            $cfg = self::STRATEGIES[$pl['strategy']];
            $reserve = (int) round(($cfg['reserve'] ?? 0) * $pl['cash']);

            while (true) {
                $budget = $pl['cash'] - $reserve;
                $pick = match ($pl['strategy']) {
                    'pasivo', 'casas' => self::pickKind($props, $byKind, $taken, $cursor, 'casa', $budget, random: $pl['strategy'] === 'pasivo'),
                    'reinvertidor' => self::pickBest($props, $byKind, $taken, $cursor, $kindOrder, $budget),
                    'mixto' => self::pickRandomKind($props, $byKind, $taken, $cursor, $kindOrder, $budget),
                };
                if ($pick === null) {
                    break;
                }
                $taken[$pick] = true;
                $pl['cash'] -= $props[$pick]['price'];
                $pl['owned'][] = $pick;
                $pl['income'] += $props[$pick]['income'];
                $pl['assets'] += $props[$pick]['price'];
                if ($pl['strategy'] === 'pasivo' && count($pl['owned']) > 5000) {
                    break;
                }
            }
            unset($pl);
        }
        while ($nextSample < count($sample)) {
            $record(array_values($sample)[$nextSample]);
            $nextSample++;
        }

        // Cierre: ingreso hasta el final, patrimonio, puestos y puntos (igual que MatchService::finish).
        $finishers = [];
        foreach ($players as $seat => &$pl) {
            self::settle($pl, $duration, $ctx);
            $finishers[] = ['user_id' => $seat, 'net_worth' => $pl['cash'] + $pl['assets'], 'properties' => count($pl['owned'])];
        }
        unset($pl);
        $scores = MatchScoring::score($finishers);

        $out = [];
        foreach ($players as $seat => $pl) {
            $out[] = [
                'seat' => $seat, 'strategy' => $pl['strategy'], 'net_worth' => $pl['cash'] + $pl['assets'], 'cash' => $pl['cash'],
                'properties' => count($pl['owned']), 'income_per_day' => self::rateAt($pl, max(0, $duration - 1), $ctx), 'rank' => $scores[$seat]['rank'], 'points' => $scores[$seat]['points'],
            ];
        }

        return ['players' => $out, 'free' => $n - count(array_filter($taken)), 'timeline' => $timeline];
    }

    /**
     * Juega muchas partidas (cambiando de silla y de semilla) y resume por estrategia.
     *
     * @param  list<array{price: int, income: int, kind: string}>  $properties
     * @param  list<string>  $seats
     * @return array{rows: list<array<string, mixed>>, free_pct: float, matches: int, timeline: array<string, array<int, int>>}
     */
    public static function summarize(array $properties, array $seats, int $matches, array $opts = []): array
    {
        $seed = $opts['seed'] ?? 1;
        $acc = [];
        $free = 0.0;
        $timeline = [];
        for ($m = 0; $m < $matches; $m++) {
            mt_srand($seed * 1000 + $m);
            $order = $seats;
            shuffle($order); // la silla decide quién llega primero a una propiedad: se rota para no favorecer a nadie
            $r = self::match($properties, $order, ['seed' => $seed * 1000 + $m] + $opts);
            $free += 100 * $r['free'] / max(1, count($properties));
            $perStrategy = [];
            foreach ($r['players'] as $p) {
                $a = &$acc[$p['strategy']];
                $a['n'] = ($a['n'] ?? 0) + 1;
                foreach (['net_worth', 'properties', 'points', 'rank', 'income_per_day'] as $k) {
                    $a[$k] = ($a[$k] ?? 0) + $p[$k];
                }
                $a['wins'] = ($a['wins'] ?? 0) + ($p['rank'] === 1 ? 1 : 0);
                $a['min'] = min($a['min'] ?? PHP_INT_MAX, $p['net_worth']);
                $a['max'] = max($a['max'] ?? 0, $p['net_worth']);
                unset($a);
                $perStrategy[$p['strategy']][] = $r['timeline'];
            }
            foreach ($r['timeline'] as $day => $worths) {
                foreach ($r['players'] as $p) {
                    $s = &$timeline[$p['strategy']][$day];
                    $s = ($s ?? 0) + $worths[$p['seat']];
                    unset($s);
                }
            }
        }

        $rows = [];
        foreach ($acc as $strategy => $a) {
            $rows[] = [
                'strategy' => $strategy, 'players' => $a['n'],
                'net_worth' => (int) round($a['net_worth'] / $a['n']), 'min' => $a['min'], 'max' => $a['max'],
                'properties' => round($a['properties'] / $a['n'], 1), 'income_per_day' => (int) round($a['income_per_day'] / $a['n']),
                'rank' => round($a['rank'] / $a['n'], 2), 'points' => round($a['points'] / $a['n'], 1), 'wins' => $a['wins'],
            ];
        }
        $counts = array_count_values($seats);
        foreach ($timeline as $strategy => &$days) {
            foreach ($days as $day => &$v) {
                $v = (int) round($v / ($counts[$strategy] * $matches));
            }
        }
        unset($days, $v);

        return ['rows' => $rows, 'free_pct' => round($free / $matches, 2), 'matches' => $matches, 'timeline' => $timeline];
    }

    // ------------------------------------------------------------------ internos

    /**
     * Ingreso por día del jugador en el segundo `$t`: lo que rinde cada propiedad con el evento activo, más los combos
     * (la misma cuenta que EconomyService). Se guarda en memoria mientras no cambie lo que tiene ni el evento.
     */
    private static function rateAt(array &$pl, int $t, array $ctx): int
    {
        $active = MatchEvents::active($ctx['events'], $t);
        $key = count($pl['owned']).':'.implode(',', array_column($active, 'key'));
        if (isset($pl['memo'][$key])) {
            return $pl['memo'][$key];
        }
        $rows = [];
        foreach ($pl['owned'] as $i) {
            $p = $ctx['props'][$i];
            $rows[] = ['id' => $i, 'kind' => $p['kind'], 'lat' => $p['lat'], 'lng' => $p['lng'], 'income' => (int) floor($p['income'] * MatchEvents::factor($active, $p['kind'], Combos::zoneKey((float) $p['lat'], (float) $p['lng'])))];
        }
        $total = $ctx['combos'] ? Combos::evaluate($rows)['total'] : array_sum(array_column($rows, 'income'));
        $pl['memo'] = [$key => $total] + array_slice($pl['memo'] ?? [], 0, 8, true); // acotada: solo hay unas pocas combinaciones vivas

        return $total;
    }

    /** Pesos y resto que rinde el jugador entre `$pl['last']` y `$t`, partiendo el tiempo donde cambia un evento. @return array{amount: int, carry: int} */
    private static function accrue(array &$pl, int $t, array $ctx): array
    {
        $cuts = [$pl['last'], ...MatchEvents::boundaries($ctx['events'], $pl['last'], $t), max($pl['last'], $t)];
        $amount = 0;
        $carry = $pl['carry'];
        for ($i = 0; $i < count($cuts) - 1; $i++) {
            $r = Accrual::settle(self::rateAt($pl, $cuts[$i], $ctx), $carry, $cuts[$i + 1] - $cuts[$i], $ctx['spd']);
            $amount += $r['amount'];
            $carry = $r['carry'];
        }

        return ['amount' => $amount, 'carry' => $carry];
    }

    /** Liquida el ingreso del jugador hasta el segundo `$t` (la misma cuenta exacta del juego). */
    private static function settle(array &$pl, int $t, array $ctx): void
    {
        ['amount' => $amount, 'carry' => $carry] = self::accrue($pl, $t, $ctx);
        $pl['cash'] += $amount;
        $pl['carry'] = $carry;
        $pl['last'] = $t;
    }

    /** Patrimonio en el segundo `$t` sin tocar al jugador. */
    private static function worth(array $pl, int $t, array $ctx): int
    {
        return $pl['cash'] + self::accrue($pl, $t, $ctx)['amount'] + $pl['assets'];
    }

    /** Tipos ordenados por rendimiento (ingreso / precio) de mayor a menor. @return list<string> */
    private static function kindsByRate(array $props): array
    {
        $rate = [];
        foreach ($props as $p) {
            $rate[$p['kind']] ??= $p['price'] > 0 ? $p['income'] / $p['price'] : 0;
        }
        arsort($rate);

        return array_keys($rate);
    }

    /** Una propiedad libre del tipo con precio <= presupuesto: la más barata, o una al azar entre las que se pueden pagar. */
    private static function pickKind(array $props, array $byKind, array &$taken, array &$cursor, string $kind, int $budget, bool $random = false): ?int
    {
        $list = $byKind[$kind] ?? [];
        $c = &$cursor[$kind];
        while (isset($list[$c]) && $taken[$list[$c]]) {
            $c++;
        }
        if (! isset($list[$c]) || $props[$list[$c]]['price'] > $budget) {
            return null;
        }
        if (! $random) {
            return $list[$c];
        }
        // Al azar entre las libres que se pueden pagar (hasta 25 intentos; si no, la más barata).
        $affordable = $c;
        while (isset($list[$affordable + 1]) && $props[$list[$affordable + 1]]['price'] <= $budget) {
            $affordable = min($affordable + 4096, count($list) - 1);
            if ($props[$list[$affordable]]['price'] > $budget) {
                break;
            }
        }
        for ($i = 0; $i < 25; $i++) {
            $idx = $list[mt_rand($c, $affordable)];
            if (! $taken[$idx] && $props[$idx]['price'] <= $budget) {
                return $idx;
            }
        }

        return $list[$c];
    }

    /** Lo que más rinde y se puede pagar: recorre los tipos de mejor a peor rendimiento y toma el más barato libre. */
    private static function pickBest(array $props, array $byKind, array &$taken, array &$cursor, array $kindOrder, int $budget): ?int
    {
        foreach ($kindOrder as $kind) {
            if (($i = self::pickKind($props, $byKind, $taken, $cursor, $kind, $budget)) !== null) {
                return $i;
            }
        }

        return null;
    }

    /** Un tipo al azar entre los que se pueden pagar (todos con igual chance), y dentro del tipo uno al azar. */
    private static function pickRandomKind(array $props, array $byKind, array &$taken, array &$cursor, array $kindOrder, int $budget): ?int
    {
        $kinds = $kindOrder;
        shuffle($kinds);
        foreach ($kinds as $kind) {
            if (($i = self::pickKind($props, $byKind, $taken, $cursor, $kind, $budget, random: true)) !== null) {
                return $i;
            }
        }

        return null;
    }
}
