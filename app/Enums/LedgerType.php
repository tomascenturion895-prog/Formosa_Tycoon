<?php

namespace App\Enums;

/** Tipos de movimiento del libro. La Fase 3 agrega los de subasta. */
enum LedgerType: string
{
    case Alta = 'alta';      // dinero inicial al abrir la billetera
    case Compra = 'compra';  // compra directa de una propiedad
    case Cobro = 'cobro';    // ingresos de las propiedades cobrados
    case Venta = 'venta';    // venta de una propiedad al banco
    case Prestamo = 'prestamo'; // el banco desembolsa un préstamo
    case Cuota = 'cuota';       // cuota o pago de un préstamo al banco
    case Mejora = 'mejora';     // el jugador paga una mejora de una propiedad

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
