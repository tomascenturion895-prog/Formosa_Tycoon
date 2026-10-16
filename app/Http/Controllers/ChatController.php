<?php

namespace App\Http\Controllers;

use App\Economy\ChatService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * API del chat. La lógica está en ChatService; acá solo se valida y se da forma a la respuesta.
 * Hay DOS canales, siempre con nombre propio en la respuesta (`scope`):
 *  - global: `/api/chat/global` (y `/api/chat`, el nombre de antes): lectura pública, escribe quien tiene sesión.
 *  - sala:   `/api/partidas/{id}/chat`: solo quienes juegan (o jugaron) esa partida, con sesión también para leer.
 */
class ChatController extends Controller
{
    public function __construct(private readonly ChatService $chat) {}

    /** Chat GLOBAL, lectura pública (sin sesión): últimos mensajes, o los posteriores a `despues`. */
    public function index(Request $request): JsonResponse
    {
        $after = $this->after($request);

        return response()->json([
            'scope' => 'global',
            'match_id' => null,
            'messages' => $this->chat->recent($after),
            'max_length' => (int) config('formosa.chat.max_length'),
        ])->header('Cache-Control', 'no-store');
    }

    /** Escribe en el chat GLOBAL. */
    public function store(Request $request): JsonResponse
    {
        [$text, $key] = $this->payload($request);
        $r = $this->chat->send($request->user(), $text, $key);

        return response()->json(['ok' => true, 'scope' => 'global', 'message' => $r['message'], 'replayed' => $r['replayed']], $r['replayed'] ? 200 : 201)
            ->header('Cache-Control', 'no-store, private');
    }

    /** Chat de la SALA: historial (o lo posterior a `despues`). 404 si la partida no existe, 403 si el jugador no es de esa partida. */
    public function roomIndex(Request $request, int $match): JsonResponse
    {
        $after = $this->after($request);
        $game = $this->chat->readableRoom($request->user(), $match);

        return response()->json([
            'scope' => 'sala',
            'match_id' => $game->id,
            'messages' => $this->chat->recent($after, $game->id),
            'max_length' => (int) config('formosa.chat.max_length'),
            'writable' => $this->chat->writable($request->user(), $game), // false: partida terminada o jugador que se fue (solo lectura)
        ])->header('Cache-Control', 'no-store, private');
    }

    /** Escribe en el chat de la SALA. */
    public function roomStore(Request $request, int $match): JsonResponse
    {
        [$text, $key] = $this->payload($request);
        $r = $this->chat->send($request->user(), $text, $key, $match);

        return response()->json(['ok' => true, 'scope' => 'sala', 'match_id' => $match, 'message' => $r['message'], 'replayed' => $r['replayed']], $r['replayed'] ? 200 : 201)
            ->header('Cache-Control', 'no-store, private');
    }

    private function after(Request $request): int
    {
        $data = $request->validate(['despues' => ['sometimes', 'integer', 'min:0', 'max:9000000000000000']]);

        return (int) ($data['despues'] ?? 0);
    }

    /** @return array{0: string, 1: string} */
    private function payload(Request $request): array
    {
        $data = $request->validate([
            // El tope de acá solo evita procesar textos enormes; el límite real (en caracteres ya limpios) lo aplica el servicio.
            'mensaje' => ['required', 'string', 'max:2000'],
            'clave' => ['required', 'string', 'regex:/^[A-Za-z0-9_-]{8,64}$/'],
        ]);

        return [$data['mensaje'], $data['clave']];
    }
}
