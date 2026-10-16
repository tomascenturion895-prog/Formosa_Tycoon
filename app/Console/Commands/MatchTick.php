<?php

namespace App\Console\Commands;

use App\Economy\MatchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * Una pasada del reloj de partidas: vence las salas que nadie inició, cierra las partidas cuyo tiempo se cumplió (puestos,
 * puntos, ranking) y cierra subastas vencidas. Se programa cada minuto; además el cierre es perezoso (cualquier lectura o
 * acción de una partida vencida la cierra), así que si esto se cae el juego sigue, solo que el cierre espera a la próxima lectura.
 */
class MatchTick extends Command
{
    protected $signature = 'matches:tick';

    protected $description = 'Vence salas sin iniciar, cierra partidas terminadas y subastas vencidas (una pasada)';

    public function handle(MatchService $matches): int
    {
        $r = $matches->tick();
        Cache::put('juego.partidas.latido', time(), 600);
        $this->info("Salas vencidas: {$r['expired']} · partidas cerradas: {$r['finished']} · subastas cerradas: {$r['auctions']}");

        return self::SUCCESS;
    }
}
