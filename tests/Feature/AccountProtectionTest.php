<?php

namespace Tests\Feature;

use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Auth\Notifications\VerifyEmail;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\URL;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

class AccountProtectionTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.auth.min_form_seconds' => 3]);
        Carbon::setTestNow('2026-10-15 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function form(array $extra = [], ?int $openedSecondsAgo = 10): array
    {
        $token = $openedSecondsAgo === null ? 'basura' : Crypt::encryptString((string) (time() - $openedSecondsAgo));

        return ['name' => 'Ana', 'email' => 'ana@example.com', 'password' => 'clave12345', 'password_confirmation' => 'clave12345', '_ft' => $token] + $extra;
    }

    // ------------------------------------------------------------------ anti-bots
    public function test_con_el_freno_activo_una_persona_normal_se_registra(): void
    {
        config(['formosa.auth.antibot' => true]);

        $this->post('/registro', $this->form())->assertRedirect(route('mapa'));

        $this->assertDatabaseHas('users', ['email' => 'ana@example.com']);
    }

    public function test_el_formulario_trae_la_marca_y_la_trampa(): void
    {
        config(['formosa.auth.antibot' => true]);

        $this->get('/registro')->assertOk()->assertSee('name="_ft"', false)->assertSee('name="sitio_web"', false);
    }

    public function test_el_campo_trampa_lleno_rechaza(): void
    {
        config(['formosa.auth.antibot' => true]);

        $this->post('/registro', $this->form(['sitio_web' => 'http://spam.example']))->assertSessionHasErrors('formulario');

        $this->assertDatabaseCount('users', 0);
    }

    public function test_enviar_demasiado_rapido_rechaza(): void
    {
        config(['formosa.auth.antibot' => true]);

        $this->post('/registro', $this->form(openedSecondsAgo: 1))->assertSessionHasErrors('formulario');

        $this->assertDatabaseCount('users', 0);
    }

    public function test_sin_marca_o_con_marca_inventada_rechaza(): void
    {
        config(['formosa.auth.antibot' => true]);

        $this->post('/registro', $this->form(openedSecondsAgo: null))->assertSessionHasErrors('formulario');
        $data = $this->form();
        unset($data['_ft']);
        $this->post('/registro', $data)->assertSessionHasErrors('formulario');
        $this->assertDatabaseCount('users', 0);
    }

    public function test_una_marca_demasiado_vieja_rechaza(): void
    {
        config(['formosa.auth.antibot' => true, 'formosa.auth.max_form_seconds' => 7200]);

        $this->post('/registro', $this->form(openedSecondsAgo: 7201))->assertSessionHasErrors('formulario');
    }

    public function test_apagado_no_exige_nada(): void
    {
        config(['formosa.auth.antibot' => false]);
        $data = $this->form();
        unset($data['_ft']);

        $this->post('/registro', $data)->assertRedirect(route('mapa'));
    }

    // ------------------------------------------------------------------ verificación de correo
    private function freeProperty(int $price = 5000): Property
    {
        \DB::table('properties')->insert([
            'osm_type' => 'way', 'osm_id' => 1, 'district' => 'test', 'kind' => 'casa', 'footprint' => 'osm', 'area_m2' => 100, 'lat' => -26.18, 'lng' => -58.17,
            'geometry' => json_encode(['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]),
            'price' => $price, 'income_per_day' => 10, 'created_at' => now(), 'updated_at' => now(),
        ]);

        return Property::firstOrFail();
    }

    public function test_apagada_todas_las_cuentas_cuentan_como_verificadas(): void
    {
        config(['formosa.auth.verify_email' => false]);
        $user = User::factory()->create(['email_verified_at' => null]);
        $p = $this->freeProperty();
        $match = $this->startedMatch([$user], 30000);

        $this->actingAs($user)->postJson("/api/partidas/{$match->id}/propiedades/{$p->id}/comprar")->assertOk();
    }

    public function test_activa_sin_confirmar_no_se_puede_jugar_ni_escribir_ni_reportar(): void
    {
        config(['formosa.auth.verify_email' => true]);
        $user = User::factory()->create(['email_verified_at' => null]);
        $p = $this->freeProperty();

        $this->actingAs($user)->postJson("/api/partidas/1/propiedades/{$p->id}/comprar")->assertStatus(403)->assertJsonPath('error', 'email_sin_verificar');
        $this->actingAs($user)->postJson('/api/partidas', ['nombre' => 'Sala'])->assertStatus(403)->assertJsonPath('error', 'email_sin_verificar');
        $this->actingAs($user)->postJson('/api/partidas/ABC123/unirse')->assertStatus(403)->assertJsonPath('error', 'email_sin_verificar');
        $this->actingAs($user)->postJson('/api/partidas/1/subastas/1/pujar', ['monto' => 9000])->assertStatus(403)->assertJsonPath('error', 'email_sin_verificar');
        $this->actingAs($user)->postJson('/api/chat', ['mensaje' => 'hola', 'clave' => 'abcdefgh1'])->assertStatus(403);
        $this->actingAs($user)->postJson('/api/chat/1/reportar', ['motivo' => 'spam'])->assertStatus(403);
        $this->assertSame(0, \DB::table('match_properties')->count());
        $this->assertSame(0, \DB::table('matches')->count());
        // Lo básico para ver su situación sigue funcionando.
        $this->actingAs($user)->getJson('/api/yo')->assertOk();
        $this->actingAs($user)->get('/mapa')->assertOk()->assertSee('Confirmá tu correo para jugar');
    }

    public function test_activa_confirmada_juega_normal(): void
    {
        config(['formosa.auth.verify_email' => true]);
        $user = User::factory()->create(['email_verified_at' => now()]);
        $p = $this->freeProperty();
        $match = $this->startedMatch([$user], 30000);

        $this->actingAs($user)->postJson("/api/partidas/{$match->id}/propiedades/{$p->id}/comprar")->assertOk();
        $this->actingAs($user)->get('/mapa')->assertOk()->assertDontSee('Confirmá tu correo para jugar');
    }

    public function test_registrarse_manda_el_correo_y_lleva_a_la_pantalla_de_confirmar(): void
    {
        config(['formosa.auth.verify_email' => true, 'formosa.auth.antibot' => false]);
        Notification::fake();

        $this->post('/registro', ['name' => 'Ana', 'email' => 'ana@example.com', 'password' => 'clave12345', 'password_confirmation' => 'clave12345'])
            ->assertRedirect(route('verification.notice'));

        Notification::assertSentTo(User::firstOrFail(), VerifyEmail::class);
    }

    public function test_el_enlace_firmado_confirma_y_uno_falso_no(): void
    {
        config(['formosa.auth.verify_email' => true]);
        $user = User::factory()->create(['email_verified_at' => null]);
        $good = URL::temporarySignedRoute('verification.verify', now()->addHour(), ['id' => $user->id, 'hash' => sha1($user->email)]);

        $this->actingAs($user)->get(route('verification.verify', ['id' => $user->id, 'hash' => sha1($user->email)]))->assertForbidden(); // sin firma
        $this->assertNull($user->fresh()->email_verified_at);

        $this->actingAs($user)->get($good)->assertRedirect(route('mapa'));
        $this->assertNotNull($user->fresh()->email_verified_at);
    }

    public function test_reenviar_manda_otro_correo_y_tiene_limite(): void
    {
        config(['formosa.auth.verify_email' => true]);
        Notification::fake();
        $user = User::factory()->create(['email_verified_at' => null]);

        for ($i = 0; $i < 3; $i++) {
            $this->actingAs($user)->post(route('verification.send'))->assertRedirect();
        }
        $this->actingAs($user)->post(route('verification.send'))->assertStatus(429);

        Notification::assertSentToTimes($user, VerifyEmail::class, 3);
    }

    public function test_un_correo_que_falla_no_impide_registrarse(): void
    {
        config(['formosa.auth.verify_email' => true, 'formosa.auth.antibot' => false, 'mail.default' => 'smtp', 'mail.mailers.smtp.host' => '127.0.0.1', 'mail.mailers.smtp.port' => 1]);

        $this->post('/registro', ['name' => 'Ana', 'email' => 'ana@example.com', 'password' => 'clave12345', 'password_confirmation' => 'clave12345'])
            ->assertRedirect(route('verification.notice'));

        $this->assertDatabaseHas('users', ['email' => 'ana@example.com']);
    }
}
