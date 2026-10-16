<?php

namespace Tests\Unit;

use App\Economy\MatchEvents;
use Tests\TestCase;

class MatchEventsTest extends TestCase
{
    private const SPD = 120;      // 1 día de juego = 2 min
    private const DURATION = 2400; // 40 min = 20 días

    protected function setUp(): void
    {
        parent::setUp();
        config(['formosa.events.enabled' => true]);
    }

    public function test_el_calendario_es_determinista_y_distinto_entre_partidas(): void
    {
        $a = MatchEvents::schedule(7, 1000, self::SPD, self::DURATION);
        $this->assertSame($a, MatchEvents::schedule(7, 1000, self::SPD, self::DURATION));
        $this->assertNotSame(array_column($a, 'key'), array_column(MatchEvents::schedule(8, 1000, self::SPD, self::DURATION), 'key') ?: [], 'se esperan calendarios distintos entre partidas (probabilístico: ids 7 y 8)');
    }

    public function test_cuatro_eventos_distintos_dentro_de_la_partida_y_sin_solaparse(): void
    {
        foreach ([1, 2, 3, 41, 1000] as $id) {
            $s = MatchEvents::schedule($id, 5000, self::SPD, self::DURATION);
            $this->assertCount(4, $s);
            $this->assertCount(4, array_unique(array_column($s, 'key')));
            $prevEnd = 5000 + 3 * self::SPD; // no antes del día 3
            foreach ($s as $e) {
                $this->assertGreaterThanOrEqual($prevEnd, $e['start'], "partida {$id}: se solapa o arranca antes del día 3");
                $this->assertSame(3 * self::SPD, $e['end'] - $e['start']);
                $this->assertLessThanOrEqual(5000 + self::DURATION, $e['end']);
                $prevEnd = $e['end'];
            }
        }
    }

    public function test_multiplicadores_y_bordes(): void
    {
        $s = [['key' => 'feria', 'label' => 'F', 'kind' => 'comercio', 'zone' => null, 'pct' => 0.3, 'text' => '', 'start' => 100, 'end' => 200]];
        $this->assertSame([], MatchEvents::active($s, 99));
        $this->assertSame(1.3, MatchEvents::factor(MatchEvents::active($s, 100), 'comercio', '1:1'));
        $this->assertSame(1.0, MatchEvents::factor(MatchEvents::active($s, 100), 'casa', '1:1'));
        $this->assertSame([], MatchEvents::active($s, 200)); // el fin es exclusivo
        $this->assertSame([100, 200], MatchEvents::boundaries($s, 0, 300));
        $this->assertSame([200], MatchEvents::boundaries($s, 100, 300)); // el inicio ya no es "estrictamente dentro"
        $this->assertSame([], MatchEvents::boundaries($s, 200, 300));
    }

    public function test_desactivado_no_hay_eventos(): void
    {
        config(['formosa.events.enabled' => false]);
        $this->assertSame([], MatchEvents::schedule(1, 0, self::SPD, self::DURATION));
    }

    public function test_partida_demasiado_corta_no_tiene_eventos(): void
    {
        $this->assertSame([], MatchEvents::schedule(1, 0, self::SPD, 3 * self::SPD));
    }
}
