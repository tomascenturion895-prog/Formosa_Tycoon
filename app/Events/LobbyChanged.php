<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * El listado de salas abiertas cambió: una sala nueva, con más o menos gente, o que dejó de estar abierta (empezó o venció).
 * Canal público `lobby`. `match` es la foto pública de la sala (ver GameMatch::toPublic); `open` dice si sigue en el listado.
 */
class LobbyChanged implements ShouldBroadcast
{
    use Dispatchable;

    /** @param array<string, mixed> $match */
    public function __construct(public array $match, public bool $open) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('lobby')];
    }

    public function broadcastAs(): string
    {
        return 'LobbyChanged';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['open' => $this->open, 'match' => $this->match];
    }
}
