<?php

namespace Tests\Feature;

use App\Economy\MatchService;
use App\Economy\VoiceService;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Voz de la sala: quién puede entrar al canal de presencia, qué se ofrece al navegador y que el servidor deje usar el micrófono. */
class VoiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
    }

    private function user(string $name): User
    {
        return User::factory()->create(['name' => $name]);
    }

    public function test_entra_a_la_voz_quien_sigue_en_la_sala(): void
    {
        [$ana, $beto, $intruso] = [$this->user('Ana'), $this->user('Beto'), $this->user('Intruso')];
        $m = $this->startedMatch([$ana, $beto]);
        $voz = app(VoiceService::class);

        $this->assertTrue($voz->canJoin($ana->id, $m->id));
        $this->assertSame(['id' => $beto->id, 'name' => 'Beto'], $voz->presence($beto, $m->id));
        $this->assertFalse($voz->canJoin($intruso->id, $m->id), 'quien no juega esa partida no escucha ni habla');
        $this->assertFalse($voz->presence($intruso, $m->id));
        $this->assertFalse($voz->canJoin($ana->id, 99999), 'una sala que no existe');

        app(MatchService::class)->leave($beto, $m->id);
        $this->assertFalse($voz->canJoin($beto->id, $m->id), 'quien abandonó se queda sin voz');
        $this->assertTrue($voz->canJoin($ana->id, $m->id));
    }

    public function test_la_voz_se_cierra_al_apagarla(): void
    {
        [$ana, $beto] = [$this->user('Ana'), $this->user('Beto')];
        $m = $this->startedMatch([$ana, $beto]);
        config(['formosa.voice.enabled' => false]);

        $this->assertFalse(app(VoiceService::class)->canJoin($ana->id, $m->id));
        $this->assertFalse(app(VoiceService::class)->clientConfig()['enabled']);
    }

    public function test_servidores_de_red_con_y_sin_turn(): void
    {
        config(['formosa.voice.stun' => ['stun:a.example:3478'], 'formosa.voice.turn_url' => null]);
        $this->assertSame([['urls' => ['stun:a.example:3478']]], app(VoiceService::class)->iceServers());

        config(['formosa.voice.turn_url' => 'turn:t.example:3478, turns:t.example:443', 'formosa.voice.turn_user' => 'u', 'formosa.voice.turn_pass' => 'p']);
        $ice = app(VoiceService::class)->iceServers();
        $this->assertCount(2, $ice);
        $this->assertSame(['turn:t.example:3478', 'turns:t.example:443'], $ice[1]['urls']);
        $this->assertSame(['u', 'p'], [$ice[1]['username'], $ice[1]['credential']]);
    }

    public function test_el_mapa_entrega_la_configuracion_de_voz_y_el_servidor_permite_el_microfono(): void
    {
        config(['broadcasting.default' => 'reverb']);
        $res = $this->get('/partida/ABC123');
        $res->assertOk();
        $this->assertStringContainsString('microphone=(self)', $res->headers->get('Permissions-Policy'));
        $conf = app(VoiceService::class)->clientConfig();
        $this->assertTrue($conf['enabled']);
        $this->assertSame(7, $conf['maxPeers']);
    }

    public function test_autorizacion_del_canal_de_presencia(): void
    {
        [$ana, $beto, $intruso] = [$this->user('Ana'), $this->user('Beto'), $this->user('Intruso')];
        $m = $this->startedMatch([$ana, $beto]);
        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.key' => 'k', 'broadcasting.connections.reverb.secret' => 's', 'broadcasting.connections.reverb.app_id' => '1',
            'broadcasting.connections.reverb.options' => ['host' => '127.0.0.1', 'port' => 8080, 'scheme' => 'http', 'useTLS' => false],
        ]);
        app(\Illuminate\Broadcasting\BroadcastManager::class)->purge();
        require base_path('routes/channels.php');
        $auth = fn (?User $u, int $id) => ($u ? $this->actingAs($u) : $this)->postJson('/broadcasting/auth', ['socket_id' => '123.456', 'channel_name' => "presence-partida.{$id}.voz"]);

        $auth($ana, $m->id)->assertOk()->assertJsonStructure(['auth', 'channel_data']);
        $auth($intruso, $m->id)->assertForbidden();
        $this->app['auth']->forgetGuards();
        $auth(null, $m->id)->assertStatus(401);
    }
}
