<?php

use App\Http\Controllers\AuctionController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\ChatController;
use App\Http\Controllers\GameController;
use App\Http\Controllers\GameScreenController;
use App\Http\Controllers\LoanController;
use App\Http\Controllers\LobbyController;
use App\Http\Controllers\MapController;
use App\Http\Controllers\MatchController;
use App\Http\Controllers\ModerationController;
use App\Http\Controllers\ModerationRoomsController;
use App\Http\Controllers\OfferController;
use App\Http\Controllers\PasswordResetController;
use App\Http\Controllers\PropertyDataController;
use App\Http\Controllers\VerificationController;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Support\Facades\Route;
use Illuminate\View\Middleware\ShareErrorsFromSession;

Route::redirect('/', '/mapa');
Route::get('/mapa', [LobbyController::class, 'show'])->name('mapa');
Route::get('/partida/{code}', [GameScreenController::class, 'partida'])->where('code', '[A-Za-z0-9]{4,12}')->name('partida');
Route::get('/explorar', [GameScreenController::class, 'explorar'])->name('explorar');

// Cuentas
Route::middleware('guest')->group(function () {
    Route::get('/registro', [AuthController::class, 'showRegister'])->name('registro');
    Route::post('/registro', [AuthController::class, 'register'])->middleware('throttle:registro')->name('registro.guardar');
    Route::get('/ingresar', [AuthController::class, 'showLogin'])->name('login');
    Route::post('/ingresar', [AuthController::class, 'login'])->middleware('throttle:20,1')->name('login.entrar');

    // Olvidé mi contraseña (los nombres de ruta son los que usa Laravel para armar el enlace del correo).
    Route::get('/olvide', [PasswordResetController::class, 'request'])->name('password.request');
    Route::post('/olvide', [PasswordResetController::class, 'send'])->middleware('throttle:recuperar')->name('password.email');
    Route::get('/restablecer/{token}', [PasswordResetController::class, 'edit'])->name('password.reset');
    Route::post('/restablecer', [PasswordResetController::class, 'update'])->middleware('throttle:recuperar')->name('password.update');
});
Route::post('/salir', [AuthController::class, 'logout'])->middleware('auth')->name('logout');

// Confirmación de correo (activa con FORMOSA_VERIFICAR_EMAIL=true).
Route::middleware('auth')->group(function () {
    Route::get('/verificar-correo', [VerificationController::class, 'notice'])->name('verification.notice');
    Route::get('/verificar-correo/{id}/{hash}', [VerificationController::class, 'verify'])->middleware(['signed', 'throttle:6,1'])->name('verification.verify');
    Route::post('/verificar-correo/reenviar', [VerificationController::class, 'resend'])->middleware('throttle:3,1')->name('verification.send');
});

// Lectura pública del mapa (datos de OpenStreetMap y dueños). Sin sesión ni cookies: así una caché intermedia
// (CDN, proxy) nunca puede guardar y repartir la cookie de otra persona junto con la respuesta.
$withoutSession = [
    EncryptCookies::class, AddQueuedCookiesToResponse::class, StartSession::class, ShareErrorsFromSession::class, PreventRequestForgery::class,
];
Route::prefix('api')->middleware('throttle:60,1')->withoutMiddleware($withoutSession)->group(function () {
    Route::get('/propiedades', [MapController::class, 'properties'])->name('api.propiedades');
    Route::get('/calles', [MapController::class, 'roads'])->name('api.calles');
    Route::get('/entorno', [MapController::class, 'environment'])->name('api.entorno');
    Route::get('/ranking', [GameController::class, 'ranking'])->name('api.ranking'); // ranking GLOBAL por puntos

    // Partidas (públicas: salas abiertas, dueños y subastas de una partida, resultado final).
    Route::get('/partidas', [MatchController::class, 'index'])->name('api.partidas');
    Route::get('/partidas/{match}/propiedades/estado', [MatchController::class, 'propertyState'])->where('match', '[0-9]{1,15}')->name('api.partidas.estado');
    Route::get('/partidas/{match}/subastas', [AuctionController::class, 'index'])->where('match', '[0-9]{1,15}')->name('api.partidas.subastas');
    Route::get('/partidas/{match}/ofertas', [OfferController::class, 'index'])->where('match', '[0-9]{1,15}')->name('api.partidas.ofertas');
    Route::get('/partidas/{match}/resultado', [MatchController::class, 'result'])->where('match', '[0-9]{1,15}')->name('api.partidas.resultado');
});
// Cierre: público (sin datos de entrada, solo adelanta lo que el servidor haría igual al vencer el plazo), con su propio límite.
Route::prefix('api')->middleware('throttle:cerrar')->withoutMiddleware($withoutSession)->group(function () {
    Route::post('/partidas/{match}/subastas/{auction}/cerrar', [AuctionController::class, 'close'])
        ->where(['match' => '[0-9]{1,15}', 'auction' => '[0-9]{1,15}'])->name('api.subastas.cerrar');
    Route::post('/partidas/{match}/ofertas/{offer}/cerrar', [OfferController::class, 'close'])
        ->where(['match' => '[0-9]{1,15}', 'offer' => '[0-9]{1,15}'])->name('api.ofertas.cerrar');
});

