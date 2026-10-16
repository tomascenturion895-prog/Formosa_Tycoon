<?php

namespace App\Enums;

/**
 * Ciclo de vida de una oferta entre jugadores (solo hacia adelante):
 *   abierta   -> el dueño la publicó; se puede ofertar hasta `ends_at` y el dueño puede aceptar hasta `decide_until`.
 *   vendida   -> el dueño aceptó la mejor oferta (o alguien pagó el "comprá ya") y la propiedad cambió de dueño.
 *   cerrada   -> terminó sin venta: nadie ofertó, o el dueño no aceptó a tiempo.
 *   cancelada -> la retiró el dueño, o se anuló porque alguien dejó la partida o terminó la partida.
 */
enum OfferStatus: string
{
    case Abierta = 'abierta';
    case Vendida = 'vendida';
    case Cerrada = 'cerrada';
    case Cancelada = 'cancelada';

    public function isActive(): bool
    {
        return $this === self::Abierta;
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
