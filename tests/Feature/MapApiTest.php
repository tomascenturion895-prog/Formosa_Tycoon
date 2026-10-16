<?php

namespace Tests\Feature;

use App\Formosa\RoadsStore;
use App\Models\Property;
use Database\Seeders\DemoSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

class MapApiTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $this->withoutVite();
    }

    public function test_la_raiz_redirige_al_mapa_y_el_mapa_carga(): void
    {
        $this->get('/')->assertRedirect('/mapa');
        $this->get('/mapa')->assertOk()->assertDontSee('id="map"', false); // el lobby no carga el mapa
        $this->get('/explorar')->assertOk()->assertSee('id="map"', false);
    }

    public function test_propiedades_devuelve_un_feature_collection_con_etag(): void
    {
        $this->seed(DemoSeeder::class);

        $res = $this->getJson('/api/propiedades')->assertOk();
        $json = $res->json();
        $this->assertSame('FeatureCollection', $json['type']);
        $this->assertCount(Property::count(), $json['features']);

        $f = $json['features'][0];
        $this->assertSame($f['id'], $f['properties']['id'], 'promoteId necesita el id también en properties');
        $this->assertSame('Polygon', $f['geometry']['type']);
        $this->assertArrayNotHasKey('owner_id', $f['properties'], 'el dueño va por /api/partidas/{id}/propiedades/estado, no acá');

        $etag = $res->headers->get('ETag');
        $this->assertNotEmpty($etag);
        $this->getJson('/api/propiedades', ['If-None-Match' => $etag])->assertStatus(304);
    }

    public function test_el_etag_cambia_si_se_reimporta(): void
    {
        $this->seed(DemoSeeder::class);
        $etag = $this->getJson('/api/propiedades')->headers->get('ETag');

        DB::table('properties')->where('id', Property::query()->value('id'))->update(['updated_at' => now()->addMinute()]);

        $this->assertNotSame($etag, $this->getJson('/api/propiedades')->headers->get('ETag'));
    }

    public function test_estado_lista_solo_las_propiedades_con_dueno_de_esa_partida(): void
    {
        $this->seed(DemoSeeder::class);
        config(['formosa.auction.dispute_seconds' => 0]);
        $ana = \App\Models\User::factory()->create(['name' => 'Anita']);
        $beto = \App\Models\User::factory()->create(['name' => 'Betito']);
        $match = $this->startedMatch([$ana], 50000);
        $otra = $this->startedMatch([$beto], 50000);
        $free = Property::where('price', '<=', 50000)->orderBy('id')->take(2)->get();
        $economy = app(\App\Economy\EconomyService::class);
        $economy->buy($ana, $match->id, $free[0]->id);
        $economy->buy($beto, $otra->id, $free[1]->id);

        $res = $this->getJson("/api/partidas/{$match->id}/propiedades/estado")->assertOk();
        $this->assertSame([['id' => $free[0]->id, 'owner_id' => $ana->id, 'owner' => 'Anita']], $res->json('owned'), 'solo lo de ESTA partida');
        $this->assertSame($match->id, $res->json('match_id'));
        $this->assertSame(['id', 'owner_id', 'owner'], array_keys($res->json('owned.0')));
        $this->assertStringContainsString('no-cache', $res->headers->get('Cache-Control'), 'el navegador siempre revalida');
        $this->assertStringNotContainsString('@', $res->getContent(), 'no se filtran emails');
        $this->getJson("/api/partidas/{$otra->id}/propiedades/estado")->assertOk()->assertJsonPath('owned.0.id', $free[1]->id);
        $this->getJson('/api/partidas/999999/propiedades/estado')->assertNotFound()->assertJsonPath('error', 'partida_inexistente');
    }

    public function test_el_estado_global_viejo_ya_no_existe(): void
    {
        $this->getJson('/api/propiedades/estado')->assertNotFound();
    }

    public function test_estado_se_arma_una_vez_por_version_y_responde_304_si_no_cambio(): void
    {
        $this->seed(DemoSeeder::class);
        config(['formosa.auction.dispute_seconds' => 0]);
        $user = \App\Models\User::factory()->create(['name' => 'Nueva']);
        $match = $this->startedMatch([$user], 50000);
        $url = "/api/partidas/{$match->id}/propiedades/estado";
        $first = $this->getJson($url)->assertOk();
        $etag = $first->headers->get('ETag');

        $this->getJson($url, ['If-None-Match' => $etag])->assertStatus(304);

        // Una compra sube la versión: el ETag cambia y el dueño nuevo aparece enseguida.
        $free = Property::where('price', '<=', 50000)->firstOrFail();
        $this->actingAs($user)->postJson("/api/partidas/{$match->id}/propiedades/{$free->id}/comprar")->assertOk();

        $after = $this->getJson($url, ['If-None-Match' => $etag])->assertOk();
        $this->assertNotSame($etag, $after->headers->get('ETag'));
        $this->assertContains($free->id, array_column($after->json('owned'), 'id'));
    }

    public function test_calles_devuelve_geojson_aunque_no_haya_importado_nada(): void
    {
        $this->getJson('/api/calles')->assertOk()->assertJsonPath('type', 'FeatureCollection')->assertJsonCount(0, 'features');

        RoadsStore::put(['type' => 'FeatureCollection', 'features' => [['type' => 'Feature', 'properties' => [], 'geometry' => ['type' => 'LineString', 'coordinates' => [[0, 0], [1, 1]]]]]]);
        $this->getJson('/api/calles')->assertOk()->assertJsonCount(1, 'features');
    }

    public function test_la_api_publica_tiene_limite_de_pedidos(): void
    {
        for ($i = 0; $i < 60; $i++) {
            $this->getJson('/api/calles')->assertOk();
        }
        $this->getJson('/api/calles')->assertStatus(429);
    }

    public function test_propiedades_se_comprime_si_el_navegador_lo_acepta_y_trae_lo_mismo(): void
    {
        $this->seed(DemoSeeder::class);

        $plain = $this->getJson('/api/propiedades')->assertOk();
        $gz = $this->call('GET', '/api/propiedades', server: ['HTTP_ACCEPT_ENCODING' => 'gzip, br', 'HTTP_ACCEPT' => 'application/json']);

        $gz->assertOk();
        $this->assertSame('gzip', $gz->headers->get('Content-Encoding'));
        $this->assertStringContainsString('Accept-Encoding', $gz->headers->get('Vary'));
        $this->assertSame($plain->getContent(), gzdecode($gz->getContent()));
        $this->assertLessThan(strlen($plain->getContent()), strlen($gz->getContent()));
        $this->assertNull($plain->headers->get('Content-Encoding'));
    }

    public function test_propiedades_se_arma_una_sola_vez_por_cambio_de_datos(): void
    {
        $this->seed(DemoSeeder::class);
        $this->getJson('/api/propiedades')->assertOk();

        $queries = 0;
        DB::listen(function ($q) use (&$queries) {
            if (str_contains($q->sql, 'geometry')) {
                $queries++;
            }
        });
        $this->getJson('/api/propiedades')->assertOk();

        $this->assertSame(0, $queries, 'la segunda lectura sale de la caché, sin releer las geometrías');
    }
}
