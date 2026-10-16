<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Revisa la instalación antes de abrirla al público (o cuando algo "no anda"): configuración de producción, base,
 * migraciones al día, reloj y planificador corriendo, correo, tiempo real. No cambia nada.
 * Sale con código 1 si hay algún PROBLEMA, para usarlo en un script de despliegue.
 */
class HealthCheck extends Command
{
    protected $signature = 'formosa:chequeo {--produccion : Exige las condiciones de producción aunque APP_ENV no lo sea}';

    protected $description = 'Revisa que la instalación esté lista (config de producción, base, reloj, planificador, correo, tiempo real)';

    /** @var list<array{0: string, 1: string, 2: string}> */
    private array $rows = [];

    public function handle(): int
    {
        $prod = $this->option('produccion') || app()->isProduction();
        $this->components->info($prod ? 'Chequeo para PRODUCCIÓN' : 'Chequeo (entorno de desarrollo: lo de producción se marca como aviso)');

        $this->checkBasics($prod);
        $this->checkDatabase();
        $this->checkRealtime($prod);
        $this->checkBackground();
        $this->checkAccounts($prod);

        $this->table(['', 'Qué', 'Detalle'], $this->rows);
        $problems = count(array_filter($this->rows, fn ($r) => $r[0] === 'PROBLEMA'));
        $warnings = count(array_filter($this->rows, fn ($r) => $r[0] === 'AVISO'));
        $problems > 0 ? $this->components->error("{$problems} problema(s) y {$warnings} aviso(s).") : $this->components->info("Sin problemas. {$warnings} aviso(s).");

        return $problems > 0 ? self::FAILURE : self::SUCCESS;
    }

    private function add(string $level, string $what, string $detail = ''): void
    {
        $this->rows[] = [$level, $what, $detail];
    }

    /** En producción es un problema; en desarrollo, un aviso. */
    private function strict(bool $prod): string
    {
        return $prod ? 'PROBLEMA' : 'AVISO';
    }

    private function checkBasics(bool $prod): void
    {
        config('app.key') ? $this->add('OK', 'APP_KEY') : $this->add('PROBLEMA', 'APP_KEY vacía', 'php artisan key:generate');
        config('app.debug') ? $this->add($this->strict($prod), 'APP_DEBUG=true', 'en producción muestra datos internos en los errores: poné APP_DEBUG=false') : $this->add('OK', 'APP_DEBUG apagado');
        $https = str_starts_with((string) config('app.url'), 'https://');
        $https ? $this->add('OK', 'APP_URL con https') : $this->add($this->strict($prod), 'APP_URL sin https', (string) config('app.url'));
        config('session.secure') ? $this->add('OK', 'SESSION_SECURE_COOKIE') : $this->add($this->strict($prod), 'SESSION_SECURE_COOKIE apagado', 'la cookie de sesión debe viajar solo por https');
        env('TRUSTED_PROXIES') ? $this->add('OK', 'TRUSTED_PROXIES') : $this->add('AVISO', 'TRUSTED_PROXIES vacío', 'detrás de Nginx/Cloudflare todos parecen venir de una IP y los límites por IP se rompen; poné la IP del proxy');
        class_exists(\Normalizer::class) ? $this->add('OK', 'extensión intl') : $this->add('PROBLEMA', 'falta la extensión intl', 'sin ella los apodos no se normalizan (suplantación con letras parecidas)');
        function_exists('gzencode') ? $this->add('OK', 'extensión zlib') : $this->add('AVISO', 'falta zlib', 'el mapa se baja sin comprimir (~4 MB)');
        $cache = (string) config('cache.default');
        in_array($cache, ['array', 'null'], true) ? $this->add('PROBLEMA', "CACHE_STORE={$cache}", 'los límites de pedidos y la caché del mapa no persisten') : $this->add('OK', "CACHE_STORE={$cache}");
    }

    private function checkDatabase(): void
    {
        try {
            DB::select('select 1');
            $this->add('OK', 'base de datos', (string) config('database.default'));
        } catch (\Throwable $e) {
            $this->add('PROBLEMA', 'base de datos', 'no conecta: '.$e->getMessage());

            return;
        }
        try {
            $pending = collect(app('migrator')->getMigrationFiles(database_path('migrations')))->keys()
                ->diff(app('migrator')->getRepository()->getRan())->count();
            $pending === 0 ? $this->add('OK', 'migraciones al día') : $this->add('PROBLEMA', "{$pending} migración(es) pendiente(s)", 'php artisan migrate');
            $props = DB::table('properties')->count();
            $props > 0 ? $this->add('OK', 'propiedades cargadas', (string) $props) : $this->add('AVISO', 'no hay propiedades', 'php artisan formosa:importar (datos reales) o db:seed (demo)');
        } catch (\Throwable $e) {
            $this->add('PROBLEMA', 'migraciones', $e->getMessage());
        }
    }

