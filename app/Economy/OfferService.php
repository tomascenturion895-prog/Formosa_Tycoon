<?php

namespace App\Economy;

use App\Enums\LedgerType;
use App\Enums\MatchStatus;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\Offer;
use App\Models\OfferBid;
use App\Models\Property;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Ofertas entre jugadores. Todo es DE UNA PARTIDA.
 *
 * Reglas:
 *  - El dueño publica una propiedad con un MÍNIMO y un "COMPRÁ YA". Los demás ofertan entre los dos; una oferta nueva tiene que
 *    superar a la anterior por el mismo incremento que las subastas. Ofertar el "comprá ya" (o más) cierra la venta en el acto
 *    a ese precio.
 *  - Las ofertas están abiertas hasta `ends_at`; después el dueño tiene hasta `decide_until` para aceptar la mejor (puede aceptarla
 *    antes, cuando quiera). Si no acepta, o nadie ofertó, se cierra sin venta y se libera la plata reservada.
 *  - Quien va ganando tiene su oferta RESERVADA en match_players.reserved (no puede ofertar plata que no tiene). Al ser superado,
 *    se libera. Es el mismo campo que usan las subastas, así que "disponible" ya descuenta ambas cosas.
 *  - La venta mueve plata en el mismo libro: el comprador asienta una "compra" y el vendedor una "venta" por lo que cobra
 *    (precio menos la comisión del banco). Claves "oferta-{id}", únicas por jugador y partida.
 *  - Orden de bloqueos SIEMPRE el de EconomyService: partida (compartido) -> propiedad -> oferta -> jugadores (por id).
 *  - Cerrar es idempotente y lo puede pedir cualquiera: solo cierra si venció. Una oferta no puede quedar viva después del fin
 *    de la partida ni de que alguno de los dos deje de jugar: MatchService las cancela (liberando la reserva).
 *  - Los avisos en vivo salen después de confirmar y, si Reverb está caído, no rompen nada.
 */
class OfferService
{
    public function __construct(private readonly EconomyService $economy) {}

    /**
     * El dueño pone su propiedad en oferta.
     *
     * @throws GameException
     */
    public function open(User $user, int $matchId, int $propertyId, int $minPrice, int $buyNowPrice): Offer
    {
        $cfg = config('formosa.offers');
        $floor = (int) $cfg['min_price'];
        if ($minPrice < $floor || $buyNowPrice <= $minPrice) {
            throw GameException::offerPrices($floor);
        }

        $offer = DB::transaction(function () use ($user, $matchId, $propertyId, $minPrice, $buyNowPrice, $cfg) {
            $match = $this->economy->liveMatch($matchId);
            Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
            $owner = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->value('owner_id');
            if ($owner === null || (int) $owner !== $user->id) {
                throw GameException::notYours();
            }
            $this->economy->lockPlayer($matchId, $user->id);
            if (Offer::where('match_id', $matchId)->where('active_property_id', $propertyId)->exists()) {
                throw GameException::alreadyOffered();
            }
            $open = Offer::where('match_id', $matchId)->where('seller_id', $user->id)->whereNotNull('active_property_id')->count();
            if ($open >= (int) $cfg['max_open_per_seller']) {
                throw GameException::tooManyOffers((int) $cfg['max_open_per_seller']);
            }

            $now = now();
            $endsAt = $now->copy()->addSeconds((int) $cfg['duration_seconds'])->ceilSecond();
            // Nunca más allá del fin de la partida: una oferta que vence después no se podría cobrar (la cancelaría el cierre).
            if ($match->ends_at !== null && $endsAt->greaterThan($match->ends_at)) {
                $endsAt = $match->ends_at->copy();
            }
            $decide = $endsAt->copy()->addSeconds((int) $cfg['decide_seconds']);
            if ($match->ends_at !== null && $decide->greaterThan($match->ends_at)) {
                $decide = $match->ends_at->copy();
            }

            $offer = new Offer;
            $offer->forceFill([
                'match_id' => $matchId, 'property_id' => $propertyId, 'seller_id' => $user->id, 'status' => 'abierta',
                'min_price' => $minPrice, 'buy_now_price' => $buyNowPrice, 'ends_at' => $endsAt, 'decide_until' => $decide,
                'active_property_id' => $propertyId,
            ])->save();

            return $offer;
        }, attempts: 3);

        Announcer::offer($offer);
        RoomNotices::offerOpened($matchId, $user->name, $propertyId, $minPrice, actorId: $user->id);

        return $offer->fresh();
    }

