<?php

namespace App\Economy;

use App\Enums\MatchStatus;
use App\Models\GameMatch;
use App\Models\MatchPlayer;
use App\Models\User;

/**
 * Chat de voz de la sala. El audio viaja directo entre los navegadores (WebRTC); el servidor solo decide QUIÉN puede entrar al canal
 * de presencia donde se arreglan las conexiones, y qué servidores de red (STUN/TURN) se les ofrece.
 *
 * Entra a la voz quien sigue en la sala (no quien salió o abandonó) mientras la partida está en espera o en juego: terminada
 * la partida, la voz se cierra. Nunca se guarda audio ni nada de lo que se dice.
 */
class VoiceService
{
    public function enabled(): bool
    {
        return (bool) config('formosa.voice.enabled');
    }

    /** ¿Puede este jugador entrar a la voz de esa sala? */
    public function canJoin(int $userId, int $matchId): bool
    {
        if (! $this->enabled()) {
            return false;
        }
        $status = GameMatch::query()->whereKey($matchId)->value('status');
        if ($status === null) {
            return false;
        }
        $value = $status instanceof MatchStatus ? $status->value : $status;
        if (! in_array($value, [MatchStatus::Lobby->value, MatchStatus::Running->value], true)) {
            return false;
        }

        return MatchPlayer::query()->where('match_id', $matchId)->where('user_id', $userId)->whereNull('left_at')->exists();
    }

    /**
     * Lo que ven los demás de mí en el canal de presencia: solo el número y el nombre (lo mismo que ya muestra el chat de la sala).
     *
     * @return array{id:int,name:string}|false
     */
    public function presence(User $user, int $matchId): array|false
    {
        return $this->canJoin((int) $user->id, $matchId) ? ['id' => (int) $user->id, 'name' => (string) $user->name] : false;
    }

    /** Servidores de red para armar la conexión. TURN solo si está configurado. */
    public function iceServers(): array
    {
        $servers = [];
        $stun = array_values(array_filter((array) config('formosa.voice.stun')));
        if ($stun !== []) {
            $servers[] = ['urls' => $stun];
        }
        $turn = config('formosa.voice.turn_url');
        if ($turn) {
            $servers[] = ['urls' => array_values(array_filter(array_map('trim', explode(',', (string) $turn)))), 'username' => (string) config('formosa.voice.turn_user'), 'credential' => (string) config('formosa.voice.turn_pass')];
        }

        return $servers;
    }

    /** Lo que recibe el navegador (los datos de TURN, si hay, son del servidor de la partida: se comparten con los jugadores). */
    public function clientConfig(): array
    {
        return [
            'enabled' => $this->enabled() && config('broadcasting.default') === 'reverb',
            'maxPeers' => (int) config('formosa.match.max_capacity') - 1,
            'iceServers' => $this->iceServers(),
        ];
    }
}
