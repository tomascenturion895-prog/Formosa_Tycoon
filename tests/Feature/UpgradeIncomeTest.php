<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\LoanService;
use App\Models\GameMatch;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Ingreso neto (bruto - mantenimiento), combos con peso y patrimonio con mejoras. */
class UpgradeIncomeTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private EconomyService $economy;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    protected function setUp(): void
    {
        parent::setUp();
        $this->economy = app(EconomyService::class);
        config([
            'formosa.match.minutes_per_day' => 2, 'formosa.events.enabled' => false, 'formosa.sprint.enabled' => false,
            'formosa.combos.zone_tiers' => [3 => 0.10], 'formosa.combos.variety' => 0.10,
        ]);
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create();
        $this->beto = User::factory()->create();
        $this->match = $this->startedMatch([$this->ana, $this->beto], 5000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function own(User $user, Property $p, int $level = 0, ?string $branch = null, int $paid = 0): void
    {
        DB::table('match_properties')->insert([
            'match_id' => $this->match->id, 'property_id' => $p->id, 'owner_id' => $user->id, 'bought_at' => now(), 'price_paid' => $p->price,
            'level' => $level, 'branch' => $branch, 'upgrade_paid' => $paid,
        ]);
    }

    public function test_el_ingreso_por_dia_es_neto(): void
    {
        $this->own($this->ana, $this->makeProperty(10000, 1000), 1, null, 5000);
        $this->assertSame(1350, $this->economy->incomePerDay($this->match->id, $this->ana->id));
    }

    public function test_un_evento_de_crisis_no_deja_ingreso_negativo(): void
    {
        config(['formosa.events' => [
            'enabled' => true, 'zonal' => false, 'per_match' => 1, 'first_day' => 0, 'duration_days' => 20, 'announce_days' => 1, 'zone_min_props' => 30,
            'types' => ['crisis' => ['label' => 'Crisis', 'kind' => 'casa', 'pct' => -0.9, 'text' => 'x']],
        ]]);
        $this->own($this->ana, $this->makeProperty(10000, 1000, 'casa'), 2, 'a', 8000); // bruto 210 - mantenimiento 300 -> 0 (nunca negativo)
        $this->own($this->ana, $this->makeProperty(40000, 2000, 'comercio'));           // otro tipo: sigue rindiendo 2000
        $this->assertSame(2000, $this->economy->incomePerDay($this->match->id, $this->ana->id));
    }

    public function test_el_sprint_duplica_el_bruto_y_no_el_mantenimiento(): void
    {
        config(['formosa.sprint.enabled' => true, 'formosa.sprint.seconds' => 300, 'formosa.sprint.income_pct' => 1.0]);
        $this->own($this->ana, $this->makeProperty(10000, 1000), 1, null, 5000);
        Carbon::setTestNow('2026-10-14 10:36:00'); // la partida dura 40 min: el sprint empieza a las 10:35
        $this->assertSame(2750, $this->economy->incomePerDay($this->match->id, $this->ana->id)); // floor(1400 x 2) - 50
    }

    public function test_la_rama_b_de_la_casa_completa_el_combo_de_zona(): void
    {
        $lat = -26.18;
        $lng = -58.17;
        $this->own($this->ana, $this->makeProperty(10000, 1000, 'casa', $lat, $lng));
        $this->own($this->ana, $this->makeProperty(10000, 1000, 'casa', $lat, $lng), 2, 'b', 9000); // neto 1650, cuenta como 2
        $c = $this->economy->combos($this->match, $this->ana->id);
        $this->assertSame(2650, $c['base']);
        $this->assertSame(265, $c['bonus']);   // 10 % con 3 en la zona
        $this->assertSame(2915, $c['total']);
        $this->assertSame(3, $c['zones'][0]['count']);
    }

    public function test_liquidar_de_a_poco_da_lo_mismo_que_de_una_vez(): void
    {
        $this->own($this->ana, $this->makeProperty(10000, 1001), 1, null, 5000);
        $this->own($this->beto, $this->makeProperty(10000, 1001), 1, null, 5000);
        foreach ([300, 600] as $secs) {
            $now = Carbon::parse('2026-10-14 10:00:00')->addSeconds($secs);
            $this->economy->settleIncome($this->match, $this->player($this->match, $this->ana), $now);
        }
        $this->economy->settleIncome($this->match, $this->player($this->match, $this->beto), Carbon::parse('2026-10-14 10:00:00')->addSeconds(600));
        $this->assertSame($this->cash($this->match, $this->beto), $this->cash($this->match, $this->ana));
        $this->assertGreaterThan(5000, $this->cash($this->match, $this->ana));
    }

    public function test_el_patrimonio_cuenta_la_mitad_de_lo_invertido(): void
    {
        $this->own($this->ana, $this->makeProperty(10000, 1000), 1, null, 5001);
        $row = collect($this->economy->standings($this->match))->firstWhere('user_id', $this->ana->id);
        $this->assertSame(10000 + 2500, $row['assets']);
        $this->assertSame(5000 + 12500, $row['net_worth']);
    }

    public function test_standings_y_prestamo_usan_el_mismo_patrimonio(): void
    {
        $this->own($this->ana, $this->makeProperty(10000, 1000), 2, 'a', 13000);
        $row = collect($this->economy->standings($this->match))->firstWhere('user_id', $this->ana->id);
        $this->assertSame($row['net_worth'], app(LoanService::class)->netWorthOf($this->match->id, $this->ana->id, $row['cash'], $row['debt']));
    }

    public function test_el_snapshot_trae_desglose_y_opciones(): void
    {
        $p = $this->makeProperty(10000, 2500);
        $this->own($this->ana, $p, 1, null, 5000);
        $mine = collect($this->economy->snapshot($this->ana, $this->match)['properties'])->firstWhere('id', $p->id);
        $this->assertSame([1, null, 5000], [$mine['level'], $mine['branch'], $mine['upgrade_paid']]);
        $this->assertSame([3500, 125, 3375], [$mine['gross'], $mine['maintenance'], $mine['net']]);
        $this->assertSame(['a', 'b'], array_column($mine['upgrade'], 'branch'));
        $this->assertSame(1, $mine['weight']);
    }
}