// Chat GLOBAL (todos los jugadores): lectura pública (cupo propio, sin sesión ni cookies); escribir exige sesión y tiene su propio límite por jugador.
// `/api/chat` es el nombre de antes y sigue funcionando igual que `/api/chat/global`.
Route::prefix('api')->middleware('throttle:chat-leer')->withoutMiddleware($withoutSession)->group(function () {
    Route::get('/chat', [ChatController::class, 'index'])->name('api.chat');
    Route::get('/chat/global', [ChatController::class, 'index'])->name('api.chat.global');
});
Route::prefix('api')->middleware(['auth', 'verificado', 'throttle:chat'])->group(function () {
    Route::post('/chat', [ChatController::class, 'store'])->name('api.chat.enviar');
    Route::post('/chat/global', [ChatController::class, 'store'])->name('api.chat.global.enviar');
    // Chat de la SALA: solo quienes juegan esa partida (lo comprueba el servicio; no alcanza con tener sesión).
    Route::post('/partidas/{match}/chat', [ChatController::class, 'roomStore'])->where('match', '[0-9]{1,15}')->name('api.partidas.chat.enviar');
});
// Leer la sala necesita sesión (con cookies): el historial no es público.
Route::prefix('api')->middleware(['auth', 'throttle:chat-leer'])->group(function () {
    Route::get('/partidas/{match}/chat', [ChatController::class, 'roomIndex'])->where('match', '[0-9]{1,15}')->name('api.partidas.chat');
});

Route::prefix('api')->middleware(['auth', 'verificado', 'throttle:reportar'])->group(function () {
    Route::post('/chat/{message}/reportar', [ModerationController::class, 'report'])->where('message', '[0-9]{1,15}')->name('api.chat.reportar');
    Route::post('/propiedades/{property}/avisar-datos', [PropertyDataController::class, 'report'])->where('property', '[0-9]{1,15}')->name('api.propiedades.avisar');
});

// Moderación (solo moderadores). Sirve a la página /moderacion (formularios) y al chat (fetch con JSON).
Route::middleware(['auth', 'moderador', 'throttle:moderar'])->prefix('moderacion')->group(function () {
    Route::get('/', [ModerationController::class, 'page'])->name('moderacion');
    Route::post('/mensajes/{message}/ocultar', [ModerationController::class, 'hide'])->where('message', '[0-9]{1,15}')->name('moderacion.ocultar');
    Route::post('/mensajes/{message}/restaurar', [ModerationController::class, 'restore'])->where('message', '[0-9]{1,15}')->name('moderacion.restaurar');
    Route::post('/mensajes/{message}/descartar', [ModerationController::class, 'dismiss'])->where('message', '[0-9]{1,15}')->name('moderacion.descartar');
    Route::post('/usuarios/{user}/silenciar', [ModerationController::class, 'mute'])->where('user', '[0-9]{1,15}')->name('moderacion.silenciar');
    Route::post('/usuarios/{user}/quitar-silencio', [ModerationController::class, 'unmute'])->where('user', '[0-9]{1,15}')->name('moderacion.quitar-silencio');

    // Salas y partidas: lista y ficha con jugadores y chat; desde la ficha se silencia, se oculta y se cierra una sala trabada.
    Route::get('/salas', [ModerationRoomsController::class, 'index'])->name('moderacion.salas');
    Route::get('/salas/{match}', [ModerationRoomsController::class, 'show'])->where('match', '[0-9]{1,15}')->name('moderacion.sala');
    Route::post('/salas/{match}/cerrar', [ModerationRoomsController::class, 'close'])->where('match', '[0-9]{1,15}')->name('moderacion.sala.cerrar');

    // Datos del mapa desactualizados: cola de avisos, corrección y ficha de revisión.
    Route::get('/mapa', [PropertyDataController::class, 'page'])->name('moderacion.mapa');
    Route::get('/propiedades/{property}', [PropertyDataController::class, 'details'])->where('property', '[0-9]{1,15}')->name('moderacion.propiedad');
    Route::post('/propiedades/{property}/corregir', [PropertyDataController::class, 'correct'])->where('property', '[0-9]{1,15}')->name('moderacion.corregir');
    Route::post('/propiedades/{property}/descartar-avisos', [PropertyDataController::class, 'dismiss'])->where('property', '[0-9]{1,15}')->name('moderacion.descartar-avisos');
});