    /**
     * Ofrece plata por una propiedad en oferta. Tiene que alcanzar el mínimo del dueño y superar la oferta actual; si llega al
     * "comprá ya", la compra se cierra al precio de "comprá ya".
     *
     * @return array{offer: Offer, sold: bool, balance: int, reserved: int}
     *
     * @throws GameException
     */
    public function bid(User $user, int $offerId, int $amount): array
    {
        $cfg = config('formosa.offers');
        $first = Offer::find($offerId) ?? throw GameException::offerNotFound();

        try {
            $out = DB::transaction(function () use ($user, $offerId, $amount, $cfg, $first) {
                $match = $this->economy->liveMatch($first->match_id);
                Property::query()->lockForUpdate()->find($first->property_id);
                $offer = Offer::query()->lockForUpdate()->find($offerId) ?? throw GameException::offerNotFound();
                if (! $offer->isActive()) {
                    throw GameException::offerClosed();
                }
                $now = now();
                if ($offer->ends_at->lessThanOrEqualTo($now)) {
                    throw GameException::offerEnded($offer->id);
                }
                if ($offer->seller_id === $user->id) {
                    throw GameException::ownOffer();
                }
                if ($offer->leader_id === $user->id && $offer->current_bid === $amount) {
                    return ['offer' => $offer, 'sold' => false, 'wallet' => MatchPlayer::where('match_id', $offer->match_id)->where('user_id', $user->id)->firstOrFail(), 'replayed' => true]; // reintento de la misma oferta
                }
                $min = AuctionRules::offerMinNext($offer->current_bid, $offer->min_price, $offer->buy_now_price);
                if ($amount < $min) {
                    throw GameException::offerLowBid($min);
                }
                $price = min($amount, $offer->buy_now_price);
                $buyNow = $amount >= $offer->buy_now_price;

                // Jugadores en orden de id: el que oferta, el vendedor (si se compra ya) y el que iba ganando.
                $ids = array_values(array_unique(array_filter([$user->id, $buyNow ? $offer->seller_id : null, $offer->leader_id])));
                $wallets = MatchPlayer::where('match_id', $offer->match_id)->whereIn('user_id', $ids)->whereNull('left_at')->orderBy('id')->lockForUpdate()->get()->keyBy('user_id');
                $mine = $wallets[$user->id] ?? throw GameException::notInMatch();
                $this->economy->settleIncome($match, $mine);
                // Si el que iba ganando es él mismo, su reserva anterior se libera antes de pedir la nueva.
                $own = $offer->leader_id === $user->id ? (int) $offer->current_bid : 0;
                if ($mine->available() + $own < $price) {
                    throw GameException::insufficientFunds($price, $mine->available() + $own);
                }
                if ($offer->leader_id !== $user->id) {
                    $leading = Offer::where('match_id', $offer->match_id)->where('leader_id', $user->id)->whereNotNull('active_property_id')->count();
                    if ($leading >= (int) $cfg['max_leading_per_user']) {
                        throw GameException::tooManyLeading((int) $cfg['max_leading_per_user']);
                    }
                }

                if ($offer->leader_id !== null && isset($wallets[$offer->leader_id])) {
                    $this->release($wallets[$offer->leader_id]->id, (int) $offer->current_bid);
                    if ($offer->leader_id === $user->id) {
                        $mine->reserved -= (int) $offer->current_bid;
                    }
                }

                if ($buyNow) {
                    $seller = $wallets[$offer->seller_id] ?? throw GameException::notInMatch();
                    $this->economy->settleIncome($match, $seller);
                    $this->recordBid($offer->id, $user->id, $price);
                    // La reserva del que iba ganando ya se liberó arriba: se olvida para que una cancelación no la libere dos veces.
                    $offer->forceFill(['leader_id' => null, 'current_bid' => null]);
                    $this->complete($offer, $match, $mine, $seller, $price, reservedByBuyer: 0);

                    return ['offer' => $offer, 'sold' => true, 'wallet' => MatchPlayer::find($mine->id), 'replayed' => false];
                }

                $this->reserve($mine->id, $price);
                $this->recordBid($offer->id, $user->id, $price);
                $offer->forceFill(['leader_id' => $user->id, 'current_bid' => $price, 'bids_count' => $offer->bids_count + 1])->save();

                return ['offer' => $offer, 'sold' => false, 'wallet' => MatchPlayer::find($mine->id), 'replayed' => false];
            }, attempts: 3);
        } catch (GameException $e) {
            if ($e->errorCode === 'oferta_terminada') {
                $this->settle($offerId); // venció mientras se ofertaba: se cierra ahora (si no hay oferta ni decisión pendiente)
            }
            throw $e;
        }

        if (! $out['replayed']) {
            $this->announce($out['offer'], $out['sold'], triggeredBy: $user);
        }

        return ['offer' => $out['offer']->fresh(), 'sold' => $out['sold'], 'balance' => (int) $out['wallet']->cash, 'reserved' => (int) $out['wallet']->reserved];
    }

