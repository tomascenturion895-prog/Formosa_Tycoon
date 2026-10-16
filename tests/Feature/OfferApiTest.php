<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** API HTTP de las ofertas entre jugadores: permisos, validación, forma de las respuestas y el circuito completo. */
class OfferApiTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private User $ana;

    private User $beto;

    private GameMatch $match;

    private int $casa;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.auction.dispute_seconds' => 0]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana-secreta@example.com']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 100000);
        $this->casa = $this->makeProperty(price: 10000)->id;
        app(EconomyService::class)->buy($this->ana, $this->match->id, $this->casa);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function publish(array $body = ['minimo' => 8000, 'comprar_ya' => 20000])
    {
        return $this->actingAs($this->ana)->postJson(route('api.ofertas.crear', [$this->match->id, $this->casa]), $body);
    }

    public function test_publicar_ofertar_y_aceptar_por_http(): void
    {
        $id = $this->publish()->assertOk()->assertJsonPath('offer.status', 'abierta')->json('offer.id');

        $this->actingAs($this->beto)->postJson(route('api.ofertas.ofrecer', [$this->match->id, $id]), ['monto' => 9000])
            ->assertOk()->assertJsonPath('sold', false)->assertJsonPath('reserved', 9000)->assertJsonPath('available', 91000)
            ->assertJsonPath('offer.leader', 'Beto');

        $this->actingAs($this->ana)->postJson(route('api.ofertas.aceptar', [$this->match->id, $id]))
            ->assertOk()->assertJsonPath('offer.status', 'vendida')->assertJsonPath('offer.sold_price', 9000);

        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $this->casa));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_la_lista_es_publica_y_no_filtra_nada_privado(): void
    {
        $this->publish()->assertOk();
        $this->app['auth']->forgetGuards();

        $r = $this->getJson(route('api.partidas.ofertas', $this->match->id))->assertOk()
            ->assertJsonPath('fee_pct', 5)->assertJsonCount(1, 'offers');
        $this->assertStringNotContainsString('ana-secreta', $r->getContent());
        $this->assertStringNotContainsString('email', $r->getContent());
    }

    public function test_publicar_y_ofertar_exigen_sesion(): void
    {
        $id = $this->publish()->json('offer.id');
        $this->app['auth']->forgetGuards(); // fin de la sesión de Ana
        $this->postJson(route('api.ofertas.crear', [$this->match->id, $this->casa]), ['minimo' => 8000, 'comprar_ya' => 20000])->assertUnauthorized();
        $this->postJson(route('api.ofertas.ofrecer', [$this->match->id, $id]), ['monto' => 9000])->assertUnauthorized();
        $this->postJson(route('api.ofertas.aceptar', [$this->match->id, $id]))->assertUnauthorized();
        $this->postJson(route('api.ofertas.retirar', [$this->match->id, $id]))->assertUnauthorized();
    }

    public function test_validacion_y_errores_con_codigo_estable(): void
    {
        $this->publish(['minimo' => 'x', 'comprar_ya' => 20000])->assertStatus(422);
        $this->publish(['minimo' => 8000])->assertStatus(422);
        $this->publish(['minimo' => 8000, 'comprar_ya' => 8000])->assertStatus(422)->assertJsonPath('error', 'precios_invalidos');

        $id = $this->publish()->json('offer.id');
        $this->actingAs($this->beto)->postJson(route('api.ofertas.ofrecer', [$this->match->id, $id]), ['monto' => 100])
            ->assertStatus(422)->assertJsonPath('error', 'oferta_baja')->assertJsonPath('minimo', 8000);
        $this->actingAs($this->beto)->postJson(route('api.ofertas.aceptar', [$this->match->id, $id]))->assertStatus(403)->assertJsonPath('error', 'no_es_tuya');
        $this->actingAs($this->ana)->postJson(route('api.ofertas.ofrecer', [$this->match->id, $id]), ['monto' => 9000])->assertStatus(403)->assertJsonPath('error', 'oferta_propia');
    }

    public function test_una_oferta_de_otra_partida_es_404(): void
    {
        $id = $this->publish()->json('offer.id');

        $this->actingAs($this->beto)->postJson(route('api.ofertas.ofrecer', [$this->match->id + 999, $id]), ['monto' => 9000])->assertNotFound();
    }

    public function test_cerrar_es_publico_y_solo_cierra_si_vencio(): void
    {
        $id = $this->publish()->json('offer.id');
        $this->app['auth']->forgetGuards();

        $this->postJson(route('api.ofertas.cerrar', [$this->match->id, $id]))->assertOk()->assertJsonPath('offer.status', 'abierta');
        Carbon::setTestNow(now()->addSeconds(125));
        $this->postJson(route('api.ofertas.cerrar', [$this->match->id, $id]))->assertOk()->assertJsonPath('offer.status', 'cerrada');
    }

    public function test_retirar_la_oferta(): void
    {
        $id = $this->publish()->json('offer.id');

        $this->actingAs($this->ana)->postJson(route('api.ofertas.retirar', [$this->match->id, $id]))->assertOk()->assertJsonPath('offer.status', 'cancelada');
        $this->app['auth']->forgetGuards();
        $this->getJson(route('api.partidas.ofertas', $this->match->id))->assertJsonCount(0, 'offers');
    }
}
