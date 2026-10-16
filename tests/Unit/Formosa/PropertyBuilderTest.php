<?php

namespace Tests\Unit\Formosa;

use App\Formosa\DemoDistrict;
use App\Formosa\Geo;
use App\Formosa\PropertyBuilder;
use Tests\TestCase;

class PropertyBuilderTest extends TestCase
{
    private const LNG = -58.18;

    private const LAT = -26.18;

    /** Edificio rectangular en formato Overpass, con esquina en (dx, dy) metros del origen. */
    private function way(int $id, array $tags, float $dx, float $dy, float $w, float $h): array
    {
        $p = fn ($x, $y) => Geo::offset(self::LNG, self::LAT, $x, $y);
        $pts = [$p($dx, $dy), $p($dx + $w, $dy), $p($dx + $w, $dy + $h), $p($dx, $dy + $h), $p($dx, $dy)];

        return ['type' => 'way', 'id' => $id, 'tags' => $tags, 'geometry' => array_map(fn ($q) => ['lat' => $q[1], 'lon' => $q[0]], $pts)];
    }

    private function node(int $id, array $tags, float $dx, float $dy): array
    {
        [$lng, $lat] = Geo::offset(self::LNG, self::LAT, $dx, $dy);

        return ['type' => 'node', 'id' => $id, 'lat' => $lat, 'lon' => $lng, 'tags' => $tags];
    }

    private function byId(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $out["{$r['osm_type']}/{$r['osm_id']}"] = $r;
        }

