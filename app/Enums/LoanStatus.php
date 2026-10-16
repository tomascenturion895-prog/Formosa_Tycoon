<?php

namespace App\Enums;

/**
 * Ciclo de vida de un préstamo (solo hacia adelante):
 *   abierto   -> el banco lo desembolsó y cobra una cuota por cada día de juego.
 *   pagado    -> se devolvió todo (capital y lo atrasado).
 *   cancelado -> el jugador abandonó la partida: ya no se cobra nada.
 */
enum LoanStatus: string
{
    case Abierto = 'abierto';
    case Pagado = 'pagado';
    case Cancelado = 'cancelado';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
