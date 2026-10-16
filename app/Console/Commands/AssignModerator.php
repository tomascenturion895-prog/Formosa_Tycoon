<?php

namespace App\Console\Commands;

use App\Economy\ModerationService;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class AssignModerator extends Command
{
    protected $signature = 'moderador:asignar {apodo : apodo exacto del jugador} {--quitar : le saca el rol en vez de dárselo}';

    protected $description = 'Convierte a un jugador en moderador del chat (o le quita el rol con --quitar)';

    public function handle(ModerationService $moderation): int
    {
        $user = User::query()->where('name', $this->argument('apodo'))->first();
        if (! $user) {
            $this->error('No existe ningún jugador con ese apodo.');

            return self::FAILURE;
        }

        $role = $this->option('quitar') ? 'jugador' : 'moderador';
        DB::table('users')->where('id', $user->id)->update(['role' => $role]); // el rol no es asignable en masa: se escribe directo, solo desde acá
        $moderation->logRole($user->id, $role); // queda anotado
        $this->info("{$user->name} ahora es {$role}.");

        return self::SUCCESS;
    }
}
