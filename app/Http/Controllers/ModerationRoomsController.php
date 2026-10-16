<?php

namespace App\Http\Controllers;

use App\Economy\GameException;
use App\Economy\ModerationService;
use App\Economy\RoomInspector;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Salas y partidas para moderadores: lista y ficha con jugadores y chat. Las decisiones sobre jugadores y mensajes (silenciar,
 * ocultar) usan las mismas acciones de /moderacion y vuelven a la ficha; cerrar una sala trabada es la única acción propia.
 * Todo queda en el registro de moderación. La ruta exige el middleware `moderador`.
 */
class ModerationRoomsController extends Controller
{
    public function __construct(private readonly RoomInspector $rooms, private readonly ModerationService $moderation) {}

    public function index(Request $request): View
    {
        $filter = (string) $request->query('estado', 'activas');
        if (! array_key_exists($filter, RoomInspector::FILTERS)) {
            $filter = 'activas';
        }
        $search = $request->query('q');
        $search = is_string($search) ? trim($search) : '';

        return view('moderacion-salas', [
            'filter' => $filter,
            'search' => $search,
            'counts' => $this->rooms->counts(),
            'rooms' => $this->rooms->rooms($filter, $search),
        ]);
    }

    public function show(int $match): View
    {
        $room = $this->rooms->room($match);
        abort_if($room === null, 404, 'No existe esa partida.');

        return view('moderacion-sala', $room + ['durations' => config('formosa.chat.mute_minutes')]);
    }

    public function close(Request $request, int $match): RedirectResponse
    {
        try {
            $result = $this->moderation->closeRoom($request->user(), $match);
        } catch (GameException $e) {
            return redirect()->route('moderacion.sala', $match)->with('error', $e->getMessage());
        }

        return redirect()->route('moderacion.sala', $match)->with('ok', $result === 'vencida' ? 'Sala cerrada: sus jugadores quedaron libres.' : 'Partida cerrada: ya están los puestos y los puntos.');
    }
}
