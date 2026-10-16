<?php

namespace App\Console\Commands;

use App\Economy\ChatService;
use Illuminate\Console\Command;

class PruneChat extends Command
{
    protected $signature = 'chat:limpiar {--dias= : borrar lo más viejo que estos días (por defecto, formosa.chat.retention_days)}';

    protected $description = 'Borra los mensajes del chat más viejos que el período de retención y deja como mucho `max_rows`';

    public function handle(ChatService $chat): int
    {
        $opt = $this->option('dias');
        if ($opt !== null && (! ctype_digit((string) $opt) || (int) $opt < 1)) {
            $this->error('--dias tiene que ser un entero de 1 o más.'); // "abc" no debe borrar casi todo en silencio

            return self::INVALID;
        }
        $days = (int) ($opt ?? config('formosa.chat.retention_days'));
        $this->info('Mensajes borrados: '.$chat->prune($days, maxRows: (int) config('formosa.chat.max_rows')));

        return self::SUCCESS;
    }
}
