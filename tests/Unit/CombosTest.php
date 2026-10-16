<?php

namespace Tests\Unit;

use App\Economy\Combos;
use Tests\TestCase;

class CombosTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        // Se fijan acá los porcentajes: estas pruebas son de la cuenta, no del balance (que se ajusta en config/formosa.php).
        config(['formosa.combos.zone_tiers' => [3 => 0.10, 5 => 0.20, 8 => 0.30], 'formosa.combos.variety' => 0.10]);
    }

    /** @return array{id: int, kind: string, lat: float, lng: float, income: int} */
    private function row(int $id, int $income, string $kind = 'casa', float $lat = -26.18, float $lng = -58.17): array
    {
        return compact('id', 'kind', 'lat', 'lng', 'income');
    }

    public function test_sin_propiedades_no_hay_nada(): void
    {
        $r = Combos::evaluate([]);
        $this->assertSame(['base' => 0, 'bonus' => 0, 'total' => 0], array_intersect_key($r, array_flip(['base', 'bonus', 'total'])));
        $this->assertFalse($r['variety']);
    }

    public function test_dos_en_la_misma_zona_no_alcanzan(): void
    {
        $r = Combos::evaluate([$this->row(1, 1000), $this->row(2, 1000)]);
        $this->assertSame(2000, $r['total']);
        $this->assertSame([], $r['zones']);
    }

    public function test_los_escalones_de_zona_suben_el_ingreso_de_esas_propiedades(): void
    {
        $three = array_map(fn ($i) => $this->row($i, 1000), [1, 2, 3]);
        $this->assertSame(3300, Combos::evaluate($three)['total']); // +10 %

        $five = array_map(fn ($i) => $this->row($i, 1000), [1, 2, 3, 4, 5]);
        $this->assertSame(6000, Combos::evaluate($five)['total']); // +20 %

        $eight = array_map(fn ($i) => $this->row($i, 1000), range(1, 8));
        $this->assertSame(10400, Combos::evaluate($eight)['total']); // +30 %
    }

    public function test_el_bonus_de_zona_solo_toca_las_de_esa_zona(): void
    {
        $rows = [$this->row(1, 1000), $this->row(2, 1000), $this->row(3, 1000), $this->row(4, 5000, 'casa', -26.30, -58.17)];
        $r = Combos::evaluate($rows);
        $this->assertSame(8300, $r['total']);
        $this->assertCount(1, $r['zones']);
        $this->assertSame([1, 2, 3], $r['zones'][0]['ids']);
    }

    public function test_variedad_suma_diez_por_ciento_del_total_con_los_cuatro_tipos(): void
    {
        $rows = [
            $this->row(1, 1000, 'casa', -26.10), $this->row(2, 2000, 'comercio', -26.20),
            $this->row(3, 3000, 'supermercado', -26.30), $this->row(4, 4000, 'hotel', -26.40),
        ];
        $r = Combos::evaluate($rows);
        $this->assertTrue($r['variety']);
        $this->assertSame(1000, $r['variety_bonus']);
        $this->assertSame(11000, $r['total']);
        $this->assertFalse(Combos::evaluate(array_slice($rows, 0, 3))['variety']);
    }

    public function test_el_borde_de_la_celda_es_estable(): void
    {
        $deg = 0.0025;
        $this->assertSame(Combos::zoneKey(-26.18, -58.17, $deg), Combos::zoneKey(-26.18, -58.17, $deg));
        $this->assertNotSame(Combos::zoneKey(-26.18, -58.17, $deg), Combos::zoneKey(-26.18, -58.1725, $deg));
    }
}
