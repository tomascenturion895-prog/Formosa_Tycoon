<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\OwnersVersion;
use App\Economy\PropertyCorrectionService;
use App\Enums\PropertyKind;
use App\Formosa\Geo;
use App\Models\Auction;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Re-importar desde OpenStreetMap respeta lo corregido a mano y se entera de los comercios que cerraron. */
class ImportCorrectionsTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private const LNG = -58.18;

    private const LAT = -26.18;

    private string $file;

    protected function setUp(): void
    {
        parent::setUp();
        config(['formosa.match.minutes_per_day' => 2, 'formosa.auction.dispute_seconds' => 0]);
        Carbon::setTestNow('2026-10-18 10:00:00');
        $this->file = tempnam(sys_get_temp_dir(), 'ovp');
    }

    protected function tearDown(): void
    {
        @unlink($this->file);
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function way(int $id, array $tags, float $w = 10, float $h = 16): array
    {
        $dx = $id * 30;
        $p = fn ($x, $y) => Geo::offset(self::LNG, self::LAT, $x, $y);
        $pts = [$p($dx, 0), $p($dx + $w, 0), $p($dx + $w, $h), $p($dx, $h), $p($dx, 0)];

        return ['type' => 'way', 'id' => $id, 'tags' => $tags, 'geometry' => array_map(fn ($q) => ['lat' => $q[1], 'lon' => $q[0]], $pts)];
    }

    private function shop(int $id, string $name = 'Ferretería Sol', string $shop = 'hardware', float $w = 10): array
    {
        return $this->way($id, ['building' => 'yes', 'shop' => $shop, 'name' => $name], $w);
    }

    private function house(int $id): array
    {
        return $this->way($id, ['building' => 'house']);
    }

    /** @param list<array<string, mixed>> $elements */
    private function import(array $elements, array $options = [])
    {
        file_put_contents($this->file, json_encode(['elements' => $elements]));

        return $this->artisan('formosa:importar', ['--archivo' => $this->file] + $options);
    }

    private function prop(int $osmId): Property
    {
        return Property::query()->where('osm_id', $osmId)->firstOrFail();
    }

    public function test_reimportar_no_pisa_rubro_nombre_ni_precio_de_lo_corregido_a_mano(): void
    {
        $this->import([$this->shop(1), $this->house(2)])->assertSuccessful();
        $mod = User::factory()->moderator()->create();
        app(PropertyCorrectionService::class)->correct($mod, $this->prop(1)->id, PropertyKind::Hotel, 'Hotel Sol', 'Lo convirtieron');
        $fixed = $this->prop(1);

        // OpenStreetMap sigue diciendo "ferretería", y el edificio se agrandó un poco.
        $this->import([$this->shop(1, 'Ferretería Sol', 'hardware', 14), $this->house(2)])->assertSuccessful();

        $after = $this->prop(1);
        $this->assertSame('hotel', $after->kind->value);
        $this->assertSame('Hotel Sol', $after->name);
        $this->assertSame($fixed->price, $after->price);
        $this->assertSame($fixed->income_per_day, $after->income_per_day);
        $this->assertNotNull($after->edited_at);
        $this->assertGreaterThan($fixed->area_m2, $after->area_m2, 'la forma del edificio sí se actualiza');
    }

    public function test_lo_que_nadie_corrigio_sigue_el_dato_nuevo_de_osm_y_avisa_a_los_mapas(): void
    {
        $this->import([$this->shop(1, 'Ferretería Sol', 'hardware'), $this->house(2)])->assertSuccessful();
        $version = OwnersVersion::catalog();

        $this->import([$this->shop(1, 'Super Sol', 'supermarket'), $this->house(2)])->assertSuccessful();

        $this->assertSame('supermercado', $this->prop(1)->kind->value);
        $this->assertSame('Super Sol', $this->prop(1)->name);
        $this->assertGreaterThan($version, OwnersVersion::catalog());
    }

    public function test_si_cambia_el_ingreso_de_un_dueno_se_le_acredita_antes_lo_acumulado(): void
    {
        $this->import([$this->shop(1, 'Ferretería Sol', 'hardware')])->assertSuccessful();
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana], 50_000_000);
        $p = $this->prop(1);
        $oldIncome = $p->income_per_day;
        app(EconomyService::class)->buy($ana, $match->id, $p->id);
        $before = $this->cash($match, $ana);

        Carbon::setTestNow(now()->addSeconds(240)); // 2 días de juego
        $this->import([$this->shop(1, 'Super Sol', 'supermarket')])->assertSuccessful();

        $this->assertSame($before + $oldIncome * 2, $this->cash($match, $ana));
        $this->assertGreaterThan($oldIncome, $this->prop(1)->income_per_day);
        $this->assertSame($ana->id, $this->ownerOf($match, $p));
        $this->assertLedgerMatchesCash($match);
    }

    public function test_por_defecto_los_comercios_que_ya_no_figuran_solo_se_avisan(): void
    {
        $this->import([$this->shop(1), $this->shop(2, 'Kiosco Luz', 'kiosk'), $this->house(3)])->assertSuccessful();

        $this->import([$this->shop(1), $this->house(3)])->expectsOutputToContain('1 comercios ya no figuran')->assertSuccessful();

        $this->assertSame('comercio', $this->prop(2)->kind->value);
        $this->assertSame('Kiosco Luz', $this->prop(2)->name);
    }

    public function test_con_ausentes_casa_el_comercio_que_ya_no_figura_pasa_a_casa_y_el_dueno_cobra_lo_suyo(): void
    {
        $this->import([$this->shop(1), $this->shop(2, 'Kiosco Luz', 'kiosk'), $this->house(3), $this->house(4)])->assertSuccessful();
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana], 50_000_000);
        $kiosk = $this->prop(2);
        app(EconomyService::class)->buy($ana, $match->id, $kiosk->id);
        $balance = $this->cash($match, $ana);

        Carbon::setTestNow(now()->addSeconds(120)); // 1 día de juego
        $this->import([$this->shop(1), $this->house(3), $this->house(4)], ['--ausentes' => 'casa'])->assertSuccessful();

        $after = $this->prop(2);
        $this->assertSame('casa', $after->kind->value);
        $this->assertNull($after->name);
        $this->assertNull($after->edited_at, 'una decisión de la re-importación no protege a la propiedad');
        $this->assertSame($ana->id, $this->ownerOf($match, $after));
        $this->assertSame($balance + $kiosk->income_per_day, $this->cash($match, $ana));
        $this->assertDatabaseHas('property_edits', ['property_id' => $kiosk->id, 'source' => 'osm', 'actor_id' => null, 'old_kind' => 'comercio', 'new_kind' => 'casa']);
        // lo demás no se toca
        $this->assertSame('comercio', $this->prop(1)->kind->value);
        $this->assertSame('casa', $this->prop(4)->kind->value);
        $this->assertSame(1, DB::table('property_edits')->count());
    }

    public function test_ausentes_casa_respeta_lo_corregido_a_mano_y_lo_que_esta_en_subasta(): void
    {
        $this->import([$this->shop(1), $this->shop(2, 'Kiosco Luz', 'kiosk'), $this->shop(3, 'Fiambrería', 'deli'), $this->house(4), $this->house(5)])->assertSuccessful();
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        // #1 corregido a mano (un moderador confirmó que sigue abierto); #2 en subasta
        app(PropertyCorrectionService::class)->correct($mod, $this->prop(1)->id, PropertyKind::Comercio, 'Ferretería Sol');
        Auction::forceCreate([
            'property_id' => $this->prop(2)->id, 'starter_id' => $ana->id, 'leader_id' => $ana->id, 'status' => 'disputa', 'list_price' => 1000,
            'current_bid' => 1000, 'ends_at' => now()->addMinute(), 'active_property_id' => $this->prop(2)->id,
        ]);

        $this->import([$this->house(4), $this->house(5)], ['--ausentes' => 'casa', '--forzar' => true])->assertSuccessful();

        $this->assertSame('comercio', $this->prop(1)->kind->value, 'confirmado por un moderador');
        $this->assertSame('comercio', $this->prop(2)->kind->value, 'en subasta no se toca');
        $this->assertSame('casa', $this->prop(3)->kind->value, 'este sí: nadie lo protegió');
    }

    public function test_una_descarga_que_trae_muy_poco_no_deja_pasar_todo_a_casa_sin_forzar(): void
    {
        $els = [];
        foreach (range(1, 10) as $i) {
            $els[] = $this->shop($i, "Local {$i}");
        }
        $this->import($els)->assertSuccessful();

        $this->import([$this->shop(1, 'Local 1'), $this->shop(2, 'Local 2')], ['--ausentes' => 'casa'])->assertFailed();
        $this->assertSame(10, Property::query()->where('kind', 'comercio')->count(), 'no se tocó nada');

        $this->import([$this->shop(1, 'Local 1'), $this->shop(2, 'Local 2')], ['--ausentes' => 'casa', '--forzar' => true])->assertSuccessful();
        $this->assertSame(2, Property::query()->where('kind', 'comercio')->count());
    }

    public function test_simular_muestra_lo_que_cambiaria_sin_guardar_nada(): void
    {
        $this->import([$this->shop(1), $this->shop(2, 'Kiosco Luz', 'kiosk')])->assertSuccessful();

        $this->import([$this->shop(1)], ['--simular' => true, '--ausentes' => 'casa', '--forzar' => true])->expectsOutputToContain('Modo simular')->assertSuccessful();

        $this->assertSame('comercio', $this->prop(2)->kind->value);
        $this->assertSame(0, DB::table('property_edits')->count());
    }

    public function test_ausentes_solo_acepta_nada_o_casa(): void
    {
        $this->import([$this->shop(1)], ['--ausentes' => 'borrar'])->assertFailed();
        $this->assertSame(0, Property::count());
    }
}
