<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Reloj de partidas: vence salas, cierra partidas terminadas (puestos y puntos) y subastas vencidas. Cada minuto.
// (El cierre también es perezoso: una lectura o acción sobre una partida vencida la cierra aunque esto no corra.)
Schedule::command('matches:tick')->everyMinute()->withoutOverlapping();

// Respaldo del cierre de subastas si no se está usando `php artisan juego:reloj` (corre con `php artisan schedule:work`).
Schedule::command('subastas:cerrar')->everyMinute()->withoutOverlapping();

// Retención del chat (por antigüedad y por cantidad). Cada hora: el tope de filas se respeta aunque alguien llene el chat.
// Requiere que corra el planificador (`php artisan schedule:work` o el cron de `schedule:run`).
Schedule::command('chat:limpiar')->hourly()->withoutOverlapping();

// Latido del planificador: `formosa:chequeo` lo mira para avisar si `schedule:work` / el cron no está corriendo.
Schedule::call(fn () => Cache::put('juego.planificador.latido', time(), 3600))->everyMinute()->name('latido-planificador');
