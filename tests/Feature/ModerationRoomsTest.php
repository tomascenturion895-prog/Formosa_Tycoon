<?php

namespace Tests\Feature;

use App\Models\ChatMessage;
use App\Models\GameMatch;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Salas y partidas en el panel de moderación: quién entra, qué se ve (y qué no) y que sea solo lectura. */
class ModerationRoomsTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private int $mods = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
    }

    private function mod(): User
    {
        $u = User::factory()->create(['name' => 'Moderador'.++$this->mods]);
        DB::table('users')->where('id', $u->id)->update(['role' => 'moderador']);

        return $u->fresh();
    }

    private function say(GameMatch $m, User $u, string $body, array $extra = []): int
    {
        return (int) DB::table('chat_messages')->insertGetId(['match_id' => $m->id, 'user_id' => $u->id, 'client_key' => bin2hex(random_bytes(8)), 'body' => $body, 'kind' => 'usuario'] + $extra);
    }

    public function test_solo_moderadores_entran(): void
    {
        $ana = User::factory()->create();
        $this->get('/moderacion/salas')->assertRedirect('/ingresar');
        $this->actingAs($ana)->get('/moderacion/salas')->assertForbidden();
        $this->actingAs($ana)->get('/moderacion/salas/1')->assertForbidden();
        $this->actingAs($this->mod())->get('/moderacion/salas')->assertOk();
    }

    public function test_la_lista_filtra_por_estado_y_cuenta(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $live = $this->startedMatch([$ana, $beto]);
        $lobby = app(\App\Economy\MatchService::class)->create(User::factory()->create(['name' => 'Cami']), 'Sala de Cami');
        $old = $this->startedMatch([User::factory()->create(), User::factory()->create()]);
        app(\App\Economy\MatchService::class)->finish($old->id, true);

        $mod = $this->mod();
        $this->actingAs($mod)->get('/moderacion/salas')->assertOk()
            ->assertSee('Sala de prueba')->assertSee('Sala de Cami')->assertSee('2/8 jugadores')
            ->assertViewHas('counts', fn ($c) => $c['activas'] === 2 && $c['terminadas'] === 1 && $c['todas'] === 3)
            ->assertViewHas('rooms', fn ($r) => count($r) === 2);
        $this->actingAs($mod)->get('/moderacion/salas?estado=terminadas')->assertViewHas('rooms', fn ($r) => count($r) === 1 && $r[0]['id'] === $old->id);
        $this->actingAs($mod)->get('/moderacion/salas?estado=todas')->assertViewHas('rooms', fn ($r) => count($r) === 3);
        $this->actingAs($mod)->get('/moderacion/salas?estado=cualquiera')->assertOk()->assertViewHas('filter', 'activas'); // filtro inválido: cae al por defecto
        $this->actingAs($mod)->get('/moderacion/salas?q='.$lobby->code)->assertViewHas('rooms', fn ($r) => count($r) === 1 && $r[0]['code'] === $lobby->code);
        $this->actingAs($mod)->get('/moderacion/salas?estado=todas&q=Ana')->assertViewHas('rooms', fn ($r) => count($r) === 1 && $r[0]['id'] === $live->id);
        $this->actingAs($mod)->get('/moderacion/salas?q=%25')->assertOk()->assertViewHas('rooms', fn ($r) => count($r) === 0); // % no es comodín
    }

    public function test_la_ficha_muestra_jugadores_dinero_y_propiedades(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $match = $this->startedMatch([$ana, $beto], 30000);
        $casa = $this->makeProperty(10000, 500);
        DB::table('match_properties')->insert(['match_id' => $match->id, 'property_id' => $casa->id, 'owner_id' => $ana->id, 'bought_at' => now(), 'price_paid' => 10000]);
        DB::table('match_players')->where('match_id', $match->id)->where('user_id', $ana->id)->update(['cash' => 20000]);

        $res = $this->actingAs($this->mod())->get("/moderacion/salas/{$match->id}")->assertOk()
            ->assertSee('Sala de prueba')->assertSee('Ana')->assertSee('Beto')->assertSee('creador')->assertSee('En juego');
        $res->assertViewHas('players', function ($p) {
            $ana = collect($p)->firstWhere('name', 'Ana');
            $beto = collect($p)->firstWhere('name', 'Beto');

            return $ana['properties'] === 1 && $ana['assets'] === 10000 && $ana['cash'] >= 20000 && $ana['net_worth'] >= 30000
                && $ana['rank'] === 1 && $beto['properties'] === 0 && $beto['cash'] >= 30000 && $ana['is_creator'] && ! $beto['is_creator'];
        });
    }

    public function test_marca_a_quien_salio_o_esta_silenciado(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $mod = $this->mod();
        $match = $this->startedMatch([$ana, $beto]);
        DB::table('match_players')->where('match_id', $match->id)->where('user_id', $beto->id)->update(['left_at' => now(), 'abandoned' => true, 'active_user_id' => null]);
        DB::table('chat_mutes')->insert(['user_id' => $ana->id, 'muted_by' => $mod->id, 'expires_at' => now()->addHour(), 'reason' => 'spam']);

        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertOk()->assertSee('abandonó')->assertSee('silenciado hasta')
            ->assertViewHas('match', fn ($m) => true)
            ->assertViewHas('players', fn ($p) => collect($p)->firstWhere('name', 'Beto')['in_room'] === false && collect($p)->firstWhere('name', 'Ana')['muted_until'] !== null);
    }

    public function test_el_chat_de_la_sala_incluye_ocultos_y_no_mezcla_otras_salas(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $a = $this->startedMatch([$ana, $beto]);
        $this->say($a, $ana, 'hola sala');
        $this->say($a, $beto, 'mensaje feo', ['hidden_at' => now(), 'hidden_reason' => 'reportes']);
        DB::table('chat_messages')->insert(['match_id' => $a->id, 'user_id' => $ana->id, 'client_key' => 'sys1', 'body' => 'AVISO DEL JUEGO', 'kind' => 'sistema', 'event_key' => 'k1']);
        ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'g1', 'body' => 'MENSAJE GLOBAL']);

        $this->actingAs($this->mod())->get("/moderacion/salas/{$a->id}")->assertOk()
            ->assertSee('hola sala')->assertSee('mensaje feo')->assertSee('oculto por reportes')
            ->assertDontSee('AVISO DEL JUEGO')->assertDontSee('MENSAJE GLOBAL')
            ->assertViewHas('chat', fn ($c) => $c['total'] === 2);
    }

    public function test_no_expone_correos_ni_ips(): void
    {
        $ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana.secreta@example.com']);
        $match = $this->startedMatch([$ana]);
        $html = $this->actingAs($this->mod())->get("/moderacion/salas/{$match->id}")->assertOk()->getContent();
        $this->assertStringNotContainsString('ana.secreta@example.com', $html);
        $this->assertStringNotContainsString('127.0.0.1', $html);
        $this->actingAs($this->mod())->get('/moderacion/salas')->assertDontSee('ana.secreta@example.com');
    }

    public function test_partida_inexistente_da_404_y_el_nombre_se_escapa(): void
    {
        $mod = $this->mod();
        $this->actingAs($mod)->get('/moderacion/salas/999')->assertNotFound();
        $this->actingAs($mod)->get('/moderacion/salas/abc')->assertNotFound();
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = $this->startedMatch([$ana]);
        DB::table('matches')->where('id', $match->id)->update(['name' => '<script>alert(1)</script>']);
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertOk()->assertDontSee('<script>alert(1)</script>', false)->assertSee('&lt;script&gt;', false);
    }

    public function test_mirar_no_modifica_nada(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = $this->startedMatch([$ana]);
        $mod = $this->mod();
        $before = [DB::table('matches')->get()->toJson(), DB::table('match_players')->get()->toJson(), DB::table('ledger_entries')->count(), DB::table('moderation_log')->count()];
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertOk();
        $this->actingAs($mod)->get('/moderacion/salas?estado=todas')->assertOk();
        $after = [DB::table('matches')->get()->toJson(), DB::table('match_players')->get()->toJson(), DB::table('ledger_entries')->count(), DB::table('moderation_log')->count()];
        $this->assertSame($before, $after);
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}")->assertStatus(405);
    }

    public function test_las_otras_pantallas_enlazan_a_salas(): void
    {
        $mod = $this->mod();
        $this->actingAs($mod)->get('/moderacion')->assertOk()->assertSee('/moderacion/salas', false);
        $this->actingAs($mod)->get('/moderacion/mapa')->assertOk()->assertSee('/moderacion/salas', false);
    }

    // ---------------------------------------------------------------------------------------- acciones desde la ficha

    public function test_silenciar_desde_la_ficha_vuelve_a_la_ficha_y_queda_registrado(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = $this->startedMatch([$ana]);
        $mod = $this->mod();

        $this->actingAs($mod)->post("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 60, 'sala' => $match->id])
            ->assertRedirect("/moderacion/salas/{$match->id}")->assertSessionHas('ok');
        $this->assertSame(1, DB::table('chat_mutes')->where('user_id', $ana->id)->whereNull('lifted_at')->count());
        $this->assertSame(1, DB::table('moderation_log')->where('action', 'silenciar')->where('actor_id', $mod->id)->count());
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertSee('silenciado hasta')->assertSee('Levantar silencio');

        $this->actingAs($mod)->post("/moderacion/usuarios/{$ana->id}/quitar-silencio", ['sala' => $match->id])->assertRedirect("/moderacion/salas/{$match->id}");
        $this->assertSame(1, DB::table('moderation_log')->where('action', 'levantar_silencio')->count());
        // Sin el campo `sala`, sigue volviendo a la cola de moderación.
        $this->actingAs($mod)->post("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertRedirect('/moderacion');
        // Un valor raro en `sala` no se usa para redirigir a ningún lado.
        $this->actingAs($mod)->post("/moderacion/usuarios/{$ana->id}/quitar-silencio", ['sala' => 'http://malo.example'])->assertRedirect('/moderacion');
    }

    public function test_ocultar_y_restaurar_desde_la_ficha(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = $this->startedMatch([$ana]);
        $id = $this->say($match, $ana, 'algo');
        $mod = $this->mod();

        $this->actingAs($mod)->post("/moderacion/mensajes/{$id}/ocultar", ['sala' => $match->id])->assertRedirect("/moderacion/salas/{$match->id}");
        $this->assertNotNull(DB::table('chat_messages')->where('id', $id)->value('hidden_at'));
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertSee('Restaurar');
        $this->actingAs($mod)->post("/moderacion/mensajes/{$id}/restaurar", ['sala' => $match->id])->assertRedirect("/moderacion/salas/{$match->id}");
        $this->assertNull(DB::table('chat_messages')->where('id', $id)->value('hidden_at'));
    }

    public function test_no_ofrece_silenciar_a_moderadores(): void
    {
        $mod = $this->mod();
        $match = $this->startedMatch([$mod]);
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertOk()->assertDontSee('Silenciar a');
    }

    public function test_cierra_una_sala_abierta_y_libera_a_sus_jugadores(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = app(\App\Economy\MatchService::class)->create($ana, 'Sala trabada');
        $mod = $this->mod();

        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertSee('Cerrar sala…', false);
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}/cerrar")->assertRedirect("/moderacion/salas/{$match->id}")->assertSessionHas('ok');
        $this->assertSame('expired', DB::table('matches')->where('id', $match->id)->value('status'));
        $this->assertNull(DB::table('match_players')->where('match_id', $match->id)->value('active_user_id'));
        $log = DB::table('moderation_log')->where('action', 'cerrar_sala')->first();
        $this->assertSame($mod->id, (int) $log->actor_id);
        $this->assertStringContainsString("Sala #{$match->id}", $log->detail);
        // La jugadora puede entrar a otra sala.
        $this->assertNotNull(app(\App\Economy\MatchService::class)->create($ana, 'Otra'));
        // Repetir (doble clic) no hace nada más y avisa.
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}/cerrar")->assertSessionHas('error');
        $this->assertSame(1, DB::table('moderation_log')->where('action', 'cerrar_sala')->count());
    }

    public function test_cierra_una_partida_vencida_con_puestos_y_puntos(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $match = $this->startedMatch([$ana, $beto]);
        $mod = $this->mod();

        // Todavía le queda tiempo: no se ofrece ni se acepta.
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertDontSee('Cerrar partida…', false);
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}/cerrar")->assertSessionHas('error');
        $this->assertSame('running', DB::table('matches')->where('id', $match->id)->value('status'));

        // Pasó la hora de fin y nadie la cerró (el reloj no corre).
        $this->travel(2)->hours();
        $this->actingAs($mod)->get("/moderacion/salas/{$match->id}")->assertSee('Cerrar partida…', false)->assertSee('¿está corriendo el reloj');
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}/cerrar")->assertSessionHas('ok');
        $this->assertSame('finished', DB::table('matches')->where('id', $match->id)->value('status'));
        $this->assertSame(2, DB::table('match_players')->where('match_id', $match->id)->whereNotNull('final_rank')->count());
        $this->assertSame(1, (int) DB::table('users')->where('id', $ana->id)->value('matches_played'));
        $this->assertSame(1, DB::table('moderation_log')->where('action', 'cerrar_sala')->count());
        $this->actingAs($mod)->post("/moderacion/salas/{$match->id}/cerrar")->assertSessionHas('error'); // ya terminada: no suma puntos dos veces
        $this->assertSame(1, (int) DB::table('users')->where('id', $ana->id)->value('matches_played'));
    }

    public function test_cerrar_exige_ser_moderador_y_que_exista(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $match = app(\App\Economy\MatchService::class)->create($ana, 'Sala');
        $this->post("/moderacion/salas/{$match->id}/cerrar")->assertRedirect('/ingresar');
        $this->actingAs($ana)->post("/moderacion/salas/{$match->id}/cerrar")->assertForbidden();
        $this->assertSame('lobby', DB::table('matches')->where('id', $match->id)->value('status'));
        $this->actingAs($this->mod())->post('/moderacion/salas/999/cerrar')->assertSessionHas('error');
    }

    public function test_la_migracion_del_registro_se_puede_revertir_y_volver_a_aplicar(): void
    {
        $mod = $this->mod();
        $sala = fn () => DB::table('moderation_log')->insert(['actor_id' => $mod->id, 'action' => 'cerrar_sala', 'detail' => 'Sala #1']);

        $sala(); // con la migración aplicada, el valor existe
        DB::table('moderation_log')->delete();
        \Illuminate\Support\Facades\Artisan::call('migrate:rollback', ['--path' => 'database/migrations/2026_10_22_000001_add_close_room_to_moderation_log.php']);
        try {
            $sala();
            $this->fail('Sin la migración, "cerrar_sala" no debería ser un valor válido.');
        } catch (\Illuminate\Database\QueryException) {
            $this->assertTrue(true);
        }
        \Illuminate\Support\Facades\Artisan::call('migrate');
        $sala();
        $this->assertSame(1, DB::table('moderation_log')->where('action', 'cerrar_sala')->count());
        // Con cierres en el registro, volver atrás se niega (no se pierde historia).
        $this->expectException(\RuntimeException::class);
        \Illuminate\Support\Facades\Artisan::call('migrate:rollback', ['--path' => 'database/migrations/2026_10_22_000001_add_close_room_to_moderation_log.php']);
    }
}
