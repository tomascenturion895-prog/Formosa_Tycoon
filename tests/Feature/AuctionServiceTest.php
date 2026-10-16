<?php

namespace Tests\Feature;

use App\Economy\AuctionService;
use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Enums\AuctionStatus;
use App\Events\AuctionUpdated;
use App\Events\PropertyOwnerChanged;
use App\Models\Auction;
use App\Models\AuctionBid;
use App\Models\LedgerEntry;
use App\Models\Property;
use App\Models\User;
use App\Models\GameMatch;
use App\Models\MatchPlayer;
use Tests\Support\PlaysMatches;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use LogicException;
use Tests\TestCase;

class AuctionServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private AuctionService $auctions;

    /** @var list<User> */
    private array $users = [];

    private ?GameMatch $match = null;

    protected function setUp(): void
    {
        parent::setUp();
        $this->auctions = app(AuctionService::class);
        config([
                        'formosa.auction.dispute_seconds' => 10,
            'formosa.auction.duration_seconds' => 30,
            'formosa.auction.snipe_window_seconds' => 10,
            'formosa.auction.snipe_extend_seconds' => 10,
            'formosa.auction.max_extensions' => 2,
            'formosa.auction.min_increment' => 100,
            'formosa.auction.min_increment_pct' => 5,
            'formosa.auction.max_active_per_user' => 5,
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        Event::fake([AuctionUpdated::class, PropertyOwnerChanged::class]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    /** Propiedades sin ingreso: acá se prueban reclamos y subastas, no el ingreso por días de juego. */
    private function property(int $price = 10000): Property
    {
        return $this->makeProperty($price, 0);
    }

    private function user(string $name): User
    {
        $this->match === null || throw new \LogicException('Creá todos los usuarios antes de la primera acción.');

        return $this->users[] = User::factory()->create(['name' => $name]);
    }

    /** La partida (todos los usuarios creados hasta ahora juegan, con $30.000 cada uno). Se crea con la primera acción. */
    private function m(): GameMatch
    {
        return $this->match ??= $this->startedMatch($this->users, 30000);
    }

    private function wallet(User $u): MatchPlayer
    {
        return $this->player($this->m(), $u);
    }

    private function claimAs(User $u, int $propertyId, ?string $key = null): \App\Economy\ClaimResult
    {
        return $this->auctions->claim($u, $this->m()->id, $propertyId, $key);
    }

    private function buyAs(User $u, int $propertyId): \App\Economy\PurchaseResult
    {
        return app(EconomyService::class)->buy($u, $this->m()->id, $propertyId);
    }

    /** Ana reserva y Beto la disputa: queda abierta, Beto va ganando con el mínimo (10.500 si el precio es 10.000). */
    private function contested(User $ana, User $beto, Property $p): Auction
    {
        $this->claimAs($ana, $p->id);
        $this->claimAs($beto, $p->id);

        return Auction::firstOrFail();
    }

    private function advance(int $seconds): void
    {
        Carbon::setTestNow(now()->addSeconds($seconds));
    }

    /** Invariantes que valen siempre: dinero = suma del libro, y reservado = suma de las pujas que cada uno va ganando. */
    private function assertInvariants(): void
    {
        $match = $this->m();
        foreach (MatchPlayer::where('match_id', $match->id)->get() as $w) {
            $this->assertSame((int) $w->cash, (int) LedgerEntry::where('match_id', $match->id)->where('user_id', $w->user_id)->sum('amount'), "libro != dinero (usuario {$w->user_id})");
            $leading = (int) Auction::where('match_id', $match->id)->where('leader_id', $w->user_id)->whereNotNull('active_property_id')->sum('current_bid');
            $this->assertSame($leading, (int) $w->reserved, "reservado != pujas ganadoras (usuario {$w->user_id})");
            $this->assertLessThanOrEqual($w->cash, $w->reserved);
        }
        $this->assertSame(0, Auction::whereNotNull('active_property_id')->whereNotIn('status', ['disputa', 'abierta'])->count());
    }

    public function test_reclamar_reserva_el_precio_y_abre_la_ventana(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property(10000);

        $r = $this->claimAs($ana, $p->id);

        $this->assertSame('reclamada', $r->result);
        $a = Auction::firstOrFail();
        $this->assertSame(AuctionStatus::Disputa, $a->status);
        $this->assertSame(10000, $a->current_bid);
        $this->assertSame($ana->id, $a->leader_id);
        $this->assertSame('2026-10-15 10:00:10', $a->ends_at->toDateTimeString());
        $w = $this->wallet($ana);
        $this->assertSame(30000, $w->cash);   // todavía no se cobró
        $this->assertSame(10000, $w->reserved);  // pero no se puede gastar
        $this->assertNull($this->ownerOf($this->m(), $p));
        $this->assertSame(1, AuctionBid::count());
        Event::assertDispatched(AuctionUpdated::class);
        $this->assertInvariants();
    }

    public function test_sin_disputa_la_propiedad_es_del_que_reclamo_al_precio_de_lista(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property(10000);
        $this->claimAs($ana, $p->id);

        $this->advance(9);
        $this->assertSame(0, $this->auctions->settleDue()); // todavía no venció
        $this->assertNull($this->ownerOf($this->m(), $p));

        $this->advance(1);
        $this->assertSame(1, $this->auctions->settleDue());

        $this->assertSame($ana->id, $this->ownerOf($this->m(), $p));
        $w = $this->wallet($ana);
        $this->assertSame(20000, $w->cash);
        $this->assertSame(0, $w->reserved);
        $a = Auction::firstOrFail();
        $this->assertSame(AuctionStatus::Cerrada, $a->status);
        $this->assertNull($a->active_property_id);
        $this->assertSame($ana->id, $a->winner_id);
        $entry = LedgerEntry::where('property_id', $p->id)->firstOrFail();
        $this->assertSame(-10000, $entry->amount);
        $this->assertSame("subasta-{$a->id}", $entry->idempotency_key);
        Event::assertDispatched(PropertyOwnerChanged::class, fn ($e) => $e->matchId === $this->m()->id && $e->propertyId === $p->id && $e->ownerName === 'Ana');
        $this->assertInvariants();
    }

    public function test_reclamar_dos_veces_lo_mismo_no_duplica_nada(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property();
        $this->claimAs($ana, $p->id);
        $again = $this->claimAs($ana, $p->id);

        $this->assertSame('en_curso', $again->result);
        $this->assertSame(1, Auction::count());
        $this->assertSame(10000, $this->wallet($ana)->reserved);
        $this->assertInvariants();
    }

    public function test_el_plazo_se_guarda_en_segundos_enteros_redondeado_hacia_arriba(): void
    {
        Carbon::setTestNow('2026-10-15 10:00:00.400');
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property();

        $res = $this->claimAs($ana, $p->id);

        $a = Auction::firstOrFail();
        $this->assertSame('2026-10-15 10:00:11', $a->ends_at->toDateTimeString()); // 10,4 s -> 11 s: nunca menos de lo configurado
        $this->assertSame($a->ends_at->getTimestampMs(), $res->auction->ends_at->getTimestampMs()); // lo mostrado = lo guardado
        $this->assertSame($a->ends_at->getTimestampMs(), $a->fresh()->ends_at->getTimestampMs());

        $this->claimAs($beto, $p->id);
        $this->assertSame('2026-10-15 10:00:31', $a->fresh()->ends_at->toDateTimeString());
    }

    public function test_disputar_es_pujar_el_minimo_y_abre_la_subasta(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $this->claimAs($ana, $p->id);
        $this->advance(4);

        $r = $this->claimAs($beto, $p->id);

        $this->assertSame('disputada', $r->result);
        $a = Auction::firstOrFail();
        $this->assertSame(AuctionStatus::Abierta, $a->status);
        $this->assertSame('2026-10-15 10:00:34', $a->ends_at->toDateTimeString()); // 30 s desde la disputa
        $this->assertNotNull($a->contested_at);
        $this->assertSame($beto->id, $a->leader_id);       // quien disputa va ganando, con el mínimo
        $this->assertSame(10500, $a->current_bid);
        $this->assertSame(0, $this->wallet($ana)->reserved);     // a Ana se le libera
        $this->assertSame(10500, $this->wallet($beto)->reserved); // disputar cuesta: queda reservado
        $this->assertSame(2, AuctionBid::count());
        $this->assertInvariants();
    }

    public function test_pujar_reserva_al_que_puja_y_libera_al_superado(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p); // Beto va ganando con 10.500

        $r = $this->auctions->bid($ana, $a->id, 11025); // 10500 + 5% (525)

        $this->assertSame($ana->id, $r->auction->leader_id);
        $this->assertSame(11025, $r->auction->current_bid);
        $this->assertSame(0, $this->wallet($beto)->reserved);      // liberada
        $this->assertSame(11025, $this->wallet($ana)->reserved);   // reservada
        $this->assertSame(11025, $r->reserved);
        $this->assertSame(30000, $this->wallet($beto)->cash);   // nadie pagó todavía
        $this->assertInvariants();
    }

    public function test_gana_la_puja_mas_alta_y_paga_ese_precio(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p);
        $this->auctions->bid($ana, $a->id, 12000);

        $this->advance(30);
        $this->assertSame(1, $this->auctions->settleDue());

        $this->assertSame($ana->id, $this->ownerOf($this->m(), $p));
        $this->assertSame(18000, $this->wallet($ana)->cash);
        $this->assertSame(30000, $this->wallet($beto)->cash); // el perdedor no paga nada
        $this->assertSame(0, $this->wallet($ana)->reserved);
        $this->assertSame(0, $this->wallet($beto)->reserved);
        $this->assertSame(AuctionStatus::Cerrada, $a->fresh()->status);
        $this->assertSame($ana->id, $a->fresh()->winner_id);
        $this->assertInvariants();
    }

    public function test_la_puja_tiene_que_superar_a_la_actual_por_el_minimo(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p); // 10.500; el próximo mínimo es 10.500 + 525 = 11.025

        try {
            $this->auctions->bid($ana, $a->id, 11024);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('puja_baja', $e->errorCode);
            $this->assertSame(11025, $e->context['minimo']);
        }
        $this->assertSame(10500, $a->fresh()->current_bid);
        $this->assertSame(2, AuctionBid::count());
    }

    public function test_no_se_puede_pujar_mas_de_lo_disponible(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p);

        try {
            $this->auctions->bid($ana, $a->id, 30001); // Ana tiene 30000
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('saldo_insuficiente', $e->errorCode);
        }
        $this->assertSame($beto->id, $a->fresh()->leader_id);
        $this->assertInvariants();
    }

    public function test_la_plata_reservada_no_se_puede_gastar_en_otra_cosa(): void
    {
        $ana = $this->user('Ana');
        $p1 = $this->property(20000);
        $p2 = $this->property(15000);
        $this->claimAs($ana, $p1->id); // reserva 20000 de 30000: quedan 10000

        try {
            $this->claimAs($ana, $p2->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('saldo_insuficiente', $e->errorCode);
            $this->assertSame(10000, $e->context['saldo']);
        }
        $this->assertSame(1, Auction::count());
        $this->assertInvariants();
    }

    public function test_la_compra_directa_no_puede_saltear_una_subasta_ni_gastar_lo_reservado(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p1 = $this->property(20000);
        $p2 = $this->property(15000);
        $this->claimAs($ana, $p1->id);

        try {
            $this->buyAs($beto, $p1->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('en_subasta', $e->errorCode);
        }
        try {
            $this->buyAs($ana, $p2->id); // solo le quedan 10000 disponibles
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('saldo_insuficiente', $e->errorCode);
        }
        $this->assertNull($this->ownerOf($this->m(), $p1));
        $this->assertInvariants();
    }

    public function test_el_que_va_ganando_no_puede_pujar_contra_si_mismo(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property();
        $a = $this->contested($ana, $beto, $p); // va ganando Beto

        $this->expectException(GameException::class);
        $this->expectExceptionMessage('Ya vas ganando');
        $this->auctions->bid($beto, $a->id, 20000);
    }

    public function test_repetir_la_misma_puja_ganadora_no_cobra_ni_reserva_dos_veces(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p);
        $this->auctions->bid($ana, $a->id, 11025);

        $again = $this->auctions->bid($ana, $a->id, 11025);

        $this->assertTrue($again->replayed);
        $this->assertSame(3, AuctionBid::count());
        $this->assertSame(11025, $this->wallet($ana)->reserved);
        $this->assertInvariants();
    }

    public function test_pujar_sobre_una_reserva_sin_disputa_tambien_abre_la_subasta(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $this->claimAs($ana, $p->id);
        $a = Auction::firstOrFail();
        $this->advance(3);

        $this->auctions->bid($beto, $a->id, 10500);

        $a->refresh();
        $this->assertSame(AuctionStatus::Abierta, $a->status);
        $this->assertSame('2026-10-15 10:00:33', $a->ends_at->toDateTimeString());
        $this->assertSame($beto->id, $a->leader_id);
        $this->assertInvariants();
    }

    public function test_una_puja_sobre_el_final_extiende_el_cierre_hasta_el_tope(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(1000);
        $a = $this->contested($ana, $beto, $p);   // Beto 1.100; cierra 10:00:30

        $this->advance(25);                       // 10:00:25, quedan 5 s
        $this->auctions->bid($ana, $a->id, 1200);
        $this->assertSame('2026-10-15 10:00:35', $a->fresh()->ends_at->toDateTimeString());
        $this->assertSame(1, $a->fresh()->extensions);

        $this->advance(8);                        // 10:00:33
        $this->auctions->bid($beto, $a->id, 1300);
        $this->assertSame('2026-10-15 10:00:43', $a->fresh()->ends_at->toDateTimeString());
        $this->assertSame(2, $a->fresh()->extensions);

        $this->advance(8);                        // 10:00:41: tope alcanzado (max_extensions = 2)
        $this->auctions->bid($ana, $a->id, 1400);
        $this->assertSame('2026-10-15 10:00:43', $a->fresh()->ends_at->toDateTimeString());
        $this->assertSame(2, $a->fresh()->extensions);
        $this->assertInvariants();
    }

    public function test_una_puja_lejos_del_final_no_extiende(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(1000);
        $a = $this->contested($ana, $beto, $p);

        $this->advance(5);
        $this->auctions->bid($ana, $a->id, 1200);

        $this->assertSame('2026-10-15 10:00:30', $a->fresh()->ends_at->toDateTimeString());
        $this->assertSame(0, $a->fresh()->extensions);
    }

    public function test_una_puja_despues_del_cierre_se_rechaza_y_cierra_la_subasta(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p); // va ganando Beto

        $this->advance(30); // justo venció

        try {
            $this->auctions->bid($ana, $a->id, 20000);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('subasta_terminada', $e->errorCode);
        }

        $this->assertSame(AuctionStatus::Cerrada, $a->fresh()->status);
        $this->assertSame($beto->id, $this->ownerOf($this->m(), $p)); // gana el último que iba ganando
        $this->assertSame(0, $this->wallet($ana)->reserved);
        $this->assertInvariants();
    }

    public function test_pujar_en_una_subasta_cerrada_da_error_claro(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property();
        $this->claimAs($ana, $p->id);
        $a = Auction::firstOrFail();
        $this->advance(10);
        $this->auctions->settleDue();

        try {
            $this->auctions->bid($beto, $a->id, 50000);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('subasta_cerrada', $e->errorCode);
        }
    }

    public function test_cerrar_dos_veces_cobra_una_sola(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property(10000);
        $this->claimAs($ana, $p->id);
        $a = Auction::firstOrFail();
        $this->advance(10);

        $this->auctions->settle($a->id);
        $this->auctions->settle($a->id);
        $this->auctions->settleDue();

        $this->assertSame(20000, $this->wallet($ana)->cash);
        $this->assertSame(1, LedgerEntry::where('property_id', $p->id)->count());
        Event::assertDispatchedTimes(PropertyOwnerChanged::class, 1);
        $this->assertInvariants();
    }

    public function test_cerrar_antes_de_tiempo_no_hace_nada(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property();
        $this->claimAs($ana, $p->id);
        $a = Auction::firstOrFail();
        $this->advance(5);

        $r = $this->auctions->settle($a->id);

        $this->assertTrue($r->isActive());
        $this->assertNull($this->ownerOf($this->m(), $p));
    }

    public function test_disputarla_exige_poder_superar_la_oferta(): void
    {
        $ana = $this->user('Ana');
        $pobre = $this->user('Pobre');
        $this->claimAs($ana, ($p = $this->property(10000))->id);
        $this->economyFor($pobre, 10200); // tiene 10200: no alcanza para 10500

        try {
            $this->claimAs($pobre, $p->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('saldo_insuficiente', $e->errorCode);
        }
        $this->assertSame(AuctionStatus::Disputa, Auction::firstOrFail()->status); // no pudo frenar la compra de Ana
    }

    public function test_no_se_puede_disputar_una_reserva_que_ya_vencio(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property(10000);
        $this->claimAs($ana, $p->id);
        $this->advance(10); // venció la ventana, todavía nadie cerró

        try {
            $this->claimAs($beto, $p->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('ocupada', $e->errorCode); // se cerró en ese momento y Ana se la llevó
        }

        $this->assertSame($ana->id, $this->ownerOf($this->m(), $p));
        $this->assertSame(AuctionStatus::Cerrada, Auction::firstOrFail()->status);
        $this->assertSame(0, $this->wallet($beto)->reserved);
        $this->assertInvariants();
    }

    public function test_disputar_cuenta_para_el_tope_de_subastas_ganando(): void
    {
        config(['formosa.auction.max_active_per_user' => 1]);
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p1 = $this->property(1000);
        $p2 = $this->property(1000);
        $this->claimAs($ana, $p1->id);
        $this->claimAs($beto, $p2->id); // Beto ya va ganando una

        try {
            $this->claimAs($beto, $p1->id); // disputar otra sería ganar dos a la vez
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('demasiadas_subastas', $e->errorCode);
        }
        $this->assertSame($ana->id, Auction::where('property_id', $p1->id)->firstOrFail()->leader_id);
        $this->assertInvariants();
    }

    public function test_si_se_abrio_la_subasta_no_se_puja_a_ciegas_al_disputar(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $carla = $this->user('Carla');
        $p = $this->property(10000);
        $a = $this->contested($ana, $beto, $p); // abierta, Beto con 10.500

        // El camino interno de claim() exige que siga en "disputa": con la subasta abierta no puja por el jugador.
        try {
            $this->auctions->bid($carla, $a->id, null, AuctionStatus::Disputa);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('en_subasta', $e->errorCode);
        }
        $this->assertSame(10500, $a->fresh()->current_bid);
        $this->assertSame(0, $this->wallet($carla)->reserved);
    }

    public function test_cerrar_antes_de_tiempo_no_toma_bloqueos_ni_cambia_nada(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property();
        $this->claimAs($ana, $p->id);
        $a = Auction::firstOrFail();
        $before = $a->fresh()->updated_at;

        $queries = [];
        DB::listen(function ($q) use (&$queries) { $queries[] = $q->sql; });
        $this->auctions->settle($a->id);

        $this->assertEmpty(array_filter($queries, fn ($sql) => str_contains(strtolower($sql), 'for update')));
        $this->assertEquals($before, $a->fresh()->updated_at);
    }

    public function test_pedir_una_propiedad_con_subasta_abierta_indica_que_hay_que_pujar(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $carla = $this->user('Carla');
        $p = $this->property();
        $this->contested($ana, $beto, $p);

        try {
            $this->claimAs($carla, $p->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('en_subasta', $e->errorCode);
        }
        $this->assertSame(0, $this->wallet($carla)->reserved);
    }

    public function test_una_propiedad_con_dueno_no_se_reclama(): void
    {
        $ana = $this->user('Ana');
        $beto = $this->user('Beto');
        $p = $this->property();
        $this->claimAs($ana, $p->id);
        $this->advance(10);
        $this->auctions->settleDue();

        foreach ([[$beto, 'ocupada'], [$ana, 'ya_es_tuya']] as [$u, $code]) {
            try {
                $this->claimAs($u, $p->id);
                $this->fail('debía rechazar');
            } catch (GameException $e) {
                $this->assertSame($code, $e->errorCode);
            }
        }
    }

    public function test_hay_un_tope_de_subastas_ganando_a_la_vez(): void
    {
        config(['formosa.auction.max_active_per_user' => 2]);
        $ana = $this->user('Ana');
        $this->claimAs($ana, $this->property(1000)->id);
        $this->claimAs($ana, $this->property(1000)->id);

        try {
            $this->claimAs($ana, $this->property(1000)->id);
            $this->fail('debía rechazar');
        } catch (GameException $e) {
            $this->assertSame('demasiadas_subastas', $e->errorCode);
        }
        $this->assertSame(2, Auction::count());
    }

    public function test_propiedad_inexistente_y_subasta_inexistente(): void
    {
        $ana = $this->user('Ana');

        try {
            $this->claimAs($ana, 9999);
            $this->fail();
        } catch (GameException $e) {
            $this->assertSame('propiedad_inexistente', $e->errorCode);
        }
        try {
            $this->auctions->bid($ana, 9999, 100);
            $this->fail();
        } catch (GameException $e) {
            $this->assertSame('subasta_inexistente', $e->errorCode);
        }
        $this->assertNull($this->auctions->settle(9999));
    }

    public function test_con_ventana_en_cero_se_compra_al_instante_como_en_la_fase_2(): void
    {
        config(['formosa.auction.dispute_seconds' => 0]);
        $ana = $this->user('Ana');
        $p = $this->property(10000);

        $r = $this->claimAs($ana, $p->id);

        $this->assertSame('comprada', $r->result);
        $this->assertSame($ana->id, $this->ownerOf($this->m(), $p));
        $this->assertSame(0, Auction::count());
        $this->assertSame(20000, $this->wallet($ana)->cash);
    }

    public function test_solo_puede_haber_una_subasta_activa_por_propiedad_a_nivel_de_base(): void
    {
        $ana = $this->user('Ana');
        $p = $this->property();
        $this->claimAs($ana, $p->id);

        $this->expectException(\Illuminate\Database\QueryException::class);
        DB::table('auctions')->insert([
            'match_id' => $this->m()->id, 'property_id' => $p->id, 'starter_id' => $ana->id, 'leader_id' => $ana->id, 'status' => 'disputa',
            'list_price' => 1, 'current_bid' => 1, 'ends_at' => now(), 'active_property_id' => $p->id,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_las_pujas_no_se_editan_ni_se_borran(): void
    {
        $ana = $this->user('Ana');
        $this->claimAs($ana, $this->property()->id);
        $bid = AuctionBid::firstOrFail();

        $this->expectException(LogicException::class);
        $bid->delete();
    }

    public function test_lo_publico_no_incluye_saldos(): void
    {
        $ana = $this->user('Ana');
        $this->claimAs($ana, $this->property(10000)->id);

        $pub = Auction::firstOrFail()->toPublic();

        $this->assertSame('Ana', $pub['leader']);
        $this->assertSame(10500, $pub['min_next']);
        $this->assertSame(Carbon::parse('2026-10-15 10:00:10')->getTimestampMs(), $pub['ends_at']);
        $this->assertSame(['id', 'match_id', 'property_id', 'status', 'list_price', 'current_bid', 'min_next', 'flash', 'leader_id', 'leader', 'contested', 'ends_at', 'server_now'], array_keys($pub));
    }

    public function test_muchas_subastas_a_la_vez_mantienen_los_invariantes(): void
    {
        $users = collect(['Ana', 'Beto', 'Carla', 'Dani'])->map(fn ($n) => $this->user($n));
        $props = collect(range(1, 6))->map(fn () => $this->property(2000));

        foreach ($props as $i => $p) {
            $this->claimAs($users[$i % 4], $p->id);
            $this->claimAs($users[($i + 1) % 4], $p->id); // disputa: queda ganando el segundo
        }
        $amount = 3000;
        foreach (Auction::orderBy('id')->get() as $a) {
            $bidder = $users->first(fn (User $u) => $u->id !== $a->leader_id);
            $this->auctions->bid($bidder, $a->id, $amount += 100);
            $this->assertInvariants();
        }
        $this->advance(60);
        $this->auctions->settleDue();

        $this->assertSame(0, Auction::whereNotNull('active_property_id')->count());
        $this->assertSame(6, DB::table('match_properties')->where('match_id', $this->m()->id)->count());
        $this->assertSame(0, (int) MatchPlayer::sum('reserved'));
        $this->assertInvariants();
    }

    /** Deja a un jugador con un dinero exacto (para probar límites). */
    private function economyFor(User $u, int $balance): void
    {
        $current = $this->wallet($u)->cash;
        DB::table('match_players')->where('match_id', $this->m()->id)->where('user_id', $u->id)->update(['cash' => $balance]);
        LedgerEntry::forceCreate([
            'match_id' => $this->m()->id, 'user_id' => $u->id, 'type' => $balance >= $current ? \App\Enums\LedgerType::Cobro : \App\Enums\LedgerType::Compra,
            'amount' => $balance - $current, 'balance_after' => $balance,
            'property_id' => $balance >= $current ? null : $this->property(1)->id,
        ]);
    }
}
