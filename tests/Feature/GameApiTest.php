<?php

namespace Tests\Feature;

use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Storage;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** API de juego dentro de una partida: comprar, vender, estado de dueños y límites. */
class GameApiTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private User $ana;

    private User $beto;

    private GameMatch $match;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        Storage::fake('local');
        config(['formosa.match.minutes_per_day' => 2]);
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana@example.com']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 30000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function buyUrl(int $propertyId, ?GameMatch $match = null): string
    {
        return '/api/partidas/'.($match ?? $this->match)->id."/propiedades/{$propertyId}/comprar";
    }

    private function sellUrl(int $propertyId): string
    {
        return "/api/partidas/{$this->match->id}/propiedades/{$propertyId}/vender";
    }

    public function test_sin_sesion_las_acciones_responden_401_en_json(): void
    {
        $p = $this->makeProperty();

        $this->getJson('/api/yo')->assertUnauthorized();
        $this->getJson('/api/yo/historial')->assertUnauthorized();
        $this->getJson('/api/partidas/actual')->assertUnauthorized();
        $this->postJson($this->buyUrl($p->id))->assertUnauthorized();
        $this->postJson($this->sellUrl($p->id))->assertUnauthorized();
        $this->postJson('/api/partidas', ['nombre' => 'x'])->assertUnauthorized();
        $this->assertNull($this->ownerOf($this->match, $p));
    }

    public function test_yo_devuelve_puntos_y_partida_pero_no_datos_privados(): void
    {
        $res = $this->actingAs($this->ana)->getJson('/api/yo')->assertOk();

        $res->assertJsonPath('user.name', 'Ana')->assertJsonPath('ranking.points', 0)->assertJsonPath('ranking.position', null)
            ->assertJsonPath('current_match.id', $this->match->id)->assertJsonPath('current_match.status', 'running');
        $this->assertStringNotContainsString('ana@example.com', $res->getContent());
        $this->assertStringContainsString('no-store', $res->headers->get('Cache-Control'));
    }

    public function test_comprar_responde_y_avisa_al_resto_de_la_partida(): void
    {
        Event::fake([PropertyOwnerChanged::class]);
        $p = $this->makeProperty(price: 12500);

        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id), [], ['Idempotency-Key' => 'abc12345-xyz'])
            ->assertOk()->assertExactJson(['ok' => true, 'match_id' => $this->match->id, 'result' => 'comprada', 'property_id' => $p->id, 'price' => 12500, 'balance' => 17500, 'replayed' => false, 'auction' => null]);

        Event::assertDispatched(PropertyOwnerChanged::class, fn ($e) => $e->matchId === $this->match->id && $e->propertyId === $p->id && $e->ownerName === 'Ana'
            && $e->broadcastWith() === ['match_id' => $this->match->id, 'id' => $p->id, 'owner_id' => $this->ana->id, 'owner' => 'Ana']
            && $e->broadcastOn()[0]->name === "partida.{$this->match->id}");

        $estado = $this->getJson("/api/partidas/{$this->match->id}/propiedades/estado")->json('owned');
        $this->assertSame([['id' => $p->id, 'owner_id' => $this->ana->id, 'owner' => 'Ana']], $estado);
    }

    public function test_el_cliente_no_puede_elegir_el_precio(): void
    {
        $p = $this->makeProperty(price: 10000);

        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id), ['price' => 1, 'owner_id' => 999, 'balance' => 9999999, 'cash' => 99999999])
            ->assertOk()->assertJsonPath('balance', 20000);

        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $p));
    }

    public function test_el_reintento_con_la_misma_clave_no_cobra_dos_veces(): void
    {
        $p = $this->makeProperty(price: 10000);
        $h = ['Idempotency-Key' => 'misma-clave-1'];

        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id), [], $h)->assertOk()->assertJsonPath('replayed', false);
        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id), [], $h)->assertOk()->assertJsonPath('replayed', true)->assertJsonPath('balance', 20000);
    }

    public function test_una_clave_de_idempotencia_rara_se_rechaza(): void
    {
        $p = $this->makeProperty();

        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id), [], ['Idempotency-Key' => "x'; DROP TABLE users;--"])->assertUnprocessable();
        $this->assertNull($this->ownerOf($this->match, $p));
    }

    public function test_errores_del_juego_con_codigo_estable(): void
    {
        $p = $this->makeProperty(price: 10000);
        $caro = $this->makeProperty(price: 99999);
        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id))->assertOk();

        $this->actingAs($this->beto)->postJson($this->buyUrl($p->id))->assertStatus(409)->assertJsonPath('error', 'ocupada');
        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id))->assertStatus(409)->assertJsonPath('error', 'ya_es_tuya');
        $this->actingAs($this->beto)->postJson($this->buyUrl($caro->id))->assertStatus(422)->assertJsonPath('error', 'saldo_insuficiente')->assertJsonPath('faltan', 69999);
        $this->actingAs($this->beto)->postJson($this->buyUrl(999999))->assertNotFound()->assertJsonPath('error', 'propiedad_inexistente');
        $this->actingAs($this->beto)->postJson($this->buyUrl(0) . 'x')->assertNotFound();
        $this->actingAs($this->beto)->postJson("/api/partidas/999999/propiedades/{$p->id}/comprar")->assertNotFound()->assertJsonPath('error', 'partida_inexistente');
    }

    public function test_quien_no_juega_esa_partida_no_puede_comprar_en_ella(): void
    {
        $carla = User::factory()->create();
        $p = $this->makeProperty();

        $this->actingAs($carla)->postJson($this->buyUrl($p->id))->assertForbidden()->assertJsonPath('error', 'no_estas_en_partida');
        $this->assertNull($this->ownerOf($this->match, $p));
    }

    public function test_en_una_partida_terminada_no_se_compra(): void
    {
        $p = $this->makeProperty();
        Carbon::setTestNow($this->match->ends_at->copy()->addMinute());

        $this->actingAs($this->ana)->postJson($this->buyUrl($p->id))->assertStatus(409)->assertJsonPath('error', 'partida_no_en_juego');
        $this->assertSame('finished', $this->match->fresh()->status->value, 'la acción tardía cierra la partida de forma perezosa');
    }

    public function test_la_ruta_de_cobro_manual_ya_no_existe(): void
    {
        $this->actingAs($this->ana)->postJson('/api/cobrar')->assertStatus(404);
    }

    public function test_hay_limite_de_acciones_por_jugador(): void
    {
        RateLimiter::clear('jugar');
        $p = $this->makeProperty();
        for ($i = 0; $i < 30; $i++) {
            $this->actingAs($this->ana)->getJson('/api/partidas/actual')->assertOk();
        }
        $this->actingAs($this->ana)->getJson('/api/partidas/actual')->assertStatus(429);

        $this->actingAs($this->beto)->getJson('/api/partidas/actual')->assertOk(); // el límite es por jugador
        unset($p);
    }

    public function test_el_mapa_para_visitantes_y_para_jugadores(): void
    {
        $this->get('/explorar')->assertOk()->assertSee('Ingresar')->assertSee('crear cuenta');

        $this->actingAs($this->ana)->get('/explorar')->assertOk()->assertSee('Ana')->assertDontSee('ana@example.com')->assertDontSee('Ingresar');
    }

    public function test_la_lectura_publica_no_manda_cookies_de_sesion(): void
    {
        $this->seed(\Database\Seeders\DemoSeeder::class);

        foreach (['/api/propiedades', "/api/partidas/{$this->match->id}/propiedades/estado", "/api/partidas/{$this->match->id}/subastas", '/api/partidas', '/api/ranking', '/api/calles'] as $url) {
            $res = $this->getJson($url)->assertOk();
            $this->assertEmpty($res->headers->getCookies(), "{$url} no debe fijar cookies (una caché podría repartirlas)");
        }
    }

    public function test_el_etag_de_la_geometria_no_cambia_con_las_compras(): void
    {
        $this->seed(\Database\Seeders\DemoSeeder::class);
        $etag = $this->getJson('/api/propiedades')->headers->get('ETag');

        $free = \App\Models\Property::where('price', '<=', 30000)->firstOrFail();
        $this->actingAs($this->ana)->postJson($this->buyUrl($free->id))->assertOk();

        $this->assertSame($etag, $this->getJson('/api/propiedades')->headers->get('ETag'));
    }

    public function test_hay_cabeceras_de_seguridad(): void
    {
        $res = $this->get('/mapa')->assertOk();

        $this->assertSame('nosniff', $res->headers->get('X-Content-Type-Options'));
        $this->assertSame('DENY', $res->headers->get('X-Frame-Options'));
        $this->assertNotEmpty($res->headers->get('Referrer-Policy'));
    }

    public function test_una_clave_de_idempotencia_no_sirve_para_otra_propiedad(): void
    {
        $a = $this->makeProperty();
        $b = $this->makeProperty();
        $h = ['Idempotency-Key' => 'clave-compartida'];
        $this->actingAs($this->ana)->postJson($this->buyUrl($a->id), [], $h)->assertOk();

        $this->actingAs($this->ana)->postJson($this->buyUrl($b->id), [], $h)->assertStatus(409)->assertJsonPath('error', 'clave_reutilizada');
        $this->assertNull($this->ownerOf($this->match, $b));
    }

    public function test_un_id_gigante_no_rompe_nada(): void
    {
        $this->actingAs($this->ana)->postJson("/api/partidas/{$this->match->id}/propiedades/99999999999999999999/comprar")->assertNotFound();
    }
}
