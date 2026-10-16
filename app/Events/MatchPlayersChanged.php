<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Cambió la gente de una partida: alguien entró, salió (`action`: joined | left | abandoned) o cambió quien la creó.
 * Canal público `partida.{id}`. Solo lleva el apodo y la cantidad: nada de dinero.
 */
class MatchPlayersChanged implements ShouldBroadcast
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
        return 'MatchPlayersChanged';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['match_id' => $this->matchId] + $this->data;
    }
}
