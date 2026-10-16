<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Algo que pasó en una partida y que los demás jugadores quieren ver pasar: compra, venta, reclamo, disputa o subasta ganada.
 * Va al canal público `partida.{id}` (el mismo de PropertyOwnerChanged y AuctionUpdated) y SOLO lleva lo que ese canal ya hace
 * público: apodo, propiedad, rubro y monto de la operación. Nada de saldos, reservas, correos ni IP.
 * No se guarda: es un aviso efímero (el historial queda en los avisos del chat de la sala).
 */
class ActivityFeed implements ShouldBroadcast
{
    use Dispatchable;

    /** Tipos que existen. El navegador ignora los que no conoce, así que se pueden sumar sin romper nada. */
    public const TYPES = ['compra', 'subasta_ganada', 'venta', 'reclamo', 'disputa', 'oferta_abierta', 'oferta_vendida'];

    /** @param array<string, mixed> $item match_id, key, type, actor_id, actor, other (la otra parte, si la hay), property_id, kind, label, amount, at */
    public function __construct(public array $item) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('partida.'.($this->item['match_id'] ?? 0))];
    }

    public function broadcastAs(): string
    {
        return 'ActivityFeed';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return $this->item;
    }
}
