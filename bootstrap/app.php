<?php

use App\Economy\GameException;
use App\Http\Middleware\EnsureModerator;
use App\Http\Middleware\EnsureVerified;
use App\Http\Middleware\SecurityHeaders;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    // Autorización de canales privados (chat de sala): POST /broadcasting/auth, con sesión, CSRF y un límite por jugador.
    ->withBroadcasting(__DIR__.'/../routes/channels.php', ['middleware' => ['web', 'auth', 'throttle:canales']])
    ->withMiddleware(function (Middleware $middleware): void {
        // Detrás de un proxy (Nginx, Cloudflare…), TRUSTED_PROXIES="*" o la IP del proxy: sin esto todos comparten una IP.
        if ($proxies = env('TRUSTED_PROXIES')) {
            $middleware->trustProxies(at: $proxies === '*' ? '*' : explode(',', $proxies));
        }
        $middleware->appendToGroup('web', SecurityHeaders::class);
        $middleware->alias(['moderador' => EnsureModerator::class, 'verificado' => EnsureVerified::class]);
        $middleware->redirectGuestsTo('/ingresar');
        $middleware->redirectUsersTo('/mapa');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Errores esperables del juego: JSON con un código estable y un mensaje listo para mostrar.
        $exceptions->render(fn (GameException $e) => response()->json(
            ['error' => $e->errorCode, 'message' => $e->getMessage()] + $e->context,
            $e->status,
        ));
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
