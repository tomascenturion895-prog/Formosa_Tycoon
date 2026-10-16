<?php

use App\Economy\ChatService;
use App\Economy\VoiceService;
use Illuminate\Support\Facades\Broadcast;

Broadcast::channel('App.Models.User.{id}', function ($user, $id) {
    return (int) $user->id === (int) $id;
});

// Chat de una sala: canal PRIVADO. Reverb solo deja entrar a quien este callback autoriza (POST /broadcasting/auth, con sesión
// y CSRF). Entra quien sigue jugando esa partida; terminada, cualquiera que la jugó (para releer el cierre).
Broadcast::channel('partida.{matchId}.chat', function ($user, $matchId) {
    return app(ChatService::class)->canListen((int) $user->id, (int) $matchId);
});

// Voz de una sala: canal de PRESENCIA (quién está conectado a la voz) donde los navegadores intercambian los datos para conectarse
// entre sí. Solo entra quien sigue en la sala mientras la partida está en espera o en juego. El audio no pasa por acá.
Broadcast::channel('partida.{matchId}.voz', function ($user, $matchId) {
    return app(VoiceService::class)->presence($user, (int) $matchId);
});
