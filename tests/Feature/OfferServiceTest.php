<?php

namespace Tests\Feature;

use App\Economy\AuctionService;
use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\MatchService;
use App\Economy\OfferService;
use App\Enums\MatchStatus;
use App\Events\ActivityFeed;
use App\Events\OfferUpdated;
use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\Offer;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Ofertas entre jugadores: reglas del mínimo y el "comprá ya", la plata reservada, el traspaso, los cierres y las cancelaciones. */
class OfferServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    private User $cami;

    private Property $casa;

    private OfferService $offers;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'formosa.auction.dispute_seconds' => 0, 'formosa.auction.min_increment' => 100, 'formosa.auction.min_increment_pct' => 5,
            'formosa.offers.duration_seconds' => 120, 'formosa.offers.decide_seconds' => 45, 'formosa.offers.fee_pct' => 5,
            'formosa.offers.min_price' => 100, 'formosa.offers.max_open_per_seller' => 3, 'formosa.offers.max_leading_per_user' => 5,
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->cami = User::factory()->create(['name' => 'Cami']);
        $this->match = $this->startedMatch([$this->ana, $this->beto, $this->cami], 100000);
        $this->casa = $this->makeProperty(price: 10000);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $this->casa->id); // Ana: 90.000
        $this->offers = app(OfferService::class);
        Event::fake([OfferUpdated::class, ActivityFeed::class, PropertyOwnerChanged::class]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function open(int $min = 8000, int $max = 20000, ?Property $p = null): Offer
    {
        return $this->offers->open($this->ana, $this->match->id, ($p ?? $this->casa)->id, $min, $max);
    }

    private function reserved(User $u): int
    {
        return (int) $this->player($this->match, $u)->reserved;
    }

    private function fails(callable $fn, string $code): GameException
    {
        try {
            $fn();
        } catch (GameException $e) {
            $this->assertSame($code, $e->errorCode);

            return $e;
        }
        $this->fail("Tenía que fallar con {$code}");
    }

    // ------------------------------------------------------------------ publicar

    public function test_el_dueno_publica_con_minimo_y_comprar_ya(): void
    {
        $o = $this->open(8000, 20000);

        $this->assertSame('abierta', $o->status->value);
        $this->assertSame(8000, $o->min_price);
        $this->assertSame(20000, $o->buy_now_price);
        $this->assertNull($o->current_bid);
        $this->assertTrue($o->ends_at->equalTo(now()->addSeconds(120)));
        $this->assertTrue($o->decide_until->equalTo(now()->addSeconds(165)));
        Event::assertDispatched(OfferUpdated::class);
    }

    public function test_los_precios_tienen_que_ser_validos(): void
    {
        $this->fails(fn () => $this->open(50, 20000), 'precios_invalidos');   // por debajo del piso
        $this->fails(fn () => $this->open(8000, 8000), 'precios_invalidos');  // el comprá ya tiene que ser mayor
        $this->fails(fn () => $this->open(9000, 8000), 'precios_invalidos');
    }

    public function test_solo_el_dueno_publica_y_una_sola_vez(): void
    {
        $this->fails(fn () => $this->offers->open($this->beto, $this->match->id, $this->casa->id, 8000, 20000), 'no_es_tuya');
        $libre = $this->makeProperty();
        $this->fails(fn () => $this->offers->open($this->ana, $this->match->id, $libre->id, 8000, 20000), 'no_es_tuya');
        $this->open();
        $this->fails(fn () => $this->open(), 'ya_en_oferta');
    }

    public function test_tope_de_ofertas_abiertas_por_dueno(): void
    {
        config(['formosa.offers.max_open_per_seller' => 2]);
        $b = $this->makeProperty();
        $c = $this->makeProperty();
        app(EconomyService::class)->buy($this->ana, $this->match->id, $b->id);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $c->id);
        $this->open();
        $this->open(8000, 20000, $b);
        $this->fails(fn () => $this->open(8000, 20000, $c), 'demasiadas_ofertas');
    }

    public function test_no_se_puede_vender_al_banco_algo_que_esta_en_oferta(): void
    {
        $this->open();
        $this->fails(fn () => app(EconomyService::class)->sell($this->ana, $this->match->id, $this->casa->id), 'en_oferta');
    }

    // ------------------------------------------------------------------ ofertar

    public function test_la_primera_oferta_alcanza_el_minimo_y_reserva_la_plata(): void
    {
        $o = $this->open();

        $this->fails(fn () => $this->offers->bid($this->beto, $o->id, 7999), 'oferta_baja');
        $r = $this->offers->bid($this->beto, $o->id, 8000);

        $this->assertFalse($r['sold']);
        $this->assertSame(8000, $r['offer']->current_bid);
        $this->assertSame($this->beto->id, $r['offer']->leader_id);
        $this->assertSame(8000, $this->reserved($this->beto));
        $this->assertSame(100000, $this->cash($this->match, $this->beto)); // todavía no se cobra
    }

    public function test_una_oferta_nueva_supera_a_la_anterior_y_libera_la_reserva_del_superado(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 8000);

        $e = $this->fails(fn () => $this->offers->bid($this->cami, $o->id, 8100), 'oferta_baja'); // incremento: 5% de 8000 = 400
        $this->assertSame(8400, $e->context['minimo']);
        $this->offers->bid($this->cami, $o->id, 8400);

        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertSame(8400, $this->reserved($this->cami));
        $this->assertSame($this->cami->id, Offer::find($o->id)->leader_id);
        $this->assertSame(2, Offer::find($o->id)->bids_count);
    }

    public function test_el_dueno_no_puede_ofertar_por_lo_suyo(): void
    {
        $o = $this->open();
        $this->fails(fn () => $this->offers->bid($this->ana, $o->id, 9000), 'oferta_propia');
    }

    public function test_no_se_puede_ofertar_plata_que_no_se_tiene(): void
    {
        $o = $this->open(8000, 500000);
        $this->fails(fn () => $this->offers->bid($this->beto, $o->id, 100001), 'saldo_insuficiente');
    }

    public function test_repetir_la_misma_oferta_no_duplica_nada(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 8000);
        $r = $this->offers->bid($this->beto, $o->id, 8000);

        $this->assertSame(1, Offer::find($o->id)->bids_count);
        $this->assertSame(8000, $this->reserved($this->beto));
        $this->assertSame(8000, $r['reserved']);
    }

    public function test_el_lider_puede_subir_su_propia_oferta_sin_reservar_doble(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 8000);
        $this->offers->bid($this->beto, $o->id, 9000);

        $this->assertSame(9000, $this->reserved($this->beto));
    }

    public function test_tope_de_ofertas_ganando_a_la_vez(): void
    {
        config(['formosa.offers.max_leading_per_user' => 1]);
        $b = $this->makeProperty();
        app(EconomyService::class)->buy($this->ana, $this->match->id, $b->id);
        $o1 = $this->open();
        $o2 = $this->open(8000, 20000, $b);
        $this->offers->bid($this->beto, $o1->id, 8000);

        $this->fails(fn () => $this->offers->bid($this->beto, $o2->id, 8000), 'demasiadas_ofertas_ganando');
    }

    public function test_pasado_el_plazo_ya_no_se_oferta(): void
    {
        $o = $this->open();
        Carbon::setTestNow(now()->addSeconds(121));

        $this->fails(fn () => $this->offers->bid($this->beto, $o->id, 8000), 'oferta_terminada');
    }

    // ------------------------------------------------------------------ comprá ya

    public function test_comprar_ya_cierra_la_venta_al_precio_de_comprar_ya_aunque_se_ofrezca_mas(): void
    {
        $o = $this->open(8000, 20000);

        $r = $this->offers->bid($this->beto, $o->id, 35000);

        $this->assertTrue($r['sold']);
        $this->assertSame('vendida', $r['offer']->status->value);
        $this->assertSame(20000, $r['offer']->sold_price);
        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $this->casa));
        $this->assertSame(80000, $this->cash($this->match, $this->beto));
        $this->assertSame(90000 + 19000, $this->cash($this->match, $this->ana)); // 20.000 menos 5% de comisión
        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertLedgerMatchesCash($this->match);
        Event::assertDispatched(PropertyOwnerChanged::class, fn ($e) => $e->propertyId === $this->casa->id && $e->ownerId === $this->beto->id);
    }

    public function test_comprar_ya_libera_a_quien_iba_ganando(): void
    {
        $o = $this->open(8000, 20000);
        $this->offers->bid($this->cami, $o->id, 9000);

        $this->offers->bid($this->beto, $o->id, 20000);

        $this->assertSame(0, $this->reserved($this->cami));
        $this->assertSame(100000, $this->cash($this->match, $this->cami));
        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $this->casa));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_el_lider_tambien_puede_pasar_a_comprar_ya(): void
    {
        $o = $this->open(8000, 20000);
        $this->offers->bid($this->beto, $o->id, 9000);

        $this->offers->bid($this->beto, $o->id, 20000);

        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertSame(80000, $this->cash($this->match, $this->beto));
        $this->assertLedgerMatchesCash($this->match);
    }

    // ------------------------------------------------------------------ aceptar

    public function test_el_dueno_acepta_la_mejor_oferta_y_se_traspasa_todo(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 10000);

        $r = $this->offers->accept($this->ana, $o->id);

        $this->assertSame('vendida', $r->status->value);
        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $this->casa));
        $this->assertSame(90000, $this->cash($this->match, $this->beto));
        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertSame(90000 + 9500, $this->cash($this->match, $this->ana)); // comisión del 5%
        $this->assertSame(10000, DB::table('match_properties')->where('match_id', $this->match->id)->where('property_id', $this->casa->id)->value('price_paid'));
        $this->assertLedgerMatchesCash($this->match);
        $this->assertSame(1, LedgerEntry::where('match_id', $this->match->id)->where('idempotency_key', "oferta-{$o->id}")->where('user_id', $this->ana->id)->count());
        Event::assertDispatched(ActivityFeed::class, fn ($e) => $e->item['type'] === 'oferta_vendida' && $e->item['actor'] === 'Ana' && $e->item['other'] === 'Beto' && $e->item['amount'] === 10000);
    }

    public function test_aceptar_sin_ofertas_o_ajeno_o_vencido_falla(): void
    {
        $o = $this->open();
        $this->fails(fn () => $this->offers->accept($this->ana, $o->id), 'sin_ofertas');
        $this->offers->bid($this->beto, $o->id, 9000);
        $this->fails(fn () => $this->offers->accept($this->beto, $o->id), 'no_es_tuya');
        Carbon::setTestNow(now()->addSeconds(166));
        $this->fails(fn () => $this->offers->accept($this->ana, $o->id), 'oferta_terminada');
        $this->assertSame(0, $this->reserved($this->beto)); // al vencer el plazo del dueño se cerró y se liberó
    }

    public function test_el_dueno_puede_aceptar_antes_de_que_termine_el_plazo_de_ofertas(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        Carbon::setTestNow(now()->addSeconds(10));

        $this->assertSame('vendida', $this->offers->accept($this->ana, $o->id)->status->value);
    }

    public function test_aceptar_dos_veces_no_cobra_dos_veces(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        $this->offers->accept($this->ana, $o->id);

        $this->fails(fn () => $this->offers->accept($this->ana, $o->id), 'oferta_cerrada');
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_el_nuevo_dueno_puede_volver_a_ofrecerla(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        $this->offers->accept($this->ana, $o->id);

        $o2 = $this->offers->open($this->beto, $this->match->id, $this->casa->id, 9500, 30000);
        $this->assertSame('abierta', $o2->status->value);
    }

    // ------------------------------------------------------------------ cierres

    public function test_sin_ofertas_se_cierra_al_terminar_el_plazo(): void
    {
        $o = $this->open();
        $this->assertSame(0, $this->offers->settleDue());
        Carbon::setTestNow(now()->addSeconds(120));

        $this->assertSame(1, $this->offers->settleDue());
        $this->assertSame('cerrada', Offer::find($o->id)->status->value);
        $this->assertNull(Offer::find($o->id)->active_property_id);
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $this->casa));
    }

    public function test_con_ofertas_espera_la_decision_del_dueno_y_despues_cierra_sin_venta(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        Carbon::setTestNow(now()->addSeconds(121)); // terminó el plazo de ofertar, el dueño todavía puede decidir

        $this->assertSame(0, $this->offers->settleDue());
        $this->assertSame(9000, $this->reserved($this->beto));

        Carbon::setTestNow(now()->addSeconds(45));
        $this->assertSame(1, $this->offers->settleDue());
        $this->assertSame('cerrada', Offer::find($o->id)->status->value);
        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $this->casa));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_cerrar_es_idempotente(): void
    {
        $o = $this->open();
        Carbon::setTestNow(now()->addSeconds(130));
        $this->offers->settle($o->id);
        $this->offers->settle($o->id);

        $this->assertSame('cerrada', Offer::find($o->id)->status->value);
    }

    public function test_retirar_libera_la_reserva(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        $this->fails(fn () => $this->offers->cancel($this->beto, $o->id), 'no_es_tuya');

        $this->assertSame('cancelada', $this->offers->cancel($this->ana, $o->id)->status->value);
        $this->assertSame(0, $this->reserved($this->beto));
        $this->open(); // se puede volver a publicar
    }

    // ------------------------------------------------------------------ salidas y fin de partida

    public function test_si_el_dueno_abandona_se_cancelan_sus_ofertas(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);

        app(MatchService::class)->leave($this->ana, $this->match->id);

        $this->assertSame('cancelada', Offer::find($o->id)->status->value);
        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertNull($this->ownerOf($this->match, $this->casa));
    }

    public function test_si_quien_iba_ganando_abandona_se_cancela_su_oferta_pero_no_la_publicada(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);

        app(MatchService::class)->leave($this->beto, $this->match->id);

        $this->assertSame('cancelada', Offer::find($o->id)->status->value); // la oferta se baja: hay que volver a publicarla
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $this->casa));
    }

    public function test_al_terminar_la_partida_se_cancelan_las_ofertas_abiertas_y_se_libera_la_plata(): void
    {
        $o = $this->open();
        $this->offers->bid($this->beto, $o->id, 9000);
        Carbon::setTestNow(GameMatch::find($this->match->id)->ends_at->copy()->addSecond());

        app(MatchService::class)->finish($this->match->id);

        $this->assertSame(MatchStatus::Finished, GameMatch::find($this->match->id)->status);
        $this->assertContains(Offer::find($o->id)->status->value, ['cancelada', 'cerrada']);
        $this->assertSame(0, $this->reserved($this->beto));
        $this->assertSame(0, Offer::whereNotNull('active_property_id')->count());
    }

    public function test_no_se_puede_ofertar_con_la_partida_terminada(): void
    {
        $o = $this->open();
        Carbon::setTestNow(GameMatch::find($this->match->id)->ends_at->copy()->addSecond());
        app(MatchService::class)->finish($this->match->id);

        $this->fails(fn () => $this->offers->bid($this->beto, $o->id, 9000), 'partida_no_en_juego');
    }

    // ------------------------------------------------------------------ avisos

    public function test_publicar_emite_una_tarjeta_y_no_filtra_nada_privado(): void
    {
        $this->open(8000, 20000);

        $items = Event::dispatched(ActivityFeed::class)->map(fn ($a) => $a[0]->item)->values()->all();
        $this->assertSame('oferta_abierta', $items[0]['type']);
        $this->assertSame(8000, $items[0]['amount']);
        $offer = Event::dispatched(OfferUpdated::class)->first()[0]->offer;
        $this->assertEqualsCanonicalizing(
            ['id', 'match_id', 'property_id', 'status', 'seller_id', 'seller', 'min_price', 'buy_now_price', 'current_bid', 'min_next', 'bids_count', 'leader_id', 'leader', 'sold_price', 'ends_at', 'decide_until', 'server_now'],
            array_keys($offer),
        );
    }

    public function test_el_conflicto_con_una_subasta_no_existe_porque_las_subastas_son_de_propiedades_libres(): void
    {
        $this->open();
        $this->assertSame(0, DB::table('auctions')->where('property_id', $this->casa->id)->count());
        $this->fails(fn () => app(AuctionService::class)->claim($this->beto, $this->match->id, $this->casa->id), 'ocupada');
    }
}
