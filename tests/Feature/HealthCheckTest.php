<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class HealthCheckTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        // En pruebas la caché es "array" (que el chequeo marca como problema); acá se usa un almacén en memoria con otro nombre.
        config(['cache.stores.memoria' => ['driver' => 'array'], 'cache.default' => 'memoria']);
    }

    public function test_en_desarrollo_no_falla_aunque_haya_avisos(): void
    {
        $this->artisan('formosa:chequeo')->expectsOutputToContain('Chequeo (entorno de desarrollo')->assertSuccessful();
    }

    public function test_en_produccion_con_las_claves_de_ejemplo_falla(): void
    {
        config(['app.debug' => true, 'broadcasting.default' => 'reverb', 'broadcasting.connections.reverb.secret' => 'formosa-local-secret']);

        $this->artisan('formosa:chequeo', ['--produccion' => true])->assertFailed();
    }

    public function test_detecta_si_el_reloj_y_el_planificador_estan_vivos(): void
    {
        $this->artisan('formosa:chequeo')->expectsOutputToContain('juego:reloj no corre')->assertSuccessful();

        Cache::put('juego.reloj.latido', time());
        Cache::put('juego.planificador.latido', time());
        $this->artisan('formosa:chequeo')->expectsOutputToContain('juego:reloj corriendo')->assertSuccessful();
    }

    public function test_la_cache_de_array_es_un_problema(): void
    {
        config(['cache.default' => 'array']);

        $this->artisan('formosa:chequeo')->expectsOutputToContain('CACHE_STORE=array')->assertFailed();
    }
}
