<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Solo moderadores. Se comprueba contra la base en cada pedido (el rol no viaja en la sesión ni en el navegador). */
class EnsureModerator
{
    public function handle(Request $request, Closure $next): Response
    {
        abort_unless($request->user()?->isModerator(), 403, 'Solo para moderadores.');

        return $next($request);
    }
}
