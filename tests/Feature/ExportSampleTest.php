<?php

namespace Tests\Feature;

use App\Models\Property;
use Database\Seeders\DemoSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** `formosa:exportar-muestra`: un JSON con propiedades, calles y entorno para probar el 3D, sin datos de jugadores. */
class ExportSampleTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private string $out;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $this->out = sys_get_temp_dir().'/muestra-'.bin2hex(random_bytes(4)).'/muestra.json';
    }

    protected function tearDown(): void
    {
        @unlink($this->out);
        @rmdir(dirname($this->out));
        parent::tearDown();
    }

    public function test_exporta_propiedades_calles_y_entorno_sin_duenos(): void
    {
        $this->seed(DemoSeeder::class);
        // Una partida en juego con una propiedad comprada: el export no tiene que llevar ni dueños ni nada de los jugadores.
        $ana = \App\Models\User::factory()->create(['name' => 'Anita']);
        $match = $this->startedMatch([$ana], 50000);
        app(\App\Economy\EconomyService::class)->buy($ana, $match->id, Property::where('price', '<=', 40000)->firstOrFail()->id);
        $this->assertSame(1, \Illuminate\Support\Facades\DB::table('match_properties')->count(), 'el ejemplo tiene una propiedad con dueño');

        $this->artisan('formosa:exportar-muestra', ['--salida' => $this->out])
            ->expectsOutputToContain('Muestra guardada en')
            ->assertSuccessful();

        $raw = (string) file_get_contents($this->out);
        $json = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame(['generated_at', 'district', 'properties', 'roads', 'environment'], array_keys($json));
        $this->assertNull($json['district']);
        $this->assertCount(Property::count(), $json['properties']);
        $this->assertSame(['id', 'kind', 'name', 'area_m2', 'lat', 'lng', 'geometry'], array_keys($json['properties'][0]));
        $this->assertSame('Polygon', $json['properties'][0]['geometry']['type']);
        $this->assertSame('FeatureCollection', $json['roads']['type']);
        $this->assertNotEmpty($json['roads']['features']);
        $this->assertSame('FeatureCollection', $json['environment']['type']);
        $this->assertNotEmpty($json['environment']['features']);

        foreach (['owner', 'owner_id', 'owned_at', 'last_collected_at', 'email', 'Anita', 'match_properties', 'price', 'income_per_day', '@demo.formosa.test'] as $bad) {
            $this->assertStringNotContainsString($bad, $raw, "la muestra no lleva {$bad}");
        }
    }

    public function test_filtra_por_zona_y_avisa_si_no_hay_nada(): void
    {
        $this->seed(DemoSeeder::class);

        $this->artisan('formosa:exportar-muestra', ['--salida' => $this->out, '--distrito' => 'no-existe'])
            ->expectsOutputToContain("No hay propiedades en la zona 'no-existe'")
            ->assertSuccessful();
        $json = json_decode((string) file_get_contents($this->out), true);
        $this->assertSame('no-existe', $json['district']);
        $this->assertSame([], $json['properties']);

        $this->artisan('formosa:exportar-muestra', ['--salida' => $this->out, '--distrito' => DemoSeeder::DISTRICT])->assertSuccessful();
        $json = json_decode((string) file_get_contents($this->out), true);
        $this->assertCount(Property::where('district', DemoSeeder::DISTRICT)->count(), $json['properties']);
    }
}
