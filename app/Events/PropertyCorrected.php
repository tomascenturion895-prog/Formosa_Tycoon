<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Un moderador corrigió el rubro o el nombre de una propiedad. Canal público `map`.
 * Lleva solo lo que ya es público en /api/propiedades: rubro, nombre, precio e ingreso; más la versión del catálogo.
 */
class PropertyCorrected implements ShouldBroadcast
{
    use Dispatchable;

    public function __construct(
        public int $propertyId,
        public string $kind,
        public ?string $name,
        public int $price,
        public int $income,
        public int $catalog,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('map')];
    }

    public function broadcastAs(): string
    {
        return 'PropertyCorrected';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['id' => $this->propertyId, 'kind' => $this->kind, 'name' => $this->name, 'price' => $this->price, 'income' => $this->income, 'catalog' => $this->catalog];
    }
}
