<?php

namespace App\Console\Commands;

use App\Economy\AuctionService;
use App\Economy\OfferService;
use Illuminate\Console\Command;

class CloseAuctions extends Command
{
    protected $signature = 'subastas:cerrar';

    protected $description = 'Cierra las subastas, reservas y ofertas entre jugadores que ya vencieron (una pasada)';

    public function handle(AuctionService $auctions, OfferService $offers): int
    {
        $n = $auctions->settleDue();
        $this->info("Subastas cerradas: {$n}");
        $this->info('Ofertas cerradas: '.$offers->settleDue());

        return self::SUCCESS;
    }
}
