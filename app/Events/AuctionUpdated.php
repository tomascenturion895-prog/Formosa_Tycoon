<?php

namespace App\Events;

use App\Models\Auction;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Una subasta cambió (se abrió, hubo una puja, se extendió o terminó). Canal público `partida.{id}` (el de su partida).
 * Lleva solo datos públicos (ver Auction::toPublic): nada de saldos ni de reservas de nadie.
 * Se guarda la foto ya armada (no el modelo) para que lo que se emite sea exactamente lo que se confirmó.
 */
class AuctionUpdated implements ShouldBroadcast
{
    use Dispatchable;

    /** @param array<string, mixed> $auction */
    public function __construct(public array $auction) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('partida.'.($this->auction['match_id'] ?? 0))];
    }

    public function broadcastAs(): string
    {
        return 'AuctionUpdated';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->auction;
    }

    public static function from(Auction $auction): self
    {
        return new self($auction->fresh()->toPublic());
    }
}
