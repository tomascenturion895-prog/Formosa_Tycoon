<?php

namespace App\Events;

use App\Models\Offer;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Una oferta entre jugadores cambió (se abrió, hubo una oferta nueva, se vendió, se cerró o se retiró). Canal público `partida.{id}`.
 * Lleva solo datos públicos (ver Offer::toPublic): nada de saldos ni de reservas de nadie.
 */
class OfferUpdated implements ShouldBroadcast
{
    use Dispatchable;

    /** @param array<string, mixed> $offer */
    public function __construct(public array $offer) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('partida.'.($this->offer['match_id'] ?? 0))];
    }

    public function broadcastAs(): string
    {
        return 'OfferUpdated';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->offer;
    }

    public static function from(Offer $offer): self
    {
        return new self($offer->fresh()->toPublic());
    }
}
