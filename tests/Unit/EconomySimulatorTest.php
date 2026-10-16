<?php

namespace Tests\Unit;

use App\Economy\EconomySimulator;
use Tests\TestCase;

class EconomySimulatorTest extends TestCase
{
    /** @return list<array{price: int, income: int, kind: string}> */
    private function props(int $n): array
    {
        $kinds = [['casa', 10000, 0.333], ['comercio', 40000, 0.300], ['supermercado', 150000, 0.270], ['hotel', 400000, 0.250]];
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            [$kind, $price, $rate] = $kinds[$i % 7 === 0 ? 1 : ($i % 31 === 0 ? 2 : 0)];
            $out[] = ['price' => $price, 'income' => (int) round($price * $rate), 'kind' => $kind];
        }

        return $out;
    }

    private function seats(): array
    {
        return ['pasivo', 'casas', 'reinvertidor', 'mixto'];
    }

    public function test_misma_semilla_mismo_resultado(): void
    {
        $a = EconomySimulator::match($this->props(200), $this->seats(), ['seed' => 5]);
        $b = EconomySimulator::match($this->props(200), $this->seats(), ['seed' => 5]);

        $this->assertSame($a, $b);
    }

    public function test_las_propiedades_no_se_reparten_de_mas_y_nada_es_negativo(): void
    {
        $props = $this->props(60);
        $r = EconomySimulator::match($props, ['reinvertidor', 'casas', 'mixto', 'pasivo', 'casas', 'mixto', 'reinvertidor', 'pasivo'], ['seed' => 3]);

        $owned = array_sum(array_column($r['players'], 'properties'));
        $this->assertSame(count($props) - $r['free'], $owned);
        $this->assertGreaterThanOrEqual(0, $r['free']);
        foreach ($r['players'] as $p) {
            $this->assertGreaterThanOrEqual(0, $p['cash']);
            $this->assertGreaterThanOrEqual($p['cash'], $p['net_worth']);
        }
    }

    public function test_puestos_y_puntos_son_coherentes(): void
    {
        $r = EconomySimulator::match($this->props(200), $this->seats(), ['seed' => 2]);

        $ranks = array_column($r['players'], 'rank');
        $this->assertSame(1, min($ranks));
        $best = max(array_column($r['players'], 'net_worth'));
        foreach ($r['players'] as $p) {
            $this->assertSame($p['net_worth'] === $best, $p['rank'] === 1);
        }
        $first = array_values(array_filter($r['players'], fn ($p) => $p['rank'] === 1))[0];
        $last = array_values(array_filter($r['players'], fn ($p) => $p['rank'] === max($ranks)))[0];
        $this->assertGreaterThan($last['points'], $first['points']);
    }

    public function test_sin_dinero_inicial_nadie_compra_y_el_patrimonio_es_cero(): void
    {
        $r = EconomySimulator::match($this->props(30), $this->seats(), ['start_cash' => 0, 'seed' => 1]);

        $this->assertSame(30, $r['free']);
        $this->assertSame(0, array_sum(array_column($r['players'], 'net_worth')));
    }

    public function test_quien_reinvierte_termina_muy_por_encima_del_pasivo(): void
    {
        $r = EconomySimulator::summarize($this->props(400), ['pasivo', 'pasivo', 'reinvertidor', 'reinvertidor', 'mixto', 'mixto'], 5, ['seed' => 4]);

        $worth = array_column($r['rows'], 'net_worth', 'strategy');
        $this->assertGreaterThan(2 * $worth['pasivo'], $worth['reinvertidor']);
        $this->assertGreaterThan(2 * $worth['pasivo'], $worth['mixto']);
        $this->assertCount(21, $r['timeline']['pasivo']); // día 0 a 20
    }

    public function test_los_eventos_y_combos_cambian_el_resultado_y_se_pueden_apagar(): void
    {
        config(['formosa.events.enabled' => true]);
        $props = array_map(fn ($p, $i) => $p + ['lat' => -26.18 + ($i % 20) * 0.0001, 'lng' => -58.17], $this->props(300), array_keys($this->props(300))); // todo en una zona
        $off = EconomySimulator::match($props, $this->seats(), ['seed' => 4, 'events' => false, 'combos' => false]);
        $combos = EconomySimulator::match($props, $this->seats(), ['seed' => 4, 'events' => false]);
        $events = EconomySimulator::match($props, $this->seats(), ['seed' => 4, 'combos' => false]);

        $worth = fn (array $r) => array_sum(array_column($r['players'], 'net_worth'));
        $this->assertGreaterThan($worth($off), $worth($combos), 'los combos suman ingreso');
        $this->assertNotSame($worth($off), $worth($events), 'los eventos mueven el ingreso');
        $this->assertSame($combos, EconomySimulator::match($props, $this->seats(), ['seed' => 4, 'events' => false]), 'sigue siendo determinista');
    }
}
