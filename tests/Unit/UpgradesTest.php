<?php

namespace Tests\Unit;

use App\Economy\Upgrades;
use InvalidArgumentException;
use Tests\TestCase;

class UpgradesTest extends TestCase
{
    public function test_ingreso_nivel_cero_no_cambia(): void
    {
        $this->assertSame(1200, Upgrades::rowIncome('casa', 1000, 0, null, 1.2));
    }

    public function test_nivel_uno_suma_bruto_y_resta_mantenimiento(): void
    {
        $this->assertSame(1350, Upgrades::rowIncome('casa', 1000, 1, null, 1.0)); // 1400 - 50
    }

    public function test_rama_a_y_b_del_nivel_dos(): void
    {
        $this->assertSame(1800, Upgrades::rowIncome('casa', 1000, 2, 'a', 1.0)); // 2100 - 300
        $this->assertSame(1650, Upgrades::rowIncome('casa', 1000, 2, 'b', 1.0)); // 1750 - 100
    }

    public function test_el_mantenimiento_no_se_multiplica_con_el_sprint(): void
    {
        $this->assertSame(2750, Upgrades::rowIncome('casa', 1000, 1, null, 2.0)); // floor(1400 * 2) - 50
    }

    public function test_el_ingreso_nunca_baja_de_cero(): void
    {
        $this->assertSame(0, Upgrades::rowIncome('casa', 1000, 2, 'a', 0.0));
    }

    public function test_mayorista_amortigua_solo_las_crisis(): void
    {
        $this->assertEqualsWithDelta(0.8, Upgrades::dampenFactor('comercio', 2, 'b', 0.6), 1e-9);
        $this->assertEqualsWithDelta(1.5, Upgrades::dampenFactor('comercio', 2, 'b', 1.5), 1e-9);
        $this->assertEqualsWithDelta(0.6, Upgrades::dampenFactor('casa', 2, 'b', 0.6), 1e-9);
        $this->assertEqualsWithDelta(0.6, Upgrades::dampenFactor('comercio', 2, 'a', 0.6), 1e-9);
    }

    public function test_costo_con_y_sin_descuento(): void
    {
        $this->assertSame(20000, Upgrades::cost(40000, 1, null, false));
        $this->assertSame(16000, Upgrades::cost(40000, 1, null, true));
        $this->assertSame(24000, Upgrades::cost(40000, 2, 'b', false));
        $this->assertSame(19200, Upgrades::cost(40000, 2, 'b', true));
    }

    public function test_peso_de_zona_solo_en_edificio_de_departamentos(): void
    {
        $this->assertSame(2, Upgrades::zoneWeight('casa', 2, 'b'));
        $this->assertSame(1, Upgrades::zoneWeight('casa', 2, 'a'));
        $this->assertSame(1, Upgrades::zoneWeight('casa', 1, null));
        $this->assertSame(1, Upgrades::zoneWeight('comercio', 2, 'b'));
    }

    public function test_descuento_solo_con_centro_logistico(): void
    {
        $this->assertTrue(Upgrades::hasDiscount([['kind' => 'supermercado', 'level' => 2, 'branch' => 'b']]));
        $this->assertFalse(Upgrades::hasDiscount([['kind' => 'supermercado', 'level' => 2, 'branch' => 'a'], ['kind' => 'casa', 'level' => 2, 'branch' => 'b'], ['kind' => 'supermercado', 'level' => 1, 'branch' => null]]));
        $this->assertFalse(Upgrades::hasDiscount([]));
    }

    public function test_valor_del_activo_cuenta_la_mitad_de_lo_invertido(): void
    {
        $this->assertSame(12500, Upgrades::assetValue(10000, 5001));
        $this->assertSame(10000, Upgrades::assetValue(10000, 0));
    }

    public function test_las_opciones_siguientes_segun_el_estado(): void
    {
        $zero = Upgrades::next('casa', 0, null, 2500, 10000, false);
        $this->assertCount(1, $zero);
        $this->assertSame(1, $zero[0]['level']);
        $this->assertSame(5000, $zero[0]['cost']);
        $this->assertSame(3500, $zero[0]['gross']);
        $this->assertSame(125, $zero[0]['maintenance']);
        $this->assertSame(3375, $zero[0]['net']);

        $one = Upgrades::next('casa', 1, null, 2500, 10000, false);
        $this->assertSame(['a', 'b'], array_column($one, 'branch'));
        $this->assertSame('Alquiler turístico', $one[0]['label']);

        $this->assertSame([], Upgrades::next('casa', 2, 'a', 2500, 10000, false));
    }

    public function test_option_rechaza_combinaciones_invalidas(): void
    {
        foreach ([[0, null], [1, 'a'], [2, null], [2, 'c']] as [$level, $branch]) {
            try {
                Upgrades::option('casa', $level, $branch);
                $this->fail("debió rechazar nivel {$level} rama ".var_export($branch, true));
            } catch (InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_bandas_de_recupero_para_los_cuatro_tipos(): void
    {
        foreach (config('formosa.kinds') as $kind => $k) {
            $price = (int) $k['base_price'];
            $base = (int) round($price * $k['rate_per_day']);
            $floor = 1 / $k['rate_per_day'];
            $n1 = Upgrades::paybackDays($kind, 1, null, $base, $price, false, 0, null);
            $a = Upgrades::paybackDays($kind, 2, 'a', $base, $price, false, 1, null);
            $b = Upgrades::paybackDays($kind, 2, 'b', $base, $price, false, 1, null);
            $this->assertGreaterThanOrEqual(5, $n1, "$kind nivel 1");
            $this->assertLessThanOrEqual(8, $n1, "$kind nivel 1");
            $this->assertGreaterThanOrEqual(6, $a, "$kind A");
            $this->assertLessThanOrEqual(10, $a, "$kind A");
            $this->assertGreaterThanOrEqual(7, $b, "$kind B");
            $this->assertLessThanOrEqual(11, $b, "$kind B");
            foreach ([$n1, $a, $b] as $days) {
                $this->assertGreaterThan($floor, $days, "$kind: una mejora no puede rendir más que comprar otra");
            }
        }
    }

    public function test_sin_ganancia_el_recupero_es_nulo_y_se_puede_codificar(): void
    {
        $opt = Upgrades::next('casa', 0, null, 0, 10000, false)[0]; // propiedad sin ingreso de lista
        $this->assertNull($opt['payback_days']);
        $this->assertIsString(json_encode($opt));
        $this->assertSame(INF, Upgrades::paybackDays('casa', 1, null, 0, 10000, false, 0, null));
    }
}
