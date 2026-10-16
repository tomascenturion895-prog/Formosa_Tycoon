<?php

namespace Tests\Feature;

use App\Formosa\DemoDistrict;
use App\Models\Property;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

class ImportIdempotencyTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private string $file;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $demo = DemoDistrict::elements(config('formosa.center.lat'), config('formosa.center.lng'));
        $this->file = tempnam(sys_get_temp_dir(), 'ovp');
        file_put_contents($this->file, json_encode(['elements' => $demo['buildings']]));
    }

    protected function tearDown(): void
    {
        @unlink($this->file);
        parent::tearDown();
    }

    private function import(): void
    {
        $this->artisan('formosa:importar', ['--archivo' => $this->file])->assertSuccessful();
    }

    public function test_importar_dos_veces_no_duplica_propiedades(): void
    {
        $this->import();
        $first = Property::count();
        $this->assertGreaterThan(0, $first);

        $this->import();
        $this->assertSame($first, Property::count());
    }

    public function test_reimportar_no_pisa_al_dueno_de_una_partida_pero_si_actualiza_el_precio(): void
    {
        $this->import();
        config(['formosa.auction.dispute_seconds' => 0]);
        $user = User::factory()->create();
        $p = Property::query()->orderBy('id')->first();
        $match = $this->startedMatch([$user], 5_000_000);
        app(\App\Economy\EconomyService::class)->buy($user, $match->id, $p->id);
        $bought = DB::table('match_properties')->where('match_id', $match->id)->first();
        DB::table('properties')->where('id', $p->id)->update(['price' => 1]);

        $this->import();

        $fresh = Property::findOrFail($p->id);
        $this->assertEquals($bought, DB::table('match_properties')->where('match_id', $match->id)->first(), 'el dueño y lo que pagó no se tocan');
        $this->assertSame($p->price, $fresh->price, 'el precio vuelve al calculado por el importador');
    }

    public function test_simular_no_guarda_nada(): void
    {
        $this->artisan('formosa:importar', ['--archivo' => $this->file, '--simular' => true])->assertSuccessful();

        $this->assertSame(0, Property::count());
    }

    public function test_una_zona_inexistente_falla_con_mensaje(): void
    {
        $this->artisan('formosa:importar', ['--distrito' => 'no-existe', '--archivo' => $this->file])->assertFailed();
    }

    public function test_un_archivo_inexistente_falla_sin_tocar_la_base(): void
    {
        $this->artisan('formosa:importar', ['--archivo' => '/no/existe.json'])->assertFailed();

        $this->assertSame(0, Property::count());
    }
}
