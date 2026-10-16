<?php

namespace Tests\Unit;

use App\Economy\AuctionRules;
use App\Economy\Combos;
use App\Economy\MatchEvents;
use Tests\TestCase;

/** Eventos por zona y ventana del sprint final: reglas puras. */
class SprintEventsTest extends TestCase
{
    private const SPD = 120;
    private const DURATION = 2400;

    protected function setUp(): void
    {
        parent::setUp();
        config(['formosa.events.enabled' => true, 'formosa.sprint.enabled' => true, 'formosa.sprint.seconds' => 300]);
    }

    public function test_cada_evento_cae_en_una_zona_elegible_y_siempre_la_misma(): void
    {
        $zones = ['10:20', '10:21', '11:20', '11:21', '12:20'];
        $a = MatchEvents::schedule(7, 1000, self::SPD, self::DURATION, $zones);
        $this->assertSame($a, MatchEvents::schedule(7, 1000, self::SPD, self::DURATION, $zones));
        foreach ($a as $e) {
            $this->assertContains($e['zone'], $zones);
        }
        $this->assertGreaterThan(1, count(array_unique(array_column(MatchEvents::schedule(8, 0, self::SPD, self::DURATION, $zones), 'zone')) + array_column($a, 'zone')));
    }

    public function test_sin_zonas_el_evento_es_de_toda_la_ciudad(): void
    {
        foreach (MatchEvents::schedule(7, 0, self::SPD, self::DURATION) as $e) {
            $this->assertNull($e['zone']);
        }
        foreach (MatchEvents::schedule(7, 0, self::SPD, self::DURATION, []) as $e) {
            $this->assertNull($e['zone']);
        }
    }

    public function test_el_factor_solo_toca_el_tipo_y_la_zona_del_evento(): void
    {
        $active = [['key' => 'feria', 'kind' => 'comercio', 'zone' => '5:6', 'pct' => 0.3]];
        $this->assertSame(1.3, MatchEvents::factor($active, 'comercio', '5:6'));
        $this->assertSame(1.0, MatchEvents::factor($active, 'comercio', '5:7'), 'otra zona no rinde más');
        $this->assertSame(1.0, MatchEvents::factor($active, 'casa', '5:6'), 'otro tipo no rinde más');
    }

    public function test_el_sprint_toca_todo_y_se_suma_a_otros_eventos(): void
    {
        $active = [
            ['key' => 'sprint', 'kind' => null, 'zone' => null, 'pct' => 1.0],
            ['key' => 'feria', 'kind' => 'comercio', 'zone' => '5:6', 'pct' => 0.3],
        ];
        $this->assertSame(2.0, MatchEvents::factor($active, 'casa', '1:1'));
        $this->assertSame(2.3, MatchEvents::factor($active, 'comercio', '5:6'));
    }

    public function test_una_crisis_nunca_deja_el_factor_negativo(): void
    {
        $this->assertSame(0.0, MatchEvents::factor([['kind' => null, 'zone' => null, 'pct' => -3.0]], 'casa', '1:1'));
    }

    public function test_ventana_del_sprint(): void
    {
        $s = MatchEvents::sprint(5000, self::DURATION);
        $this->assertSame('sprint', $s['key']);
        $this->assertSame(5000 + self::DURATION - 300, $s['start']);
        $this->assertSame(5000 + self::DURATION, $s['end']);
        $this->assertSame(1.0, $s['pct']);
    }

    public function test_sprint_apagado_o_partida_corta_no_tiene_sprint(): void
    {
        $this->assertNull(MatchEvents::sprint(0, 800), 'la partida tiene que durar al menos el triple del sprint');
        config(['formosa.sprint.enabled' => false]);
        $this->assertNull(MatchEvents::sprint(0, self::DURATION));
    }

    public function test_zonas_elegibles_exigen_propiedades_suficientes(): void
    {
        $rows = [];
        for ($i = 0; $i < 5; $i++) {
            $rows[] = ['lat' => -26.1801, 'lng' => -58.1701];
        }
        for ($i = 0; $i < 2; $i++) {
            $rows[] = ['lat' => -26.3001, 'lng' => -58.3001];
        }
        $zones = MatchEvents::zonesFromRows($rows, 5);
        $this->assertSame([Combos::zoneKey(-26.1801, -58.1701)], $zones);
    }

    public function test_los_limites_de_la_zona_contienen_sus_puntos(): void
    {
        [$w, $s, $e, $n] = MatchEvents::zoneBounds(Combos::zoneKey(-26.1801, -58.1701));
        $this->assertTrue($w <= -58.1701 && -58.1701 < $e);
        $this->assertTrue($s <= -26.1801 && -26.1801 < $n);
    }

    public function test_precio_con_descuento(): void
    {
        $this->assertSame(9000, AuctionRules::discounted(10000, 10));
        $this->assertSame(10000, AuctionRules::discounted(10000, 0));
        $this->assertSame(1, AuctionRules::discounted(1, 99));
    }
}
