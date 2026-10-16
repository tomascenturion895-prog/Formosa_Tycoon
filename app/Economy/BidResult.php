<?php

namespace App\Economy;

use App\Models\Auction;

final class BidResult
{
    public function __construct(
        public readonly Auction $auction,
        public readonly int $balance,
        public readonly int $reserved,
        public readonly bool $replayed = false,
    ) {}
}
