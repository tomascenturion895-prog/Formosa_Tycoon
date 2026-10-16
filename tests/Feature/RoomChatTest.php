<?php

namespace Tests\Feature;

use App\Economy\AuctionService;
use App\Economy\ChatService;
use App\Economy\EconomyService;
use App\Economy\MatchService;
use App\Economy\RoomNotices;
use App\Events\ChatMessageHidden;
use App\Events\ChatMessageSent;
use App\Models\ChatMessage;
use App\Models\GameMatch;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Schema;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Los dos chats (global y sala), los avisos automáticos del juego y su moderación. */
class RoomChatTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.auction.dispute_seconds' => 0, 'formosa.match.duration_minutes' => 40, 'formosa.match.minutes_per_day' => 2, 'formosa.chat.auto_hide_min_age_hours' => 0]);
        Carbon::setTestNow('2026-10-21 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function user(string $name): User
    {
        return User::factory()->create(['name' => $name]);
    }

    private function say(User $u, string $text, ?int $matchId = null, ?string $key = null)
    {
        $url = $matchId === null ? '/api/chat/global' : "/api/partidas/{$matchId}/chat";

        return $this->actingAs($u)->postJson($url, ['mensaje' => $text, 'clave' => $key ?? bin2hex(random_bytes(8))]);
    }

    private function room(User $u, int $matchId)
    {
        return $this->actingAs($u)->getJson("/api/partidas/{$matchId}/chat");
    }

    /** @return list<string> textos del canal ('' = global) */
    private function bodies(?int $matchId): array
    {
        return array_column($matchId === null ? $this->getJson('/api/chat/global')->json('messages') : [], 'body');
    }

    private function roomBodies(User $u, int $matchId): array
    {
        return array_column($this->room($u, $matchId)->assertOk()->json('messages'), 'body');
    }

    /** @return list<string> */
    private function systemTexts(int $matchId, string $contains = ''): array
    {
        return array_values(array_filter($this->systemRows($matchId)->pluck('body')->all(), fn ($b) => str_contains($b, $contains)));
    }

    private function systemRows(int $matchId)
    {
        return ChatMessage::where('match_id', $matchId)->where('kind', 'sistema')->orderBy('id')->get();
    }

    // ------------------------------------------------------------------------------------ aislamiento

    public function test_global_y_sala_no_se_mezclan_y_cada_uno_sale_por_su_canal(): void
    {
        Event::fake([ChatMessageSent::class]);
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);

        $this->say($ana, 'hola a todos')->assertCreated()->assertJsonPath('scope', 'global')->assertJsonPath('message.match_id', null);
        $this->say($beto, 'psst, es de la sala', $m->id)->assertCreated()->assertJsonPath('scope', 'sala')->assertJsonPath('message.match_id', $m->id)->assertJsonPath('message.kind', 'usuario');

        $this->assertSame(['hola a todos'], $this->bodies(null));
        $roomTexts = $this->roomBodies($ana, $m->id);
        $this->assertContains('psst, es de la sala', $roomTexts);
        $this->assertNotContains('hola a todos', $roomTexts);

        $this->getJson('/api/chat')->assertOk()->assertJsonPath('scope', 'global'); // el nombre de antes sigue andando
        Event::assertDispatched(ChatMessageSent::class, fn ($e) => $e->message['body'] === 'hola a todos' && ! ($e->broadcastOn()[0] instanceof PrivateChannel) && $e->broadcastOn()[0]->name === 'chat');
        Event::assertDispatched(ChatMessageSent::class, fn ($e) => $e->message['body'] === 'psst, es de la sala' && $e->broadcastOn()[0] instanceof PrivateChannel && $e->broadcastOn()[0]->name === "private-partida.{$m->id}.chat");
    }

    public function test_dos_salas_no_se_ven_entre_si(): void
    {
        [$ana, $beto, $cami, $dani] = [$this->user('Ana'), $this->user('Beto'), $this->user('Cami'), $this->user('Dani')];
        $a = $this->startedMatch([$ana, $beto]);
        $b = $this->startedMatch([$cami, $dani]);

        $this->say($ana, 'secreto de A', $a->id)->assertCreated();

        $this->assertContains('secreto de A', $this->roomBodies($beto, $a->id));
        $this->assertNotContains('secreto de A', $this->roomBodies($cami, $b->id));
        $this->room($cami, $a->id)->assertForbidden()->assertJsonPath('error', 'no_estas_en_partida');
        $this->say($cami, 'intruso', $a->id)->assertForbidden();
    }

    // ------------------------------------------------------------------------------------ acceso

    public function test_la_sala_exige_sesion_y_ser_de_la_partida(): void
    {
        [$ana, $beto, $intruso] = [$this->user('Ana'), $this->user('Beto'), $this->user('Intruso')];
        $m = $this->startedMatch([$ana, $beto]);

        $this->getJson("/api/partidas/{$m->id}/chat")->assertUnauthorized();
        $this->postJson("/api/partidas/{$m->id}/chat", ['mensaje' => 'hola', 'clave' => 'abcdefgh12'])->assertUnauthorized();
        $this->room($intruso, $m->id)->assertForbidden();
        $this->say($intruso, 'hola', $m->id)->assertForbidden();
        $this->room($ana, 999999)->assertNotFound()->assertJsonPath('error', 'partida_inexistente');
        $this->say($ana, 'hola', 999999)->assertNotFound();
        $this->assertSame(0, ChatMessage::where('user_id', $intruso->id)->count());
    }

    public function test_quien_salio_de_la_sala_de_espera_ya_no_es_miembro(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $svc = app(MatchService::class);
        $m = $svc->create($ana, 'Sala');
        $svc->join($beto, $m->code);
        $this->say($beto, 'hola desde la espera', $m->id)->assertCreated();

        $svc->leave($beto, $m->id);

        $this->room($beto, $m->id)->assertForbidden();
        $this->assertContains('Beto salió de la sala', $this->roomBodies($ana, $m->id));
    }

    public function test_quien_abandona_lee_pero_no_escribe_y_al_terminar_queda_solo_lectura(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $this->say($ana, 'vamos', $m->id)->assertCreated();

        app(MatchService::class)->leave($beto, $m->id);

        $this->room($beto, $m->id)->assertOk()->assertJsonPath('writable', false);
        $this->say($beto, 'me fui', $m->id)->assertStatus(409)->assertJsonPath('error', 'sala_solo_lectura');
        $this->room($ana, $m->id)->assertOk()->assertJsonPath('writable', true);

        Carbon::setTestNow(now()->addMinutes(41));
        app(MatchService::class)->finish($m->id);
        $this->room($ana, $m->id)->assertOk()->assertJsonPath('writable', false);
        $this->say($ana, 'gg', $m->id)->assertStatus(409)->assertJsonPath('error', 'sala_solo_lectura');
        $this->assertContains('vamos', $this->roomBodies($ana, $m->id)); // el historial de una sala terminada se conserva
    }

    public function test_la_clave_de_envio_no_sirve_para_otro_canal(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $this->say($ana, 'hola', null, 'clave-compartida-1')->assertCreated();

        $this->say($ana, 'hola', $m->id, 'clave-compartida-1')->assertStatus(409)->assertJsonPath('error', 'clave_reutilizada');
    }

    public function test_antispam_por_canal_y_silencio_en_ambos(): void
    {
        [$ana, $beto, $mod] = [$this->user('Ana'), $this->user('Beto'), $this->user('Mod')];
        $mod->forceFill(['role' => 'moderador'])->save();
        $m = $this->startedMatch([$ana, $beto]);

        $this->say($ana, 'mismo texto', null)->assertCreated();
        $this->say($ana, 'mismo texto', $m->id)->assertCreated();          // otro canal: no es repetido
        $this->say($ana, 'mismo texto', $m->id)->assertStatus(429)->assertJsonPath('error', 'mensaje_repetido');
        $this->say($ana, str_repeat('x', 281), $m->id)->assertStatus(422)->assertJsonPath('error', 'mensaje_largo');

        $this->actingAs($mod)->postJson("/moderacion/usuarios/{$ana->id}/silenciar", ['minutos' => 10])->assertOk();
        $this->say($ana, 'otra cosa', $m->id)->assertForbidden()->assertJsonPath('error', 'silenciado');
        $this->say($ana, 'otra cosa', null)->assertForbidden()->assertJsonPath('error', 'silenciado');
    }

    // ------------------------------------------------------------------------------------ avisos de compra

    public function test_una_compra_se_avisa_en_la_sala_y_no_en_el_global(): void
    {
        Event::fake([ChatMessageSent::class]);
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto], 500000);
        $p = $this->makeProperty(150000, 100, 'supermercado');
        DB::table('properties')->where('id', $p->id)->update(['name' => 'Supermercado Carrefour']);

        $r = app(EconomyService::class)->buy($ana, $m->id, $p->id, 'k-compra-1');

        $rows = $this->systemRows($m->id)->filter(fn ($r) => str_contains($r->body, 'compró'));
        $this->assertCount(1, $rows);
        $row = $rows->first();
        $this->assertSame('Ana compró Supermercado Carrefour por $150.000', $row->body);
        $this->assertNull($row->user_id);
        $this->assertSame('sistema', $row->kind);
        $this->assertSame([], array_filter($this->bodies(null), fn ($b) => str_contains($b, 'compró')));
        $this->assertContains('Ana compró Supermercado Carrefour por $150.000', $this->roomBodies($beto, $m->id));
        Event::assertDispatched(ChatMessageSent::class, fn ($e) => $e->message['kind'] === 'sistema' && $e->message['user'] === null && $e->broadcastOn()[0] instanceof PrivateChannel);

        // El mismo pedido repetido (reintento de red) no vuelve a avisar.
        app(EconomyService::class)->buy($ana, $m->id, $p->id, 'k-compra-1');
        $this->assertCount(1, $this->systemTexts($m->id, 'compró'));
        $this->assertSame(150000, $r->price);
    }

    public function test_comprar_por_la_api_tambien_avisa(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto], 100000);
        $p = $this->makeProperty(40000, 10, 'comercio');

        $this->actingAs($ana)->postJson("/api/partidas/{$m->id}/propiedades/{$p->id}/comprar", [], ['Idempotency-Key' => 'abcdefgh-1'])->assertOk();

        $this->assertContains('Ana compró un comercio por $40.000', $this->roomBodies($beto, $m->id));
    }

    public function test_nombre_de_la_propiedad_en_el_aviso(): void
    {
        $nameless = $this->makeProperty(10000, 1, 'casa');
        DB::table('properties')->where('id', $nameless->id)->update(['street' => 'España']);
        $bare = $this->makeProperty(10000, 1, 'casa');
        $shop = $this->makeProperty(40000, 1, 'comercio');
        DB::table('properties')->where('id', $shop->id)->update(['street' => 'Moreno']);
        $named = $this->makeProperty(40000, 1, 'hotel');
        DB::table('properties')->where('id', $named->id)->update(['name' => 'Hotel Colón', 'street' => 'Belgrano']);

        $this->assertSame('Casa de calle España', RoomNotices::propertyLabel($nameless->id));
        $this->assertSame('una casa', RoomNotices::propertyLabel($bare->id));
        $this->assertSame('Comercio de calle Moreno', RoomNotices::propertyLabel($shop->id));
        $this->assertSame('Hotel Colón', RoomNotices::propertyLabel($named->id));
        $this->assertSame('una propiedad', RoomNotices::propertyLabel(987654));
        $this->assertSame('$1.234.500', RoomNotices::money(1234500));
        $this->assertSame('$0', RoomNotices::money(0));
    }

    public function test_venta_al_banco_se_avisa(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto], 100000);
        $p = $this->makeProperty(50000, 0, 'comercio');
        DB::table('properties')->where('id', $p->id)->update(['name' => 'Kiosco Don Pepe']);
        $econ = app(EconomyService::class);
        $econ->buy($ana, $m->id, $p->id);

        $econ->sell($ana, $m->id, $p->id, 'k-venta-1');
        $econ->sell($ana, $m->id, $p->id, 'k-venta-1'); // reintento: no repite

        $this->assertSame(['Ana vendió Kiosco Don Pepe al banco por $30.000'], $this->systemTexts($m->id, 'vendió'));
    }

    public function test_subasta_ganada_y_reclamo_sin_disputa(): void
    {
        config(['formosa.auction.dispute_seconds' => 10, 'formosa.auction.duration_seconds' => 30]);
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto], 500000);
        $disputed = $this->makeProperty(100000, 0, 'hotel');
        DB::table('properties')->where('id', $disputed->id)->update(['name' => 'Hotel Colón']);
        $quiet = $this->makeProperty(40000, 0, 'casa');
        $auctions = app(AuctionService::class);

        // Hotel: Ana reclama, Beto lo disputa y se abre la subasta; gana Beto con una puja mayor.
        $auctions->claim($ana, $m->id, $disputed->id);
        $r = $auctions->claim($beto, $m->id, $disputed->id);
        $this->assertSame('disputada', $r->result);
        $this->assertSame([], $this->systemTexts($m->id, 'subasta')); // todavía nadie ganó nada
        Carbon::setTestNow(now()->addSeconds(31));
        $auctions->settleDue();

        // Casa: Ana la reclama y nadie la disputa: es una compra al precio de lista.
        $auctions->claim($ana, $m->id, $quiet->id);
        Carbon::setTestNow(now()->addSeconds(11));
        $auctions->settleDue();

        $texts = $this->systemRows($m->id)->pluck('body')->all();
        $this->assertContains('Beto ganó la subasta de Hotel Colón por $'.number_format((int) \App\Models\Auction::query()->value('current_bid'), 0, ',', '.'), $texts);
        $this->assertContains('Ana compró una casa por $40.000', $texts);
        $this->assertSame([], array_filter($this->bodies(null), fn ($b) => str_contains($b, 'subasta')));
    }

    public function test_un_fallo_del_chat_no_revierte_la_compra(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto], 100000);
        $p = $this->makeProperty(20000, 5, 'casa');
        $q = $this->makeProperty(20000, 5, 'casa');
        $econ = app(EconomyService::class);

        // (a) El servicio del chat revienta.
        $this->app->instance(ChatService::class, new class(app(\App\Economy\ModerationService::class)) extends ChatService
        {
            public function system(int $matchId, string $text, ?string $eventKey = null): ?array
            {
                throw new \RuntimeException('chat caído');
            }
        });
        $econ->buy($ana, $m->id, $p->id);
        $this->assertSame($ana->id, $this->ownerOf($m, $p));

        // (b) La tabla del chat directamente no existe.
        $this->app->forgetInstance(ChatService::class);
        $this->app->bind(ChatService::class);
        Schema::drop('chat_messages');
        $econ->buy($ana, $m->id, $q->id);
        $this->assertSame($ana->id, $this->ownerOf($m, $q));
        $this->assertSame(100000 - 40000, $this->cash($m, $ana));
        $this->assertLedgerMatchesCash($m);
    }

    public function test_un_fallo_al_avisar_no_rompe_unirse_ni_cerrar_la_partida(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $svc = app(MatchService::class);
        $m = $svc->create($ana, 'Sala');
        Schema::drop('chat_messages');

        $svc->join($beto, $m->code);
        $svc->start($ana, $m->id);
        Carbon::setTestNow(now()->addMinutes(41));
        $this->assertNotNull($svc->finish($m->id));
        $this->assertSame('finished', GameMatch::find($m->id)->status->value);
    }

    // ------------------------------------------------------------------------------------ avisos de la partida

    public function test_entradas_salidas_inicio_y_fin_con_ganador(): void
    {
        [$ana, $beto, $cami] = [$this->user('Ana'), $this->user('Beto'), $this->user('Cami')];
        config(['formosa.match.min_players' => 2, 'formosa.match.start_cash' => 100000]);
        $svc = app(MatchService::class);
        $m = $svc->create($ana, 'Sala', 4);
        $svc->join($beto, $m->code);
        $svc->join($cami, $m->code);
        $svc->leave($cami, $m->id);                       // sale de la espera
        $svc->start($ana, $m->id);
        $p = $this->makeProperty(30000, 1000, 'comercio');
        DB::table('properties')->where('id', $p->id)->update(['name' => 'Panadería Sol']);
        app(EconomyService::class)->buy($ana, $m->id, $p->id);
        Carbon::setTestNow(now()->addMinutes(41));
        $svc->finish($m->id);

        $texts = $this->systemRows($m->id)->pluck('body')->all();
        $this->assertSame([
            'Beto entró a la sala',
            'Cami entró a la sala',
            'Cami salió de la sala',
            '¡Arrancó la partida! Son 40 minutos. ¡Suerte!',
            'Ana compró Panadería Sol por $30.000',
        ], array_slice($texts, 0, 5));
        $this->assertMatchesRegularExpression('/^Terminó la partida\. Ganó Ana con \$[\d.]+ de patrimonio$/', end($texts));
    }

    public function test_abandonar_en_juego_se_avisa_y_si_se_van_todos_cierra_sin_ganador(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $svc = app(MatchService::class);

        $svc->leave($beto, $m->id);
        $svc->leave($ana, $m->id);

        $texts = $this->systemRows($m->id)->pluck('body')->all();
        $this->assertContains('Beto abandonó la partida', $texts);
        $this->assertContains('Ana abandonó la partida', $texts);
        $this->assertSame('Terminó la partida, sin ganador', end($texts));
    }

    public function test_avisos_de_tiempo_una_sola_vez_y_solo_en_su_ventana(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $svc = app(MatchService::class);
        $texts = fn () => $this->systemRows($m->id)->pluck('body')->all();

        $svc->tick();
        $this->assertNotContains('Quedan 10 minutos', $texts());           // faltan 40

        Carbon::setTestNow($m->started_at->copy()->addMinutes(30)->addSeconds(5));   // faltan 9:55
        $svc->tick();
        $svc->tick();                                                       // dos relojes a la vez: sale una sola vez
        $this->assertSame(1, count(array_keys($texts(), 'Quedan 10 minutos')));

        Carbon::setTestNow($m->started_at->copy()->addMinutes(36));        // faltan 4:00: ya se pasó la ventana de 10, entra la de 5
        $svc->tick();
        $this->assertSame(1, count(array_keys($texts(), 'Quedan 5 minutos')));
        $this->assertSame(1, count(array_keys($texts(), 'Quedan 10 minutos')));
        $svc->tick();
        $this->assertSame(1, count(array_keys($texts(), 'Quedan 5 minutos')));
    }

    public function test_un_reloj_retomado_tarde_no_avisa_lo_que_ya_paso(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);

        Carbon::setTestNow($m->started_at->copy()->addMinutes(38));        // faltan 2: ni "10" ni "5"
        app(MatchService::class)->tick();

        $this->assertSame([], $this->systemRows($m->id)->where('event_key', 'like', 'falta-%')->all());
    }

    // ------------------------------------------------------------------------------------ moderación

    public function test_un_aviso_de_sistema_no_se_reporta_ni_se_oculta_ni_tiene_autor_para_silenciar(): void
    {
        [$ana, $beto, $mod] = [$this->user('Ana'), $this->user('Beto'), $this->user('Mod')];
        $mod->forceFill(['role' => 'moderador'])->save();
        $m = $this->startedMatch([$ana, $beto]);
        $sys = $this->systemRows($m->id)->first();
        $this->assertNotNull($sys);

        $this->actingAs($beto)->postJson("/api/chat/{$sys->id}/reportar", ['motivo' => 'spam'])->assertNotFound();
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$sys->id}/ocultar")->assertNotFound();
        $this->assertNull(ChatMessage::find($sys->id)->hidden_at);
        $this->assertNull($sys->user_id);
        $this->assertSame(0, DB::table('chat_reports')->count());
    }

    public function test_reportar_y_ocultar_en_la_sala_salen_por_el_canal_de_la_sala(): void
    {
        Event::fake([ChatMessageHidden::class, ChatMessageSent::class]);
        [$ana, $beto, $cami, $dani, $intruso, $mod] = array_map(fn ($n) => $this->user($n), ['Ana', 'Beto', 'Cami', 'Dani', 'Intruso', 'Mod']);
        $mod->forceFill(['role' => 'moderador'])->save();
        $m = $this->startedMatch([$ana, $beto, $cami, $dani]);
        $id = $this->say($ana, 'mensaje feo', $m->id)->assertCreated()->json('message.id');

        $this->actingAs($intruso)->postJson("/api/chat/{$id}/reportar", ['motivo' => 'acoso'])->assertNotFound(); // no es de la partida
        $this->actingAs($ana)->postJson("/api/chat/{$id}/reportar", ['motivo' => 'acoso'])->assertStatus(422);    // el propio
        foreach ([$beto, $cami] as $u) {
            $this->actingAs($u)->postJson("/api/chat/{$id}/reportar", ['motivo' => 'acoso'])->assertOk()->assertJsonPath('hidden', false);
        }
        $this->actingAs($dani)->postJson("/api/chat/{$id}/reportar", ['motivo' => 'acoso'])->assertOk()->assertJsonPath('hidden', true); // 3 distintos: se oculta solo

        $this->assertNotContains('mensaje feo', $this->roomBodies($beto, $m->id));
        Event::assertDispatched(ChatMessageHidden::class, fn ($e) => $e->id === $id && $e->broadcastOn()[0] instanceof PrivateChannel && $e->broadcastOn()[0]->name === "private-partida.{$m->id}.chat");

        // Un moderador lo restaura: vuelve a aparecer, por el canal de la sala.
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$id}/restaurar")->assertOk();
        $this->assertContains('mensaje feo', $this->roomBodies($beto, $m->id));
        Event::assertDispatched(ChatMessageSent::class, fn ($e) => $e->message['id'] === $id && $e->broadcastOn()[0] instanceof PrivateChannel);

        // Y uno del global sigue saliendo por el canal público.
        $gid = $this->say($ana, 'global feo')->json('message.id');
        $this->actingAs($mod)->postJson("/moderacion/mensajes/{$gid}/ocultar")->assertOk();
        Event::assertDispatched(ChatMessageHidden::class, fn ($e) => $e->id === $gid && ! ($e->broadcastOn()[0] instanceof PrivateChannel));
    }

    public function test_la_pagina_de_moderacion_indica_el_canal(): void
    {
        [$ana, $beto, $mod] = [$this->user('Ana'), $this->user('Beto'), $this->user('Mod')];
        $mod->forceFill(['role' => 'moderador'])->save();
        $m = $this->startedMatch([$ana, $beto]);
        $id = $this->say($ana, 'algo en la sala', $m->id)->json('message.id');
        $this->actingAs($beto)->postJson("/api/chat/{$id}/reportar", ['motivo' => 'spam'])->assertOk();

        $this->actingAs($mod)->get('/moderacion')->assertOk()->assertSee("Sala (partida #{$m->id})", false);
    }

    // ------------------------------------------------------------------------------------ canal en tiempo real

    public function test_autorizacion_del_canal_privado_de_la_sala(): void
    {
        [$ana, $beto, $intruso] = [$this->user('Ana'), $this->user('Beto'), $this->user('Intruso')];
        $m = $this->startedMatch([$ana, $beto]);
        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.key' => 'k', 'broadcasting.connections.reverb.secret' => 's', 'broadcasting.connections.reverb.app_id' => '1',
            'broadcasting.connections.reverb.options' => ['host' => '127.0.0.1', 'port' => 8080, 'scheme' => 'http', 'useTLS' => false],
        ]);
        app(\Illuminate\Broadcasting\BroadcastManager::class)->purge(); // el canal se registró en el emisor "null" del arranque: se vuelve a registrar en el nuevo
        require base_path('routes/channels.php');
        $auth = fn (?User $u, int $id) => ($u ? $this->actingAs($u) : $this)->postJson('/broadcasting/auth', ['socket_id' => '123.456', 'channel_name' => "private-partida.{$id}.chat"]);

        $auth($ana, $m->id)->assertOk()->assertJsonStructure(['auth']);
        $auth($intruso, $m->id)->assertForbidden();
        $this->app['auth']->forgetGuards();
        $auth(null, $m->id)->assertStatus(401);

        app(MatchService::class)->leave($beto, $m->id);
        $auth($beto, $m->id)->assertForbidden();   // abandonó: deja de recibir lo que pasa en vivo
    }

    // ------------------------------------------------------------------------------------ retención

    public function test_la_retencion_aplica_por_canal(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $other = $this->startedMatch([$this->user('Cami'), $this->user('Dani')]);
        $put = fn (?int $match, string $body, $when = null) => DB::table('chat_messages')->insert([
            'match_id' => $match, 'kind' => 'usuario', 'user_id' => $ana->id, 'client_key' => bin2hex(random_bytes(8)), 'body' => $body, 'created_at' => $when ?? now(),
        ]);
        DB::table('chat_messages')->delete();
        for ($i = 1; $i <= 6; $i++) {
            $put(null, "g{$i}");
        }
        for ($i = 1; $i <= 5; $i++) {
            $put($m->id, "s{$i}");
        }
        $put($other->id, 'otra');

        // Topes: global 4, cada sala 3. El global no toca las salas ni al revés.
        $this->assertSame(2 + 2, app(ChatService::class)->prune(7, maxRows: 4, roomMaxRows: 3));

        $this->assertSame(['g3', 'g4', 'g5', 'g6'], array_column($this->getJson('/api/chat/global')->json('messages'), 'body'));
        $this->assertSame(['s3', 's4', 's5'], $this->roomBodies($ana, $m->id));
        $this->assertSame(1, ChatMessage::where('match_id', $other->id)->count());
    }

    public function test_una_sala_terminada_se_conserva_hasta_la_retencion_y_despues_se_va(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $this->say($ana, 'gg', $m->id)->assertCreated();
        Carbon::setTestNow(now()->addMinutes(41));
        app(MatchService::class)->finish($m->id);

        Carbon::setTestNow(now()->addDays(6));
        $this->assertSame(0, app(ChatService::class)->prune(7));
        $this->assertContains('gg', $this->roomBodies($ana, $m->id));

        Carbon::setTestNow(now()->addDays(2));
        $this->assertGreaterThan(0, app(ChatService::class)->prune(7));
        $this->assertSame(0, ChatMessage::where('match_id', $m->id)->count());
    }

    public function test_los_avisos_de_sistema_no_se_duplican_con_la_misma_clave_de_evento(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $chat = app(ChatService::class);

        $this->assertNotNull($chat->system($m->id, 'Hola', 'prueba-1'));
        $this->assertNull($chat->system($m->id, 'Hola otra vez', 'prueba-1'));
        $this->assertNotNull($chat->system($m->id, 'Sin clave'));
        $this->assertNotNull($chat->system($m->id, 'Sin clave'));
        $this->assertNull($chat->system(999999, 'Sala que no existe')); // la clave foránea frena: no lanza
    }

    // ------------------------------------------------------------------------------------ migración

    public function test_la_migracion_se_puede_revertir_y_volver_a_aplicar_sin_filtrar_salas_al_global(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        $this->say($ana, 'global previo')->assertCreated();
        $this->say($ana, 'de la sala', $m->id)->assertCreated();

        // Solo esa migración (no "la última": se siguen agregando migraciones nuevas después).
        Artisan::call('migrate:rollback', ['--path' => 'database/migrations/2026_10_21_000001_add_rooms_to_chat_messages.php']);

        $this->assertFalse(Schema::hasColumn('chat_messages', 'match_id'));
        $this->assertFalse(Schema::hasColumn('chat_messages', 'kind'));
        $this->assertSame(['global previo'], DB::table('chat_messages')->pluck('body')->all()); // lo de las salas se fue, no pasó al global

        Artisan::call('migrate');
        $this->assertTrue(Schema::hasColumn('chat_messages', 'match_id'));
        $this->assertSame('usuario', DB::table('chat_messages')->value('kind'));
        $this->assertNull(DB::table('chat_messages')->value('match_id'));
    }
}
