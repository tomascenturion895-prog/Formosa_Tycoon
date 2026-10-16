<?php

namespace App\Economy;

final readonly class CollectResult
{
    public function __construct(
        public int $collected,
        public int $balance,
        public int $properties,
    ) {}
}
