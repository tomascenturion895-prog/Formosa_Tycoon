<?php

namespace Tests\Feature;

use App\Formosa\DemoDistrict;
use App\Formosa\EnvironmentBuilder;
use App\Formosa\EnvironmentStore;
use App\Formosa\OverpassClient;
use App\Formosa\PropertyBuilder;
use App\Formosa\RoadsStore;
use App\Models\Property;
use Database\Seeders\DemoSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/** Entorno de la ciudad 3D: se arma desde OSM, se guarda al importar y se sirve en /api/entorno. */
class EnvironmentImportTest extends TestCase
{
    use RefreshDatabase;

    private const LNG = -58.18;

    private const LAT = -26.18;

    /** @var list<string> */
    private array $files = [];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
    }

    protected function tearDown(): void
    {
        foreach ($this->files as $f) {
            @unlink($f);
        }
        parent::tearDown();
    }

    /** Puntos de Overpass de un cuadrado de `$m` metros con esquina SO desplazada (dx, dy) metros. */
    private function square(float $dx, float $dy, float $m = 50, bool $close = true): array
    {
        $k = 1 / 111_000;
        $pts = [[$dx, $dy], [$dx + $m, $dy], [$dx + $m, $dy + $m], [$dx, $dy + $m]];
        if ($close) {
            $pts[] = [$dx, $dy];
        }

        return array_map(fn ($p) => ['lat' => self::LAT + $p[1] * $k, 'lon' => self::LNG + $p[0] * $k], $pts);
    }

    private function way(int $id, array $tags, ?array $geometry = null): array
    {
        return ['type' => 'way', 'id' => $id, 'tags' => $tags, 'geometry' => $geometry ?? $this->square(0, 0)];
    }

    private function node(int $id, array $tags): array
    {
        return ['type' => 'node', 'id' => $id, 'lat' => self::LAT, 'lon' => self::LNG, 'tags' => $tags];
    }

    /** @return array<int, array<string, mixed>> features por osm_id */
    private function byId(array $fc): array
    {
        $out = [];
        foreach ($fc['features'] as $f) {
            $out[$f['properties']['osm_id']] = $f;
        }

        return $out;
    }

    private function tempJson(array $data): string
    {
        $f = tempnam(sys_get_temp_dir(), 'env');
        file_put_contents($f, json_encode($data));

        return $this->files[] = $f;
    }

    public function test_clasifica_cada_tipo_del_entorno(): void
    {
        $fc = EnvironmentBuilder::build([
            $this->way(1, ['natural' => 'water', 'name' => 'Laguna']),
            $this->way(2, ['waterway' => 'riverbank']),
            $this->way(3, ['waterway' => 'river', 'name' => 'Riacho', 'width' => '30 m'], $this->square(0, 0, 50, false)),
            $this->way(4, ['leisure' => 'park', 'name' => 'Parque Siglo XXI']),
            $this->way(5, ['leisure' => 'park', 'name' => 'Plaza San Martín']),
            $this->way(6, ['place' => 'square']),
            $this->way(7, ['leisure' => 'garden']),
            $this->way(8, ['leisure' => 'pitch', 'sport' => 'soccer']),
            $this->way(9, ['leisure' => 'playground']),
            $this->way(10, ['landuse' => 'cemetery']),
            $this->node(11, ['highway' => 'traffic_signals']),
            $this->node(12, ['highway' => 'bus_stop', 'name' => 'Parada']),
            $this->node(13, ['highway' => 'crossing']),
            $this->node(14, ['public_transport' => 'platform', 'bus' => 'yes']),
            $this->way(15, ['building' => 'yes']), // un edificio común no es entorno
            $this->node(16, ['natural' => 'water']), // agua como punto: no se puede dibujar
        ]);
        $f = $this->byId($fc);

        $this->assertSame('FeatureCollection', $fc['type']);
        $kinds = array_map(fn ($x) => $x['properties']['kind'], $f);
        $this->assertSame([1 => 'water', 2 => 'water', 3 => 'river', 4 => 'park', 5 => 'plaza', 6 => 'plaza', 7 => 'park', 8 => 'pitch', 9 => 'playground', 10 => 'landuse',
            11 => 'signal', 12 => 'bus_stop', 13 => 'crossing', 14 => 'bus_stop'], $kinds);

        $this->assertSame('Polygon', $f[1]['geometry']['type']);
        $this->assertSame('Laguna', $f[1]['properties']['name']);
        $this->assertNull($f[2]['properties']['name']);
        $this->assertSame('LineString', $f[3]['geometry']['type']);
        $this->assertSame(30.0, $f[3]['properties']['width']);
        $this->assertSame('cemetery', $f[10]['properties']['landuse']);
        $this->assertSame('Point', $f[11]['geometry']['type']);
        $this->assertSame([self::LNG, self::LAT], $f[11]['geometry']['coordinates']);

        // Coordenadas con 6 decimales y anillos cerrados.
        $ring = $f[1]['geometry']['coordinates'][0];
        $this->assertSame($ring[0], $ring[count($ring) - 1]);
        foreach ($ring as [$lng, $lat]) {
            $this->assertSame(round($lng, 6), $lng);
            $this->assertSame(round($lat, 6), $lat);
        }
    }

    public function test_plaza_solo_si_es_place_square_o_parque_que_empieza_con_plaza(): void
    {
        $f = $this->byId(EnvironmentBuilder::build([
            $this->way(1, ['leisure' => 'park', 'name' => 'plaza Independencia']),
            $this->way(2, ['leisure' => 'park', 'name' => 'Parque de la Plaza']),
            $this->way(3, ['leisure' => 'park']),
            $this->way(4, ['place' => 'square', 'name' => 'Paseo']),
        ]));

        $this->assertSame('plaza', $f[1]['properties']['kind']);
        $this->assertSame('park', $f[2]['properties']['kind']);
        $this->assertSame('park', $f[3]['properties']['kind']);
        $this->assertSame('plaza', $f[4]['properties']['kind']);
    }

    public function test_detecta_los_edificios_emblematicos(): void
    {
        $f = $this->byId(EnvironmentBuilder::build([
            $this->way(1, ['building' => 'cathedral', 'amenity' => 'place_of_worship', 'name' => 'Catedral Nuestra Señora del Carmen']),
            $this->way(2, ['building' => 'government', 'name' => 'Casa de Gobierno']),
            $this->way(3, ['building' => 'yes', 'name' => 'Ex Estación del Ferrocarril']),
            $this->way(4, ['tourism' => 'museum', 'name' => 'Museo Histórico']),
            $this->way(5, ['amenity' => 'place_of_worship', 'name' => 'Parroquia San Francisco']),
            $this->node(6, ['historic' => 'monument', 'name' => 'Monumento a la Madre']),
            $this->way(7, ['building' => 'yes', 'name' => 'Puerto Formosa']),
            $this->way(8, ['building' => 'yes', 'name' => 'Estación de Servicio YPF', 'amenity' => 'fuel']), // no es la estación
            $this->way(9, ['amenity' => 'place_of_worship']), // templo sin nombre: no
            $this->way(10, ['building' => 'yes', 'name' => 'Terminal de Ómnibus']),
        ]));

        $landmarks = array_map(fn ($x) => $x['properties']['landmark'] ?? null, $f);
        $this->assertSame([1 => 'catedral', 2 => 'casa_gobierno', 3 => 'estacion', 4 => 'museo', 5 => 'iglesia', 6 => 'monumento', 7 => 'puerto', 10 => 'otro'], $landmarks);
        $this->assertSame('landmark', $f[1]['properties']['kind']);
        $this->assertSame('Polygon', $f[1]['geometry']['type']);
        $this->assertSame('Point', $f[6]['geometry']['type']);
    }

    public function test_arma_multipoligonos_uniendo_tramos_y_descarta_lo_degenerado(): void
    {
        $sq = $this->square(0, 0, 100);
        // El contorno exterior viene partido en dos tramos (uno al revés); el hueco se ignora.
        $relation = ['type' => 'relation', 'id' => 50, 'tags' => ['type' => 'multipolygon', 'natural' => 'water', 'name' => 'Río Paraguay'], 'members' => [
            ['type' => 'way', 'ref' => 1, 'role' => 'outer', 'geometry' => [$sq[0], $sq[1], $sq[2]]],
            ['type' => 'way', 'ref' => 2, 'role' => 'outer', 'geometry' => [$sq[0], $sq[3], $sq[2]]],
            ['type' => 'way', 'ref' => 3, 'role' => 'inner', 'geometry' => $this->square(40, 40, 10)],
        ]];
        $two = ['type' => 'relation', 'id' => 51, 'tags' => ['type' => 'multipolygon', 'leisure' => 'park'], 'members' => [
            ['type' => 'way', 'ref' => 4, 'role' => 'outer', 'geometry' => $this->square(0, 0)],
            ['type' => 'way', 'ref' => 5, 'role' => 'outer', 'geometry' => $this->square(200, 0)],
            ['type' => 'way', 'ref' => 6, 'role' => 'outer', 'geometry' => [$sq[0], $sq[1]]], // tramo suelto: no cierra
        ]];
        $f = $this->byId(EnvironmentBuilder::build([
            $relation, $two,
            $this->way(60, ['landuse' => 'grass'], $this->square(0, 0, 50, false)), // abierto: no es superficie
            $this->way(61, ['natural' => 'water'], [$sq[0], $sq[1], $sq[0]]),       // sin superficie
            $this->way(62, ['leisure' => 'pitch'], [['lat' => 'x', 'lon' => 1]]),   // basura
        ]));

        $this->assertSame([50, 51], array_keys($f));
        $this->assertSame('Polygon', $f[50]['geometry']['type']);
        $this->assertSame('water', $f[50]['properties']['kind']);
        $this->assertSame('Río Paraguay', $f[50]['properties']['name']);
        $this->assertCount(1, $f[50]['geometry']['coordinates'], 'sin huecos');
        $this->assertCount(5, $f[50]['geometry']['coordinates'][0]);
        $this->assertSame('MultiPolygon', $f[51]['geometry']['type']);
        $this->assertCount(2, $f[51]['geometry']['coordinates']);
    }

    public function test_recorta_las_superficies_a_la_zona_y_descarta_lo_de_afuera(): void
    {
        $k = 1 / 111_000;
        $box = ['south' => self::LAT, 'west' => self::LNG, 'north' => self::LAT + 100 * $k, 'east' => self::LNG + 100 * $k];
        $f = $this->byId(EnvironmentBuilder::build([
            $this->way(1, ['natural' => 'water'], $this->square(50, -500, 1000)),  // río enorme que sobresale
            $this->way(2, ['leisure' => 'park'], $this->square(10, 10, 20)),     // adentro: intacto
            $this->way(3, ['leisure' => 'park'], $this->square(500, 500, 20)),   // afuera
            $this->node(4, ['highway' => 'traffic_signals']),                    // en el borde: adentro
        ], $box));

        $this->assertSame([1, 2, 4], array_keys($f));
        foreach ($f[1]['geometry']['coordinates'][0] as [$lng, $lat]) {
            $this->assertGreaterThanOrEqual(round($box['west'] + 50 * $k, 6) - 1e-6, $lng);
            $this->assertLessThanOrEqual(round($box['east'], 6) + 1e-6, $lng);
            $this->assertGreaterThanOrEqual(round($box['south'], 6) - 1e-6, $lat);
            $this->assertLessThanOrEqual(round($box['north'], 6) + 1e-6, $lat);
        }
        $this->assertCount(5, $f[1]['geometry']['coordinates'][0], 'queda un rectángulo');
        $this->assertSame(EnvironmentBuilder::build([$this->way(2, ['leisure' => 'park'], $this->square(10, 10, 20))])['features'][0]['geometry'], $f[2]['geometry']);
    }

    public function test_importar_con_entorno_archivo_lo_guarda(): void
    {
        $buildings = $this->tempJson(['elements' => [$this->way(900, ['building' => 'house'], $this->square(0, 0, 10))]]);
        $env = $this->tempJson(['elements' => [$this->way(1, ['leisure' => 'park', 'name' => 'Plaza San Martín']), $this->node(2, ['highway' => 'traffic_signals'])]]);

        $this->artisan('formosa:importar', ['--archivo' => $buildings, '--entorno-archivo' => $env])
            ->expectsOutputToContain('2 elementos del entorno 3D')
            ->assertSuccessful();

        $stored = EnvironmentStore::get();
        $this->assertCount(2, $stored['features']);
        $this->assertSame('plaza', $stored['features'][0]['properties']['kind']);
        $this->assertSame(1, Property::count());
    }

    public function test_si_falla_el_entorno_la_importacion_sigue(): void
    {
        $buildings = $this->tempJson(['elements' => [$this->way(900, ['building' => 'house'], $this->square(0, 0, 10))]]);

        $this->artisan('formosa:importar', ['--archivo' => $buildings, '--entorno-archivo' => '/no/existe/entorno.json'])
            ->expectsOutputToContain('No se pudo obtener el entorno 3D')
            ->assertSuccessful();
        $this->assertSame(1, Property::count());
        $this->assertSame([], EnvironmentStore::get()['features']);
    }

    public function test_si_overpass_falla_con_el_entorno_se_importan_igual_edificios_y_calles(): void
    {
        $queries = [];
        Http::fake(function ($request) use (&$queries) {
            $q = (string) ($request->data()['data'] ?? '');
            $queries[] = $q;
            if (str_contains($q, 'traffic_signals')) {
                return Http::response('ocupado', 500);
            }
            if (str_contains($q, 'way["highway"')) {
                return Http::response(['elements' => [['type' => 'way', 'id' => 5, 'tags' => ['highway' => 'residential', 'oneway' => 'yes'], 'geometry' => $this->square(0, 0, 50, false)]]]);
            }

            return Http::response(['elements' => [$this->way(900, ['building' => 'house'], $this->square(0, 0, 10))]]);
        });

        $this->artisan('formosa:importar')->expectsOutputToContain('No se pudo obtener el entorno 3D')->assertSuccessful();

        $this->assertSame(1, Property::count());
        $this->assertSame(1, RoadsStore::get()['features'][0]['properties']['oneway']);
        $this->assertCount(3, $queries);

        // Calles y entorno se piden en la zona ampliada; los edificios, en la zona tal cual.
        $bbox = config('formosa.districts.'.config('formosa.default_district'));
        $wide = OverpassClient::expand($bbox, 500);
        $this->assertLessThan($bbox['south'], $wide['south']);
        $this->assertGreaterThan($bbox['east'], $wide['east']);
        $this->assertStringContainsString((string) $bbox['south'], $queries[0]);
        $this->assertStringContainsString((string) $wide['south'], $queries[1]);
        $this->assertStringContainsString((string) $wide['west'], $queries[2]);
        $this->assertEqualsWithDelta(1000, ($wide['north'] - $wide['south'] - ($bbox['north'] - $bbox['south'])) * 111_195, 2);
    }

    public function test_api_entorno_vacia_y_con_datos(): void
    {
        $res = $this->getJson('/api/entorno')->assertOk()->assertJsonPath('type', 'FeatureCollection')->assertJsonCount(0, 'features');
        $this->assertEmpty($res->headers->getCookies(), 'lectura pública sin cookies');

        EnvironmentStore::put(EnvironmentBuilder::build([$this->way(1, ['leisure' => 'park', 'name' => 'Plaza San Martín'])]));
        $res = $this->getJson('/api/entorno')->assertOk()->assertJsonCount(1, 'features')
            ->assertJsonPath('features.0.properties.kind', 'plaza')
            ->assertJsonPath('features.0.properties.name', 'Plaza San Martín');
        $this->assertStringContainsString('max-age=300', $res->headers->get('Cache-Control'));
        $this->assertStringContainsString('public', $res->headers->get('Cache-Control'));
        $this->assertNotNull($res->headers->get('Last-Modified'));
        $this->assertSame(route('api.entorno', absolute: false), '/api/entorno');
    }

    public function test_el_barrio_de_ejemplo_trae_bulevar_peatonal_tierra_y_entorno(): void
    {
        $this->seed(DemoSeeder::class);
        $this->assertGreaterThan(0, Property::count());

        $roads = $this->getJson('/api/calles')->assertOk()->json('features');
        $bulevar = array_values(array_filter($roads, fn ($f) => $f['properties']['name'] === 'Avenida 25 de Mayo'));
        $this->assertCount(2, $bulevar, 'dos manos de sentido único');
        foreach ($bulevar as $f) {
            $this->assertSame(1, $f['properties']['oneway']);
            $this->assertSame(2, $f['properties']['lanes']);
        }
        // Las dos manos van en sentidos opuestos, a ~14 m.
        $a = $bulevar[0]['geometry']['coordinates'];
        $b = $bulevar[1]['geometry']['coordinates'];
        $this->assertLessThan(0, ($a[1][0] - $a[0][0]) * ($b[1][0] - $b[0][0]));
        $this->assertEqualsWithDelta(14, abs($a[0][1] - $b[0][1]) * 111_195, 0.5);

        $this->assertContains('pedestrian', array_map(fn ($f) => $f['properties']['highway'], array_filter($roads, fn ($f) => $f['properties']['name'] === 'Rivadavia')));
        $this->assertGreaterThan(0, count(array_filter($roads, fn ($f) => $f['properties']['surface'] === 'unpaved')));

        $env = $this->getJson('/api/entorno')->assertOk()->json('features');
        $kinds = array_count_values(array_map(fn ($f) => $f['properties']['kind'], $env));
        $this->assertSame(1, $kinds['water']);
        $this->assertSame(2, $kinds['plaza']);
        $this->assertSame(6, $kinds['signal']);
        $this->assertGreaterThanOrEqual(3, $kinds['bus_stop']);
        $landmarks = array_column(array_column(array_filter($env, fn ($f) => $f['properties']['kind'] === 'landmark'), 'properties'), 'landmark');
        sort($landmarks);
        $this->assertSame(['casa_gobierno', 'catedral', 'estacion'], $landmarks);
        $names = array_column(array_column($env, 'properties'), 'name');
        $this->assertContains('Plaza San Martín', $names);
        $this->assertContains('Río Paraguay', $names);
    }

    public function test_el_barrio_de_ejemplo_es_repetible_y_no_tiene_lotes_en_la_plaza(): void
    {
        $a = DemoDistrict::elements(-26.183, -58.178);
        $this->assertSame($a, DemoDistrict::elements(-26.183, -58.178));

        $env = EnvironmentBuilder::build($a['environment']);
        $plaza = array_values(array_filter($env['features'], fn ($f) => $f['properties']['name'] === 'Plaza San Martín'))[0];
        $ring = $plaza['geometry']['coordinates'][0];
        foreach (PropertyBuilder::build($a['buildings'], 'demo')['rows'] as $row) {
            $this->assertFalse(\App\Formosa\Geo::pointInRing($row['lng'], $row['lat'], $ring), 'no hay casas dentro de la plaza');
        }
    }
}
