<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Un mensaje se ocultó: los navegadores lo sacan de la pantalla. Lleva solo el número y el canal (nada del motivo ni de quién).
 * Sale por el mismo canal que el mensaje: público `chat` (global) o privado `partida.{id}.chat` (sala).
 */
class ChatMessageHidden implements ShouldBroadcast
{
    use Dispatchable;

    public function __construct(public int $id, public ?int $matchId = null) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [$this->matchId === null ? new Channel('chat') : new PrivateChannel("partida.{$this->matchId}.chat")];
    }

    public function broadcastAs(): string
    {
        return 'ChatMessageHidden';
    }

    /** @return array<string, int|null> */
    public function broadcastWith(): array
    {
        return ['id' => $this->id, 'match_id' => $this->matchId];
    }
}