        return $out;
    }

    public function test_una_casa_queda_sin_nombre_aunque_osm_lo_traiga(): void
    {
        $r = PropertyBuilder::build([$this->way(1, ['building' => 'house', 'name' => 'Casa de Juan Pérez', 'addr:street' => 'Calle 5', 'addr:housenumber' => '123'], 0, 0, 10, 12)], 'z');

        $this->assertCount(1, $r['rows']);
        $row = $r['rows'][0];
        $this->assertSame('casa', $row['kind']);
        $this->assertNull($row['name']);              // privacidad
        $this->assertSame('Calle 5', $row['street']); // calle sí, número no
        $this->assertArrayNotHasKey('housenumber', $row);
        $this->assertSame('osm', $row['footprint']);
        $this->assertEqualsWithDelta(120.0, $row['area_m2'], 2.0);
        $this->assertSame(10000, $row['price']);
        $this->assertSame('z', $row['district']);
    }

    public function test_la_geometria_se_guarda_como_poligono_geojson_cerrado(): void
    {
        $row = PropertyBuilder::build([$this->way(1, ['building' => 'house'], 0, 0, 10, 12)], 'z')['rows'][0];
        $geo = json_decode($row['geometry'], true);

        $this->assertSame('Polygon', $geo['type']);
        $this->assertSame($geo['coordinates'][0][0], $geo['coordinates'][0][4]);
    }

    public function test_un_anillo_abierto_se_cierra(): void
    {
        $way = $this->way(1, ['building' => 'house'], 0, 0, 10, 12);
        array_pop($way['geometry']); // sin el punto de cierre

        $row = PropertyBuilder::build([$way], 'z')['rows'][0];
        $ring = json_decode($row['geometry'], true)['coordinates'][0];

        $this->assertSame($ring[0], end($ring));
    }

    public function test_edificio_sin_tipo_se_cuenta_pero_no_se_guarda(): void
    {
        $r = PropertyBuilder::build([
            $this->way(1, ['building' => 'yes'], 0, 0, 3, 3),         // 9 m²: demasiado chico
            $this->way(2, ['building' => 'church'], 50, 0, 20, 20),
        ], 'z');

        $this->assertSame([], $r['rows']);
        $this->assertSame(2, $r['stats']['edificios_sin_tipo']);
    }

    public function test_un_comercio_mapeado_como_punto_dentro_de_un_edificio_lo_convierte_en_comercio(): void
    {
        $r = PropertyBuilder::build([
            $this->way(10, ['building' => 'yes'], 0, 0, 20, 25),
            $this->node(11, ['shop' => 'bakery', 'name' => 'Panadería Sol'], 10, 12),
        ], 'z');

        $this->assertCount(1, $r['rows']); // no se duplica
        $this->assertSame('comercio', $r['rows'][0]['kind']);
        $this->assertSame('Panadería Sol', $r['rows'][0]['name']);
        $this->assertSame('way', $r['rows'][0]['osm_type']);
        $this->assertSame(1, $r['stats']['puntos_en_edificio']);
    }

    public function test_un_comercio_en_un_punto_fuera_de_todo_edificio_recibe_una_huella_sintetica(): void
    {
        $r = PropertyBuilder::build([$this->node(20, ['shop' => 'kiosk', 'name' => 'Kiosco Norte'], 500, 500)], 'z');

        $this->assertCount(1, $r['rows']);
        $row = $r['rows'][0];
        $this->assertSame('node', $row['osm_type']);
        $this->assertSame('sintetica', $row['footprint']);
        $this->assertEqualsWithDelta(144.0, $row['area_m2'], 1.0);
        $this->assertSame(1, $r['stats']['puntos_sinteticos']);
    }

    public function test_un_punto_sin_tipo_comercial_se_ignora(): void
    {
        $r = PropertyBuilder::build([$this->node(21, ['amenity' => 'bench'], 5, 5)], 'z');

        $this->assertSame([], $r['rows']);
    }

    public function test_gana_el_tipo_de_mayor_prioridad_dentro_del_mismo_edificio(): void
    {
        $r = PropertyBuilder::build([
            $this->way(30, ['building' => 'retail', 'shop' => 'clothes'], 0, 0, 40, 40),
            $this->node(31, ['shop' => 'supermarket', 'name' => 'Super Centro'], 20, 20),
        ], 'z');

        $this->assertSame('supermercado', $r['rows'][0]['kind']);
        $this->assertSame('Super Centro', $r['rows'][0]['name']);
    }

    public function test_si_hay_edificios_anidados_el_punto_va_al_mas_chico(): void
    {
        $r = PropertyBuilder::build([
            $this->way(40, ['building' => 'yes'], 0, 0, 40, 40),           // galpón grande: queda sin tipo
            $this->way(41, ['building' => 'yes'], 10, 10, 10, 12),         // local chico adentro
            $this->node(42, ['shop' => 'kiosk'], 15, 16),
        ], 'z');

        $byId = $this->byId($r['rows']);
        $this->assertSame('comercio', $byId['way/41']['kind']);
        $this->assertArrayNotHasKey('way/40', $byId); // 1600 m²: galpón sin tipo, no es propiedad
        $this->assertSame(1, $r['stats']['edificios_sin_tipo']);
        $this->assertSame(1, $r['stats']['puntos_en_edificio']);
    }

    public function test_los_textos_de_osm_se_limpian_y_se_recortan(): void
    {
        $dirty = "Super\x00\x07Mercado\n".str_repeat('x', 300);
        $r = PropertyBuilder::build([$this->way(50, ['building' => 'retail', 'shop' => 'convenience', 'name' => $dirty], 0, 0, 12, 12)], 'z');

        $name = $r['rows'][0]['name'];
        $this->assertLessThanOrEqual(120, mb_strlen($name));
        $this->assertDoesNotMatchRegularExpression('/[\x00-\x1F]/', $name);
        $this->assertStringStartsWith('Super', $name);
    }

    public function test_calles_solo_las_vehiculares_y_con_coordenadas_redondeadas(): void
    {
        $road = fn (int $id, string $hw) => ['type' => 'way', 'id' => $id, 'tags' => ['highway' => $hw, 'name' => 'Calle X'], 'geometry' => [['lat' => -26.1800001234, 'lon' => -58.1800009999], ['lat' => -26.19, 'lon' => -58.19]]];
        $fc = PropertyBuilder::roads([$road(1, 'residential'), $road(2, 'footway'), $road(3, 'primary'), ['type' => 'way', 'id' => 4, 'tags' => ['highway' => 'service'], 'geometry' => [['lat' => 1, 'lon' => 1]]]]);

        $this->assertSame('FeatureCollection', $fc['type']);
        $this->assertCount(2, $fc['features']); // footway fuera; el tramo de 1 punto fuera
        $this->assertSame([-58.180001, -26.18], $fc['features'][0]['geometry']['coordinates'][0]);
    }

    public function test_el_barrio_de_ejemplo_genera_los_cuatro_tipos_y_es_repetible(): void
    {
        $demo = DemoDistrict::elements(-26.183, -58.178);
        $a = PropertyBuilder::build($demo['buildings'], 'demo');
        $b = PropertyBuilder::build(DemoDistrict::elements(-26.183, -58.178)['buildings'], 'demo');

        $this->assertSame($a['rows'], $b['rows']); // determinista
        foreach (['casa', 'comercio', 'supermercado', 'hotel'] as $kind) {
            $this->assertGreaterThan(0, $a['stats'][$kind], "falta {$kind} en el barrio de ejemplo");
        }
        $this->assertGreaterThan(0, $a['stats']['puntos_en_edificio']);
        $this->assertGreaterThan(0, $a['stats']['puntos_sinteticos']);
        $this->assertCount(count($a['rows']), $this->byId($a['rows'])); // sin ids repetidos

        $roads = PropertyBuilder::roads($demo['roads']);
        $this->assertCount(DemoDistrict::BLOCKS_X + DemoDistrict::BLOCKS_Y + 2, $roads['features']);
    }
}
