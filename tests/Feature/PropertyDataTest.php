<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Events\PropertyCorrected;
use App\Models\Auction;
use App\Models\Property;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Datos del mapa desactualizados: avisos de jugadores y correcciones de moderadores. */
class PropertyDataTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.match.minutes_per_day' => 2, 'formosa.auction.dispute_seconds' => 0]);
        Carbon::setTestNow('2026-10-18 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function property(string $kind = 'comercio', ?string $name = 'Ferretería Sol', float $area = 160): Property
    {
        ['price' => $price, 'income' => $income] = \App\Formosa\Pricing::for(\App\Enums\PropertyKind::from($kind), $area);
        static $n = 0;
        $n++;
        $id = DB::table('properties')->insertGetId([
            'osm_type' => 'way', 'osm_id' => 9000 + $n, 'district' => 'test', 'kind' => $kind, 'footprint' => 'osm', 'name' => $name,
            'area_m2' => $area, 'lat' => -26.18, 'lng' => -58.17, 'geometry' => json_encode(['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]),
            'price' => $price, 'income_per_day' => $income,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return Property::findOrFail($id);
    }

    private function fix(User $by, Property $p, array $data)
    {
        return $this->actingAs($by)->postJson("/moderacion/propiedades/{$p->id}/corregir", $data);
    }

    // ---------------------------------------------------------------------------------------- corregir

    public function test_un_moderador_corrige_el_rubro_y_se_recalculan_precio_e_ingreso(): void
    {
        Event::fake([PropertyCorrected::class]);
        $mod = User::factory()->moderator()->create();
        $p = $this->property('comercio', 'Ferretería Sol');

        $this->fix($mod, $p, ['rubro' => 'supermercado', 'nombre' => 'Super Norte', 'motivo' => 'Cambió de dueño'])
            ->assertOk()->assertJsonPath('changed', true)->assertJsonPath('property.kind', 'supermercado')->assertJsonPath('property.name', 'Super Norte');

        $fresh = $p->fresh();
        $expected = \App\Formosa\Pricing::for(\App\Enums\PropertyKind::Supermercado, 160);
        $this->assertSame($expected['price'], $fresh->price);
        $this->assertSame($expected['income'], $fresh->income_per_day);
        $this->assertNotNull($fresh->edited_at);
        $this->assertDatabaseHas('property_edits', ['property_id' => $p->id, 'actor_id' => $mod->id, 'source' => 'moderador', 'old_kind' => 'comercio', 'new_kind' => 'supermercado', 'old_name' => 'Ferretería Sol', 'new_name' => 'Super Norte', 'reason' => 'Cambió de dueño']);
        Event::assertDispatched(PropertyCorrected::class, fn ($e) => $e->propertyId === $p->id && $e->kind === 'supermercado' && $e->price === $expected['price']);
    }

    public function test_cerrar_un_local_lo_convierte_en_casa_sin_nombre(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property('comercio', 'Librería Luna');

        $this->fix($mod, $p, ['rubro' => 'casa', 'nombre' => 'Librería Luna'])->assertOk();

        $this->assertNull($p->fresh()->name, 'las casas no llevan nombre');
        $this->assertSame('casa', $p->fresh()->kind->value);
    }

    public function test_solo_los_moderadores_corrigen(): void
    {
        $player = User::factory()->create();
        $p = $this->property();

        $this->postJson("/moderacion/propiedades/{$p->id}/corregir", ['rubro' => 'casa'])->assertUnauthorized();
        $this->fix($player, $p, ['rubro' => 'casa'])->assertForbidden();
        $this->actingAs($player)->getJson("/moderacion/propiedades/{$p->id}")->assertForbidden();
        $this->actingAs($player)->get('/moderacion/mapa')->assertForbidden();
        $this->assertSame('comercio', $p->fresh()->kind->value);
        $this->assertNull($p->fresh()->edited_at);
    }

    public function test_el_servicio_tambien_rechaza_a_un_jugador_comun(): void
    {
        $this->expectException(\App\Economy\GameException::class);
        app(\App\Economy\PropertyCorrectionService::class)->correct(User::factory()->create(), $this->property()->id, \App\Enums\PropertyKind::Casa, null);
    }

    public function test_valida_el_rubro_y_el_largo_del_nombre(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property();

        $this->fix($mod, $p, ['rubro' => 'castillo'])->assertStatus(422);
        $this->fix($mod, $p, ['rubro' => 'hotel', 'nombre' => str_repeat('a', 121)])->assertStatus(422);
        $this->fix($mod, $p, [])->assertStatus(422);
    }

    public function test_el_nombre_se_limpia_de_caracteres_de_control_y_se_muestra_como_texto(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property();

        $this->fix($mod, $p, ['rubro' => 'comercio', 'nombre' => "  Kiosco\x00 \u{202E}  Don   Pepe <b>x</b> "])->assertOk();

        $this->assertSame('Kiosco Don Pepe <b>x</b>', $p->fresh()->name);
    }

    public function test_repetir_la_misma_correccion_no_cambia_ni_avisa_de_nuevo(): void
    {
        Event::fake([PropertyCorrected::class]);
        $mod = User::factory()->moderator()->create();
        $p = $this->property();

        $this->fix($mod, $p, ['rubro' => 'hotel', 'nombre' => 'Hotel Sur'])->assertOk()->assertJsonPath('changed', true);
        $this->fix($mod, $p, ['rubro' => 'hotel', 'nombre' => 'Hotel Sur'])->assertOk()->assertJsonPath('changed', false);

        Event::assertDispatchedTimes(PropertyCorrected::class, 1);
        $this->assertSame(1, DB::table('property_edits')->count());
    }

    public function test_confirmar_que_esta_bien_la_protege_sin_cambiar_nada(): void
    {
        Event::fake([PropertyCorrected::class]);
        $mod = User::factory()->moderator()->create();
        $p = $this->property('comercio', 'Ferretería Sol');

        $this->fix($mod, $p, ['rubro' => 'comercio', 'nombre' => 'Ferretería Sol'])->assertOk()->assertJsonPath('changed', false)->assertJsonPath('verified', true);

        $this->assertNotNull($p->fresh()->edited_at, 'queda protegida de la re-importación');
        Event::assertNotDispatched(PropertyCorrected::class);
    }

    public function test_no_se_corrige_una_propiedad_reservada_o_en_subasta(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $p = $this->property();
        Auction::forceCreate([
            'property_id' => $p->id, 'starter_id' => $ana->id, 'leader_id' => $ana->id, 'status' => 'disputa', 'list_price' => $p->price,
            'current_bid' => $p->price, 'ends_at' => now()->addMinute(), 'active_property_id' => $p->id,
        ]);

        $this->fix($mod, $p, ['rubro' => 'casa'])->assertStatus(409)->assertJsonPath('error', 'en_subasta_no_editable');
        $this->assertSame('comercio', $p->fresh()->kind->value);
    }

    public function test_una_propiedad_inexistente_da_404(): void
    {
        $mod = User::factory()->moderator()->create();
        $this->actingAs($mod)->postJson('/moderacion/propiedades/999999/corregir', ['rubro' => 'casa'])->assertNotFound();
    }

    // ---------------------------------------------------------------------------------------- dueños

    /** Partida en juego donde Ana compró la propiedad (con mucho dinero inicial). */
    private function ownedByAna(Property $p): array
    {
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana], 50_000_000);
        app(EconomyService::class)->buy($ana, $match->id, $p->id);

        return [$ana, $match];
    }

    public function test_si_tiene_dueno_se_le_acredita_lo_acumulado_a_la_tarifa_vieja(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property('hotel', 'Hotel Fantasma', 400);
        [$ana, $match] = $this->ownedByAna($p);
        $oldIncome = $p->income_per_day;
        $before = $this->cash($match, $ana);

        Carbon::setTestNow(now()->addSeconds(360)); // pasaron 3 días de juego (días de 120 s) sin que Ana actúe
        $this->fix($mod, $p, ['rubro' => 'casa'])->assertOk()->assertJsonPath('paid', $oldIncome * 3);

        $this->assertSame($before + $oldIncome * 3, $this->cash($match, $ana));
        $fresh = $p->fresh();
        $this->assertLessThan($oldIncome, $fresh->income_per_day);
        $this->assertSame($ana->id, $this->ownerOf($match, $p), 'sigue siendo de Ana');
        $this->assertTrue($this->player($match, $ana)->last_settled_at->equalTo(now()), 'el reloj de liquidación arranca de cero con la tarifa nueva');
        $this->assertSame($oldIncome * 3, (int) DB::table('property_edits')->value('paid_out'));
        // el libro sigue cuadrando: dinero = suma de movimientos
        $this->assertLedgerMatchesCash($match);
    }

    public function test_sin_nada_acumulado_no_se_escribe_un_movimiento_vacio(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property('hotel', 'Hotel', 400);
        $this->ownedByAna($p);
        $entries = DB::table('ledger_entries')->count();

        $this->fix($mod, $p, ['rubro' => 'casa'])->assertOk()->assertJsonPath('paid', 0);

        $this->assertSame($entries, DB::table('ledger_entries')->count());
    }

    // ---------------------------------------------------------------------------------------- avisos de jugadores

    public function test_un_jugador_avisa_y_no_cambia_nada(): void
    {
        $ana = User::factory()->create();
        $p = $this->property();

        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado', 'nota' => 'Hace meses que está cerrado'])
            ->assertOk()->assertJsonPath('replayed', false);

        $this->assertDatabaseHas('property_reports', ['property_id' => $p->id, 'reporter_id' => $ana->id, 'reason' => 'cerrado', 'status' => 'abierto', 'note' => 'Hace meses que está cerrado']);
        $this->assertSame('comercio', $p->fresh()->kind->value);
        $this->assertNull($p->fresh()->edited_at);
    }

    public function test_avisar_dos_veces_no_suma(): void
    {
        $ana = User::factory()->create();
        $p = $this->property();
        $url = "/api/propiedades/{$p->id}/avisar-datos";

        $this->actingAs($ana)->postJson($url, ['motivo' => 'cerrado'])->assertOk();
        $this->actingAs($ana)->postJson($url, ['motivo' => 'otro_rubro'])->assertOk()->assertJsonPath('replayed', true);

        $this->assertSame(1, DB::table('property_reports')->count());
    }

    public function test_avisar_exige_sesion_motivo_valido_y_propiedad_existente(): void
    {
        $ana = User::factory()->create();
        $p = $this->property();

        $this->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado'])->assertUnauthorized();
        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'me-cae-mal'])->assertStatus(422);
        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", [])->assertStatus(422);
        $this->actingAs($ana)->postJson('/api/propiedades/999999/avisar-datos', ['motivo' => 'cerrado'])->assertNotFound();
    }

    public function test_hay_un_tope_de_avisos_abiertos_por_jugador(): void
    {
        config(['formosa.data.max_open_reports_per_user' => 2]);
        $ana = User::factory()->create();
        $ids = [$this->property()->id, $this->property()->id, $this->property()->id];

        $this->actingAs($ana)->postJson("/api/propiedades/{$ids[0]}/avisar-datos", ['motivo' => 'cerrado'])->assertOk();
        $this->actingAs($ana)->postJson("/api/propiedades/{$ids[1]}/avisar-datos", ['motivo' => 'cerrado'])->assertOk();
        $this->actingAs($ana)->postJson("/api/propiedades/{$ids[2]}/avisar-datos", ['motivo' => 'cerrado'])->assertStatus(429)->assertJsonPath('error', 'demasiados_avisos');
        // repetir uno que ya hizo no cuenta como nuevo
        $this->actingAs($ana)->postJson("/api/propiedades/{$ids[0]}/avisar-datos", ['motivo' => 'cerrado'])->assertOk()->assertJsonPath('replayed', true);
    }

    public function test_el_aviso_no_permite_html_ni_texto_enorme(): void
    {
        $ana = User::factory()->create();
        $p = $this->property();

        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado', 'nota' => str_repeat('x', 141)])->assertStatus(422);
        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado', 'nota' => "<script>\x00alert(1)</script>"])->assertOk();
        $this->assertSame('<script> alert(1)</script>', DB::table('property_reports')->value('note')); // se guarda como texto; la pantalla lo muestra con textContent / escapado
    }

    public function test_corregir_resuelve_los_avisos_abiertos_y_descartar_los_cierra(): void
    {
        $mod = User::factory()->moderator()->create();
        [$a, $b] = User::factory()->count(2)->create();
        $p = $this->property();
        $q = $this->property();
        foreach ([$a, $b] as $u) {
            $this->actingAs($u)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado'])->assertOk();
        }
        $this->actingAs($a)->postJson("/api/propiedades/{$q->id}/avisar-datos", ['motivo' => 'otro_nombre'])->assertOk();

        $this->fix($mod, $p, ['rubro' => 'casa'])->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/propiedades/{$q->id}/descartar-avisos")->assertOk();

        $this->assertSame(2, DB::table('property_reports')->where('property_id', $p->id)->where('status', 'resuelto')->count());
        $this->assertSame(1, DB::table('property_reports')->where('property_id', $q->id)->where('status', 'descartado')->count());
        $this->assertSame(0, DB::table('property_reports')->where('status', 'abierto')->count());
    }

    public function test_la_ficha_del_moderador_muestra_avisos_y_ultima_correccion(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $p = $this->property();
        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado', 'nota' => 'Está en alquiler'])->assertOk();

        $this->actingAs($mod)->getJson("/moderacion/propiedades/{$p->id}")->assertOk()
            ->assertJsonPath('reports', 1)->assertJsonPath('reasons.cerrado', 1)->assertJsonPath('notes.0', 'Está en alquiler')->assertJsonPath('edited', null);
    }

    public function test_la_pagina_de_revision_lista_los_avisos_y_escapa_las_notas(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $p = $this->property('comercio', 'Kiosco Sol');
        $this->actingAs($ana)->postJson("/api/propiedades/{$p->id}/avisar-datos", ['motivo' => 'cerrado', 'nota' => '<img src=x onerror=alert(1)>'])->assertOk();

        $html = $this->actingAs($mod)->get('/moderacion/mapa')->assertOk()->getContent();

        $this->assertStringContainsString('Kiosco Sol', $html);
        $this->assertStringContainsString('&lt;img src=x onerror=alert(1)&gt;', $html);
        $this->assertStringNotContainsString('<img src=x', $html);
    }

    public function test_corregir_desde_la_pagina_redirige_con_aviso(): void
    {
        $mod = User::factory()->moderator()->create();
        $p = $this->property();

        $this->actingAs($mod)->post("/moderacion/propiedades/{$p->id}/corregir", ['rubro' => 'casa', 'motivo' => 'Cerrado'])
            ->assertRedirect(route('moderacion.mapa'))->assertSessionHas('ok');
        $this->assertSame('casa', $p->fresh()->kind->value);
    }

    // ---------------------------------------------------------------------------------------- mapa

    public function test_el_estado_lleva_la_version_del_catalogo_y_sube_al_corregir(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana]);
        $url = "/api/partidas/{$match->id}/propiedades/estado";
        $p = $this->property();
        $before = $this->getJson($url)->json('catalog');
        $etag = $this->getJson('/api/propiedades')->headers->get('ETag');

        $this->fix($mod, $p, ['rubro' => 'hotel', 'nombre' => 'Hotel Nuevo'])->assertOk();

        $this->assertSame($before + 1, $this->getJson($url)->json('catalog'));
        $this->assertNotSame($etag, $this->getJson('/api/propiedades')->headers->get('ETag'), 'el mapa de un visitante recarga la geometría y los datos');
        $feature = collect($this->getJson('/api/propiedades')->json('features'))->firstWhere('id', $p->id);
        $this->assertSame('hotel', $feature['properties']['kind']);
        $this->assertSame('Hotel Nuevo', $feature['properties']['name']);
    }

    public function test_vaciar_la_cache_no_repite_un_etag_que_los_navegadores_ya_guardaron(): void
    {
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana]);
        $etag = fn () => $this->getJson("/api/partidas/{$match->id}/propiedades/estado")->headers->get('ETag');
        $seen = [$etag()];
        \App\Economy\OwnersVersion::bump($match->id);
        $seen[] = $etag();
        \Illuminate\Support\Facades\Cache::flush(); // cache:clear, reinicio del servidor de caché…
        $seen[] = $etag();
        \App\Economy\OwnersVersion::bump($match->id);
        $seen[] = $etag();

        $this->assertCount(4, array_unique($seen), 'un ETag repetido haría que un navegador muestre dueños viejos con un 304');
    }
}
