<?php

namespace Tests\Unit\Formosa;

use App\Enums\PropertyKind;
use App\Formosa\Pricing;
use Tests\TestCase;

class PricingTest extends TestCase
{
    public function test_superficie_tipica_da_el_precio_base(): void
    {
        $this->assertSame(['price' => 10000, 'income' => 2500], Pricing::for(PropertyKind::Casa, 120));
        $this->assertSame(['price' => 400000, 'income' => 80000], Pricing::for(PropertyKind::Hotel, 600));
    }

    public function test_sin_superficie_usa_el_precio_base(): void
    {
        $this->assertSame(40000, Pricing::for(PropertyKind::Comercio, null)['price']);
    }

    public function test_el_factor_de_superficie_tiene_techo_y_piso(): void
    {
        $this->assertSame(20000, Pricing::for(PropertyKind::Casa, 100000)['price']); // techo x2
        $this->assertSame(6000, Pricing::for(PropertyKind::Casa, 1)['price']);       // piso x0,6
    }

    public function test_el_precio_es_multiplo_del_paso_y_nunca_cero(): void
    {
        foreach (PropertyKind::cases() as $kind) {
            foreach ([0.5, 25.0, 133.0, 333.3, 777.7, 2500.0] as $area) {
                $p = Pricing::for($kind, $area);
                $this->assertSame(0, $p['price'] % 500, "precio {$p['price']} no es multiplo de 500");
                $this->assertGreaterThan(0, $p['price']);
                $this->assertGreaterThan(0, $p['income']);
            }
        }
    }

    public function test_el_ingreso_recupera_el_precio_en_3_a_6_dias_de_juego(): void
    {
        // Objetivo de balance de la partida de 40 min (20 días de juego): recupero base entre 3 y 6 días por propiedad (con combos baja).
        foreach (PropertyKind::cases() as $kind) {
            $p = Pricing::for($kind, config("formosa.kinds.{$kind->value}.typical_area"));
            $days = $p['price'] / $p['income'];
            $this->assertGreaterThanOrEqual(3.0, $days, "{$kind->value} recupera en {$days} días");
            $this->assertLessThanOrEqual(6.0, $days, "{$kind->value} recupera en {$days} días");
        }
    }

    public function test_lo_barato_se_recupera_antes_y_lo_caro_rinde_mas_plata(): void
    {
        $r = fn (PropertyKind $k) => Pricing::for($k, config("formosa.kinds.{$k->value}.typical_area"));
        $payback = fn (PropertyKind $k) => $r($k)['price'] / $r($k)['income'];

        $this->assertLessThan($payback(PropertyKind::Hotel), $payback(PropertyKind::Casa));
        $this->assertGreaterThan($r(PropertyKind::Casa)['income'], $r(PropertyKind::Hotel)['income']);
    }
}
