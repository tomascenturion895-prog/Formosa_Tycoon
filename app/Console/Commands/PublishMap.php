<?php

namespace App\Console\Commands;

use App\Formosa\MapSnapshot;
use Illuminate\Console\Command;

/** Deja listos los archivos estáticos del mapa (propiedades y calles) en public/data. Se corre después de importar o actualizar. */
class PublishMap extends Command
{
    protected $signature = 'mapa:publicar';

    protected $description = 'Genera los archivos estáticos del mapa (propiedades y calles) para que salgan sin arrancar Laravel';

    public function handle(): int
    {
        if (! MapSnapshot::enabled()) {
            $this->warn('Los archivos estáticos del mapa están apagados (FORMOSA_MAPA_ESTATICO=false).');

            return self::SUCCESS;
        }
        $t = microtime(true);
        $urls = MapSnapshot::publishAll();
        foreach ($urls as $name => $url) {
            $this->line(sprintf('%-12s %s', $name, $url ?? 'no disponible'));
        }
        $this->info(sprintf('Listo en %.1f s.', microtime(true) - $t));

        return in_array(null, $urls, true) ? self::FAILURE : self::SUCCESS;
    }
}
