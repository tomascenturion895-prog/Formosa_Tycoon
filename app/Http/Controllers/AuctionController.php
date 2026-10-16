<?php

namespace App\Http\Controllers;

use App\Economy\AuctionService;
use App\Economy\GameException;
use App\Economy\MatchService;
use App\Models\Auction;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** API de subastas de una partida. La lógica está en AuctionService; acá solo se valida y se da forma a la respuesta. */
class AuctionController extends Controller
{
    public function __construct(private readonly AuctionService $auctions, private readonly MatchService $matches) {}

    /** Subastas activas de la partida (pública, sin sesión). Si alguna venció y nadie la cerró todavía, se cierra acá. */
    public function index(int $match): JsonResponse
    {
        $this->matches->fresh($match) ?? throw GameException::matchNotFound();
        if ($this->auctions->hasDue($match)) {
            $this->auctions->settleDue(5, $match); // pocas por lectura pública: el resto lo cierra el reloj del servidor
        }

        return response()->json([
            'server_now' => now()->getTimestampMs(),
            'match_id' => $match,
            'dispute_seconds' => (int) config('formosa.auction.dispute_seconds'),
            'auctions' => $this->auctions->activeForPublic($match),
        ])->header('Cache-Control', 'no-store');
    }

    public function bid(Request $request, int $match, int $auction): JsonResponse
    {
        $data = $request->validate(['monto' => ['required', 'integer', 'min:1', 'max:9000000000000']]);
        $this->inMatch($match, $auction);
        $this->matches->fresh($match);

        $r = $this->auctions->bid($request->user(), $auction, (int) $data['monto']);

        return response()->json([
            'ok' => true,
            'auction' => $r->auction->toPublic(),
            'balance' => $r->balance,
            'reserved' => $r->reserved,
            'available' => $r->balance - $r->reserved,
            'replayed' => $r->replayed,
        ])->header('Cache-Control', 'no-store, private');
    }

    /**
     * Cierra la subasta si ya venció. Pública y sin datos de entrada: no puede dañar nada, solo adelantar
     * lo que el servidor haría igual en cuanto pase el reloj. Sirve para que el cierre no dependa de un solo proceso.
     */
    public function close(int $match, int $auction): JsonResponse
    {
        $this->inMatch($match, $auction);
        $a = $this->auctions->settle($auction);
        abort_if($a === null, 404, 'Esa subasta no existe.');

        return response()->json(['auction' => $a->toPublic()])->header('Cache-Control', 'no-store');
    }

    /** La subasta tiene que ser de ESA partida (una puja en la URL de otra partida es un 404, no un cruce de datos). */
    private function inMatch(int $match, int $auction): void
    {
        if (! Auction::where('id', $auction)->where('match_id', $match)->exists()) {
            throw GameException::auctionNotFound();
        }
    }
}