// Acciones del jugador (sesión + CSRF). Límite por jugador, no por IP.
Route::prefix('api')->middleware(['auth', 'throttle:jugar'])->group(function () {
    Route::get('/yo', [GameController::class, 'me'])->name('api.yo');
    Route::get('/yo/historial', [GameController::class, 'history'])->name('api.yo.historial');
    Route::get('/partidas/actual', [MatchController::class, 'current'])->name('api.partidas.actual');
});
Route::prefix('api')->middleware(['auth', 'verificado', 'throttle:jugar'])->group(function () {
    Route::post('/partidas/{match}/salir', [MatchController::class, 'leave'])->where('match', '[0-9]{1,15}')->name('api.partidas.salir');
    Route::post('/partidas/{match}/iniciar', [MatchController::class, 'start'])->where('match', '[0-9]{1,15}')->name('api.partidas.iniciar');
    Route::post('/partidas/{code}/unirse', [MatchController::class, 'join'])->where('code', '[A-Za-z0-9]{4,12}')->name('api.partidas.unirse');
    Route::post('/partidas/{match}/propiedades/{property}/comprar', [GameController::class, 'buy'])
        ->where(['match' => '[0-9]{1,15}', 'property' => '[0-9]{1,15}'])->name('api.comprar');
    Route::post('/partidas/{match}/propiedades/{property}/vender', [GameController::class, 'sell'])
        ->where(['match' => '[0-9]{1,15}', 'property' => '[0-9]{1,15}'])->name('api.vender');
    Route::post('/partidas/{match}/subastas/{auction}/pujar', [AuctionController::class, 'bid'])
        ->where(['match' => '[0-9]{1,15}', 'auction' => '[0-9]{1,15}'])->name('api.subastas.pujar');
    Route::post('/partidas/{match}/propiedades/{property}/ofertar', [OfferController::class, 'store'])
        ->where(['match' => '[0-9]{1,15}', 'property' => '[0-9]{1,15}'])->name('api.ofertas.crear');
    Route::post('/partidas/{match}/ofertas/{offer}/ofrecer', [OfferController::class, 'bid'])
        ->where(['match' => '[0-9]{1,15}', 'offer' => '[0-9]{1,15}'])->name('api.ofertas.ofrecer');
    Route::post('/partidas/{match}/ofertas/{offer}/aceptar', [OfferController::class, 'accept'])
        ->where(['match' => '[0-9]{1,15}', 'offer' => '[0-9]{1,15}'])->name('api.ofertas.aceptar');
    Route::get('/partidas/{match}/prestamos', [LoanController::class, 'index'])->where('match', '[0-9]{1,15}')->name('api.prestamos');
    Route::post('/partidas/{match}/prestamos', [LoanController::class, 'store'])->where('match', '[0-9]{1,15}')->name('api.prestamos.pedir');
    Route::post('/partidas/{match}/prestamos/{loan}/pagar', [LoanController::class, 'pay'])
        ->where(['match' => '[0-9]{1,15}', 'loan' => '[0-9]{1,15}'])->name('api.prestamos.pagar');
    Route::post('/partidas/{match}/ofertas/{offer}/retirar', [OfferController::class, 'cancel'])
        ->where(['match' => '[0-9]{1,15}', 'offer' => '[0-9]{1,15}'])->name('api.ofertas.retirar');
});
// Crear una sala: límite propio (cada sala ocupa a todos sus jugadores y aparece en el listado público).
Route::prefix('api')->middleware(['auth', 'verificado', 'throttle:salas'])->group(function () {
    Route::post('/partidas', [MatchController::class, 'store'])->name('api.partidas.crear');
});
