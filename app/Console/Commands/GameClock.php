<?php

namespace App\Console\Commands;

use App\Economy\MatchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * Reloj del servidor: cierra las subastas y las partidas apenas vencen, sin depender de que haya un navegador abierto.
 * Se deja corriendo en una terminal (o como servicio). Si se cae, el juego sigue: los navegadores y las lecturas
 * piden el cierre de las vencidas; esto solo lo hace puntual y también cuando no hay nadie mirando.
 */
class GameClock extends Command
{
    protected $signature = 'juego:reloj {--cada=1 : segundos entre pasadas}';

    protected $description = 'Cierra subastas y partidas vencidas en un bucle (dejalo corriendo en una terminal)';

    private bool $stop = false;

    public function handle(MatchService $matches): int
    {
        $every = max(1, (int) $this->option('cada'));
        if (function_exists('pcntl_async_signals') && defined('SIGINT')) {
            pcntl_async_signals(true);
            pcntl_signal(SIGINT, fn () => $this->stop = true);
            pcntl_signal(SIGTERM, fn () => $this->stop = true);
        }

        $this->info("Reloj del juego en marcha (cada {$every} s). Ctrl+C para detenerlo.");
        while (! $this->stop) {
            try {
                Cache::put('juego.reloj.latido', time(), 600); // `formosa:chequeo` lo mira para saber si el reloj está vivo
                $r = $matches->tick();
                if ($r['auctions'] + $r['finished'] + $r['expired'] > 0) {
                    $this->line('['.now()->format('H:i:s')."] subastas: {$r['auctions']} · partidas cerradas: {$r['finished']} · salas vencidas: {$r['expired']}");
                }
            } catch (\Throwable $e) {
                report($e); // la base se cayó un instante, etc.: se reintenta en la próxima vuelta
            }
            sleep($every);
        }

        return self::SUCCESS;
    }
}
