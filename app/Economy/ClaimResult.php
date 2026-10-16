<?php

namespace App\Economy;

use App\Models\Auction;

/**
 * Resultado de pedir una propiedad:
 *  - comprada: compra directa inmediata (sin ventana de disputa).
 *  - reclamada: quedó reservada para vos; si nadie la disputa en la ventana, es tuya.
 *  - disputada: ya estaba reservada por otro y la disputaste: se abrió la subasta.
 *  - en_curso: ya ibas ganando esa propiedad (repetición del mismo pedido).
 */
final class ClaimResult
{
    public function __construct(
        public readonly string $result,
        public readonly int $propertyId,
        public readonly int $price,
        public readonly int $balance,
        public readonly ?Auction $auction = null,
        public readonly bool $replayed = false,
    ) {}
}
