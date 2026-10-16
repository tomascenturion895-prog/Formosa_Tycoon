<?php

namespace App\Enums;

/**
 * Ciclo de vida de una subasta (solo hacia adelante):
 *   disputa  -> alguien reclamó la propiedad y corre la ventana; si nadie la disputa, se vende al precio de lista.
 *   abierta  -> otro jugador la disputó: hay pujas y un tiempo límite.
 *   cerrada  -> terminó y la propiedad tiene dueño.
 *   cancelada -> terminó sin poder cobrarse (no debería pasar: los fondos están reservados).
 */
enum AuctionStatus: string
{
    case Disputa = 'disputa';
    case Abierta = 'abierta';
    case Cerrada = 'cerrada';
    case Cancelada = 'cancelada';

    public function isActive(): bool
    {
        return $this === self::Disputa || $this === self::Abierta;
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
