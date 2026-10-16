<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * Una propiedad cambió de dueño EN UNA PARTIDA. Va al canal público `partida.{id}` (solo los mapas de esa partida lo escuchan).
 * Solo lleva datos que ya son públicos en /api/partidas/{id}/propiedades/estado: id, id del dueño y su apodo.
 */
class PropertyOwnerChanged implements ShouldBroadcast
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public int $matchId,
        public int $propertyId,
        public ?int $ownerId,
        public ?string $ownerName,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel("partida.{$this->matchId}")];
    }

    // En el navegador se escucha como ".PropertyOwnerChanged" (el punto evita el prefijo App\Events).
    public function broadcastAs(): string
    {
        return 'PropertyOwnerChanged';
    }

    /** @return array{match_id: int, id: int, owner_id: int|null, owner: string|null} */
    public function broadcastWith(): array
    {
        return ['match_id' => $this->matchId, 'id' => $this->propertyId, 'owner_id' => $this->ownerId, 'owner' => $this->ownerName];
    }
}
