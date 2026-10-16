<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Llegó un mensaje al chat.
 *  - Global (`match_id` null): canal público `chat` (como el mapa: cualquiera puede mirar, solo con sesión se escribe).
 *  - Sala: canal PRIVADO `partida.{id}.chat`; el navegador lo autoriza en /broadcasting/auth (ver routes/channels.php)
 *    y solo entran quienes juegan (o jugaron) esa partida.
 * Lleva la foto ya armada de ChatMessage::toPublic(): nada de correo ni de datos privados.
 */
class ChatMessageSent implements ShouldBroadcast
{
    use Dispatchable;

    /** @param array<string, mixed> $message */
    public function __construct(public array $message) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        $matchId = $this->message['match_id'] ?? null;

        return [$matchId === null ? new Channel('chat') : new PrivateChannel("partida.{$matchId}.chat")];
    }

    public function broadcastAs(): string
    {
        return 'ChatMessageSent';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->message;
    }
}
