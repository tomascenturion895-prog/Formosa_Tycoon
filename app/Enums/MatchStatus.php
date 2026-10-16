<?php

namespace App\Enums;

/**
 * Ciclo de vida de una partida (solo hacia adelante):
 *   lobby    -> sala abierta, se pueden unir y salir. El creador la inicia.
 *   running  -> en juego durante `duration_minutes`.
 *   finished -> terminó: hay puestos, patrimonio y puntos.
 *   expired  -> la sala no se inició a tiempo (o quedó vacía); no cuenta para nadie.
 */
enum MatchStatus: string
{
    case Lobby = 'lobby';
    case Running = 'running';
    case Finished = 'finished';
    case Expired = 'expired';

    /** Una partida "activa" es la que ocupa al jugador: en la sala o jugando. */
    public function isActive(): bool
    {
        return $this === self::Lobby || $this === self::Running;
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