    /**
     * El dueño acepta la mejor oferta actual. Tiene que haber alguna y no haber vencido el plazo para decidir.
     *
     * @throws GameException
     */
    public function accept(User $user, int $offerId): Offer
    {
        $first = Offer::find($offerId) ?? throw GameException::offerNotFound();

        try {
            $offer = DB::transaction(function () use ($user, $offerId, $first) {
                $match = $this->economy->liveMatch($first->match_id);
                Property::query()->lockForUpdate()->find($first->property_id);
                $offer = Offer::query()->lockForUpdate()->find($offerId) ?? throw GameException::offerNotFound();
                if ($offer->seller_id !== $user->id) {
                    throw GameException::notYours();
                }
                if (! $offer->isActive()) {
                    throw GameException::offerClosed();
                }
                if ($offer->decide_until->lessThanOrEqualTo(now())) {
                    throw GameException::offerEnded($offer->id);
                }
                if ($offer->leader_id === null) {
                    throw GameException::noBids();
                }

                $wallets = MatchPlayer::where('match_id', $offer->match_id)->whereIn('user_id', [$offer->seller_id, $offer->leader_id])->whereNull('left_at')->orderBy('id')->lockForUpdate()->get()->keyBy('user_id');
                $seller = $wallets[$offer->seller_id] ?? throw GameException::notInMatch();
                $buyer = $wallets[$offer->leader_id] ?? null;
                $this->economy->settleIncome($match, $seller);
                if ($buyer === null) {
                    $this->cancelLocked($offer);

                    return $offer;
                }
                $this->economy->settleIncome($match, $buyer);
                $this->complete($offer, $match, $buyer, $seller, (int) $offer->current_bid, reservedByBuyer: (int) $offer->current_bid);

                return $offer;
            }, attempts: 3);
        } catch (GameException $e) {
            if ($e->errorCode === 'oferta_terminada') {
                $this->settle($offerId);
            }
            throw $e;
        }

        $this->announce($offer, $offer->status->value === 'vendida', triggeredBy: $user);

        return $offer->fresh();
    }

    /**
     * El dueño retira su oferta (con o sin ofertas hechas) y se libera la plata de quien iba ganando.
     *
     * @throws GameException
     */
    public function cancel(User $user, int $offerId): Offer
    {
        $first = Offer::find($offerId) ?? throw GameException::offerNotFound();
        $offer = DB::transaction(function () use ($user, $offerId, $first) {
            $this->economy->liveMatch($first->match_id);
            Property::query()->lockForUpdate()->find($first->property_id);
            $offer = Offer::query()->lockForUpdate()->find($offerId) ?? throw GameException::offerNotFound();
            if ($offer->seller_id !== $user->id) {
                throw GameException::notYours();
            }
            if (! $offer->isActive()) {
                throw GameException::offerClosed();
            }
            if ($offer->leader_id !== null) {
                MatchPlayer::where('match_id', $offer->match_id)->where('user_id', $offer->leader_id)->lockForUpdate()->first();
            }
            $this->cancelLocked($offer);

            return $offer;
        }, attempts: 3);

        Announcer::offer($offer);

        return $offer->fresh();
    }

    /**
     * Cierra la oferta SI ya corresponde (si no, no hace nada): sin ofertas, apenas vence el plazo de ofertar; con ofertas, cuando
     * vence el plazo del dueño para decidir. Seguro de llamar desde cualquier lado y varias veces. Una oferta que vence DESPUÉS del
     * fin de la partida no se toca: la cancela el cierre de la partida (MatchService::finish).
     */
    public function settle(int $offerId): ?Offer
    {
        $first = Offer::find($offerId);
        if (! $first || ! $first->isActive() || ! $this->isDue($first)) {
            return $first;
        }

        $closed = DB::transaction(function () use ($offerId, $first) {
            $match = GameMatch::query()->sharedLock()->find($first->match_id);
            if (! $match || $match->status !== MatchStatus::Running) {
                return null;
            }
            Property::query()->lockForUpdate()->find($first->property_id);
            $offer = Offer::query()->lockForUpdate()->find($offerId);
            if (! $offer->isActive() || ! $this->isDue($offer)) {
                return null;
            }
            if ($offer->leader_id !== null) {
                MatchPlayer::where('match_id', $offer->match_id)->where('user_id', $offer->leader_id)->lockForUpdate()->first();
            }
            $this->finishLocked($offer, 'cerrada');

            return $offer;
        }, attempts: 3);

        if ($closed === null) {
            return Offer::find($offerId);
        }
        Announcer::offer($closed);

        return $closed->fresh();
    }

