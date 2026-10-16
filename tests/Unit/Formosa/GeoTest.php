<?php

namespace Tests\Unit\Formosa;

use App\Formosa\Geo;
use PHPUnit\Framework\TestCase;

class GeoTest extends TestCase
{
    /** Rectángulo de $w × $h metros con esquina inferior izquierda en (-58.18, -26.18). */
    private function rect(float $w, float $h): array
    {
        $sw = [-58.18, -26.18];
        $se = Geo::offset($sw[0], $sw[1], $w, 0);
        $ne = Geo::offset($sw[0], $sw[1], $w, $h);
        $nw = Geo::offset($sw[0], $sw[1], 0, $h);

        return [$sw, $se, $ne, $nw, $sw];
    }

    public function test_area_de_un_rectangulo_de_100_por_50_metros(): void
    {
        $m = Geo::areaAndCentroid($this->rect(100, 50));

        $this->assertEqualsWithDelta(5000.0, $m['area'], 5000 * 0.01); // 1 % de tolerancia
    }

    public function test_centroide_de_un_rectangulo_esta_en_su_centro(): void
    {
        $ring = $this->rect(100, 50);
        $m = Geo::areaAndCentroid($ring);
        [$cx, $cy] = Geo::offset(-58.18, -26.18, 50, 25);

        $this->assertEqualsWithDelta($cx, $m['lng'], 1e-6);
        $this->assertEqualsWithDelta($cy, $m['lat'], 1e-6);
    }

    public function test_el_sentido_del_anillo_no_cambia_el_area(): void
    {
        $ring = $this->rect(40, 30);
        $a = Geo::areaAndCentroid($ring)['area'];
        $b = Geo::areaAndCentroid(array_reverse($ring))['area'];

        $this->assertEqualsWithDelta($a, $b, 1e-6);
    }

    public function test_un_anillo_abierto_se_cierra_solo(): void
    {
        $open = array_slice($this->rect(20, 20), 0, 4);
        $m = Geo::areaAndCentroid($open);

        $this->assertEqualsWithDelta(400.0, $m['area'], 4.0);
        $this->assertSame(Geo::close($open), Geo::close(Geo::close($open)));
    }

    public function test_puntos_en_linea_dan_area_cero_sin_dividir_por_cero(): void
    {
        $m = Geo::areaAndCentroid([[-58.18, -26.18], [-58.179, -26.18], [-58.178, -26.18], [-58.18, -26.18]]);

        $this->assertSame(0.0, $m['area']);
    }

    public function test_punto_dentro_y_fuera_de_un_anillo(): void
    {
        $ring = $this->rect(100, 50);
        [$inLng, $inLat] = Geo::offset(-58.18, -26.18, 50, 25);
        [$outLng, $outLat] = Geo::offset(-58.18, -26.18, 150, 25);

        $this->assertTrue(Geo::pointInRing($inLng, $inLat, $ring));
        $this->assertFalse(Geo::pointInRing($outLng, $outLat, $ring));
    }

    public function test_cuadrado_alrededor_de_un_punto_tiene_el_lado_pedido(): void
    {
        $ring = Geo::squareAround(-58.18, -26.18, 12);
        $m = Geo::areaAndCentroid($ring);

        $this->assertEqualsWithDelta(144.0, $m['area'], 1.5);
        $this->assertEqualsWithDelta(-58.18, $m['lng'], 1e-7);
        $this->assertEqualsWithDelta(-26.18, $m['lat'], 1e-7);
        $this->assertSame($ring[0], $ring[4]);
    }

    public function test_bbox_devuelve_oeste_sur_este_norte(): void
    {
        [$w, $s, $e, $n] = Geo::bbox([[-58.2, -26.1], [-58.1, -26.1], [-58.1, -26.3], [-58.2, -26.1]]);

        $this->assertSame([-58.2, -26.3, -58.1, -26.1], [$w, $s, $e, $n]);
    }
}
