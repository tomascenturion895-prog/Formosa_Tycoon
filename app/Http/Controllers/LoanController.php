<?php

namespace App\Http\Controllers;

use App\Economy\LoanService;
use App\Economy\MatchService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** API del banco: préstamos del jugador en su partida. Todo es privado (sesión + jugador de esa partida). La lógica está en LoanService. */
class LoanController extends Controller
{
    public function __construct(private readonly LoanService $loans, private readonly MatchService $matches) {}

    public function index(Request $request, int $match): JsonResponse
    {
        $this->matches->fresh($match);

        return response()->json(['ok' => true, 'match_id' => $match] + $this->loans->summary($request->user(), $match))->header('Cache-Control', 'no-store, private');
    }

    public function store(Request $request, int $match): JsonResponse
    {
        $data = $request->validate([
            'monto' => ['required', 'integer', 'min:1', 'max:9000000000000'],
            'plazo' => ['required', 'integer', 'min:1', 'max:365'],
        ]);
        $this->matches->fresh($match);
        $loan = $this->loans->take($request->user(), $match, (int) $data['monto'], (int) $data['plazo']);

        return response()->json(['ok' => true, 'loan' => $loan->toOwner()] + $this->loans->summary($request->user(), $match))->header('Cache-Control', 'no-store, private');
    }

    public function pay(Request $request, int $match, int $loan): JsonResponse
    {
        $data = $request->validate(['monto' => ['nullable', 'integer', 'min:1', 'max:9000000000000']]);
        $this->matches->fresh($match);
        $l = $this->loans->repay($request->user(), $match, $loan, isset($data['monto']) ? (int) $data['monto'] : null);

        return response()->json(['ok' => true, 'loan' => $l->toOwner()] + $this->loans->summary($request->user(), $match))->header('Cache-Control', 'no-store, private');
    }
}
