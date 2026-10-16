<?php

namespace Tests\Feature;

use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** La ruta de mejorar: sesión, validación y forma de la respuesta. */
class UpgradeApiTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private int $propertyId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.match.minutes_per_day' => 2, 'formosa.events.enabled' => false, 'formosa.sprint.enabled' => false]);
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create();
        $this->match = $this->startedMatch([$this->ana], 100000);
        $p = $this->makeProperty(10000, 2500, 'casa');
        $this->propertyId = $p->id;
        DB::table('match_properties')->insert(['match_id' => $this->match->id, 'property_id' => $p->id, 'owner_id' => $this->ana->id, 'bought_at' => now(), 'price_paid' => 10000]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function url(?int $propertyId = null): string
    {
        return "/api/partidas/{$this->match->id}/propiedades/".($propertyId ?? $this->propertyId).'/mejorar';
    }

    public function test_requiere_sesion(): void
    {
        $this->postJson($this->url(), ['nivel' => 1])->assertUnauthorized();
    }

    public function test_la_ruta_valida_los_numeros(): void
    {
        $this->actingAs($this->ana)->postJson("/api/partidas/abc/propiedades/{$this->propertyId}/mejorar", ['nivel' => 1])->assertNotFound();
        $this->actingAs($this->ana)->postJson($this->url(0 + 99999999999999999), ['nivel' => 1])->assertNotFound();
    }

    public function test_respuesta_trae_nivel_costo_y_saldo(): void
    {
        $this->actingAs($this->ana)->postJson($this->url(), ['nivel' => 1], ['Idempotency-Key' => 'abc12345-xyz'])
            ->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJson(['ok' => true, 'match_id' => $this->match->id, 'property_id' => $this->propertyId, 'level' => 1, 'branch' => null, 'cost' => 5000, 'balance' => 95000, 'replayed' => false]);
    }

    public function test_nivel_dos_con_rama_por_la_api(): void
    {
        $h = ['Idempotency-Key' => 'abc12345-xyz'];
        $this->actingAs($this->ana)->postJson($this->url(), ['nivel' => 1], $h)->assertOk();
        $this->actingAs($this->ana)->postJson($this->url(), ['nivel' => 2, 'rama' => 'b'], ['Idempotency-Key' => 'otra-clave-12'])
            ->assertOk()->assertJsonPath('branch', 'b')->assertJsonPath('cost', 6000);
    }

    public function test_cuerpo_invalido_da_422(): void
    {
        foreach ([[], ['nivel' => 3], ['nivel' => 'x'], ['nivel' => 2, 'rama' => 'c'], ['nivel' => 1, 'rama' => 'a']] as $body) {
            $this->actingAs($this->ana)->postJson($this->url(), $body)->assertUnprocessable();
        }
    }

    public function test_encabezado_de_clave_invalido_da_422(): void
    {
        $this->actingAs($this->ana)->postJson($this->url(), ['nivel' => 1], ['Idempotency-Key' => "x'; DROP TABLE users;--"])->assertUnprocessable();
    }

    public function test_errores_de_juego_dan_codigo_estable(): void
    {
        $this->actingAs($this->ana)->postJson($this->url(), ['nivel' => 2, 'rama' => 'a'])->assertStatus(409)->assertJsonPath('error', 'mejora_no_disponible');
    }
}
