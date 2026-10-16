<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\MatchService;
use App\Economy\OfferService;
use App\Events\ActivityFeed;
use App\Events\OfferUpdated;
use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Qué pasa con una propiedad mejorada al ofertarla, venderla al banco o abandonar la partida. */
class UpgradeTradeTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    private Property $casa;

    protected function setUp(): void
    {
        parent::setUp();
        config(['formosa.match.minutes_per_day' => 2, 'formosa.events.enabled' => false, 'formosa.sprint.enabled' => false]);
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create();
        $this->beto = User::factory()->create();
        $this->match = $this->startedMatch([$this->ana, $this->beto], 100000);
        $this->casa = $this->makeProperty(price: 10000);
        app(EconomyService::class)->buy($this->ana, $this->match->id, $this->casa->id);
        $this->setUpgrade(2, 'a', 13000);
        Event::fake([OfferUpdated::class, ActivityFeed::class, PropertyOwnerChanged::class]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function setUpgrade(int $level, ?string $branch, int $paid): void
    {
        DB::table('match_properties')->where('match_id', $this->match->id)->where('property_id', $this->casa->id)->update(['level' => $level, 'branch' => $branch, 'upgrade_paid' => $paid]);
    }

    private function row(): ?object
    {
        return DB::table('match_properties')->where('match_id', $this->match->id)->where('property_id', $this->casa->id)->first();
    }

    public function test_la_oferta_aceptada_traspasa_nivel_rama_e_inversion(): void
    {
        $offers = app(OfferService::class);
        $o = $offers->open($this->ana, $this->match->id, $this->casa->id, 8000, 20000);
        $offers->bid($this->beto, $o->id, 10000);
        $offers->accept($this->ana, $o->id);

        $row = $this->row();
        $this->assertSame($this->beto->id, (int) $row->owner_id);
        $this->assertSame([2, 'a', 13000], [(int) $row->level, $row->branch, (int) $row->upgrade_paid]);
    }

    public function test_la_lista_de_ofertas_muestra_nivel_y_etiqueta(): void
    {
        $offers = app(OfferService::class);
        $offers->open($this->ana, $this->match->id, $this->casa->id, 8000, 20000);

        $o = $offers->activeForPublic($this->match->id)[0];
        $this->assertSame([2, 'a', 'Alquiler turístico'], [$o['level'], $o['branch'], $o['label']]);
    }

    public function test_una_oferta_de_propiedad_sin_mejora_no_trae_etiqueta(): void
    {
        $this->setUpgrade(0, null, 0);
        $offers = app(OfferService::class);
        $offers->open($this->ana, $this->match->id, $this->casa->id, 8000, 20000);

        $o = $offers->activeForPublic($this->match->id)[0];
        $this->assertSame([0, null, null], [$o['level'], $o['branch'], $o['label']]);
    }

    public function test_vender_al_banco_devuelve_el_porcentaje_de_lista_y_pierde_la_mejora(): void
    {
        $before = $this->cash($this->match, $this->ana);
        $r = app(EconomyService::class)->sell($this->ana, $this->match->id, $this->casa->id);

        $this->assertSame(6000, $r['refund']);          // 60 % del precio de lista, sin contar lo invertido
        $this->assertNull($this->row());
        $this->assertSame($before + 6000, $this->cash($this->match, $this->ana));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_abandonar_la_partida_borra_las_mejoras(): void
    {
        app(MatchService::class)->leave($this->ana, $this->match->id);
        $this->assertNull($this->row());
    }
}
