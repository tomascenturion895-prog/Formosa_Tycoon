<?php

namespace Tests\Feature;

use App\Economy\MatchService;
use App\Events\LobbyChanged;
use App\Events\MatchFinished;
use App\Events\MatchPlayersChanged;
use App\Events\MatchStarted;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Salas y partidas de punta a punta: crear, unirse, iniciar, jugar, cerrar, puntos y ranking. */
class MatchLifecycleTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['formosa.match.minutes_per_day' => 2, 'formosa.match.duration_minutes' => 40, 'formosa.match.min_players' => 2, 'formosa.auction.dispute_seconds' => 0]);
        Carbon::setTestNow('2026-10-14 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function users(int $n): array
    {
        return User::factory()->count($n)->create()->all();
    }

    private function lobby(User $creator, array $joiners = [], ?int $cupo = null): array
    {
        $id = $this->actingAs($creator)->postJson('/api/partidas', ['nombre' => 'Sala', 'cupo' => $cupo])->assertCreated()->json('match.id');
        $code = GameMatch::findOrFail($id)->code;
        foreach ($joiners as $u) {
            $this->actingAs($u)->postJson("/api/partidas/{$code}/unirse")->assertOk();
        }

        return [$id, $code];
    }

    // ------------------------------------------------------------------ sala
    public function test_crear_unirse_y_listar_la_sala(): void
    {
        [$ana, $beto] = $this->users(2);

        [$id, $code] = $this->lobby($ana, [$beto], 4);

        $this->assertMatchesRegularExpression('/^[A-Z0-9]{4,12}$/', $code);
        $this->getJson('/api/partidas')->assertOk()->assertJsonPath('matches.0.id', $id)->assertJsonPath('matches.0.players', 2)->assertJsonPath('matches.0.capacity', 4);
        $this->actingAs($beto)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match.status', 'lobby');
    }

    public function test_el_cupo_se_valida_y_la_sala_se_llena(): void
    {
        [$ana, $beto, $cami] = $this->users(3);
        $this->actingAs($ana)->postJson('/api/partidas', ['cupo' => 1])->assertStatus(422)->assertJsonPath('error', 'cupo_invalido');
        $this->actingAs($ana)->postJson('/api/partidas', ['cupo' => 9])->assertStatus(422)->assertJsonPath('error', 'cupo_invalido');

        [, $code] = $this->lobby($ana, [$beto], 2);

        $this->actingAs($cami)->postJson("/api/partidas/{$code}/unirse")->assertStatus(409)->assertJsonPath('error', 'sala_llena');
        $this->actingAs($cami)->postJson('/api/partidas/ZZZZZZ/unirse')->assertStatus(404)->assertJsonPath('error', 'codigo_invalido');
    }

    public function test_un_jugador_no_puede_estar_en_dos_partidas_activas(): void
    {
        [$ana, $beto] = $this->users(2);
        [, $code] = $this->lobby($ana);

        $this->actingAs($ana)->postJson('/api/partidas', ['nombre' => 'Otra'])->assertStatus(409)->assertJsonPath('error', 'ya_estas_en_partida');
        [, $otra] = $this->lobby($beto);
        $this->actingAs($ana)->postJson("/api/partidas/{$otra}/unirse")->assertStatus(409)->assertJsonPath('error', 'ya_estas_en_partida');
        $this->assertSame(1, DB::table('match_players')->where('user_id', $ana->id)->count());
    }

    public function test_la_base_garantiza_una_partida_activa_por_jugador(): void
    {
        [$ana] = $this->users(1);
        [$id] = $this->lobby($ana);
        $second = new GameMatch;
        $second->forceFill(['code' => 'OTRO99', 'name' => 'x', 'is_public' => true, 'status' => 'lobby', 'capacity' => 4, 'min_players' => 2, 'creator_id' => $ana->id,
            'start_cash' => 1, 'minutes_per_day' => 2, 'duration_minutes' => 40, 'lobby_expires_at' => now()->addMinutes(5)])->save();

        $this->expectException(QueryException::class);
        DB::table('match_players')->insert(['match_id' => $second->id, 'user_id' => $ana->id, 'active_user_id' => $ana->id, 'cash' => 0, 'reserved' => 0, 'joined_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
    }

    public function test_salir_de_la_sala_y_reasignar_al_creador(): void
    {
        [$ana, $beto] = $this->users(2);
        [$id] = $this->lobby($ana, [$beto]);

        $this->actingAs($ana)->postJson("/api/partidas/{$id}/salir")->assertOk();

        $this->assertSame($beto->id, (int) GameMatch::findOrFail($id)->creator_id);
        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match', null);
        $this->actingAs($ana)->postJson('/api/partidas', ['nombre' => 'Nueva'])->assertCreated(); // quedó libre
    }

    public function test_iniciar_exige_creador_y_minimo_de_jugadores(): void
    {
        [$ana, $beto] = $this->users(2);
        [$id, $code] = $this->lobby($ana);

        $this->actingAs($ana)->postJson("/api/partidas/{$id}/iniciar")->assertStatus(422)->assertJsonPath('error', 'faltan_jugadores');
        $this->actingAs($beto)->postJson("/api/partidas/{$code}/unirse")->assertOk();
        $this->actingAs($beto)->postJson("/api/partidas/{$id}/iniciar")->assertStatus(403)->assertJsonPath('error', 'no_sos_el_creador');
        $this->actingAs($ana)->postJson("/api/partidas/{$id}/iniciar")->assertOk()->assertJsonPath('match.status', 'running');
        $this->actingAs($ana)->postJson("/api/partidas/{$id}/iniciar")->assertStatus(409);
    }

    public function test_al_iniciar_cada_uno_tiene_el_mismo_dinero_y_el_reloj_parte_de_started_at(): void
    {
        [$ana, $beto, $cami] = $this->users(3);
        config(['formosa.match.start_cash' => 60000]);
        [$id] = $this->lobby($ana, [$beto, $cami]);

        $res = $this->actingAs($ana)->postJson("/api/partidas/{$id}/iniciar")->assertOk();

        $m = GameMatch::findOrFail($id);
        $res->assertJsonPath('match.started_at', $m->started_at->getTimestampMs())->assertJsonPath('match.ends_at', $m->started_at->copy()->addMinutes(40)->getTimestampMs())
            ->assertJsonPath('match.minutes_per_day', 2)->assertJsonPath('match.days_total', 20);
        $this->assertIsInt($res->json('match.server_now'));
        foreach ([$ana, $beto, $cami] as $u) {
            $this->assertSame(60000, $this->cash($m, $u));
        }
        $this->assertLedgerMatchesCash($m);
    }

    public function test_una_sala_sin_iniciar_vence_y_libera_a_los_jugadores(): void
    {
        [$ana] = $this->users(1);
        [$id] = $this->lobby($ana);

        Carbon::setTestNow('2026-10-14 10:16:00');
        $this->artisan('matches:tick')->assertSuccessful();

        $this->assertSame('expired', GameMatch::findOrFail($id)->status->value);
        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match', null);
        $this->actingAs($ana)->postJson('/api/partidas', [])->assertCreated();
    }

    public function test_la_sala_vencida_se_cierra_sola_al_leer_sin_el_comando(): void
    {
        [$ana] = $this->users(1);
        [$id] = $this->lobby($ana);

        Carbon::setTestNow('2026-10-14 10:20:00');

        // La primera lectura aplica el vencimiento y todavía devuelve la sala (ya vencida); la siguiente ya no hay partida activa.
        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match.status', 'expired');
        $this->assertSame('expired', GameMatch::findOrFail($id)->status->value);
        $this->actingAs($ana)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match', null);
    }

    // ------------------------------------------------------------------ partida
    public function test_la_partida_termina_sola_al_leer_y_otorga_puntos(): void
    {
        [$ana, $beto, $cami, $dani] = $this->users(4);
        $match = $this->startedMatch([$ana, $beto, $cami, $dani], 20000);
        config(['formosa.match.min_players' => 1]);
        $p1 = $this->makeProperty(10000, 1000);
        $p2 = $this->makeProperty(5000, 500);
        $economy = app(\App\Economy\EconomyService::class);
        $economy->buy($ana, $match->id, $p1->id);
        $economy->buy($beto, $match->id, $p2->id);

        Carbon::setTestNow('2026-10-14 10:40:01');
        $this->actingAs($cami)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match.status', 'finished'); // la lectura la cierra
        $this->actingAs($cami)->getJson('/api/partidas/actual')->assertOk()->assertJsonPath('match', null)->assertJsonPath('last_finished_match_id', $match->id);

        $res = $this->getJson("/api/partidas/{$match->id}/resultado")->assertOk();
        $res->assertJsonPath('match.status', 'finished')->assertJsonPath('players.0.user_id', $ana->id)->assertJsonPath('players.0.rank', 1);
        $this->assertSame([1, 2, 3, 3], array_column($res->json('players'), 'rank')); // cami y dani empatan con 20000
        $this->assertSame(1 + 100, $res->json('players.0.points')); // 100 + 1 propiedad
        $this->assertSame(60 + 1, $res->json('players.1.points'));
        $this->assertSame(25, $res->json('players.2.points')); // (35 + 15) / 2
        $this->assertLedgerMatchesCash($match);
    }

    public function test_el_ingreso_por_dia_de_juego_se_acredita_y_no_se_duplica_al_cerrar(): void
    {
        [$ana, $beto] = $this->users(2);
        $match = $this->startedMatch([$ana, $beto], 20000);
        $p = $this->makeProperty(10000, 1000);
        app(\App\Economy\EconomyService::class)->buy($ana, $match->id, $p->id);

        Carbon::setTestNow('2026-10-14 10:40:30');
        $svc = app(MatchService::class);
        $svc->finish($match->id);
        $svc->finish($match->id); // idempotente

        // Le quedan 10.000 de efectivo tras comprar + 20 días de juego x 1.000, una sola vez.
        $this->assertSame(10000 + 20 * 1000, $this->cash($match, $ana));
        $this->assertSame(1, \App\Models\MatchPlayer::where('match_id', $match->id)->whereNotNull('points_awarded')->where('user_id', $ana->id)->count());
        $this->assertLedgerMatchesCash($match);
    }

    public function test_abandonar_en_juego_libera_propiedades_y_queda_ultimo_sin_puntos(): void
    {
        [$ana, $beto, $cami] = $this->users(3);
        $match = $this->startedMatch([$ana, $beto, $cami], 20000);
        $p = $this->makeProperty(10000, 1000);
        app(\App\Economy\EconomyService::class)->buy($beto, $match->id, $p->id);

        $this->actingAs($beto)->postJson("/api/partidas/{$match->id}/salir")->assertOk();

        $this->assertNull($this->ownerOf($match, $p));
        Carbon::setTestNow('2026-10-14 10:41:00');
        $res = $this->getJson("/api/partidas/{$match->id}/resultado")->assertOk();
        $beto_row = collect($res->json('players'))->firstWhere('user_id', $beto->id);
        $this->assertTrue($beto_row['abandoned']);
        $this->assertSame(0, $beto_row['points']);
        $this->assertSame(3, $beto_row['rank']);
        $this->actingAs($beto)->postJson('/api/partidas', [])->assertCreated(); // quedó libre para otra
    }

    public function test_la_misma_propiedad_tiene_dueno_distinto_en_cada_partida(): void
    {
        [$ana, $beto, $cami, $dani] = $this->users(4);
        $a = $this->startedMatch([$ana, $beto], 20000);
        $b = $this->startedMatch([$cami, $dani], 20000);
        $p = $this->makeProperty(10000, 0);
        $economy = app(\App\Economy\EconomyService::class);

        $economy->buy($ana, $a->id, $p->id);
        $economy->buy($dani, $b->id, $p->id);

        $this->assertSame($ana->id, $this->ownerOf($a, $p));
        $this->assertSame($dani->id, $this->ownerOf($b, $p));
        $this->actingAs($beto)->getJson("/api/partidas/{$b->id}/propiedades/estado")->assertOk(); // el estado es público
        $this->assertLedgerMatchesCash($a);
        $this->assertLedgerMatchesCash($b);
    }

    public function test_la_base_rechaza_un_dueno_que_no_juega_esa_partida(): void
    {
        [$ana, $beto, $cami] = $this->users(3);
        $a = $this->startedMatch([$ana, $beto], 20000);
        $p = $this->makeProperty();

        $this->expectException(QueryException::class);
        DB::table('match_properties')->insert(['match_id' => $a->id, 'property_id' => $p->id, 'owner_id' => $cami->id, 'created_at' => now(), 'updated_at' => now()]);
    }

    public function test_el_ranking_global_suma_puntos_y_el_historial_muestra_la_partida(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);
        $match = $this->startedMatch([$ana, $beto], 20000);
        $p = $this->makeProperty(10000, 1000);
        app(\App\Economy\EconomyService::class)->buy($ana, $match->id, $p->id);
        Carbon::setTestNow('2026-10-14 10:41:00');
        $this->getJson("/api/partidas/{$match->id}/resultado")->assertOk();

        $rank = $this->getJson('/api/ranking')->assertOk();
        $this->assertSame('Ana', $rank->json('players.0.name'));
        $hist = $this->actingAs($ana)->getJson('/api/yo/historial')->assertOk();
        $this->assertSame($match->id, $hist->json('matches.0.match_id'));
        $this->assertSame(1, $hist->json('matches.0.rank'));
        $this->assertSame(101, $hist->json('matches.0.points'));
    }

    public function test_resultado_de_una_partida_en_juego_da_409(): void
    {
        [$ana] = $this->users(1);
        $match = $this->startedMatch([$ana], 20000);

        $this->getJson("/api/partidas/{$match->id}/resultado")->assertStatus(409)->assertJsonPath('error', 'partida_no_terminada');
        $this->getJson('/api/partidas/99999/resultado')->assertNotFound();
    }

    public function test_el_comando_tick_cierra_lo_vencido_y_marca_el_latido(): void
    {
        [$ana, $beto] = $this->users(2);
        $match = $this->startedMatch([$ana, $beto], 20000);
        Carbon::setTestNow('2026-10-14 10:41:00');

        $this->artisan('matches:tick')->expectsOutputToContain('partidas cerradas: 1')->assertSuccessful();

        $this->assertSame('finished', GameMatch::findOrFail($match->id)->status->value);
        $this->assertNotNull(\Cache::get('juego.partidas.latido'));
    }

    // ------------------------------------------------------------------ eventos
    public function test_los_eventos_de_sala_y_partida_se_emiten(): void
    {
        Event::fake([LobbyChanged::class, MatchPlayersChanged::class, MatchStarted::class, MatchFinished::class]);
        [$ana, $beto] = $this->users(2);
        [$id, $code] = $this->lobby($ana, [$beto]);
        Event::assertDispatched(LobbyChanged::class);
        Event::assertDispatched(MatchPlayersChanged::class);

        $this->actingAs($ana)->postJson("/api/partidas/{$id}/iniciar")->assertOk();
        Event::assertDispatched(MatchStarted::class);

        Carbon::setTestNow('2026-10-14 10:41:00');
        app(MatchService::class)->finish($id);
        Event::assertDispatched(MatchFinished::class);
    }
}