    /** Cierra las vencidas, hasta `$limit` por pasada (el reloj del servidor usa el máximo; las lecturas públicas, pocas). */
    public function settleDue(int $limit = 50, ?int $matchId = null): int
    {
        $closed = 0;
        foreach ($this->dueIds($limit, $matchId) as $id) {
            try {
                if ($this->settle($id)?->isActive() === false) {
                    $closed++;
                }
            } catch (\Throwable $e) {
                report($e); // una oferta con problemas no frena a las demás; se reintenta en la próxima vuelta
            }
        }

        return $closed;
    }

    public function hasDue(?int $matchId = null): bool
    {
        return $this->dueIds(1, $matchId) !== [];
    }

    /**
     * Cancela las ofertas abiertas de una partida y libera la plata reservada: todas, o solo las que tienen que ver con `$userId`
     * (las que puso como dueño y las que iba ganando). Se llama DENTRO de la transacción de MatchService (que ya tiene la partida
     * en exclusiva). Devuelve las canceladas para que quien llama las anuncie DESPUÉS de confirmar.
     *
     * @return list<Offer>
     */
    public function cancelActive(int $matchId, ?int $userId = null): array
    {
        $offers = Offer::query()->where('match_id', $matchId)->whereNotNull('active_property_id')
            ->when($userId !== null, fn ($q) => $q->where(fn ($w) => $w->where('seller_id', $userId)->orWhere('leader_id', $userId)))
            ->orderBy('id')->lockForUpdate()->get();

        foreach ($offers as $o) {
            $this->cancelLocked($o);
        }

        return $offers->all();
    }

    /** @return list<array<string, mixed>> */
    public function activeForPublic(int $matchId): array
    {
        return Offer::query()->where('match_id', $matchId)->whereNotNull('active_property_id')->with('seller:id,name', 'leader:id,name')->orderBy('id')->get()
            ->map(fn (Offer $o) => $o->toPublic())->all();
    }

    // ------------------------------------------------------------------ interno

    /** ¿Ya no tiene sentido seguir esperando? Sin ofertas: al vencer el plazo de ofertar. Con ofertas: al vencer el del dueño. */
    private function isDue(Offer $offer): bool
    {
        $at = $offer->leader_id === null ? $offer->ends_at : $offer->decide_until;

        return $at->lessThanOrEqualTo(now());
    }

    /** @return list<int> */
    private function dueIds(int $limit, ?int $matchId): array
    {
        $now = now()->toDateTimeString();

        return Offer::query()->whereNotNull('active_property_id')
            ->where(fn ($q) => $q->where(fn ($w) => $w->whereNull('leader_id')->where('ends_at', '<=', $now))->orWhere(fn ($w) => $w->whereNotNull('leader_id')->where('decide_until', '<=', $now)))
            ->when($matchId !== null, fn ($q) => $q->where('match_id', $matchId))
            ->orderBy('decide_until')->limit($limit)->pluck('id')->map(fn ($id) => (int) $id)->all();
    }

