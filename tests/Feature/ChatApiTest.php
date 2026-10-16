<?php

namespace Tests\Feature;

use App\Economy\ChatService;
use App\Events\ChatMessageSent;
use App\Models\ChatMessage;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use LogicException;
use RuntimeException;
use Tests\TestCase;

class ChatApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        Storage::fake('local');
        Carbon::setTestNow('2026-10-16 10:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function say(User $u, string $text, ?string $key = null)
    {
        return $this->actingAs($u)->postJson('/api/chat', ['mensaje' => $text, 'clave' => $key ?? bin2hex(random_bytes(8))]);
    }

    public function test_enviar_guarda_y_avisa_solo_datos_publicos(): void
    {
        Event::fake([ChatMessageSent::class]);
        $ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana@example.com']);

        $res = $this->say($ana, 'Hola Formosa')->assertCreated();

        $res->assertJsonPath('message.user', 'Ana')->assertJsonPath('message.body', 'Hola Formosa')->assertJsonPath('replayed', false);
        $this->assertSame(1, ChatMessage::count());
        Event::assertDispatched(ChatMessageSent::class, function ($e) {
            return $e->message['user'] === 'Ana' && $e->message['body'] === 'Hola Formosa'
                && ! str_contains(json_encode($e->message), 'ana@example.com') && ! array_key_exists('client_key', $e->message);
        });
    }

    public function test_el_autor_sale_de_la_sesion_no_del_pedido(): void
    {
        $ana = User::factory()->create(['name' => 'Ana']);
        $beto = User::factory()->create(['name' => 'Beto']);

        $this->actingAs($ana)->postJson('/api/chat', ['mensaje' => 'soy Beto', 'clave' => 'clave-12345', 'user_id' => $beto->id, 'user' => 'Beto'])->assertCreated();

        $this->assertSame($ana->id, ChatMessage::firstOrFail()->user_id);
    }

    public function test_enviar_exige_sesion(): void
    {
        $this->postJson('/api/chat', ['mensaje' => 'hola', 'clave' => 'clave-12345'])->assertUnauthorized();
        $this->assertSame(0, ChatMessage::count());
    }

    public function test_mensajes_vacios_o_invisibles_se_rechazan(): void
    {
        $ana = User::factory()->create();

        $this->say($ana, "   \n ")->assertStatus(422); // lo frena la validación (TrimStrings lo deja vacío)
        $this->say($ana, "\u{2060}\u{202E}\u{2060}")->assertStatus(422)->assertJsonPath('error', 'mensaje_vacio');
        $this->assertSame(0, ChatMessage::count());
    }

    public function test_el_largo_se_cuenta_en_caracteres_ya_limpios(): void
    {
        $ana = User::factory()->create();

        $this->say($ana, str_repeat('ñ', 280))->assertCreated();
        $this->say($ana, str_repeat('ñ', 281))->assertStatus(422)->assertJsonPath('error', 'mensaje_largo')->assertJsonPath('maximo', 280);
        $this->say($ana, str_repeat('a', 2001))->assertStatus(422);
        $this->assertSame(1, ChatMessage::count());
    }

    public function test_los_campos_se_validan(): void
    {
        $ana = User::factory()->create();

        foreach ([[], ['mensaje' => 'hola'], ['clave' => 'clave-12345'], ['mensaje' => ['a'], 'clave' => 'clave-12345'], ['mensaje' => 'hola', 'clave' => 'corta'],
            ['mensaje' => 'hola', 'clave' => 'tiene espacios y <b>'], ['mensaje' => 'hola', 'clave' => str_repeat('a', 65)]] as $body) {
            $this->actingAs($ana)->postJson('/api/chat', $body)->assertStatus(422);
        }
        $this->assertSame(0, ChatMessage::count());
    }

    public function test_reintentar_el_mismo_envio_no_duplica_ni_vuelve_a_avisar(): void
    {
        Event::fake([ChatMessageSent::class]);
        $ana = User::factory()->create(['name' => 'Ana']);

        $first = $this->say($ana, 'hola', 'misma-clave-1')->assertCreated();
        $again = $this->say($ana, 'hola', 'misma-clave-1')->assertOk()->assertJsonPath('replayed', true);

        $this->assertSame($first->json('message.id'), $again->json('message.id'));
        $this->assertSame(1, ChatMessage::count());
        Event::assertDispatchedTimes(ChatMessageSent::class, 1);
    }

    public function test_la_misma_clave_con_otro_texto_no_es_un_reintento(): void
    {
        $ana = User::factory()->create();
        $this->say($ana, 'hola', 'misma-clave-1')->assertCreated();

        $this->say($ana, 'chau', 'misma-clave-1')->assertStatus(409)->assertJsonPath('error', 'clave_reutilizada');
        $this->assertSame(1, ChatMessage::count());
    }

    public function test_la_clave_es_por_jugador(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();

        $this->say($ana, 'hola', 'misma-clave-1')->assertCreated();
        $this->say($beto, 'otra cosa', 'misma-clave-1')->assertCreated();

        $this->assertSame(2, ChatMessage::count());
    }

    public function test_la_base_impide_dos_filas_con_la_misma_clave(): void
    {
        $ana = User::factory()->create();
        $row = ['user_id' => $ana->id, 'client_key' => 'clave-12345', 'body' => 'x'];
        ChatMessage::forceCreate($row);

        $this->expectException(UniqueConstraintViolationException::class);
        ChatMessage::forceCreate($row);
    }

    public function test_el_mismo_texto_repetido_se_frena_un_rato(): void
    {
        $ana = User::factory()->create();
        $beto = User::factory()->create();
        $this->say($ana, 'oferta oferta')->assertCreated();

        $this->say($ana, 'oferta oferta')->assertStatus(429)->assertJsonPath('error', 'mensaje_repetido');
        $this->say($ana, '  oferta   oferta ')->assertStatus(429); // limpiado, es lo mismo
        $this->say($beto, 'oferta oferta')->assertCreated();         // otro jugador sí puede
        Carbon::setTestNow('2026-10-16 10:00:31');
        $this->say($ana, 'oferta oferta')->assertCreated();
        $this->assertSame(3, ChatMessage::count());
    }

    public function test_si_el_tiempo_real_falla_el_mensaje_queda_guardado(): void
    {
        $ana = User::factory()->create();
        Event::listen(ChatMessageSent::class, fn () => throw new RuntimeException('Reverb caído'));

        $this->say($ana, 'hola igual')->assertCreated();

        $this->assertSame(1, ChatMessage::count());
    }

    public function test_el_html_se_guarda_como_texto_y_viaja_escapado_en_json(): void
    {
        $ana = User::factory()->create();

        $res = $this->say($ana, '<img src=x onerror=alert(1)>')->assertCreated();

        $res->assertJsonPath('message.body', '<img src=x onerror=alert(1)>');
        $this->assertStringContainsString('application/json', $res->headers->get('Content-Type'));
    }

    public function test_leer_es_publico_sin_cookies_ni_datos_privados(): void
    {
        $ana = User::factory()->create(['name' => 'Ana', 'email' => 'ana@example.com']);
        $this->say($ana, 'uno');
        $this->say($ana, 'dos');
        auth()->logout();

        $res = $this->getJson('/api/chat')->assertOk();

        $this->assertSame(['uno', 'dos'], array_column($res->json('messages'), 'body'));
        $this->assertSame('Ana', $res->json('messages.0.user'));
        $this->assertSame(280, $res->json('max_length'));
        $this->assertStringNotContainsString('ana@example.com', $res->getContent());
        $this->assertStringNotContainsString('client_key', $res->getContent());
        $this->assertEmpty($res->headers->getCookies());
        $this->assertStringContainsString('no-store', $res->headers->get('Cache-Control'));
    }

    public function test_sin_despues_trae_los_ultimos_en_orden(): void
    {
        $ana = User::factory()->create();
        for ($i = 1; $i <= 60; $i++) {
            ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => "clave-{$i}0000", 'body' => "m{$i}"]);
        }

        $bodies = array_column($this->getJson('/api/chat')->assertOk()->json('messages'), 'body');

        $this->assertCount(50, $bodies);
        $this->assertSame('m11', $bodies[0]);
        $this->assertSame('m60', $bodies[49]);
    }

    public function test_con_despues_trae_solo_lo_nuevo_con_tope(): void
    {
        $ana = User::factory()->create();
        for ($i = 1; $i <= 130; $i++) {
            ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => "clave-{$i}0000", 'body' => "m{$i}"]);
        }
        $firstId = ChatMessage::where('body', 'm10')->value('id');

        $page = $this->getJson("/api/chat?despues={$firstId}")->assertOk()->json('messages');

        $this->assertCount(100, $page);
        $this->assertSame('m11', $page[0]['body']);
        $this->assertSame('m110', $page[99]['body']);
        $this->getJson('/api/chat?despues=999999')->assertOk()->assertJsonCount(0, 'messages');
    }

    public function test_el_parametro_despues_se_valida(): void
    {
        foreach (['abc', '-1', '1.5', '99999999999999999999'] as $v) {
            $this->getJson("/api/chat?despues={$v}")->assertStatus(422);
        }
    }

    public function test_escribir_tiene_limite_por_jugador_y_no_gasta_el_cupo_del_juego(): void
    {
        $ana = User::factory()->create();
        $status = [];
        for ($i = 0; $i < 12; $i++) {
            $status[] = $this->say($ana, "mensaje {$i}")->status();
        }

        $this->assertCount(10, array_filter($status, fn ($c) => $c === 201));
        $this->assertContains(429, $status);
        $this->actingAs($ana)->getJson('/api/yo')->assertOk(); // el cupo de "jugar" sigue intacto
    }

    public function test_la_lectura_no_gasta_el_cupo_de_lectura_del_mapa(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->getJson('/api/chat')->assertOk();
        }
        // Es la primera lectura del mapa en su propio cupo (60/min): quedan 59.
        $this->assertSame('59', $this->getJson('/api/partidas')->assertOk()->headers->get('X-RateLimit-Remaining'));
    }

    public function test_limpiar_borra_lo_viejo_y_conserva_lo_reciente(): void
    {
        $ana = User::factory()->create();
        $old = ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'clave-old01', 'body' => 'viejo']);
        DB::table('chat_messages')->where('id', $old->id)->update(['created_at' => now()->subDays(8)]);
        ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'clave-new01', 'body' => 'nuevo']);

        $this->artisan('chat:limpiar')->expectsOutput('Mensajes borrados: 1')->assertSuccessful();

        $this->assertSame(['nuevo'], ChatMessage::pluck('body')->all());
    }

    public function test_limpiar_borra_por_tandas(): void
    {
        $ana = User::factory()->create();
        $rows = [];
        for ($i = 0; $i < 25; $i++) {
            $rows[] = ['user_id' => $ana->id, 'client_key' => "clave-{$i}0000", 'body' => "m{$i}", 'created_at' => now()->subDays(30)];
        }
        DB::table('chat_messages')->insert($rows);

        $this->assertSame(25, app(ChatService::class)->prune(7, batch: 10));
        $this->assertSame(0, ChatMessage::count());
    }

    public function test_los_mensajes_no_se_editan_ni_se_borran_desde_el_modelo(): void
    {
        $ana = User::factory()->create();
        $m = ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'clave-12345', 'body' => 'x']);

        try {
            $m->forceFill(['body' => 'y'])->save();
            $this->fail('Debió fallar');
        } catch (LogicException) {
        }
        $this->expectException(LogicException::class);
        $m->delete();
    }

    public function test_el_mapa_informa_el_largo_maximo_del_chat(): void
    {
        $this->get('/mapa')->assertOk()->assertViewHas('config', fn ($c) => $c['chat']['max'] === 280);
    }

    public function test_crear_cuentas_no_multiplica_el_cupo_de_una_misma_ip(): void
    {
        $status = [];
        for ($u = 0; $u < 8; $u++) {
            $user = User::factory()->create();
            for ($i = 0; $i < 9; $i++) { // 72 envíos en total, todos de la misma IP: 9 por cuenta, bajo el límite de cada una
                $status[] = $this->say($user, "u{$u} m{$i}")->status();
            }
        }

        $this->assertCount(60, array_filter($status, fn ($c) => $c === 201));
        $this->assertCount(12, array_filter($status, fn ($c) => $c === 429));
    }

    public function test_en_ipv6_el_limite_es_por_red_64(): void
    {
        $key = fn (string $ip) => \App\Providers\AppServiceProvider::ipKey(\Illuminate\Http\Request::create('/', 'GET', server: ['REMOTE_ADDR' => $ip]));

        $this->assertSame($key('2001:db8:1:2:aaaa::1'), $key('2001:db8:1:2:bbbb::ffff'));
        $this->assertNotSame($key('2001:db8:1:2::1'), $key('2001:db8:1:3::1'));
        $this->assertSame('203.0.113.9', $key('203.0.113.9'));
    }

    public function test_limpiar_deja_como_mucho_las_ultimas_filas(): void
    {
        $ana = User::factory()->create();
        for ($i = 1; $i <= 12; $i++) {
            ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => "clave-{$i}0000", 'body' => "m{$i}"]);
        }

        $this->assertSame(7, app(ChatService::class)->prune(7, batch: 3, maxRows: 5));

        $this->assertSame(['m8', 'm9', 'm10', 'm11', 'm12'], ChatMessage::orderBy('id')->pluck('body')->all());
    }

    public function test_limpiar_no_borra_si_hay_menos_filas_que_el_tope(): void
    {
        $ana = User::factory()->create();
        ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'clave-12345', 'body' => 'x']);

        $this->assertSame(0, app(ChatService::class)->prune(7, maxRows: 5));
    }

    public function test_limpiar_rechaza_dias_invalidos_sin_borrar_nada(): void
    {
        $ana = User::factory()->create();
        $old = ChatMessage::forceCreate(['user_id' => $ana->id, 'client_key' => 'clave-12345', 'body' => 'x']);
        DB::table('chat_messages')->where('id', $old->id)->update(['created_at' => now()->subDays(3)]);

        foreach (['abc', '0', '-2', '1.5'] as $v) {
            $this->artisan('chat:limpiar', ['--dias' => $v])->assertFailed();
        }
        $this->assertSame(1, ChatMessage::count());
    }
}
