<?php

namespace App\Http\Controllers;

use App\Support\PublicConfig;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Pantalla de juego: el mapa con todo lo de la partida. `/partida/{código}` es la sala de espera, la partida y los
 * resultados (el navegador decide con /api/partidas/actual si ese código es la partida del jugador); `/explorar` es
 * el mismo mapa sin juego (visitantes incluidos).
 */
class GameScreenController extends Controller
{
    public function partida(Request $request, string $code): View
    {
        return view('partida', ['config' => PublicConfig::forGame($request->user()) + ['page' => 'partida', 'code' => strtoupper($code)]]);
    }

    public function explorar(Request $request): View
    {
        return view('partida', ['config' => PublicConfig::forGame($request->user()) + ['page' => 'explorar', 'code' => null]]);
    }
}
