<?php

namespace Tests\Feature;

use App\Economy\ChatService;
use App\Events\ChatMessageHidden;
use App\Events\ChatMessageSent;
use App\Models\ChatMessage;
use App\Models\ChatMute;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class ChatModerationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        Storage::fake('local');
        Carbon::setTestNow('2026-10-17 10:00:00');
        config(['formosa.chat.auto_hide_min_age_hours' => 0]); // sin filtro de antigüedad, salvo en las pruebas que lo ejercitan
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function msg(User $u, string $body = 'hola'): ChatMessage
    {
        return ChatMessage::forceCreate(['user_id' => $u->id, 'client_key' => bin2hex(random_bytes(8)), 'body' => $body]);
    }

    private function report(User $by, ChatMessage $m, string $reason = 'spam')
    {
        return $this->actingAs($by)->postJson("/api/chat/{$m->id}/reportar", ['motivo' => $reason]);
    }

    private function visible(): array
    {
        return array_column($this->getJson('/api/chat')->json('messages'), 'id');
    }

    // ---------------------------------------------------------------------------------------- reportar

    public function test_reportar_guarda_un_reporte_abierto(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $m = $this->msg($ana);

        $this->report($beto, $m, 'acoso')->assertOk()->assertJsonPath('replayed', false)->assertJsonPath('hidden', false);

        $this->assertDatabaseHas('chat_reports', ['message_id' => $m->id, 'reporter_id' => $beto->id, 'reason' => 'acoso', 'status' => 'abierto']);
    }

    public function test_reportar_exige_sesion_y_un_motivo_valido(): void
    {
        $ana = User::factory()->create();
        $m = $this->msg($ana);
        $this->postJson("/api/chat/{$m->id}/reportar", ['motivo' => 'spam'])->assertUnauthorized();

        $beto = User::factory()->create();
        foreach ([[], ['motivo' => 'inventado'], ['motivo' => ['spam']]] as $body) {
            $this->actingAs($beto)->postJson("/api/chat/{$m->id}/reportar", $body)->assertStatus(422);
        }
        $this->assertSame(0, DB::table('chat_reports')->count());
    }

    public function test_no_se_puede_reportar_el_propio_mensaje_ni_uno_inexistente(): void
    {
        $ana = User::factory()->create();
        $m = $this->msg($ana);

        $this->report($ana, $m)->assertStatus(422)->assertJsonPath('error', 'reporte_propio');
        $this->actingAs($ana)->postJson('/api/chat/99999/reportar', ['motivo' => 'spam'])->assertStatus(404)->assertJsonPath('error', 'mensaje_inexistente');
    }

    public function test_reportar_dos_veces_no_suma(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $m = $this->msg($ana);

        $this->report($beto, $m)->assertOk();
        $this->report($beto, $m, 'acoso')->assertOk()->assertJsonPath('replayed', true);

        $this->assertSame(1, DB::table('chat_reports')->count());
    }

    public function test_tres_reportes_de_personas_distintas_ocultan_el_mensaje(): void
    {
        Event::fake([ChatMessageHidden::class]);
        $ana = User::factory()->create();
        $m = $this->msg($ana, 'ofensa');
        $other = $this->msg($ana, 'inocente');
        [$b, $c, $d] = [User::factory()->create(), User::factory()->create(), User::factory()->create()];

        $this->report($b, $m)->assertJsonPath('hidden', false);
        $this->report($b, $m); // el mismo no cuenta de nuevo
        $this->report($c, $m)->assertJsonPath('hidden', false);
        $this->assertContains($m->id, $this->visible());
        $this->report($d, $m)->assertJsonPath('hidden', true);

        $this->assertSame([$other->id], $this->visible());
        $this->assertSame('reportes', DB::table('chat_messages')->where('id', $m->id)->value('hidden_reason'));
        $this->assertNull(DB::table('chat_messages')->where('id', $m->id)->value('hidden_by'));
        Event::assertDispatchedTimes(ChatMessageHidden::class, 1);
        Event::assertDispatched(ChatMessageHidden::class, fn ($e) => $e->id === $m->id);
        $this->assertSame(3, DB::table('chat_reports')->where('message_id', $m->id)->where('status', 'abierto')->count()); // quedan para revisar
    }

    public function test_un_mensaje_oculto_no_se_puede_seguir_reportando(): void
    {
        $ana = User::factory()->create();
        $m = $this->msg($ana);
        DB::table('chat_messages')->where('id', $m->id)->update(['hidden_at' => now(), 'hidden_reason' => 'reportes']);

        $this->report(User::factory()->create(), $m)->assertStatus(404);
    }

    public function test_reportar_tiene_limite_por_minuto(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $status = [];
        for ($i = 0; $i < 7; $i++) {
            $status[] = $this->report($beto, $this->msg($ana, "m{$i}"))->status();
        }

        $this->assertContains(429, $status);
        $this->assertCount(5, array_filter($status, fn ($s) => $s === 200));
    }

    public function test_el_umbral_se_puede_apagar(): void
    {
        config(['formosa.chat.auto_hide_reports' => 0]);
        $ana = User::factory()->create();
        $m = $this->msg($ana);
        foreach (range(1, 4) as $_) {
            $this->report(User::factory()->create(), $m)->assertJsonPath('hidden', false);
        }
        $this->assertContains($m->id, $this->visible());
    }

    // ---------------------------------------------------------------------------------------- ocultar / restaurar

    public function test_solo_un_moderador_puede_moderar(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $m = $this->msg($ana);

        $this->actingAs($beto)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertForbidden();
        $this->actingAs($beto)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertForbidden();
        $this->actingAs($beto)->postJson("/moderacion/usuarios/{$ana->id}/quitar-silencio")->assertForbidden();
        $this->actingAs($beto)->postJson("/moderacion/mensajes/{$m->id}/restaurar")->assertForbidden();
        $this->actingAs($beto)->postJson("/moderacion/mensajes/{$m->id}/descartar")->assertForbidden();
        auth()->logout();
        $this->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertUnauthorized();
        $this->assertContains($m->id, $this->visible());
    }

    public function test_el_moderador_oculta_y_los_reportes_quedan_resueltos(): void
    {
        Event::fake([ChatMessageHidden::class]);
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $m = $this->msg($ana);
        $this->report(User::factory()->create(), $m);

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();

        $this->assertNotContains($m->id, $this->visible());
        $row = DB::table('chat_messages')->where('id', $m->id)->first();
        $this->assertSame($mod->id, (int) $row->hidden_by);
        $this->assertSame('moderador', $row->hidden_reason);
        $this->assertSame('resuelto', DB::table('chat_reports')->value('status'));
        $this->assertSame($mod->id, (int) DB::table('chat_reports')->value('resolved_by'));
        Event::assertDispatched(ChatMessageHidden::class, fn ($e) => $e->id === $m->id);
    }

    public function test_ocultar_dos_veces_avisa_una_sola_vez(): void
    {
        Event::fake([ChatMessageHidden::class]);
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();

        Event::assertDispatchedTimes(ChatMessageHidden::class, 1);
    }

    public function test_moderar_un_mensaje_inexistente_da_404(): void
    {
        $mod = User::factory()->moderator()->create();

        $this->actingAs($mod)->postJson('/moderacion/mensajes/9999/ocultar')->assertStatus(404)->assertJsonPath('error', 'mensaje_inexistente');
    }

    public function test_restaurar_lo_muestra_de_nuevo_descarta_reportes_y_avisa(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $m = $this->msg($ana, 'a revisar');
        foreach (range(1, 3) as $_) {
            $this->report(User::factory()->create(), $m);
        }
        $this->assertNotContains($m->id, $this->visible());

        Event::fake([ChatMessageSent::class]);
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/restaurar")->assertOk();

        $this->assertContains($m->id, $this->visible());
        $this->assertSame(['descartado'], DB::table('chat_reports')->pluck('status')->unique()->all());
        Event::assertDispatched(ChatMessageSent::class, fn ($e) => $e->message['id'] === $m->id && $e->message['body'] === 'a revisar');
        // Ya sin reportes abiertos: hacen falta 3 nuevos para volver a ocultarlo.
        $this->report(User::factory()->create(), $m)->assertJsonPath('hidden', false);
    }

    public function test_descartar_cierra_los_reportes_sin_ocultar(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        $this->report(User::factory()->create(), $m);

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/descartar")->assertOk();

        $this->assertContains($m->id, $this->visible());
        $this->assertSame('descartado', DB::table('chat_reports')->value('status'));
    }

    public function test_los_ocultos_tampoco_salen_al_ponerse_al_dia(): void
    {
        $ana = User::factory()->create();
        $a = $this->msg($ana, 'a');
        $b = $this->msg($ana, 'b');
        DB::table('chat_messages')->where('id', $b->id)->update(['hidden_at' => now(), 'hidden_reason' => 'reportes']);

        $this->assertSame([], array_column($this->getJson("/api/chat?despues={$a->id}")->json('messages'), 'id'));
    }

    // ---------------------------------------------------------------------------------------- silenciar

    public function test_un_silenciado_no_puede_escribir_y_se_le_dice_hasta_cuando(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 60, 'motivo' => 'spam'])->assertOk();

        $res = $this->actingAs($ana)->postJson('/api/chat', ['mensaje' => 'hola', 'clave' => 'clave-12345'])
            ->assertStatus(403)->assertJsonPath('error', 'silenciado');

        $this->assertSame(Carbon::parse('2026-10-17 11:00:00')->getTimestampMs(), $res->json('hasta'));
        $this->assertSame(0, ChatMessage::count());
    }

    public function test_el_silencio_vence_solo(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertOk();

        Carbon::setTestNow('2026-10-17 10:10:01');

        $this->actingAs($ana)->postJson('/api/chat', ['mensaje' => 'ya puedo', 'clave' => 'clave-12345'])->assertCreated();
    }

    public function test_levantar_el_silencio_deja_escribir_y_queda_en_el_historial(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 1440])->assertOk();

        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/quitar-silencio")->assertOk();

        $this->actingAs($ana)->postJson('/api/chat', ['mensaje' => 'hola otra vez', 'clave' => 'clave-12345'])->assertCreated();
        $mute = ChatMute::firstOrFail();
        $this->assertNotNull($mute->lifted_at);
        $this->assertSame($mod->id, (int) DB::table('chat_mutes')->value('lifted_by'));
    }

    public function test_solo_hay_duraciones_permitidas(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();

        foreach ([5, 0, -10, 999999, 61] as $mins) {
            $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => $mins])->assertStatus(422);
        }
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", [])->assertStatus(422);
        $this->assertSame(0, ChatMute::count());
    }

    public function test_no_se_silencia_a_un_moderador_ni_a_uno_mismo_ni_a_quien_no_existe(): void
    {
        $mod = User::factory()->moderator()->create();
        $otro = User::factory()->moderator()->create();

        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$mod->id}/silenciar", ['minutos' => 10])->assertStatus(422)->assertJsonPath('error', 'usuario_invalido');
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$otro->id}/silenciar", ['minutos' => 10])->assertStatus(422)->assertJsonPath('error', 'usuario_invalido');
        $this->actingAs($mod)->postJson('/moderacion/usuarios/99999/silenciar', ['minutos' => 10])->assertStatus(404)->assertJsonPath('error', 'usuario_inexistente');
    }

    public function test_un_silenciado_puede_seguir_leyendo_y_reportando(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $m = $this->msg($beto);
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertOk();

        $this->getJson('/api/chat')->assertOk();
        $this->report($ana, $m)->assertOk();
    }

    public function test_los_silencios_no_se_borran_desde_el_modelo(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10]);

        $this->expectException(\LogicException::class);
        ChatMute::firstOrFail()->delete();
    }

    // ---------------------------------------------------------------------------------------- página

    public function test_la_pagina_es_solo_para_moderadores(): void
    {
        $this->get('/moderacion')->assertRedirect('/ingresar');
        $this->actingAs(User::factory()->create())->get('/moderacion')->assertForbidden();
        $this->actingAs(User::factory()->moderator()->create())->get('/moderacion')->assertOk()->assertSee('No hay mensajes reportados ni ocultos.');
    }

    public function test_la_pagina_lista_lo_reportado_con_el_texto_escapado(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create(['name' => 'Ana']);
        $m = $this->msg($ana, '<script>alert(1)</script>');
        $this->report(User::factory()->create(), $m, 'ofensivo');
        $this->report(User::factory()->create(), $m, 'spam');

        $res = $this->actingAs($mod)->get('/moderacion')->assertOk();

        $res->assertSee('<b>2</b> reportes', false)->assertSee('Ana')->assertSee('Contenido ofensivo 1', false);
        $res->assertDontSee('<script>alert(1)</script>', false);
        $res->assertSee('&lt;script&gt;alert(1)&lt;/script&gt;', false);
    }

    public function test_los_formularios_de_la_pagina_redirigen_con_aviso(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $m = $this->msg($ana);

        $this->actingAs($mod)->post("/moderacion/mensajes/{$m->id}/ocultar")->assertRedirect('/moderacion')->assertSessionHas('ok', 'Mensaje oculto.');
        $this->actingAs($mod)->post("/moderacion/usuarios/{$mod->id}/silenciar", ['minutos' => 10])->assertRedirect('/moderacion')->assertSessionHas('error');
        $this->actingAs($mod)->post("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertRedirect('/moderacion')->assertSessionHas('ok');
    }

    public function test_la_pagina_muestra_los_silencios_vigentes(): void
    {
        $mod = User::factory()->moderator()->create(['name' => 'Moderadora']);
        $ana = User::factory()->create(['name' => 'Ana']);
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 60, 'motivo' => 'insultos'])->assertOk();

        $this->actingAs($mod)->get('/moderacion')->assertOk()->assertSee('Ana')->assertSee('insultos')->assertSee('2026-10-17 11:00:00');
    }

    // ---------------------------------------------------------------------------------------- roles

    public function test_el_rol_no_se_puede_pedir_al_registrarse(): void
    {
        $this->post('/registro', [
            'name' => 'Intruso', 'email' => 'intruso@example.com', 'password' => 'clave12345', 'password_confirmation' => 'clave12345',
            'role' => 'moderador', 'is_moderator' => true,
        ]);

        $this->assertSame('jugador', User::where('email', 'intruso@example.com')->value('role'));
    }

    public function test_el_comando_asigna_y_quita_el_rol(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);

        $this->artisan('moderador:asignar', ['apodo' => 'Ana'])->expectsOutput('Ana ahora es moderador.')->assertSuccessful();
        $this->assertTrue($ana->fresh()->isModerator());
        $this->artisan('moderador:asignar', ['apodo' => 'Ana', '--quitar' => true])->expectsOutput('Ana ahora es jugador.')->assertSuccessful();
        $this->assertFalse($ana->fresh()->isModerator());
        $this->artisan('moderador:asignar', ['apodo' => 'Nadie'])->assertFailed();
    }

    public function test_el_mapa_le_dice_al_navegador_si_sos_moderador(): void
    {
        $this->actingAs(User::factory()->moderator()->create())->get('/mapa')->assertViewHas('config', fn ($c) => $c['user']['moderator'] === true
            && $c['chat']['reasons']['spam'] === 'Spam' && $c['chat']['mute_minutes'] === [10, 60, 1440, 10080]);
        $this->actingAs(User::factory()->create())->get('/mapa')->assertViewHas('config', fn ($c) => $c['user']['moderator'] === false);
    }

    public function test_el_rol_del_moderador_se_lee_de_la_base_en_cada_pedido(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/descartar")->assertOk();

        DB::table('users')->where('id', $mod->id)->update(['role' => 'jugador']); // se lo sacan con la sesión abierta

        $this->actingAs(User::find($mod->id))->postJson("/moderacion/mensajes/{$m->id}/descartar")->assertForbidden();
    }

    // ---------------------------------------------------------------------------------------- datos

    public function test_al_vencer_un_mensaje_se_van_sus_reportes(): void
    {
        $ana = User::factory()->create();
        $m = $this->msg($ana);
        $this->report(User::factory()->create(), $m);
        DB::table('chat_messages')->where('id', $m->id)->update(['created_at' => now()->subDays(30)]);

        app(ChatService::class)->prune(7);

        $this->assertSame(0, DB::table('chat_reports')->count());
    }

    public function test_la_base_impide_un_oculto_por_moderador_sin_moderador(): void
    {
        if (! in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            $this->markTestSkipped('SQLite no admite agregar restricciones CHECK a una tabla existente.');
        }
        $m = $this->msg(User::factory()->create());

        $this->expectException(QueryException::class);
        DB::table('chat_messages')->where('id', $m->id)->update(['hidden_at' => now(), 'hidden_reason' => 'moderador']); // falta hidden_by
    }

    public function test_la_base_impide_un_oculto_sin_motivo(): void
    {
        if (! in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            $this->markTestSkipped('SQLite no admite agregar restricciones CHECK a una tabla existente.');
        }
        $m = $this->msg(User::factory()->create());

        $this->expectException(QueryException::class);
        DB::table('chat_messages')->where('id', $m->id)->update(['hidden_at' => now()]);
    }

    // ---------------------------------------------------------------------------------------- reglas contra la censura

    public function test_solo_cuentan_para_ocultar_solo_los_reportes_de_cuentas_con_antiguedad(): void
    {
        config(['formosa.chat.auto_hide_min_age_hours' => 12]);
        $m = $this->msg(User::factory()->create());

        foreach (range(1, 5) as $_) {
            $this->report(User::factory()->create(), $m)->assertJsonPath('hidden', false); // cuentas recién creadas
        }
        $this->assertContains($m->id, $this->visible());
        $this->assertSame(5, DB::table('chat_reports')->count()); // igual quedan registrados para el moderador

        foreach (range(1, 2) as $_) {
            $this->report(User::factory()->create(['created_at' => now()->subHours(13)]), $m)->assertJsonPath('hidden', false);
        }
        $this->report(User::factory()->create(['created_at' => now()->subHours(13)]), $m)->assertJsonPath('hidden', true);
    }

    public function test_nunca_se_oculta_solo_un_mensaje_de_un_moderador(): void
    {
        $m = $this->msg(User::factory()->moderator()->create());

        foreach (range(1, 4) as $_) {
            $this->report(User::factory()->create(), $m)->assertJsonPath('hidden', false);
        }
        $this->assertContains($m->id, $this->visible());
    }

    public function test_un_mensaje_revisado_por_un_moderador_no_se_vuelve_a_ocultar_solo(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        foreach (range(1, 3) as $_) {
            $this->report(User::factory()->create(), $m);
        }
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/restaurar")->assertOk();

        foreach (range(1, 6) as $_) {
            $this->report(User::factory()->create(), $m)->assertJsonPath('hidden', false);
        }
        $this->assertContains($m->id, $this->visible());
    }

    public function test_descartar_los_reportes_de_un_mensaje_oculto_solo_por_reportes_lo_devuelve(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        foreach (range(1, 3) as $_) {
            $this->report(User::factory()->create(), $m);
        }
        $this->assertNotContains($m->id, $this->visible());

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/descartar")->assertOk();

        $this->assertContains($m->id, $this->visible());
    }

    public function test_ocultar_un_mensaje_oculto_por_reportes_lo_confirma_un_moderador(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        foreach (range(1, 3) as $_) {
            $this->report(User::factory()->create(), $m);
        }

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();

        $row = DB::table('chat_messages')->where('id', $m->id)->first();
        $this->assertSame('moderador', $row->hidden_reason);
        $this->assertSame($mod->id, (int) $row->hidden_by);
        $this->assertSame('resuelto', DB::table('chat_reports')->pluck('status')->unique()->first());
        $this->assertNotContains($m->id, $this->visible());
    }

    public function test_la_cola_incluye_lo_oculto_aunque_ya_no_tenga_reportes_abiertos(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create(['name' => 'Ana']), 'oculto por error');
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();

        $res = $this->actingAs($mod)->get('/moderacion')->assertOk()->assertSee('oculto por error')->assertSee('Restaurar');
        $this->actingAs($mod)->post("/moderacion/mensajes/{$m->id}/restaurar")->assertRedirect('/moderacion');
        $this->assertContains($m->id, $this->visible());
    }

    public function test_la_cola_avisa_cuantos_reportes_son_de_cuentas_nuevas(): void
    {
        config(['formosa.chat.auto_hide_min_age_hours' => 12]);
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());
        $this->report(User::factory()->create(), $m);
        $this->report(User::factory()->create(), $m);
        $this->report(User::factory()->create(['created_at' => now()->subDays(3)]), $m);

        $this->actingAs($mod)->get('/moderacion')->assertOk()->assertSee('2 de cuentas nuevas');
    }

    public function test_un_moderador_nunca_queda_silenciado(): void
    {
        $mod = User::factory()->moderator()->create();
        ChatMute::forceCreate(['user_id' => $mod->id, 'muted_by' => $mod->id, 'expires_at' => now()->addHour()->toDateTimeString()]); // silencio previo al ascenso

        $this->actingAs($mod)->postJson('/api/chat', ['mensaje' => 'sigo acá', 'clave' => 'clave-12345'])->assertCreated();
    }

    // ---------------------------------------------------------------------------------------- registro de acciones

    public function test_cada_decision_queda_en_el_registro_con_copia_del_texto(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();
        $m = $this->msg($ana, 'texto original');

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/restaurar")->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 60, 'motivo' => 'insultos'])->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/quitar-silencio")->assertOk();

        $log = DB::table('moderation_log')->orderBy('id')->get();
        $this->assertSame(['ocultar', 'restaurar', 'silenciar', 'levantar_silencio'], $log->pluck('action')->all());
        $this->assertSame([$mod->id], $log->pluck('actor_id')->unique()->map(fn ($v) => (int) $v)->all());
        $this->assertSame('texto original', $log[0]->detail);
        $this->assertSame('60 min: insultos', $log[2]->detail);
        $this->assertSame($ana->id, (int) $log[2]->target_user_id);
    }

    public function test_repetir_una_accion_no_llena_el_registro(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create());

        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();

        $this->assertSame(1, DB::table('moderation_log')->where('action', 'ocultar')->count());
    }

    public function test_el_ocultado_automatico_queda_registrado_sin_actor(): void
    {
        $m = $this->msg(User::factory()->create(), 'spam spam');
        foreach (range(1, 3) as $_) {
            $this->report(User::factory()->create(), $m);
        }

        $row = DB::table('moderation_log')->first();
        $this->assertSame('auto_ocultar', $row->action);
        $this->assertNull($row->actor_id);
        $this->assertSame('spam spam', $row->detail);
    }

    public function test_el_registro_sobrevive_a_la_limpieza_del_chat(): void
    {
        $mod = User::factory()->moderator()->create();
        $m = $this->msg(User::factory()->create(), 'prueba');
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$m->id}/ocultar")->assertOk();
        DB::table('chat_messages')->where('id', $m->id)->update(['created_at' => now()->subDays(30)]);

        app(ChatService::class)->prune(7);

        $this->assertSame(0, ChatMessage::count());
        $this->assertSame('prueba', DB::table('moderation_log')->value('detail'));
    }

    public function test_asignar_el_rol_queda_registrado(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);

        $this->artisan('moderador:asignar', ['apodo' => 'Ana'])->assertSuccessful();

        $row = DB::table('moderation_log')->first();
        $this->assertSame('rol', $row->action);
        $this->assertSame('moderador', $row->detail);
        $this->assertSame($ana->id, (int) $row->target_user_id);
    }

    public function test_reportar_tambien_tiene_limite_por_ip(): void
    {
        $status = [];
        for ($u = 0; $u < 26; $u++) {
            $user = User::factory()->create();
            for ($i = 0; $i < 5; $i++) { // 130 reportes de la misma IP desde 26 cuentas (cada una bajo su límite)
                $status[] = $this->report($user, $this->msg(User::factory()->create(), "m{$u}-{$i}"))->status();
            }
        }

        $this->assertContains(429, $status);
        $this->assertLessThanOrEqual(120, count(array_filter($status, fn ($s) => $s === 200)));
    }

    public function test_un_motivo_nuevo_en_la_configuracion_se_acepta_sin_cambiar_la_base(): void
    {
        config(['formosa.chat.report_reasons' => ['spam' => 'Spam', 'estafa' => 'Estafa']]);
        $m = $this->msg(User::factory()->create());

        $this->report(User::factory()->create(), $m, 'estafa')->assertOk();
        $this->assertSame('estafa', DB::table('chat_reports')->value('reason'));
    }

    public function test_la_pagina_muestra_los_errores_de_validacion(): void
    {
        $mod = User::factory()->moderator()->create();
        $ana = User::factory()->create();

        $this->actingAs($mod)->from('/moderacion')->followingRedirects()->post("/moderacion/usuarios/{$ana->id}/silenciar", [])->assertOk()->assertSee('role="alert"', false);
    }
}
