<?php

namespace App\Economy;

final readonly class PurchaseResult
{
    public function __construct(
        public int $propertyId,
        public int $price,
        public int $balance,
        /** true si era un reintento de una compra ya hecha (misma clave de idempotencia). */
        public bool $replayed = false,
    ) {}
}
