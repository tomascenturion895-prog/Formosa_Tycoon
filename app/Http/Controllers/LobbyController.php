<?php

namespace App\Http\Controllers;

use App\Support\PublicConfig;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Lobby (/mapa): salas, ranking y guías. No carga el mapa; la partida vive en /partida/{código}. */
class LobbyController extends Controller
{
    public function show(Request $request): View
    {
        return view('lobby', ['config' => PublicConfig::forLobby($request->user())]);
    }
}