    /**
     * Traspasa la propiedad y la plata. Todo está bloqueado por quien llama (partida, propiedad, oferta, ambos jugadores) y el
     * ingreso de los dos ya está liquidado. `$reservedByBuyer` = lo que el comprador tenía reservado por esta oferta (se descuenta
     * de su reserva al cobrarle).
     */
    private function complete(Offer $offer, GameMatch $match, MatchPlayer $buyer, MatchPlayer $seller, int $price, int $reservedByBuyer): void
    {
        $owner = DB::table('match_properties')->where('match_id', $offer->match_id)->where('property_id', $offer->property_id)->value('owner_id');
        $ok = $owner !== null && (int) $owner === $offer->seller_id && $seller->left_at === null && $buyer->left_at === null
            && $buyer->cash >= $price && $buyer->reserved - $reservedByBuyer >= 0;
        if (! $ok) {
            // No debería ocurrir (la plata está reservada y las salidas cancelan las ofertas). Si pasa, se cancela sin tocar saldos.
            Log::error('Oferta cancelada: no se pudo cobrar', ['offer' => $offer->id]);
            $this->finishLocked($offer, 'cancelada');

            return;
        }

        $split = AuctionRules::offerSplit($price, (int) config('formosa.offers.fee_pct'));
        $now = now()->toDateTimeString();
        $buyerCash = $buyer->cash - $price;
        $sellerCash = $seller->cash + $split['net'];
        DB::table('match_players')->where('id', $buyer->id)->update(['cash' => $buyerCash, 'reserved' => $buyer->reserved - $reservedByBuyer, 'updated_at' => $now]);
        DB::table('match_players')->where('id', $seller->id)->update(['cash' => $sellerCash, 'updated_at' => $now]);
        DB::table('match_properties')->where('match_id', $offer->match_id)->where('property_id', $offer->property_id)
            ->update(['owner_id' => $buyer->user_id, 'bought_at' => $now, 'price_paid' => $price]);
        LedgerEntry::forceCreate([
            'match_id' => $offer->match_id, 'user_id' => $buyer->user_id, 'type' => LedgerType::Compra, 'amount' => -$price,
            'balance_after' => $buyerCash, 'property_id' => $offer->property_id, 'idempotency_key' => "oferta-{$offer->id}",
        ]);
        LedgerEntry::forceCreate([
            'match_id' => $offer->match_id, 'user_id' => $seller->user_id, 'type' => LedgerType::Venta, 'amount' => $split['net'],
            'balance_after' => $sellerCash, 'property_id' => $offer->property_id, 'idempotency_key' => "oferta-{$offer->id}",
        ]);
        $offer->forceFill([
            'status' => 'vendida', 'buyer_id' => $buyer->user_id, 'leader_id' => $buyer->user_id, 'current_bid' => $offer->current_bid,
            'sold_price' => $price, 'active_property_id' => null, 'closed_at' => $now,
        ])->save();
    }

    /** Cancela una oferta abierta (la oferta y el jugador que iba ganando ya están bloqueados por quien llama). */
    private function cancelLocked(Offer $offer): void
    {
        $this->finishLocked($offer, 'cancelada');
    }

    /** Cierra sin venta ('cerrada' o 'cancelada') y libera la reserva del que iba ganando. */
    private function finishLocked(Offer $offer, string $status): void
    {
        if ($offer->leader_id !== null && $offer->current_bid !== null) {
            DB::table('match_players')->where('match_id', $offer->match_id)->where('user_id', $offer->leader_id)
                ->update(['reserved' => DB::raw('CASE WHEN reserved >= '.(int) $offer->current_bid.' THEN reserved - '.(int) $offer->current_bid.' ELSE 0 END'), 'updated_at' => now()->toDateTimeString()]);
        }
        $offer->forceFill(['status' => $status, 'active_property_id' => null, 'closed_at' => now()->toDateTimeString()])->save();
    }

    /** Avisos en vivo y de sala, DESPUÉS de confirmar. */
    private function announce(Offer $offer, bool $sold, ?User $triggeredBy = null): void
    {
        Announcer::offer($offer);
        if (! $sold || $offer->status->value !== 'vendida') {
            return;
        }
        $fresh = $offer->fresh();
        $names = User::whereIn('id', [$fresh->seller_id, $fresh->buyer_id])->pluck('name', 'id');
        Announcer::owner($fresh->match_id, $fresh->property_id, $fresh->buyer_id, $names[$fresh->buyer_id] ?? null);
        RoomNotices::offerSold($fresh->match_id, (string) ($names[$fresh->seller_id] ?? ''), (string) ($names[$fresh->buyer_id] ?? ''), $fresh->property_id, (int) $fresh->sold_price, actorId: $triggeredBy?->id);
    }

    private function reserve(int $walletId, int $amount): void
    {
        DB::table('match_players')->where('id', $walletId)->update(['reserved' => DB::raw('reserved + '.(int) $amount), 'updated_at' => now()->toDateTimeString()]);
    }

    private function release(int $walletId, int $amount): void
    {
        DB::table('match_players')->where('id', $walletId)->update(['reserved' => DB::raw('reserved - '.(int) $amount), 'updated_at' => now()->toDateTimeString()]);
    }

    private function recordBid(int $offerId, int $userId, int $amount): void
    {
        OfferBid::forceCreate(['offer_id' => $offerId, 'user_id' => $userId, 'amount' => $amount]);
    }
}
