<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class GameScreenTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
    }

    public function test_partida_responde_con_el_mapa_y_el_codigo_en_mayusculas(): void
    {
        $this->get('/partida/abc123')
            ->assertOk()
            ->assertSee('id="map"', false)
            ->assertViewHas('config', fn ($c) => $c['page'] === 'partida' && $c['code'] === 'ABC123');
    }

    public function test_codigo_invalido_da_404(): void
    {
        $this->get('/partida/ab')->assertNotFound();
        $this->get('/partida/abc-123')->assertNotFound();
        $this->get('/partida/'.str_repeat('A', 13))->assertNotFound();
    }

    public function test_explorar_no_tiene_codigo(): void
    {
        $this->get('/explorar')
            ->assertOk()
            ->assertSee('id="map"', false)
            ->assertViewHas('config', fn ($c) => $c['page'] === 'explorar' && $c['code'] === null);
    }

    public function test_partida_permite_el_microfono(): void
    {
        $res = $this->get('/partida/ABC123')->assertOk();
        $this->assertStringContainsString('microphone=(self)', $res->headers->get('Permissions-Policy'));
    }

    public function test_las_rutas_tienen_nombre(): void
    {
        $this->assertSame(url('/partida/ABC123'), route('partida', ['code' => 'ABC123']));
        $this->assertSame(url('/explorar'), route('explorar'));
    }
}
