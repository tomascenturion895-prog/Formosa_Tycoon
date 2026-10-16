<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Con FORMOSA_VERIFICAR_EMAIL=true, las acciones del juego exigen correo confirmado. Sin la variable no hace nada.
 * Responde con un código estable (el navegador muestra el mensaje y el enlace para confirmar).
 */
class EnsureVerified
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if ($user && ! $user->hasVerifiedEmail()) {
            $message = 'Confirmá tu correo para jugar: te mandamos un enlace.';
            if ($request->expectsJson()) {
                return response()->json(['error' => 'email_sin_verificar', 'message' => $message, 'url' => route('verification.notice')], 403);
            }

            return redirect()->route('verification.notice');
        }

        return $next($request);
    }
}
