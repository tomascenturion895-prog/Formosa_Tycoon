<?php

namespace Tests\Feature;

use App\Formosa\PropertyBuilder;
use Tests\TestCase;

/** Las calles guardan las etiquetas de OSM que usa la ciudad 3D (sentido, carriles, ancho, calzada…). */
class RoadTagsTest extends TestCase
{
    private function road(array $tags, int $id = 1): array
    {
        $fc = PropertyBuilder::roads([['type' => 'way', 'id' => $id, 'tags' => ['highway' => 'residential'] + $tags, 'geometry' => [['lat' => -26.18, 'lon' => -58.18], ['lat' => -26.181, 'lon' => -58.18]]]]);

        return $fc['features'][0]['properties'];
    }

    public function test_sin_etiquetas_extra_quedan_valores_por_defecto(): void
    {
        $p = $this->road(['name' => 'Calle X'], 77);

        $this->assertSame(['highway' => 'residential', 'name' => 'Calle X', 'oneway' => 0, 'lanes' => null, 'width' => null, 'surface' => null, 'maxspeed' => null, 'junction' => null, 'bridge' => false, 'osm_id' => 77], $p);
    }

    public function test_sentido_unico(): void
    {
        foreach (['yes' => 1, '1' => 1, 'true' => 1, 'YES' => 1, '-1' => -1, 'reverse' => -1, 'no' => 0, 'algo' => 0] as $v => $want) {
            $this->assertSame($want, $this->road(['oneway' => (string) $v])['oneway'], "oneway={$v}");
        }
        $round = $this->road(['junction' => 'roundabout']);
        $this->assertSame(1, $round['oneway'], 'una rotonda es mano única');
        $this->assertSame('roundabout', $round['junction']);
        $this->assertSame(0, $this->road(['junction' => 'roundabout', 'oneway' => 'no'])['oneway']);
        $this->assertNull($this->road(['junction' => 'yes'])['junction']);
    }

    public function test_carriles_ancho_y_velocidad(): void
    {
        $this->assertSame(2, $this->road(['lanes' => '2'])['lanes']);
        $this->assertSame(3, $this->road(['lanes' => '3;2'])['lanes']);
        $this->assertNull($this->road(['lanes' => 'muchos'])['lanes']);
        $this->assertNull($this->road(['lanes' => '0'])['lanes']);

        foreach (['7' => 7.0, '7 m' => 7.0, '7.5' => 7.5, '7,5' => 7.5, '12m' => 12.0] as $v => $want) {
            $this->assertSame($want, $this->road(['width' => (string) $v])['width'], "width={$v}");
        }
        foreach (['20\'', '7 ft', 'ancho', '0', '500'] as $v) {
            $this->assertNull($this->road(['width' => $v])['width'], "width={$v}");
        }

        $this->assertSame(40, $this->road(['maxspeed' => '40'])['maxspeed']);
        $this->assertSame(60, $this->road(['maxspeed' => '60 km/h'])['maxspeed']);
        $this->assertSame(48, $this->road(['maxspeed' => '30 mph'])['maxspeed']);
        $this->assertNull($this->road(['maxspeed' => 'AR:urban'])['maxspeed']);
        $this->assertNull($this->road(['maxspeed' => 'none'])['maxspeed']);
    }

    public function test_calzada_puente_e_id(): void
    {
        $cases = ['asphalt' => 'asphalt', 'paved' => 'paved', 'concrete:plates' => 'concrete', 'paving_stones' => 'paving_stones', 'cobblestone' => 'sett',
            'unpaved' => 'unpaved', 'compacted' => 'unpaved', 'dirt' => 'dirt', 'earth' => 'dirt', 'gravel' => 'gravel', 'ground' => 'ground', 'Asphalt' => 'asphalt', 'plastico' => null];
        foreach ($cases as $v => $want) {
            $this->assertSame($want, $this->road(['surface' => $v])['surface'], "surface={$v}");
        }

        $this->assertTrue($this->road(['bridge' => 'yes'])['bridge']);
        $this->assertTrue($this->road(['bridge' => 'viaduct'])['bridge']);
        $this->assertFalse($this->road(['bridge' => 'no'])['bridge']);
        $this->assertSame(123456789012, $this->road([], 123456789012)['osm_id']);
    }
}
