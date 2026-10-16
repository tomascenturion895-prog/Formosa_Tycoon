<?php

namespace Tests\Feature;

use App\Events\AuctionUpdated;
use App\Models\Auction;
use App\Models\GameMatch;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

class AuctionApiTest extends TestCase
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
        config([
            'formosa.auction.dispute_seconds' => 10,
            'formosa.auction.duration_seconds' => 30,
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana@example.com']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 30000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function property(int $price = 10000): Property
    {
        return $this->makeProperty($price, 0);
    }

    private function buyUrl(Property $p): string
    {
        return "/api/partidas/{$this->match->id}/propiedades/{$p->id}/comprar";
    }

    private function bidUrl(int $auctionId): string
    {
        return "/api/partidas/{$this->match->id}/subastas/{$auctionId}/pujar";
    }

    private function closeUrl(int|string $auctionId): string
    {
        return "/api/partidas/{$this->match->id}/subastas/{$auctionId}/cerrar";
    }

    public function test_comprar_con_ventana_reserva_y_devuelve_la_subasta(): void
    {
        Event::fake([AuctionUpdated::class]);
        $ana = $this->ana;
        $p = $this->property();

        $res = $this->actingAs($ana)->postJson($this->buyUrl($p))->assertOk();

        $res->assertJsonPath('result', 'reclamada')->assertJsonPath('balance', 30000)
            ->assertJsonPath('auction.status', 'disputa')->assertJsonPath('auction.leader', 'Ana')
            ->assertJsonPath('auction.current_bid', 10000)->assertJsonPath('auction.min_next', 10500);
        $this->assertNull($this->ownerOf($this->match, $p));
        Event::assertDispatched(AuctionUpdated::class, fn ($e) => $e->auction['leader'] === 'Ana');
    }

    public function test_el_estado_de_la_partida_informa_reservado_y_disponible(): void
    {
        $ana = $this->ana;
        $p = $this->property(10000);
        $this->actingAs($ana)->postJson($this->buyUrl($p))->assertOk();

        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertOk()
            ->assertJsonPath('me.cash', 30000)->assertJsonPath('me.reserved', 10000)->assertJsonPath('me.available', 20000);
    }

    public function test_flujo_completo_por_la_api(): void
    {
        $ana = $this->ana;
        $beto = $this->beto;
        $p = $this->property(10000);

        $this->actingAs($ana)->postJson($this->buyUrl($p))->assertOk();
        $res = $this->actingAs($beto)->postJson($this->buyUrl($p))->assertOk()
            ->assertJsonPath('result', 'disputada')->assertJsonPath('auction.status', 'abierta')
            ->assertJsonPath('auction.leader', 'Beto')->assertJsonPath('auction.current_bid', 10500);
        $id = $res->json('auction.id');

        $this->actingAs($ana)->postJson($this->bidUrl($id), ['monto' => 12000])->assertOk()
            ->assertJsonPath('auction.leader', 'Ana')->assertJsonPath('reserved', 12000)->assertJsonPath('available', 18000);

        // La propiedad todavía no se asignó: falta que venza el plazo.
        $this->postJson($this->closeUrl($id))->assertOk()->assertJsonPath('auction.status', 'abierta');
        Carbon::setTestNow('2026-10-15 10:00:30');
        $this->postJson($this->closeUrl($id))->assertOk()->assertJsonPath('auction.status', 'cerrada');

        $this->assertSame($ana->id, $this->ownerOf($this->match, $p));
        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertJsonPath('me.cash', 18000)->assertJsonPath('me.reserved', 0);
        $this->actingAs($beto)->getJson('/api/partidas/actual')->assertJsonPath('me.cash', 30000)->assertJsonPath('me.reserved', 0);
    }

    public function test_errores_de_puja_tienen_codigo_estable(): void
    {
        $ana = $this->ana;
        $beto = $this->beto;
        $p = $this->property(10000);
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        $this->actingAs($beto)->postJson($this->buyUrl($p)); // Beto va ganando con 10.500
        $id = Auction::firstOrFail()->id;

        $this->actingAs($ana)->postJson($this->bidUrl($id), ['monto' => 10600])
            ->assertStatus(422)->assertJsonPath('error', 'puja_baja')->assertJsonPath('minimo', 11025);
        $this->actingAs($beto)->postJson($this->bidUrl($id), ['monto' => 20000])
            ->assertStatus(409)->assertJsonPath('error', 'ya_lideras');
        $this->actingAs($ana)->postJson($this->bidUrl($id), ['monto' => 31000])
            ->assertStatus(422)->assertJsonPath('error', 'saldo_insuficiente');
        $this->actingAs($ana)->postJson($this->bidUrl(999), ['monto' => 31000])
            ->assertStatus(404)->assertJsonPath('error', 'subasta_inexistente');
    }

    public function test_el_monto_se_valida(): void
    {
        $ana = $this->ana;
        $beto = $this->beto;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        $id = Auction::firstOrFail()->id;

        foreach ([[], ['monto' => 'mucho'], ['monto' => 1.5], ['monto' => -5], ['monto' => 0], ['monto' => '1e3'], ['monto' => 99999999999999]] as $body) {
            $this->actingAs($beto)->postJson($this->bidUrl($id), $body)->assertStatus(422);
        }
        $this->assertSame(1, DB::table('auction_bids')->count());
    }

    public function test_pujar_exige_sesion(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        $id = Auction::firstOrFail()->id;
        auth()->logout();

        $this->postJson($this->bidUrl($id), ['monto' => 99999])->assertUnauthorized();
    }

    public function test_la_lista_publica_no_usa_cookies_ni_muestra_datos_privados(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        auth()->logout();

        $res = $this->getJson("/api/partidas/{$this->match->id}/subastas")->assertOk();

        $res->assertJsonPath('auctions.0.leader', 'Ana')->assertJsonPath('dispute_seconds', 10);
        $this->assertIsInt($res->json('server_now'));
        $this->assertStringNotContainsString('ana@example.com', $res->getContent());
        $this->assertStringNotContainsString('reserved', $res->getContent());
        $this->assertEmpty($res->headers->getCookies());
        $this->assertStringContainsString('no-store', $res->headers->get('Cache-Control'));
    }

    public function test_la_lista_publica_cierra_las_vencidas(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        auth()->logout();
        Carbon::setTestNow('2026-10-15 10:00:11');

        $this->getJson("/api/partidas/{$this->match->id}/subastas")->assertOk()->assertJsonCount(0, 'auctions');

        $this->assertSame($ana->id, $this->ownerOf($this->match, $p));
    }

    public function test_el_comando_cierra_las_vencidas(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        Carbon::setTestNow('2026-10-15 10:00:10');

        $this->artisan('subastas:cerrar')->expectsOutput('Subastas cerradas: 1')->assertSuccessful();

        $this->assertSame($ana->id, $this->ownerOf($this->match, $p));
    }

    public function test_el_cierre_publico_tiene_su_propio_limite(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        $id = Auction::firstOrFail()->id;
        auth()->logout();

        $status = [];
        for ($i = 0; $i < 45; $i++) {
            $status[] = $this->postJson($this->closeUrl($id))->status();
        }
        $this->assertContains(429, $status);
        // El cupo de lectura del mapa NO se gastó: sigue respondiendo.
        $this->getJson("/api/partidas/{$this->match->id}/subastas")->assertOk();
    }

    public function test_cerrar_una_subasta_inexistente_da_404(): void
    {
        $this->postJson($this->closeUrl(12345))->assertNotFound();
        $this->postJson($this->closeUrl('abc'))->assertNotFound();
    }

    public function test_los_pedidos_de_juego_tienen_limite_por_jugador(): void
    {
        $ana = $this->ana;
        $p = $this->property();
        $this->actingAs($ana)->postJson($this->buyUrl($p));
        $id = Auction::firstOrFail()->id;
        $beto = $this->beto;

        $status = [];
        for ($i = 0; $i < 33; $i++) {
            $status[] = $this->actingAs($beto)->postJson($this->bidUrl($id), ['monto' => 1])->status();
        }

        $this->assertContains(429, $status);
    }
}
