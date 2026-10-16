<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Vite;
use Symfony\Component\HttpFoundation\Response;

/**
 * Cabeceras de seguridad del navegador, incluida una Content-Security-Policy con nonce: solo corren los scripts propios
 * (los de Vite y el de configuración del mapa, que llevan el nonce). Aunque alguien lograra meter HTML en la página,
 * un <script> o un onerror inyectado no se ejecutaría.
 *
 * Con `npm run dev` (Vite en caliente) la CSP se omite: el servidor de desarrollo de Vite inyecta scripts y estilos propios.
 */
class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        $hot = Vite::isRunningHot();
        if (! $hot) {
            Vite::useCspNonce();
        }

        $response = $next($request);

        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
        if ($request->isSecure()) {
            $response->headers->set('Strict-Transport-Security', 'max-age=31536000');
        }
        if (! $hot && str_contains((string) $response->headers->get('Content-Type'), 'text/html')) {
            $response->headers->set('Content-Security-Policy', $this->policy(Vite::cspNonce(), $response->getStatusCode() >= 400));
        }

        return $response;
    }

    /** Las páginas de error (403, 404, 500…) las arma Laravel con estilos en línea: ahí se permiten estilos, nunca scripts. */
    private function policy(string $nonce, bool $errorPage = false): string
    {
        $connect = ["'self'"];
        if (config('broadcasting.default') === 'reverb') {
            $host = config('formosa.realtime.host');
            $port = config('formosa.realtime.port');
            $secure = config('formosa.realtime.scheme') === 'https';
            $connect[] = ($secure ? 'wss://' : 'ws://').$host.($port ? ':'.$port : '');
        }

        return implode('; ', [
            "default-src 'self'",
            "script-src 'self' 'nonce-{$nonce}'",
            $errorPage ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-{$nonce}'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            'connect-src '.implode(' ', $connect),
            "worker-src 'self' blob:",
            "child-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]);
    }
}
