<?php

namespace App\Http\Controllers;

use App\Economy\GameException;
use App\Economy\MatchService;
use App\Economy\OfferService;
use App\Models\Offer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** API de ofertas entre jugadores de una partida. La lógica está en OfferService; acá solo se valida y se da forma a la respuesta. */
class OfferController extends Controller
{
    public function __construct(private readonly OfferService $offers, private readonly MatchService $matches) {}

    /** Ofertas abiertas de la partida (pública, sin sesión). Si alguna venció y nadie la cerró todavía, se cierra acá. */
    public function index(int $match): JsonResponse
    {
        $this->matches->fresh($match) ?? throw GameException::matchNotFound();
        if ($this->offers->hasDue($match)) {
            $this->offers->settleDue(5, $match);
        }

        return response()->json([
            'server_now' => now()->getTimestampMs(),
            'match_id' => $match,
            'fee_pct' => (int) config('formosa.offers.fee_pct'),
            'min_price' => (int) config('formosa.offers.min_price'),
            'offers' => $this->offers->activeForPublic($match),
        ])->header('Cache-Control', 'no-store');
    }

    public function store(Request $request, int $match, int $property): JsonResponse
    {
        $data = $request->validate([
            'minimo' => ['required', 'integer', 'min:1', 'max:9000000000000'],
            'comprar_ya' => ['required', 'integer', 'min:1', 'max:9000000000000'],
        ]);
        $this->matches->fresh($match) ?? throw GameException::matchNotFound();

        $offer = $this->offers->open($request->user(), $match, $property, (int) $data['minimo'], (int) $data['comprar_ya']);

        return response()->json(['ok' => true, 'offer' => $offer->toPublic()])->header('Cache-Control', 'no-store, private');
    }

    public function bid(Request $request, int $match, int $offer): JsonResponse
    {
        $data = $request->validate(['monto' => ['required', 'integer', 'min:1', 'max:9000000000000']]);
        $this->inMatch($match, $offer);
        $this->matches->fresh($match);

        $r = $this->offers->bid($request->user(), $offer, (int) $data['monto']);

        return response()->json([
            'ok' => true,
            'offer' => $r['offer']->toPublic(),
            'sold' => $r['sold'],
            'balance' => $r['balance'],
            'reserved' => $r['reserved'],
            'available' => $r['balance'] - $r['reserved'],
        ])->header('Cache-Control', 'no-store, private');
    }

    public function accept(Request $request, int $match, int $offer): JsonResponse
    {
        $this->inMatch($match, $offer);
        $this->matches->fresh($match);

        return response()->json(['ok' => true, 'offer' => $this->offers->accept($request->user(), $offer)->toPublic()])->header('Cache-Control', 'no-store, private');
    }

    public function cancel(Request $request, int $match, int $offer): JsonResponse
    {
        $this->inMatch($match, $offer);
        $this->matches->fresh($match);

        return response()->json(['ok' => true, 'offer' => $this->offers->cancel($request->user(), $offer)->toPublic()])->header('Cache-Control', 'no-store, private');
    }

    /** Cierra la oferta si ya corresponde. Pública y sin datos de entrada: solo adelanta lo que el servidor haría igual. */
    public function close(int $match, int $offer): JsonResponse
    {
        $this->inMatch($match, $offer);
        $o = $this->offers->settle($offer);
        abort_if($o === null, 404, 'Esa oferta no existe.');

        return response()->json(['offer' => $o->toPublic()])->header('Cache-Control', 'no-store');
    }

    /** La oferta tiene que ser de ESA partida (una oferta en la URL de otra partida es un 404, no un cruce de datos). */
    private function inMatch(int $match, int $offer): void
    {
        if (! Offer::where('id', $offer)->where('match_id', $match)->exists()) {
            throw GameException::offerNotFound();
        }
    }
}
