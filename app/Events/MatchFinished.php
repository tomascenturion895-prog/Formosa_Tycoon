<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * La partida terminó: los puestos y puntos se piden a GET /api/partidas/{id}/resultado.
 * Canal público `partida.{id}`.
 */
class MatchFinished implements ShouldBroadcast
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
        return 'MatchFinished';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['match_id' => $this->matchId] + $this->data;
    }
}
