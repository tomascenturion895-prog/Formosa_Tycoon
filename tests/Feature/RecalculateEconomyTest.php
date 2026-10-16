<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

class RecalculateEconomyTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private function property(int $id, string $kind, float $area, int $price, int $income): void
    {
        DB::table('properties')->insert([
            'osm_type' => 'way', 'osm_id' => $id, 'district' => 'test', 'kind' => $kind, 'footprint' => 'osm',
            'area_m2' => $area, 'lat' => -26.18, 'lng' => -58.17, 'geometry' => json_encode(['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]),
            'price' => $price, 'income_per_day' => $income, 'created_at' => now(), 'updated_at' => '2026-01-01 00:00:00',
        ]);
    }

    public function test_recalcula_ingreso_sin_tocar_dueno_ni_propiedades_correctas(): void
    {
        $user = User::factory()->create();
        // Casa de 120 m² (la típica): precio 10.000. Con un rendimiento viejo rendía 100 por día; hoy 25 %/día = 2.500.
        $this->property(1, 'casa', 120, 10000, 100);
        $this->property(2, 'casa', 120, 10000, 2500); // ya correcta
        config(['formosa.auction.dispute_seconds' => 0]);
        $match = $this->startedMatch([$user], 50000);
        app(\App\Economy\EconomyService::class)->buy($user, $match->id, (int) DB::table('properties')->where('osm_id', 1)->value('id'));

        $this->artisan('formosa:recalcular-economia')->expectsOutputToContain('Actualizadas 1 de 2')->assertSuccessful();

        $this->assertSame(2500, (int) DB::table('properties')->where('osm_id', 1)->value('income_per_day'));
        $this->assertSame($user->id, $this->ownerOf($match, (int) DB::table('properties')->where('osm_id', 1)->value('id')), 'el dueño no se toca');
        $this->assertNotSame('2026-01-01 00:00:00', (string) DB::table('properties')->where('osm_id', 1)->value('updated_at'), 'los mapas deben recargar');
        $this->assertSame('2026-01-01 00:00:00', (string) DB::table('properties')->where('osm_id', 2)->value('updated_at'), 'lo que ya estaba bien no se toca');
    }

    public function test_simular_no_guarda_nada(): void
    {
        $this->property(1, 'casa', 120, 10000, 100);

        $this->artisan('formosa:recalcular-economia', ['--simular' => true])->expectsOutputToContain('Cambiarían 1 de 1')->assertSuccessful();

        $this->assertSame(100, (int) DB::table('properties')->value('income_per_day'));
    }
}
