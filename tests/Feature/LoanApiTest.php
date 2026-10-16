<?php

namespace Tests\Feature;

use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** API HTTP del banco: sesión, validación, forma de las respuestas y que nada se filtre entre jugadores. */
class LoanApiTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private User $ana;

    private User $beto;

    private GameMatch $match;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 100000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_pedir_y_pagar_por_http(): void
    {
        $r = $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 10000, 'plazo' => 5])
            ->assertOk()->assertJsonPath('loan.principal', 10000)->assertJsonPath('debt', 10000)->assertJsonPath('cash', 110000)->assertJsonPath('rules.rate_pct', 3);
        $id = $r->json('loan.id');

        $this->actingAs($this->ana)->postJson(route('api.prestamos.pagar', [$this->match->id, $id]), ['monto' => 4000])
            ->assertOk()->assertJsonPath('loan.balance', 6000)->assertJsonPath('debt', 6000);
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pagar', [$this->match->id, $id]))
            ->assertOk()->assertJsonPath('loan.status', 'pagado')->assertJsonPath('debt', 0)->assertJsonCount(0, 'loans');
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_exige_sesion(): void
    {
        $this->getJson(route('api.prestamos', $this->match->id))->assertUnauthorized();
        $this->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 10000, 'plazo' => 5])->assertUnauthorized();
        $this->postJson(route('api.prestamos.pagar', [$this->match->id, 1]))->assertUnauthorized();
    }

    public function test_validacion_y_errores_con_codigo_estable(): void
    {
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 'x', 'plazo' => 5])->assertStatus(422);
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 10000])->assertStatus(422);
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 10000, 'plazo' => 7])->assertStatus(422)->assertJsonPath('error', 'plazo_invalido');
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 90000, 'plazo' => 5])
            ->assertStatus(422)->assertJsonPath('error', 'prestamo_excedido')->assertJsonPath('maximo', 50000);
    }

    public function test_el_resumen_es_privado(): void
    {
        $this->actingAs($this->ana)->postJson(route('api.prestamos.pedir', $this->match->id), ['monto' => 10000, 'plazo' => 5])->assertOk();
        $loan = $this->actingAs($this->ana)->getJson(route('api.prestamos', $this->match->id))->assertOk()->assertJsonCount(1, 'loans')->json('loans.0.id');

        $this->actingAs($this->beto)->getJson(route('api.prestamos', $this->match->id))->assertOk()->assertJsonCount(0, 'loans')->assertJsonPath('debt', 0);
        $this->actingAs($this->beto)->postJson(route('api.prestamos.pagar', [$this->match->id, $loan]))->assertNotFound()->assertJsonPath('error', 'prestamo_inexistente');
    }

    public function test_quien_no_juega_esa_partida_no_ve_el_banco(): void
    {
        $otro = User::factory()->create();

        $this->actingAs($otro)->getJson(route('api.prestamos', $this->match->id))->assertStatus(403)->assertJsonPath('error', 'no_estas_en_partida');
    }
}