    private function checkRealtime(bool $prod): void
    {
        if (config('broadcasting.default') !== 'reverb') {
            $this->add('AVISO', 'tiempo real apagado', 'BROADCAST_CONNECTION no es reverb: los mapas se actualizan por consulta cada 20 s');

            return;
        }
        in_array(config('broadcasting.connections.reverb.secret'), [null, '', 'formosa-local-secret'], true)
            ? $this->add($this->strict($prod), 'REVERB_APP_SECRET de ejemplo', 'cualquiera podría emitir avisos falsos al mapa')
            : $this->add('OK', 'REVERB_APP_SECRET propio');
        $port = (int) config('reverb.servers.reverb.port', 8080);
        $host = (string) config('reverb.servers.reverb.hostname', config('reverb.servers.reverb.host', '127.0.0.1'));
        $host = in_array($host, ['0.0.0.0', ''], true) ? '127.0.0.1' : $host;
        $sock = @fsockopen($host, $port, $errno, $errstr, 1.0);
        if ($sock) {
            fclose($sock);
            $this->add('OK', 'Reverb escuchando', "{$host}:{$port}");
        } else {
            $this->add('AVISO', 'Reverb no responde', "{$host}:{$port} — php artisan reverb:start (sin él, los mapas se actualizan por consulta)");
        }
        $origins = (array) config('reverb.apps.apps.0.allowed_origins', ['*']);
        in_array('*', $origins, true)
            ? $this->add($this->strict($prod), 'Reverb acepta cualquier origen', 'REVERB_ALLOWED_ORIGINS=tu-dominio.com: así otras páginas no pueden abrir conexiones en vivo a tu servidor')
            : $this->add('OK', 'Reverb solo acepta tu dominio', implode(', ', $origins));
        $mailer = (string) config('mail.default');
        in_array($mailer, ['log', 'array'], true)
            ? $this->add($this->strict($prod), "MAIL_MAILER={$mailer}", 'los correos (recuperar contraseña, confirmar cuenta) no le llegan a nadie: configurá un servicio de correo real')
            : $this->add('OK', "correo: {$mailer}");
        // Con el bucle de eventos de PHP por defecto, Reverb aguanta ~1000 conexiones y se cae al pasarlas (medido en la Fase 5).
        extension_loaded('uv') || extension_loaded('event') || extension_loaded('ev')
            ? $this->add('OK', 'bucle de eventos escalable', 'ext-uv/event/ev')
            : $this->add('AVISO', 'Reverb sin ext-uv/event', 'con el bucle por defecto aguanta ~900 jugadores conectados a la vez; para más, instalá ext-uv o ext-event (Linux)');
    }

    private function checkBackground(): void
    {
        $clock = (int) Cache::get('juego.reloj.latido', 0);
        $clock >= time() - 30
            ? $this->add('OK', 'juego:reloj corriendo')
            : $this->add('AVISO', 'juego:reloj no corre', 'las subastas igual se cierran cuando alguien mira, pero con retraso y no si no hay nadie');
        $sched = (int) Cache::get('juego.planificador.latido', 0);
        $sched >= time() - 150
            ? $this->add('OK', 'planificador corriendo')
            : $this->add('AVISO', 'el planificador no corre', 'php artisan schedule:work (o el cron de schedule:run): sin él el chat no se limpia');
        config('queue.default') === 'sync'
            ? $this->add('OK', 'cola sync', 'los avisos en vivo salen dentro de cada pedido: bien para pocos jugadores; con muchos, QUEUE_CONNECTION=database + php artisan queue:work')
            : $this->add('OK', 'cola '.config('queue.default'), 'recordá tener php artisan queue:work corriendo');
    }

    private function checkAccounts(bool $prod): void
    {
        config('formosa.auth.antibot') ? $this->add('OK', 'freno a bots en el registro') : $this->add($this->strict($prod), 'FORMOSA_ANTIBOT apagado');
        if (config('formosa.auth.verify_email')) {
            in_array(config('mail.default'), ['log', 'array', null], true)
                ? $this->add($this->strict($prod), 'verificación de correo con MAIL_MAILER='.config('mail.default'), 'los correos no salen: configurá un mailer real (SMTP, Mailgun, SES…)')
                : $this->add('OK', 'verificación de correo', 'mailer '.config('mail.default'));
        } else {
            $this->add('AVISO', 'verificación de correo apagada', 'antes de abrir al público conviene FORMOSA_VERIFICAR_EMAIL=true: los silencios del chat son por cuenta');
        }
    }
}
