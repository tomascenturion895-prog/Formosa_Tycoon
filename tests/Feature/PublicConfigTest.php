<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\PublicConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PublicConfigTest extends TestCase
{
    use RefreshDatabase;

    public function test_for_game_trae_el_mapa_y_la_partida(): void
    {
        $c = PublicConfig::forGame(null);

        foreach (['center', 'zoom', 'kinds', 'static', 'clock', 'data', 'user', 'match', 'economy', 'auction', 'combos', 'events', 'voice', 'chat', 'urls', 'reverb'] as $key) {
            $this->assertArrayHasKey($key, $c, "falta la clave {$key}");
        }
        $this->assertNull($c['user']);
    }

    public function test_for_lobby_no_trae_datos_del_mapa(): void
    {
        $c = PublicConfig::forLobby(null);

        foreach (['static', 'center', 'zoom', 'data'] as $key) {
            $this->assertArrayNotHasKey($key, $c, "{$key} no corresponde al lobby");
        }
        foreach (['match', 'economy', 'auction', 'combos', 'events', 'voice', 'chat', 'kinds', 'bank', 'offers', 'sprint', 'upgrades', 'user', 'urls', 'reverb', 'clock'] as $key) {
            $this->assertArrayHasKey($key, $c, "falta la clave {$key}");
        }
    }

    public function test_bank_offers_y_sprint_reflejan_la_configuracion(): void
    {
        config(['formosa.bank.rate_pct' => 4, 'formosa.offers.fee_pct' => 7, 'formosa.sprint.seconds' => 240]);

        foreach ([PublicConfig::forGame(null), PublicConfig::forLobby(null)] as $c) {
            $this->assertSame(4, $c['bank']['ratePct']);
            $this->assertSame([5, 10, 20], $c['bank']['terms']);
            $this->assertSame(config('formosa.bank.max_loans'), $c['bank']['maxLoans']);
            $this->assertSame(7, $c['offers']['feePct']);
            $this->assertSame(240, $c['sprint']['seconds']);
            $this->assertSame(10, $c['sprint']['comebackPct']);
            $this->assertIsBool($c['sprint']['enabled']);
            $this->assertIsBool($c['sprint']['blockLoans']);
        }
    }

    public function test_la_sala_sin_iniciar_vence_segun_la_configuracion(): void
    {
        config(['formosa.match.lobby_ttl_minutes' => 9]);

        $this->assertSame(9, PublicConfig::forLobby(null)['match']['lobbyTtlMinutes']);
    }

    public function test_user_nunca_incluye_el_correo(): void
    {
        $user = User::factory()->create(['email' => 'secreto@example.com']);

        foreach ([PublicConfig::forGame($user), PublicConfig::forLobby($user)] as $c) {
            $this->assertSame($user->id, $c['user']['id']);
            $this->assertArrayNotHasKey('email', $c['user']);
            $this->assertStringNotContainsString('secreto@example.com', json_encode($c));
        }
    }

    public function test_la_configuracion_publica_trae_las_mejoras(): void
    {
        config(['formosa.upgrades.levels.1.cost_pct' => 0.6, 'formosa.upgrades.discount' => 0.25]);
        $u = PublicConfig::forLobby(null)['upgrades'];

        $this->assertSame(25, $u['discountPct']);
        $this->assertSame(50, $u['netWorthPct']);
        $this->assertEqualsCanonicalizing(['casa', 'comercio', 'supermercado', 'hotel'], array_keys($u['kinds']));
        $casa = $u['kinds']['casa'];
        $this->assertSame([1, null, 'Reformada', 60, 40, 5], array_values(array_intersect_key($casa['levels'][0], array_flip(['level', 'branch', 'label', 'costPct', 'boostPct', 'maintPct']))));
        $this->assertSame(['a', 'b'], [$casa['levels'][1]['branch'], $casa['levels'][2]['branch']]);
        $this->assertSame('Edificio de departamentos', $casa['levels'][2]['label']);
        $this->assertSame('Cuenta como 2 propiedades para el combo de zona.', $casa['branchBEffect']);
    }
}
