<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LobbyTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
    }

    public function test_mapa_es_el_lobby_y_no_tiene_el_mapa(): void
    {
        $this->get('/mapa')
            ->assertOk()
            ->assertViewIs('lobby')
            ->assertDontSee('id="map"', false)
            ->assertSee('id="room-list"', false)
            ->assertSee('id="tab-ranking"', false)
            ->assertSee('id="tab-manual"', false)
            ->assertSee('id="lobby-manual"', false)
            ->assertSee('id="btn-explorar"', false);
    }

    public function test_el_visitante_ve_ingresar_y_crear_cuenta(): void
    {
        $this->get('/mapa')->assertOk()->assertSee('Ingresá')->assertSee('creá una cuenta')->assertDontSee('id="room-form"', false);
    }

    public function test_el_jugador_ve_el_formulario_de_salas_su_nombre_y_no_su_correo(): void
    {
        $user = User::factory()->create(['name' => 'Ana', 'email' => 'ana@example.com']);

        $this->actingAs($user)->get('/mapa')
            ->assertOk()
            ->assertSee('id="room-form"', false)
            ->assertSee('id="code-form"', false)
            ->assertSee('id="tab-historial"', false)
            ->assertSee('Ana')
            ->assertDontSee('ana@example.com')
            ->assertViewHas('config', fn ($c) => $c['user']['id'] === $user->id && ! array_key_exists('static', $c));
    }

    public function test_avisa_si_falta_confirmar_el_correo(): void
    {
        config(['formosa.auth.verify_email' => true]);
        $user = User::factory()->unverified()->create();

        $this->actingAs($user)->get('/mapa')->assertOk()->assertSee('Confirmá tu correo para jugar');
    }

    public function test_el_moderador_ve_el_enlace_de_moderacion(): void
    {
        $this->actingAs(User::factory()->moderator()->create())->get('/mapa')->assertOk()->assertSee('Moderación');
        $this->actingAs(User::factory()->create())->get('/mapa')->assertOk()->assertDontSee('Moderación');
    }

    public function test_tiene_las_cabeceras_de_seguridad(): void
    {
        $res = $this->get('/mapa')->assertOk();

        $this->assertSame('nosniff', $res->headers->get('X-Content-Type-Options'));
        $this->assertSame('DENY', $res->headers->get('X-Frame-Options'));
    }
}
