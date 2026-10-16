<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * La partida empezó. Lleva `started_at`, `ends_at` y `server_now` (ms) para que el navegador arme el reloj de juego.
 * Canal público `partida.{id}`.
 */
class MatchStarted implements ShouldBroadcast
{
    use Dispatchable;

    /** @param array<string, mixed> $data */
    public function __construct(public int $matchId, public array $data) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel("partida.{$this->matchId}")];
    }

    public function broadcastAs(): string
    {
        return 'MatchStarted';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['match_id' => $this->matchId] + $this->data;
    }
}
