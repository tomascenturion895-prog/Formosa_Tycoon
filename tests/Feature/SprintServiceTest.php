<?php

namespace Tests\Feature;

use App\Economy\AuctionService;
use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\LoanService;
use App\Economy\MatchEvents;
use App\Economy\MatchService;
use App\Economy\SprintService;
use App\Enums\AuctionStatus;
use App\Models\Auction;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Sprint final: ingreso x2, subastas relámpago, remontada y préstamos bloqueados; y eventos por zona en el ingreso real. */
class SprintServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    private User $cami;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'formosa.sprint.enabled' => true, 'formosa.sprint.seconds' => 300, 'formosa.events.enabled' => false,
            'formosa.auction.dispute_seconds' => 10, 'formosa.auction.duration_seconds' => 30, 'formosa.auction.min_increment' => 100, 'formosa.auction.min_increment_pct' => 5,
            'formosa.match.duration_minutes' => 40, 'formosa.match.minutes_per_day' => 2,
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->cami = User::factory()->create(['name' => 'Cami']);
        $this->match = $this->startedMatch([$this->ana, $this->beto, $this->cami], 100000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function goToSprint(int $secondsIn = 0): void
    {
        Carbon::setTestNow($this->match->started_at->copy()->addSeconds(40 * 60 - 300 + $secondsIn));
    }

    // ------------------------------------------------------------------ ingreso

    public function test_en_el_sprint_el_ingreso_rinde_el_doble(): void
    {
        $p = $this->makeProperty(price: 1000, income: 1200); // 1200 por día de juego = 10 por segundo
        app(EconomyService::class)->buy($this->ana, $this->match->id, $p->id);
        $svc = app(EconomyService::class);

        $this->assertSame(1200, $svc->incomePerDay($this->match->id, $this->ana->id));
        $this->goToSprint(10);
        $this->assertSame(2400, $svc->incomePerDay($this->match->id, $this->ana->id));
    }

    public function test_el_ingreso_se_parte_donde_empieza_el_sprint(): void
    {
        $p = $this->makeProperty(price: 1000, income: 1200);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $p->id);
        $cashBefore = $this->cash($this->match, $this->ana);
        // 100 s antes del sprint y 100 s dentro: 100 s al ritmo normal (10/s) y 100 s al doble (20/s).
        Carbon::setTestNow($this->match->started_at->copy()->addSeconds(40 * 60 - 300 - 100));
        $svc = app(EconomyService::class);
        $svc->settleIncome($this->match->fresh(), $this->player($this->match, $this->ana));
        $mid = $this->cash($this->match, $this->ana);
        $this->goToSprint(100);
        $svc->settleIncome($this->match->fresh(), $this->player($this->match, $this->ana)->fresh());
        $this->assertSame(100 * 10 + 100 * 20, $this->cash($this->match, $this->ana) - $mid);
    }

    public function test_un_evento_de_zona_solo_beneficia_las_propiedades_de_esa_zona(): void
    {
        config(['formosa.events.enabled' => true, 'formosa.events.zonal' => true, 'formosa.events.zone_min_props' => 2, 'formosa.sprint.enabled' => false]);
        // Dos comercios en la misma celda y uno lejos.
        $a = $this->makeProperty(price: 1000, income: 1000, kind: 'comercio', lat: -26.1801, lng: -58.1701);
        $b = $this->makeProperty(price: 1000, income: 1000, kind: 'comercio', lat: -26.1802, lng: -58.1702);
        $far = $this->makeProperty(price: 1000, income: 1000, kind: 'comercio', lat: -26.3001, lng: -58.3001);
        foreach ([$a, $b, $far] as $x) {
            app(EconomyService::class)->buy($this->ana, $this->match->id, $x->id);
        }
        $zones = MatchEvents::zonesFor($this->match->id);
        $this->assertCount(1, $zones, 'solo la celda con dos propiedades es elegible');

        $schedule = MatchEvents::forMatch($this->match);
        $feria = collect($schedule)->firstWhere('kind', 'comercio') ?? $schedule[0];
        // Se fuerza el calendario: un comercio-evento en esa zona.
        $active = [['key' => 'feria', 'kind' => 'comercio', 'zone' => $zones[0], 'pct' => 0.5]];
        $this->assertSame(1.5, MatchEvents::factor($active, 'comercio', \App\Economy\Combos::zoneKey(-26.1801, -58.1701)));
        $this->assertSame(1.0, MatchEvents::factor($active, 'comercio', \App\Economy\Combos::zoneKey(-26.3001, -58.3001)));
        $this->assertNotNull($feria);
        foreach (MatchEvents::forMatch($this->match) as $e) {
            $this->assertSame($zones[0], $e['zone']);
        }
    }

    // ------------------------------------------------------------------ relámpago

    public function test_el_reloj_abre_una_relampago_por_tramo_y_no_repite(): void
    {
        $this->makeProperty(price: 10000);
        $this->makeProperty(price: 20000);
        $svc = app(SprintService::class);

        $this->assertSame(0, $svc->tick(), 'antes del sprint no pasa nada');
        $this->goToSprint(1);
        $this->assertSame(1, $svc->tick());
        $this->assertSame(0, $svc->tick(), 'el mismo tramo no abre otra');

        $a = Auction::firstOrFail();
        $this->assertTrue($a->flash);
        $this->assertNull($a->leader_id);
        $this->assertSame(AuctionStatus::Abierta, $a->status);
        $this->assertSame((int) floor($a->property->price * 0.6), $a->list_price);
        $this->assertSame(20, $a->ends_at->getTimestamp() - now()->getTimestamp());

        Carbon::setTestNow(now()->addSeconds(61));
        $this->assertSame(1, $svc->tick(), 'el siguiente tramo abre otra');
    }

    public function test_no_se_abre_una_relampago_que_no_alcanza_a_terminar_antes_del_cierre(): void
    {
        $this->makeProperty(price: 10000);
        Carbon::setTestNow($this->match->ends_at->copy()->subSeconds(10)); // quedan 10 s y la relámpago dura 20
        $this->assertSame(0, app(SprintService::class)->tick());
    }

    public function test_la_primera_puja_iguala_el_precio_de_salida_y_gana_el_ultimo(): void
    {
        $p = $this->makeProperty(price: 10000);
        $this->goToSprint(1);
        app(SprintService::class)->tick();
        $a = Auction::firstOrFail();
        $auctions = app(AuctionService::class);

        $r = $auctions->bid($this->ana, $a->id, null); // sin monto = el mínimo vigente = el precio de salida
        $this->assertSame(6000, $r->auction->current_bid);
        $this->assertSame($this->ana->id, $r->auction->leader_id);
        $this->assertSame(6000, $this->player($this->match, $this->ana)->reserved);

        $auctions->bid($this->beto, $a->id, 7000);
        $this->assertSame(0, $this->player($this->match, $this->ana)->fresh()->reserved, 'a Ana se le libera lo reservado');

        Carbon::setTestNow(now()->addSeconds(25));
        $auctions->settleDue();
        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $p));
        $this->assertSame(100000 - 7000, $this->cash($this->match, $this->beto));
    }

    public function test_la_relampago_no_se_prorroga_aunque_pujen_al_final(): void
    {
        $this->makeProperty(price: 10000);
        $this->goToSprint(1);
        app(SprintService::class)->tick();
        $a = Auction::firstOrFail();
        $end = $a->ends_at->copy();
        Carbon::setTestNow($end->copy()->subSeconds(1));
        app(AuctionService::class)->bid($this->ana, $a->id, null);
        $this->assertTrue($a->fresh()->ends_at->equalTo($end));
        $this->assertSame(0, $a->fresh()->extensions);
    }

    public function test_sin_pujas_se_cancela_y_la_propiedad_sigue_libre(): void
    {
        $p = $this->makeProperty(price: 10000);
        $this->goToSprint(1);
        app(SprintService::class)->tick();
        Carbon::setTestNow(now()->addSeconds(25));

        app(AuctionService::class)->settleDue();

        $a = Auction::firstOrFail();
        $this->assertSame(AuctionStatus::Cancelada, $a->status);
        $this->assertNull($a->active_property_id);
        $this->assertNull($this->ownerOf($this->match, $p));
        $this->assertSame(100000, $this->cash($this->match, $this->ana));
    }

    public function test_el_cierre_de_la_partida_cancela_una_relampago_sin_lider(): void
    {
        $this->makeProperty(price: 10000);
        $this->goToSprint(1);
        app(SprintService::class)->tick();
        Carbon::setTestNow($this->match->ends_at->copy()->addSecond());

        app(MatchService::class)->finish($this->match->id);

        $this->assertSame(AuctionStatus::Cancelada, Auction::firstOrFail()->status);
    }

    // ------------------------------------------------------------------ remontada

    public function test_el_ultimo_tercio_compra_con_descuento_y_el_primero_no(): void
    {
        // Cami y Beto tienen propiedades; Ana, nada: va última.
        $x = $this->makeProperty(price: 5000, income: 100);
        $y = $this->makeProperty(price: 3000, income: 100);
        app(EconomyService::class)->buy($this->cami, $this->match->id, $x->id);
        app(EconomyService::class)->buy($this->beto, $this->match->id, $y->id);
        $target = $this->makeProperty(price: 10000);
        $target2 = $this->makeProperty(price: 10000);
        $svc = app(SprintService::class);

        $this->assertSame(0, $svc->discountPct($this->match, $this->ana->id), 'fuera del sprint no hay descuento');
        $this->goToSprint(5);
        $this->assertSame(10, $svc->discountPct($this->match, $this->ana->id));
        $this->assertSame(0, $svc->discountPct($this->match, $this->cami->id));

        config(['formosa.auction.dispute_seconds' => 0]);
        $r = app(EconomyService::class)->buy($this->ana, $this->match->id, $target->id);
        $this->assertSame(9000, $r->price);
        $r2 = app(EconomyService::class)->buy($this->cami, $this->match->id, $target2->id);
        $this->assertSame(10000, $r2->price);
    }

    public function test_el_snapshot_informa_el_descuento(): void
    {
        $x = $this->makeProperty(price: 5000, income: 100);
        $y = $this->makeProperty(price: 3000, income: 100);
        app(EconomyService::class)->buy($this->cami, $this->match->id, $x->id);
        app(EconomyService::class)->buy($this->beto, $this->match->id, $y->id);
        $this->goToSprint(5);
        $this->assertSame(10, app(EconomyService::class)->snapshot($this->ana, $this->match->fresh())['comeback_pct']);
        $this->assertSame(0, app(EconomyService::class)->snapshot($this->cami, $this->match->fresh())['comeback_pct']);
    }

    public function test_el_libro_de_caja_sigue_cuadrando_con_el_descuento(): void
    {
        $x = $this->makeProperty(price: 5000, income: 100);
        app(EconomyService::class)->buy($this->cami, $this->match->id, $x->id);
        $t = $this->makeProperty(price: 10000);
        $this->goToSprint(5);
        config(['formosa.auction.dispute_seconds' => 0]);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $t->id);

        $sum = (int) DB::table('ledger_entries')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->sum('amount');
        $this->assertSame($this->cash($this->match, $this->ana), $sum);
    }

    // ------------------------------------------------------------------ banco

    public function test_en_el_sprint_no_se_piden_prestamos(): void
    {
        $this->goToSprint(5);
        try {
            app(LoanService::class)->take($this->ana, $this->match->id, 5000, 5);
            $this->fail('debía bloquearse');
        } catch (GameException $e) {
            $this->assertSame('prestamo_sprint', $e->errorCode);
        }
        $this->assertSame('sprint', app(LoanService::class)->summary($this->ana, $this->match->id)['blocked']);
    }

    public function test_apagado_no_cambia_nada(): void
    {
        config(['formosa.sprint.enabled' => false]);
        $this->goToSprint(5);
        $this->assertFalse(app(SprintService::class)->isOn($this->match));
        $this->assertSame(0, app(SprintService::class)->tick());
        $this->assertNotNull(app(LoanService::class)->take($this->ana, $this->match->id, 5000, 5));
    }
}
