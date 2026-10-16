<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\OfferService;
use App\Economy\UpgradeService;
use App\Models\GameMatch;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Mejorar una propiedad: costo, niveles, ramas, bloqueos, idempotencia y descuento del centro logístico. */
class UpgradeServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private UpgradeService $upgrades;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    private Property $casa;

    protected function setUp(): void
    {
        parent::setUp();
        $this->upgrades = app(UpgradeService::class);
        config(['formosa.match.minutes_per_day' => 2, 'formosa.events.enabled' => false, 'formosa.sprint.enabled' => false]);
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create();
        $this->beto = User::factory()->create();
        $this->match = $this->startedMatch([$this->ana, $this->beto], 100000);
        $this->casa = $this->makeProperty(10000, 2500, 'casa');
        $this->own($this->ana, $this->casa);
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

    private function row(Property $p): object
    {
        return DB::table('match_properties')->where('match_id', $this->match->id)->where('property_id', $p->id)->first();
    }

    private function up(int $level, ?string $branch = null, ?string $key = null, ?User $user = null, ?Property $p = null): array
    {
        return $this->upgrades->upgrade($user ?? $this->ana, $this->match->id, ($p ?? $this->casa)->id, $level, $branch, $key);
    }

    private function fails(callable $fn, string $code): void
    {
        try {
            $fn();
            $this->fail("debió fallar con {$code}");
        } catch (GameException $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }

    public function test_mejora_de_cero_a_uno_cobra_y_escribe_el_libro(): void
    {
        $r = $this->up(1);

        $this->assertSame([1, null, 5000, 95000, 3375, false], [$r['level'], $r['branch'], $r['cost'], $r['balance'], $r['income_per_day'], $r['replayed']]);
        $row = $this->row($this->casa);
        $this->assertSame([1, null, 5000], [(int) $row->level, $row->branch, (int) $row->upgrade_paid]);
        $this->assertDatabaseHas('ledger_entries', ['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'mejora', 'amount' => -5000, 'balance_after' => 95000, 'property_id' => $this->casa->id]);
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_mejora_de_uno_a_dos_con_rama(): void
    {
        $this->up(1);
        $r = $this->up(2, 'a');

        $this->assertSame([2, 'a', 8000, 87000], [$r['level'], $r['branch'], $r['cost'], $r['balance']]);
        $this->assertSame(13000, (int) $this->row($this->casa)->upgrade_paid);
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_no_se_salta_de_cero_a_dos(): void
    {
        $this->fails(fn () => $this->up(2, 'a'), 'mejora_no_disponible');
        $this->assertSame(0, (int) $this->row($this->casa)->level);
    }

    public function test_rama_invalida_o_faltante(): void
    {
        $this->up(1);
        $this->fails(fn () => $this->up(2, null), 'rama_invalida');
        $this->fails(fn () => $this->up(2, 'c'), 'rama_invalida');
        $other = $this->makeProperty(10000, 2500, 'casa');
        $this->own($this->ana, $other);
        $this->fails(fn () => $this->up(1, 'a', null, null, $other), 'rama_invalida');
    }

    public function test_el_mismo_nivel_o_uno_menor_no_esta_disponible(): void
    {
        $this->up(1);
        $this->fails(fn () => $this->up(1), 'mejora_no_disponible');
        $this->fails(fn () => $this->up(0), 'mejora_no_disponible');
        $this->fails(fn () => $this->up(3, 'a'), 'mejora_no_disponible');
    }

    public function test_solo_el_dueno_mejora(): void
    {
        $this->fails(fn () => $this->up(1, null, null, $this->beto), 'no_es_tuya');
        $libre = $this->makeProperty();
        $this->fails(fn () => $this->up(1, null, null, null, $libre), 'no_es_tuya');
    }

    public function test_no_se_mejora_con_oferta_abierta(): void
    {
        app(OfferService::class)->open($this->ana, $this->match->id, $this->casa->id, 8000, 20000);
        $this->fails(fn () => $this->up(1), 'en_oferta');
        $this->assertSame(0, (int) $this->row($this->casa)->level);
    }

    public function test_fondos_insuficientes_cuentan_lo_reservado(): void
    {
        DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->update(['cash' => 6000, 'reserved' => 2000]);
        $this->fails(fn () => $this->up(1), 'saldo_insuficiente'); // disponible 4000 < 5000
        DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->update(['reserved' => 1000]);
        $this->assertSame(1, $this->up(1)['level']);                // disponible 5000 alcanza justo
    }

    public function test_la_misma_clave_devuelve_lo_mismo_y_no_cobra_dos_veces(): void
    {
        $a = $this->up(1, null, 'clave-uno-1234');
        $b = $this->up(1, null, 'clave-uno-1234');

        $this->assertFalse($a['replayed']);
        $this->assertTrue($b['replayed']);
        $this->assertSame([1, 5000, 95000], [$b['level'], $b['cost'], $b['balance']]);
        $this->assertSame(95000, $this->cash($this->match, $this->ana));
        $this->assertSame(1, DB::table('ledger_entries')->where('type', 'mejora')->count());
    }

    public function test_la_clave_para_otra_propiedad_es_error(): void
    {
        $this->up(1, null, 'clave-uno-1234');
        $other = $this->makeProperty(10000, 2500, 'casa');
        $this->own($this->ana, $other);
        $this->fails(fn () => $this->up(1, null, 'clave-uno-1234', null, $other), 'clave_reutilizada');
    }

    public function test_dos_envios_sin_clave_solo_suben_un_nivel(): void
    {
        $this->up(1);
        $this->fails(fn () => $this->up(1), 'mejora_no_disponible');
        $this->assertSame(95000, $this->cash($this->match, $this->ana));
    }

    public function test_el_primer_centro_logistico_se_paga_completo_y_el_siguiente_con_descuento(): void
    {
        $super = $this->makeProperty(150000, 31500, 'supermercado');
        $this->own($this->ana, $super, 1, null, 75000);
        DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->update(['cash' => 300000]);

        $r = $this->up(2, 'b', null, null, $super);
        $this->assertSame(90000, $r['cost']);   // 60 % de 150000, todavía sin descuento
        $this->assertSame(4000, $this->up(1)['cost']); // casa: 5000 - 20 %
    }

    public function test_se_liquida_el_ingreso_pendiente_antes_de_cobrar(): void
    {
        Carbon::setTestNow('2026-10-14 10:02:00'); // un día de juego: la casa rindió 2500
        $r = $this->up(1);
        $this->assertSame(100000 + 2500 - 5000, $r['balance']);
        $this->assertSame(2500, $r['collected']);
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_partida_terminada_no_permite_mejorar(): void
    {
        Carbon::setTestNow('2026-10-14 11:00:00'); // la partida dura 40 minutos
        $this->fails(fn () => $this->up(1), 'partida_no_en_juego');
    }
}
