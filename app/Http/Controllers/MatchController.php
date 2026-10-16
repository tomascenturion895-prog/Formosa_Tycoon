<?php

namespace App\Http\Controllers;

use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\MatchService;
use App\Economy\OwnersVersion;
use App\Models\GameMatch;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/** API de salas y partidas. La lógica está en MatchService / EconomyService; acá solo se valida y se da forma a la respuesta. */
class MatchController extends Controller
{
    public function __construct(private readonly MatchService $matches, private readonly EconomyService $economy) {}

    /** Salas abiertas (pública, sin sesión). */
    public function index(): JsonResponse
    {
        return response()->json([
            'server_now' => now()->getTimestampMs(),
            'min_capacity' => (int) config('formosa.match.min_capacity'),
            'max_capacity' => (int) config('formosa.match.max_capacity'),
            'matches' => $this->matches->openRooms(),
        ])->header('Cache-Control', 'no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'nombre' => ['nullable', 'string', 'max:120'],
            'cupo' => ['nullable', 'integer', 'min:1', 'max:100'],
            'publica' => ['nullable', 'boolean'],
        ]);

        $match = $this->matches->create($request->user(), $data['nombre'] ?? null, isset($data['cupo']) ? (int) $data['cupo'] : null, (bool) ($data['publica'] ?? true));

        return response()->json(['ok' => true] + $this->matches->state($request->user(), $match), 201)->header('Cache-Control', 'no-store, private');
    }

    public function join(Request $request, string $code): JsonResponse
    {
        $match = $this->matches->join($request->user(), $code);

        return response()->json(['ok' => true] + $this->matches->state($request->user(), $match))->header('Cache-Control', 'no-store, private');
    }

    public function leave(Request $request, int $match): JsonResponse
    {
        $r = $this->matches->leave($request->user(), $match);

        return response()->json(['ok' => true, 'match_id' => $match] + $r)->header('Cache-Control', 'no-store, private');
    }

    public function start(Request $request, int $match): JsonResponse
    {
        $m = $this->matches->start($request->user(), $match);

        return response()->json(['ok' => true] + $this->matches->state($request->user(), $m))->header('Cache-Control', 'no-store, private');
    }

    /** Estado completo de mi partida activa (o `match: null` si no estoy en ninguna). */
    public function current(Request $request): JsonResponse
    {
        $user = $request->user();
        $match = $this->matches->current($user);
        if ($match === null) {
            // Si la última partida terminó hace poco, se avisa cuál para ir a ver el resultado.
            $last = DB::table('match_players')->join('matches', 'matches.id', '=', 'match_players.match_id')
                ->where('match_players.user_id', $user->id)->where('matches.status', 'finished')->orderByDesc('matches.finished_at')->orderByDesc('matches.id')->value('matches.id');

            return response()->json(['match' => null, 'me' => null, 'players' => [], 'last_finished_match_id' => $last ? (int) $last : null, 'server_now' => now()->getTimestampMs()])
                ->header('Cache-Control', 'no-store, private');
        }

        return response()->json($this->matches->state($user, $match) + ['last_finished_match_id' => null])->header('Cache-Control', 'no-store, private');
    }

    /**
     * Qué propiedades tienen dueño en ESTA partida y de quién. Solo las ocupadas. Pública (sin sesión). La respuesta se arma
     * una vez por "versión de dueños" de la partida (sube con cada compra, venta o cierre de subasta) y los navegadores la
     * revalidan con ETag: sin cambios, un 304 vacío. El tope de 30 s cubre cambios hechos fuera del juego.
     */
    public function propertyState(Request $request, int $match): Response|JsonResponse
    {
        $m = $this->matches->fresh($match) ?? throw GameException::matchNotFound();
        $version = OwnersVersion::current($m->id);
        $catalog = OwnersVersion::catalog();
        $etag = md5("estado|{$m->id}|{$version}|{$catalog}|{$m->status->value}|".config('app.key'));
        $response = response()->json(null)->setEtag($etag)->setPublic();
        $response->headers->set('Cache-Control', 'public, no-cache'); // siempre revalidar: el 304 es casi gratis
        if ($response->isNotModified($request)) {
            return $response;
        }

        $json = Cache::remember("match.state.{$m->id}.{$version}.{$catalog}.{$m->status->value}", 30, fn () => json_encode([
            'match_id' => $m->id,
            'status' => $m->status->value,
            'catalog' => $catalog,
            'owned' => DB::table('match_properties')
                ->join('users', 'users.id', '=', 'match_properties.owner_id')
                ->where('match_properties.match_id', $m->id)
                ->select(['match_properties.property_id', 'match_properties.owner_id', 'users.name AS owner'])
                ->orderBy('match_properties.property_id')
                ->get()
                ->map(fn ($r) => ['id' => (int) $r->property_id, 'owner_id' => (int) $r->owner_id, 'owner' => $r->owner])
                ->values(),
        ], JSON_UNESCAPED_UNICODE));

        $response = response($json, 200, ['Content-Type' => 'application/json'])->setEtag($etag)->setPublic();
        $response->headers->set('Cache-Control', 'public, no-cache');

        return $response;
    }

    /** Resultado de una partida terminada: puestos, patrimonio y puntos (pública; una partida terminada ya no cambia). */
    public function result(int $match): JsonResponse
    {
        $m = $this->matches->fresh($match) ?? throw GameException::matchNotFound();

        return response()->json($this->matches->result($m))->setPublic()->setMaxAge(60);
    }
}
