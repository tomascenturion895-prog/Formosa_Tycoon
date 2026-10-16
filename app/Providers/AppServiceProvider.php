<?php

namespace App\Providers;

use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Auth\Notifications\VerifyEmail;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /** Clave de IP para los límites: en IPv6, la red /64 (una persona tiene miles de direcciones dentro de la suya). */
    public static function ipKey(Request $request): string
    {
        $ip = (string) $request->ip();
        if (str_contains($ip, ':') && ($bin = @inet_pton($ip)) !== false) {
            return bin2hex(substr($bin, 0, 8)).'/64';
        }

        return $ip;
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Detrás de un túnel o proxy con HTTPS (APP_URL=https://...) todos los enlaces y archivos se arman con https,
        // aunque el proxy no mande bien el encabezado de protocolo: si no, el navegador bloquea el CSS/JS por contenido mixto.
        if (str_starts_with((string) config('app.url'), 'https://')) {
            URL::forceScheme('https');
        }

        // Acciones de juego: 30 por minuto por jugador (un humano no llega; un script sí).
        RateLimiter::for('jugar', fn (Request $request) => Limit::perMinute(30)->by((string) ($request->user()?->id ?? $request->ip())));

        // Crear salas: pocas por minuto y por hora (cada una aparece en el listado público).
        RateLimiter::for('salas', fn (Request $request) => [
            Limit::perMinute(5)->by('salas|'.$request->user()?->id),
            Limit::perHour(40)->by('salas-h|'.$request->user()?->id),
        ]);

        // Cierre de subastas (público, por IP): límite propio para que un navegador insistente no gaste el cupo de lectura del mapa.
        RateLimiter::for('cerrar', fn (Request $request) => Limit::perMinute(40)->by('cerrar|'.$request->ip()));

        // Chat: escribir, por jugador (un humano no llega); leer, por IP y aparte del cupo del mapa (el navegador relee si se cae el tiempo real).
        // También por IP (varias personas pueden compartirla: una escuela) para que crear cuentas no multiplique el cupo.
        RateLimiter::for('chat', fn (Request $request) => [
            Limit::perMinute(10)->by('chat|'.$request->user()?->id),
            Limit::perHour(150)->by('chat-h|'.$request->user()?->id),
            Limit::perMinute(60)->by('chat-ip|'.self::ipKey($request)),
        ]);
        // Autorizar canales privados (cada sala y cada reconexión pide una): holgado para un humano, corto para un script.
        RateLimiter::for('canales', fn (Request $request) => Limit::perMinute(30)->by('canales|'.($request->user()?->id ?? self::ipKey($request))));
        // Reportar: pocos por hora (un reporte falso masivo es una forma de acoso). Moderar: generoso, son personas de confianza.
        RateLimiter::for('reportar', fn (Request $request) => [
            Limit::perMinute(5)->by('rep|'.$request->user()?->id),
            Limit::perHour(30)->by('rep-h|'.$request->user()?->id),
            Limit::perHour(120)->by('rep-ip|'.self::ipKey($request)),
        ]);
        // Recuperar contraseña: pocos pedidos por IP (cada uno manda un correo).
        RateLimiter::for('recuperar', fn (Request $request) => [Limit::perMinute(3)->by('rec|'.self::ipKey($request)), Limit::perHour(20)->by('rec-h|'.self::ipKey($request))]);
        RateLimiter::for('moderar', fn (Request $request) => Limit::perMinute(60)->by('mod|'.$request->user()?->id));
        RateLimiter::for('chat-leer', fn (Request $request) => Limit::perMinute(240)->by('chat-leer|'.self::ipKey($request)));

        // Registro: poco por minuto y un tope diario por IP (cada cuenta recibe dinero inicial).
        RateLimiter::for('registro', fn (Request $request) => [
            Limit::perMinute(6)->by(self::ipKey($request)),
            Limit::perDay((int) config('formosa.economy.max_signups_per_ip_per_day', 40))->by(self::ipKey($request)),
        ]);

        // Un despliegue en producción con las claves de ejemplo permitiría a cualquiera emitir avisos falsos al mapa.
        if ($this->app->isProduction() && in_array(config('broadcasting.connections.reverb.secret'), [null, '', 'formosa-local-secret'], true)) {
            throw new \RuntimeException('Producción necesita su propio REVERB_APP_SECRET (no el de ejemplo).');
        }

        // Correo de confirmación en español.
        VerifyEmail::toMailUsing(fn ($notifiable, string $url) => (new MailMessage)
            ->subject('Confirmá tu correo — Formosa Tycoon')
            ->greeting("Hola, {$notifiable->name}")
            ->line('Para poder comprar, pujar y escribir en el chat, confirmá tu correo.')
            ->action('Confirmar correo', $url)
            ->line('El enlace vence en 60 minutos. Si no creaste esta cuenta, ignorá este mensaje.')
            ->salutation('Formosa Tycoon'));

        ResetPassword::toMailUsing(fn ($notifiable, string $token) => (new MailMessage)
            ->subject('Elegí una contraseña nueva — Formosa Tycoon')
            ->greeting("Hola, {$notifiable->name}")
            ->line('Pediste cambiar la contraseña de tu cuenta.')
            ->action('Elegir contraseña nueva', route('password.reset', ['token' => $token, 'email' => $notifiable->getEmailForPasswordReset()]))
            ->line('El enlace vence en 60 minutos y sirve una sola vez. Si no lo pediste, ignorá este mensaje: tu contraseña sigue igual.')
            ->salutation('Formosa Tycoon'));

        Password::defaults(fn () => Password::min(8)->letters()->numbers());
    }
}
