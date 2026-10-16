<?php

namespace Tests\Feature;

use App\Economy\AuctionService;
use App\Economy\EconomyService;
use App\Economy\RoomNotices;
use App\Events\ActivityFeed;
use App\Events\AuctionUpdated;
use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Avisos de actividad para las tarjetas del mapa: qué se emite, con qué datos y que nunca filtre de más. */
class ActivityFeedTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'formosa.auction.dispute_seconds' => 10, 'formosa.auction.duration_seconds' => 30,
            'formosa.auction.snipe_window_seconds' => 10, 'formosa.auction.snipe_extend_seconds' => 10, 'formosa.auction.max_extensions' => 2,
            'formosa.auction.min_increment' => 100, 'formosa.auction.min_increment_pct' => 5, 'formosa.auction.max_active_per_user' => 5,
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana-secreta@example.test']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 50000);
        Event::fake([ActivityFeed::class, AuctionUpdated::class, PropertyOwnerChanged::class]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    /** @return list<array<string, mixed>> */
    private function items(): array
    {
        return Event::dispatched(ActivityFeed::class)->map(fn ($args) => $args[0]->item)->values()->all();
    }

    public function test_comprar_directo_emite_una_compra_con_los_datos_publicos(): void
    {
        config(['formosa.auction.dispute_seconds' => 0]);
        $p = $this->makeProperty(price: 1200, kind: 'comercio');

        app(AuctionService::class)->claim($this->ana, $this->match->id, $p->id);

        $items = $this->items();
        $this->assertCount(1, $items);
        $this->assertSame(
            ['match_id' => $this->match->id, 'type' => 'compra', 'actor_id' => $this->ana->id, 'actor' => 'Ana', 'property_id' => $p->id, 'kind' => 'comercio', 'amount' => 1200],
            array_intersect_key($items[0], array_flip(['match_id', 'type', 'actor_id', 'actor', 'property_id', 'kind', 'amount'])),
        );
        $this->assertNotSame('', $items[0]['label']);
        $this->assertNotSame('', $items[0]['key']);
    }

    public function test_vender_al_banco_emite_una_venta_con_lo_devuelto(): void
    {
        config(['formosa.auction.dispute_seconds' => 0]);
        $p = $this->makeProperty(price: 1000);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $p->id);
        Event::fake([ActivityFeed::class, AuctionUpdated::class, PropertyOwnerChanged::class]);

        app(EconomyService::class)->sell($this->ana, $this->match->id, $p->id);

        $items = $this->items();
        $this->assertCount(1, $items);
        $this->assertSame('venta', $items[0]['type']);
        $this->assertSame($this->ana->id, $items[0]['actor_id']);
        $this->assertSame(600, $items[0]['amount']); // sell_ratio 0,6
    }

    public function test_reclamar_y_disputar_emiten_tarjetas_y_ganar_la_subasta_cierra_la_historia(): void
    {
        $p = $this->makeProperty(price: 10000);
        $auctions = app(AuctionService::class);

        $auctions->claim($this->ana, $this->match->id, $p->id);
        $auctions->claim($this->beto, $this->match->id, $p->id); // le disputa la reserva
        Carbon::setTestNow(now()->addSeconds(100));
        $this->assertSame(1, $auctions->settleDue());

        $this->assertSame(['reclamo', 'disputa', 'subasta_ganada'], array_column($this->items(), 'type'));
        $this->assertSame([$this->ana->id, $this->beto->id, $this->beto->id], array_column($this->items(), 'actor_id'));
        $this->assertSame([10000, 10500, 10500], array_column($this->items(), 'amount'));
    }

    public function test_una_reserva_que_nadie_disputo_se_anuncia_como_compra_comun(): void
    {
        $p = $this->makeProperty(price: 10000);
        $auctions = app(AuctionService::class);
        $auctions->claim($this->ana, $this->match->id, $p->id);
        Carbon::setTestNow(now()->addSeconds(10));
        $auctions->settleDue();

        $this->assertSame(['reclamo', 'compra'], array_column($this->items(), 'type'));
    }

    public function test_repetir_el_mismo_reclamo_no_duplica_la_tarjeta(): void
    {
        $p = $this->makeProperty(price: 10000);
        $auctions = app(AuctionService::class);
        $auctions->claim($this->ana, $this->match->id, $p->id);
        $auctions->claim($this->ana, $this->match->id, $p->id); // mismo pedido repetido (doble clic)

        $this->assertSame(['reclamo'], array_column($this->items(), 'type'));
    }

    public function test_el_aviso_no_lleva_saldos_correos_ni_nada_privado(): void
    {
        config(['formosa.auction.dispute_seconds' => 0]);
        $p = $this->makeProperty(price: 1000);
        app(AuctionService::class)->claim($this->ana, $this->match->id, $p->id);

        $item = $this->items()[0];
        $this->assertEqualsCanonicalizing(['match_id', 'key', 'type', 'actor_id', 'actor', 'other', 'property_id', 'kind', 'label', 'amount', 'at'], array_keys($item));
        $this->assertStringNotContainsString('ana-secreta', json_encode($item));
        $this->assertSame('partida.'.$this->match->id, (new ActivityFeed($item))->broadcastOn()[0]->name);
        $this->assertSame('ActivityFeed', (new ActivityFeed($item))->broadcastAs());
    }

    public function test_si_el_tiempo_real_falla_la_compra_igual_se_confirma(): void
    {
        config(['formosa.auction.dispute_seconds' => 0]);
        Event::fake([PropertyOwnerChanged::class, AuctionUpdated::class]); // ActivityFeed real: va al driver de broadcast de las pruebas
        config(['broadcasting.default' => 'reverb', 'broadcasting.connections.reverb.options.host' => '127.0.0.1', 'broadcasting.connections.reverb.options.port' => 1, 'broadcasting.connections.reverb.options.scheme' => 'http']);
        $p = $this->makeProperty(price: 1000);

        $r = app(AuctionService::class)->claim($this->ana, $this->match->id, $p->id);

        $this->assertSame('comprada', $r->result);
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $p));
    }

    public function test_los_tipos_conocidos_son_los_que_el_mapa_entiende(): void
    {
        $this->assertSame(['compra', 'subasta_ganada', 'venta', 'reclamo', 'disputa', 'oferta_abierta', 'oferta_vendida'], ActivityFeed::TYPES);
        $this->assertTrue(method_exists(RoomNotices::class, 'claimed') && method_exists(RoomNotices::class, 'contested'));
    }
}
