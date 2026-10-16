<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** MVP: vender al banco, ranking, recuperar contraseña, CSP y límite de login por cuenta. */
class MvpTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        Carbon::setTestNow('2026-10-20 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private User $ana;

    private User $beto;

    private GameMatch $match;

    /** Una partida en juego con Ana y Beto (cada uno con $50.000 y compra directa). */
    private function sala(): void
    {
        config(['formosa.auction.dispute_seconds' => 0, 'formosa.match.minutes_per_day' => 2]);
        $this->ana = User::factory()->create();
        $this->beto = User::factory()->create();
        $this->match = $this->startedMatch([$this->ana, $this->beto], 50000);
    }

    /** Propiedad con dueño en la partida (compra de verdad, por el servicio). */
    private function ownedBy(User $owner, int $price = 10000, int $income = 1200): int
    {
        $p = $this->makeProperty($price, $income);
        app(EconomyService::class)->buy($owner, $this->match->id, $p->id);

        return $p->id;
    }

    // ---------------------------------------------------------------------------------------- vender

    public function test_vender_devuelve_el_60_por_ciento_y_cobra_lo_acumulado(): void
    {
        Event::fake([PropertyOwnerChanged::class]);
        $this->sala();
        $id = $this->ownedBy($this->ana, 10000, 1200); // 10 por segundo real
        $before = $this->cash($this->match, $this->ana);

        Carbon::setTestNow(now()->addSeconds(12)); // 120 acumulados
        $this->actingAs($this->ana)->postJson("/api/partidas/{$this->match->id}/propiedades/{$id}/vender")->assertOk()
            ->assertJsonPath('refund', 6000)->assertJsonPath('collected', 120);

        $this->assertSame($before + 6000 + 120, $this->cash($this->match, $this->ana));
        $this->assertNull($this->ownerOf($this->match, $id));
        $this->assertDatabaseHas('ledger_entries', ['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'venta', 'amount' => 6000, 'property_id' => $id]);
        $this->assertLedgerMatchesCash($this->match);
        Event::assertDispatched(PropertyOwnerChanged::class, fn ($e) => $e->propertyId === $id && $e->ownerId === null && $e->matchId === $this->match->id);
    }

    public function test_no_se_puede_vender_lo_ajeno_ni_lo_libre(): void
    {
        $this->sala();
        $ajena = $this->ownedBy($this->beto);
        $libre = $this->makeProperty()->id;
        $base = "/api/partidas/{$this->match->id}/propiedades";

        $this->actingAs($this->ana)->postJson("{$base}/{$ajena}/vender")->assertStatus(403)->assertJsonPath('error', 'no_es_tuya');
        $this->actingAs($this->ana)->postJson("{$base}/{$libre}/vender")->assertStatus(403);
        $this->actingAs($this->ana)->postJson("{$base}/999999/vender")->assertNotFound();
        $this->assertSame($this->beto->id, $this->ownerOf($this->match, $ajena));
    }

    public function test_vender_exige_sesion(): void
    {
        $this->sala();
        $id = $this->makeProperty()->id;
        $this->postJson("/api/partidas/{$this->match->id}/propiedades/{$id}/vender")->assertUnauthorized();
    }

    public function test_vender_dos_veces_con_la_misma_clave_no_paga_dos_veces(): void
    {
        $this->sala();
        $id = $this->ownedBy($this->ana);
        $headers = ['Idempotency-Key' => 'venta-abc-123'];
        $url = "/api/partidas/{$this->match->id}/propiedades/{$id}/vender";

        $this->actingAs($this->ana)->postJson($url, [], $headers)->assertOk()->assertJsonPath('replayed', false);
        $after = $this->cash($this->match, $this->ana);
        $this->actingAs($this->ana)->postJson($url, [], $headers)->assertOk()->assertJsonPath('replayed', true);

        $this->assertSame($after, $this->cash($this->match, $this->ana));
        $this->assertSame(1, DB::table('ledger_entries')->where('type', 'venta')->count());
    }

    public function test_vender_otra_vez_sin_clave_ya_no_es_tuya(): void
    {
        $this->sala();
        $id = $this->ownedBy($this->ana);
        $url = "/api/partidas/{$this->match->id}/propiedades/{$id}/vender";

        $this->actingAs($this->ana)->postJson($url)->assertOk();
        $this->actingAs($this->ana)->postJson($url)->assertStatus(403);
    }

    public function test_comprar_y_vender_enseguida_siempre_pierde(): void
    {
        $this->sala();
        $id = $this->makeProperty(10000, 0)->id;
        $start = $this->cash($this->match, $this->ana);

        $this->actingAs($this->ana)->postJson("/api/partidas/{$this->match->id}/propiedades/{$id}/comprar")->assertOk();
        $this->actingAs($this->ana)->postJson("/api/partidas/{$this->match->id}/propiedades/{$id}/vender")->assertOk();

        $this->assertSame($start - 4000, $this->cash($this->match, $this->ana));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_la_base_exige_que_una_venta_sume_y_nombre_la_propiedad(): void
    {
        if (! in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            $this->markTestSkipped('CHECK solo en mysql/mariadb/pgsql.');
        }
        $this->sala();
        $this->expectException(\Illuminate\Database\QueryException::class);
        DB::table('ledger_entries')->insert(['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'venta', 'amount' => -5, 'balance_after' => 0, 'created_at' => now()]);
    }

    // ---------------------------------------------------------------------------------------- ranking global

    public function test_el_ranking_global_ordena_por_puntos_y_solo_lista_a_quien_jugo(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $carla = User::factory()->create();
        User::factory()->create(); // nunca jugó: no aparece
        DB::table('users')->where('id', $ana->id)->update(['rank_points' => 160, 'matches_won' => 1, 'matches_played' => 2]);
        DB::table('users')->where('id', $beto->id)->update(['rank_points' => 300, 'matches_won' => 3, 'matches_played' => 3]);
        DB::table('users')->where('id', $carla->id)->update(['rank_points' => 160, 'matches_won' => 2, 'matches_played' => 4]);

        $r = $this->getJson('/api/ranking')->assertOk()->json('players');

        $this->assertSame([$beto->name, $carla->name, $ana->name], array_column($r, 'name'), 'a igual puntaje, más victorias');
        $this->assertSame([300, 160, 160], array_column($r, 'points'));
        $this->assertSame([3, 2, 1], array_column($r, 'wins'));
        $this->assertSame([3, 4, 2], array_column($r, 'matches'));
        $this->assertSame([1, 2, 3], array_column($r, 'position'));
        $this->assertArrayNotHasKey('email', $r[0]);
    }

    public function test_el_jugador_ve_su_puesto_global(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        DB::table('users')->where('id', $ana->id)->update(['rank_points' => 100, 'matches_won' => 1, 'matches_played' => 1]);
        DB::table('users')->where('id', $beto->id)->update(['rank_points' => 60, 'matches_won' => 0, 'matches_played' => 1]);

        $this->actingAs($beto)->getJson('/api/yo')->assertOk()
            ->assertJsonPath('ranking.position', 2)->assertJsonPath('ranking.points', 60)->assertJsonPath('ranking.wins', 0)->assertJsonPath('ranking.matches', 1);
    }

    public function test_el_ranking_es_publico_y_no_lleva_cookies(): void
    {
        $r = $this->getJson('/api/ranking')->assertOk();
        $this->assertEmpty($r->headers->getCookies());
    }

    // ---------------------------------------------------------------------------------------- recuperar contraseña

    public function test_pedir_el_enlace_responde_igual_exista_o_no_la_cuenta(): void
    {
        Notification::fake();
        $ana = User::factory()->create(['email' => 'ana@x.test']);

        $a = $this->post('/olvide', ['email' => 'ANA@x.test '])->assertRedirect()->getSession()->get('ok');
        $b = $this->post('/olvide', ['email' => 'nadie@x.test'])->assertRedirect()->getSession()->get('ok');

        $this->assertSame($a, $b);
        Notification::assertSentTo($ana, ResetPassword::class);
        Notification::assertCount(1);
    }

    public function test_restablecer_con_el_token_cambia_la_contrasena(): void
    {
        $ana = User::factory()->create(['email' => 'ana@x.test']);
        $token = Password::createToken($ana);

        $this->get("/restablecer/{$token}?email=ana@x.test")->assertOk()->assertSee('Contraseña nueva');
        $this->post('/restablecer', ['token' => $token, 'email' => 'ana@x.test', 'password' => 'nueva12345', 'password_confirmation' => 'nueva12345'])
            ->assertRedirect(route('login'));

        $this->assertTrue(Hash::check('nueva12345', $ana->fresh()->password));
        // el token sirve una sola vez
        $this->post('/restablecer', ['token' => $token, 'email' => 'ana@x.test', 'password' => 'otra123456', 'password_confirmation' => 'otra123456'])
            ->assertSessionHasErrors('email');
    }

    public function test_un_token_falso_no_sirve(): void
    {
        User::factory()->create(['email' => 'ana@x.test']);
        $this->post('/restablecer', ['token' => 'falso', 'email' => 'ana@x.test', 'password' => 'nueva12345', 'password_confirmation' => 'nueva12345'])
            ->assertSessionHasErrors('email');
    }

    public function test_la_contrasena_nueva_respeta_las_reglas(): void
    {
        $ana = User::factory()->create(['email' => 'ana@x.test']);
        $token = Password::createToken($ana);
        $this->post('/restablecer', ['token' => $token, 'email' => 'ana@x.test', 'password' => 'corta', 'password_confirmation' => 'corta'])->assertSessionHasErrors('password');
    }

    public function test_pedir_enlaces_tiene_limite(): void
    {
        Notification::fake();
        foreach (range(1, 3) as $i) {
            $this->post('/olvide', ['email' => "x{$i}@x.test"])->assertRedirect();
        }
        $this->post('/olvide', ['email' => 'x4@x.test'])->assertStatus(429);
    }

    public function test_el_login_ofrece_recuperar_la_contrasena(): void
    {
        $this->get('/ingresar')->assertOk()->assertSee('¿Olvidaste tu contraseña?');
    }

    // ---------------------------------------------------------------------------------------- login y cabeceras

    public function test_el_limite_de_login_por_cuenta_vale_desde_cualquier_ip(): void
    {
        User::factory()->create(['email' => 'ana@x.test']);
        foreach (range(1, 30) as $i) {
            // cada intento desde una IP distinta: el límite por correo+IP nunca se alcanza
            $this->withServerVariables(['REMOTE_ADDR' => "10.0.{$i}.1"])->post('/ingresar', ['email' => 'ana@x.test', 'password' => 'mala'.$i]);
        }
        $r = $this->withServerVariables(['REMOTE_ADDR' => '10.9.9.9'])->post('/ingresar', ['email' => 'ana@x.test', 'password' => 'password']);
        $r->assertSessionHasErrors('email');
        $this->assertGuest();
    }

    public function test_las_paginas_llevan_csp_con_nonce_y_el_script_del_mapa_lo_usa(): void
    {
        $r = $this->get('/mapa')->assertOk();
        $csp = (string) $r->headers->get('Content-Security-Policy');
        $this->assertStringContainsString("object-src 'none'", $csp);
        $this->assertStringContainsString("frame-ancestors 'none'", $csp);
        $this->assertMatchesRegularExpression("/script-src 'self' 'nonce-([A-Za-z0-9+\\/=]+)'/", $csp);
        preg_match("/'nonce-([^']+)'/", $csp, $m);
        $this->assertStringContainsString('<script nonce="'.$m[1].'">window.__MAP_CONFIG__', $r->getContent());
        $this->assertStringNotContainsString('unsafe-inline', $csp);
        $this->assertStringNotContainsString('unsafe-eval', $csp);
    }

    public function test_cada_pagina_tiene_un_nonce_distinto(): void
    {
        $a = $this->get('/mapa')->headers->get('Content-Security-Policy');
        $b = $this->get('/mapa')->headers->get('Content-Security-Policy');
        $this->assertNotSame($a, $b);
    }

    public function test_las_apis_json_no_llevan_csp(): void
    {
        $this->assertNull($this->getJson('/api/ranking')->headers->get('Content-Security-Policy'));
    }

    public function test_el_registro_no_tiene_estilos_en_linea(): void
    {
        $this->get('/registro')->assertOk()->assertDontSee('style="', false);
    }

    public function test_las_paginas_de_error_permiten_sus_estilos_pero_no_scripts(): void
    {
        $csp = (string) $this->actingAs(User::factory()->create())->get('/moderacion')->assertForbidden()->headers->get('Content-Security-Policy');
        $this->assertStringContainsString("style-src 'self' 'unsafe-inline'", $csp);
        $this->assertMatchesRegularExpression("/script-src 'self' 'nonce-[^']+'(;|$)/", $csp);
    }

    public function test_el_mapa_recibe_la_hora_del_servidor_y_la_duracion_del_dia(): void
    {
        config(['formosa.clock.minutes_per_day' => 24]);
        $this->get('/explorar')->assertOk()->assertSee('id="clock"', false)->assertViewHas('config', function (array $c) {
            return $c['clock']['minutesPerDay'] === 24 && $c['clock']['serverNow'] === now()->getTimestampMs();
        });
    }
}
