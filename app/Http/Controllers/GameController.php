<?php

namespace App\Http\Controllers;

use App\Economy\AuctionService;
use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\MatchService;
use App\Economy\RankingService;
use App\Economy\UpgradeService;
use App\Models\GameMatch;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** API del jugador identificado dentro de una partida. Todo pasa por los servicios; acá solo se valida y se da forma a la respuesta. */
class GameController extends Controller
{
    public function __construct(
        private readonly EconomyService $economy,
        private readonly AuctionService $auctions,
        private readonly MatchService $matches,
        private readonly RankingService $ranking,
        private readonly UpgradeService $upgrades,
    ) {}

    /** Quién soy: puntos globales, puesto en el ranking y la partida activa (si hay). */
    public function me(Request $request): JsonResponse
    {
        $user = $request->user();
        $current = $this->matches->current($user);

        return response()->json([
            'user' => ['id' => $user->id, 'name' => $user->name],
            'ranking' => $this->ranking->standing($user),
            'current_match' => $current ? ['id' => $current->id, 'code' => $current->code, 'status' => $current->status->value] : null,
        ])->header('Cache-Control', 'no-store, private');
    }

    /** Historial de partidas terminadas del jugador. */
    public function history(Request $request): JsonResponse
    {
        return response()->json(['matches' => $this->matches->history($request->user())])->header('Cache-Control', 'no-store, private');
    }

    public function buy(Request $request, int $match, int $property): JsonResponse
    {
        // Clave opcional que manda el navegador por cada clic: un reintento (doble toque, red lenta) no cobra dos veces.
        $key = $request->header('Idempotency-Key');
        validator(['key' => $key], ['key' => ['nullable', 'string', 'regex:/^[A-Za-z0-9_-]{8,64}$/']])->validate();
        $this->touch($match);

        // Pedir una propiedad: se compra al instante, queda reservada (ventana de disputa) o abre una subasta.
        $r = $this->auctions->claim($request->user(), $match, $property, $key);

        return response()->json([
            'ok' => true,
            'match_id' => $match,
            'result' => $r->result,
            'property_id' => $r->propertyId,
            'price' => $r->price,
            'balance' => $r->balance,
            'replayed' => $r->replayed,
            'auction' => $r->auction?->toPublic(),
        ])->header('Cache-Control', 'no-store, private');
    }

    public function sell(Request $request, int $match, int $property): JsonResponse
    {
        $key = $request->header('Idempotency-Key');
        validator(['key' => $key], ['key' => ['nullable', 'string', 'regex:/^[A-Za-z0-9_-]{8,64}$/']])->validate();
        $this->touch($match);

        return response()->json(['ok' => true, 'match_id' => $match] + $this->economy->sell($request->user(), $match, $property, $key))->header('Cache-Control', 'no-store, private');
    }

    /** Sube una propiedad propia al nivel siguiente (el nivel 2 pide rama). Reintentable con `Idempotency-Key`. */
    public function upgrade(Request $request, int $match, int $property): JsonResponse
    {
        $key = $request->header('Idempotency-Key');
        validator(['key' => $key], ['key' => ['nullable', 'string', 'regex:/^[A-Za-z0-9_-]{8,64}$/']])->validate();
        $data = $request->validate([
            'nivel' => ['required', 'integer', 'in:1,2'],
            'rama' => ['nullable', 'string', 'in:a,b', 'required_if:nivel,2', 'prohibited_if:nivel,1'],
        ]);
        $this->touch($match);

        return response()->json(['ok' => true, 'match_id' => $match] + $this->upgrades->upgrade($request->user(), $match, $property, (int) $data['nivel'], $data['rama'] ?? null, $key))
            ->header('Cache-Control', 'no-store, private');
    }

    /** Ranking GLOBAL público por puntos. */
    public function ranking(): JsonResponse
    {
        return response()->json(['players' => $this->ranking->leaderboard()])->setPublic()->setMaxAge(15);
    }

    /** Antes de actuar se aplica el vencimiento pendiente: si la partida ya cumplió su tiempo, se cierra y la acción responde "no está en juego". */
    private function touch(int $matchId): GameMatch
    {
        return $this->matches->fresh($matchId) ?? throw GameException::matchNotFound();
    }
}
