<?php

namespace App\Economy;

use App\Enums\AuctionStatus;
use App\Enums\LedgerType;
use App\Enums\MatchStatus;
use App\Models\Auction;
use App\Models\AuctionBid;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\Property;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Reclamo, disputa y subasta de propiedades. Todo es DE UNA PARTIDA: la misma propiedad puede estar en subasta en dos partidas a la vez.
 *
 * Reglas:
 *  - Orden de bloqueos SIEMPRE: partida (compartido) -> propiedad -> (subasta) -> jugadores (por id). Igual que EconomyService,
 *    así que ninguna operación espera a otra en círculo (y cerrar la partida, que la toma en exclusiva, no se cruza con una puja).
 *  - Toda operación sobre una propiedad toma el bloqueo de ESA propiedad: eso serializa lo que pase en su subasta.
 *  - Solo quien VA GANANDO tiene plata reservada (match_players.reserved = su puja actual). Al ser superado, se libera.
 *  - Disputar una reserva ajena es PUJAR (el mínimo): cuesta plata reservada y cuenta para el tope de subastas, así que
 *    no se puede usar para estirar los tiempos de otros gratis.
 *  - El reloj es el del servidor (`ends_at`). Cerrar es idempotente: cualquiera puede pedirlo, solo cierra si venció.
 *  - Al cerrar, la compra se asienta en el mismo libro que la compra directa (tipo "compra", clave "subasta-{id}").
 *  - Las subastas no pueden quedar vivas después del fin de la partida: MatchService las cierra o las cancela (liberando la reserva).
 *  - Los avisos en vivo salen después de confirmar y, si Reverb está caído, no rompen nada.
 */
class AuctionService
{
    public function __construct(private readonly EconomyService $economy) {}

    /**
     * El jugador quiere una propiedad.
     *  - Con ventana de disputa en 0: compra directa (comportamiento de la Fase 2).
     *  - Libre y sin disputa: queda reservada para él (se le reserva el precio de lista) y corre la ventana.
     *  - Reservada por otro y todavía en ventana: la disputa pujando el mínimo -> se abre la subasta con tiempo límite.
     *
     * @throws GameException
     */
    public function claim(User $user, int $matchId, int $propertyId, ?string $idempotencyKey = null): ClaimResult
    {
        if ((int) config('formosa.auction.dispute_seconds') <= 0) {
            $r = $this->economy->buy($user, $matchId, $propertyId, $idempotencyKey);

            return new ClaimResult('comprada', $r->propertyId, $r->price, $r->balance, replayed: $r->replayed);
        }

        try {
            return $this->claimOnce($user, $matchId, $propertyId);
        } catch (GameException $e) {
            if ($e->errorCode === 'reclamo_competido') {
                // Otro la reservó y sigue en su ventana: se la disputa pujando el mínimo. "Solo si sigue en disputa":
                // si mientras tanto se abrió la subasta, no se puja a ciegas (el jugador tiene que ver el precio nuevo).
                $r = $this->bid($user, (int) $e->context['auction'], null, AuctionStatus::Disputa);
                RoomNotices::contested($matchId, $user->name, $propertyId, $r->auction->current_bid, actorId: $user->id);

                return new ClaimResult('disputada', $propertyId, $r->auction->list_price, $r->balance, $r->auction);
            }
            if ($e->errorCode === 'subasta_terminada') {
                // La ventana venció justo ahora: se cierra (se la lleva quien la reservó) y a este jugador se le avisa.
                $this->settle((int) $e->context['auction']);
                throw GameException::taken(false);
            }
            throw $e;
        }
    }

    /** @throws GameException */
    private function claimOnce(User $user, int $matchId, int $propertyId): ClaimResult
    {
        $cfg = config('formosa.auction');

        [$result, $auction, $price, $balance] = DB::transaction(function () use ($user, $matchId, $propertyId, $cfg) {
            $match = $this->economy->liveMatch($matchId);
            $property = Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
            $owner = DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->value('owner_id');
            if ($owner !== null) {
                throw GameException::taken((int) $owner === $user->id);
            }
            // El jugador se bloquea ANTES de las lecturas simples de abajo: así esas lecturas ya ven todo lo confirmado
            // por otro pedido del mismo jugador (si no, dos reclamos a la vez podrían pasar el tope de subastas).
            $wallet = $this->economy->lockPlayer($matchId, $user->id);
            $this->economy->settleIncome($match, $wallet);
            $now = now();

            // La fila de la propiedad (ya bloqueada) serializa todo lo de esta propiedad, así que acá alcanza con leer.
            // NO se usa lockForUpdate() sobre esta búsqueda: si no hay subasta, InnoDB bloquearía el "hueco" del índice
            // único y dos reclamos sobre propiedades distintas se trabarían entre sí al insertar (deadlock).
            $auction = Auction::where('match_id', $matchId)->where('active_property_id', $property->id)->first();

            if ($auction) {
                if ($auction->leader_id === $user->id) {
                    return ['en_curso', $auction, $property->price, $wallet->cash]; // mismo pedido repetido: no es un error
                }
                if ($auction->ends_at->lessThanOrEqualTo($now)) {
                    throw GameException::auctionEnded($auction->id); // la ventana ya venció: no se puede disputar
                }
                if ($auction->status !== AuctionStatus::Disputa) {
                    throw GameException::inAuction(); // ya hay subasta abierta: se entra pujando
                }
                throw GameException::contested($auction->id);
            }

            $price = app(SprintService::class)->price($match, $user->id, $property->price); // remontada del sprint final
            if ($wallet->available() < $price) {
                throw GameException::insufficientFunds($price, $wallet->available());
            }
            $leading = Auction::where('match_id', $matchId)->where('leader_id', $user->id)->whereNotNull('active_property_id')->count();
            if ($leading >= (int) $cfg['max_active_per_user']) {
                throw GameException::tooManyAuctions((int) $cfg['max_active_per_user']);
            }

            $auction = new Auction;
            $auction->forceFill([
                'match_id' => $matchId, 'property_id' => $property->id, 'starter_id' => $user->id, 'leader_id' => $user->id,
                'status' => AuctionStatus::Disputa, 'list_price' => $price, 'current_bid' => $price,
                'ends_at' => $this->deadline($now, (int) $cfg['dispute_seconds']),
                'active_property_id' => $property->id,
            ])->save();
            $this->reserve($wallet->id, $price);
            $this->recordBid($auction->id, $user->id, $price);

            return ['reclamada', $auction, $price, $wallet->cash];
        }, attempts: 3);

        if ($result !== 'en_curso') {
            Announcer::auction($auction);
        }
        if ($result === 'reclamada') {
            RoomNotices::claimed($matchId, $user->name, $propertyId, $price, actorId: $user->id);
        }

        return new ClaimResult($result, $propertyId, $price, $balance, $auction, replayed: $result === 'en_curso');
    }

    /**
     * Abre una subasta relámpago (sprint final) de una propiedad libre: la abre el juego, arranca a `flash_start_pct` % del precio de
     * lista, dura `flash_seconds`, no se prorroga y no tiene líder hasta la primera puja. null si la propiedad ya no está libre.
     */
    public function openFlash(int $matchId, int $propertyId): ?Auction
    {
        $cfg = config('formosa.sprint');
        $auction = DB::transaction(function () use ($matchId, $propertyId, $cfg) {
            $this->economy->liveMatch($matchId);
            $property = Property::query()->lockForUpdate()->find($propertyId);
            if (! $property
                || DB::table('match_properties')->where('match_id', $matchId)->where('property_id', $propertyId)->exists()
                || Auction::where('match_id', $matchId)->where('active_property_id', $propertyId)->exists()) {
                return null;
            }
            $start = AuctionRules::discounted((int) $property->price, 100 - (int) $cfg['flash_start_pct']);
            $now = now();
            $a = new Auction;
            $a->forceFill([
                'match_id' => $matchId, 'property_id' => $property->id, 'starter_id' => null, 'leader_id' => null,
                'status' => AuctionStatus::Abierta, 'flash' => true, 'list_price' => $start, 'current_bid' => $start,
                'ends_at' => $this->deadline($now, (int) $cfg['flash_seconds']), 'contested_at' => $now, 'active_property_id' => $property->id,
            ])->save();

            return $a;
        }, attempts: 3);

        if ($auction !== null) {
            Announcer::auction($auction);
        }

        return $auction;
    }

    /**
     * Puja. Tiene que superar la actual por el mínimo, y el jugador tiene que tener ese dinero DISPONIBLE.
     * Su plata queda reservada y la de quien iba ganando se libera.
     *
     * @param  int|null  $amount  null = el mínimo vigente (así disputa `claim()` una reserva ajena)
     * @param  AuctionStatus|null  $onlyIfStatus  si se indica y la subasta ya está en otro estado, no puja
     *
     * @throws GameException
     */
    public function bid(User $user, int $auctionId, ?int $amount, ?AuctionStatus $onlyIfStatus = null): BidResult
    {
        $cfg = config('formosa.auction');
        $first = Auction::find($auctionId) ?? throw GameException::auctionNotFound();

        try {
            [$auction, $wallet, $replayed] = DB::transaction(function () use ($user, $auctionId, $amount, $cfg, $first, $onlyIfStatus) {
                $match = $this->economy->liveMatch($first->match_id);
                Property::query()->lockForUpdate()->find($first->property_id);
                $auction = Auction::query()->lockForUpdate()->find($auctionId) ?? throw GameException::auctionNotFound();
                if (! $auction->isActive()) {
                    throw GameException::auctionClosed();
                }
                $now = now();
                if ($auction->ends_at->lessThanOrEqualTo($now)) {
                    throw GameException::auctionEnded($auction->id);
                }
                if ($onlyIfStatus !== null && $auction->status !== $onlyIfStatus) {
                    throw GameException::inAuction();
                }

                // Sin líder (relámpago sin pujas) alcanza con igualar el precio de salida; con líder, hay que superarlo.
                $min = $auction->leader_id === null ? $auction->current_bid : AuctionRules::minNextBid($auction->current_bid, ...AuctionRules::configured());
                if ($auction->leader_id === $user->id) {
                    if ($amount !== null && $auction->current_bid === $amount) {
                        return [$auction, MatchPlayer::where('match_id', $auction->match_id)->where('user_id', $user->id)->firstOrFail(), true]; // reintento de la misma puja
                    }
                    throw GameException::alreadyLeading();
                }
                $amount ??= $min;
                if ($amount < $min) {
                    throw GameException::lowBid($min);
                }

                // Jugadores en orden de id: el que puja y el que iba ganando.
                $wallets = MatchPlayer::where('match_id', $auction->match_id)->whereIn('user_id', array_filter([$user->id, $auction->leader_id]))->whereNull('left_at')->orderBy('id')->lockForUpdate()->get()->keyBy('user_id');
                $mine = $wallets[$user->id] ?? throw GameException::notInMatch();
                $this->economy->settleIncome($match, $mine);
                if ($mine->available() < $amount) {
                    throw GameException::insufficientFunds($amount, $mine->available());
                }
                $leading = Auction::where('match_id', $auction->match_id)->where('leader_id', $user->id)->whereNotNull('active_property_id')->count();
                if ($leading >= (int) $cfg['max_active_per_user']) {
                    throw GameException::tooManyAuctions((int) $cfg['max_active_per_user']);
                }

                if ($auction->leader_id !== null) {
                    $this->release($wallets[$auction->leader_id]->id, $auction->current_bid);
                }
                $this->reserve($mine->id, $amount);
                $this->recordBid($auction->id, $user->id, $amount);

                $changes = ['leader_id' => $user->id, 'current_bid' => $amount];
                if ($auction->status === AuctionStatus::Disputa) {
                    // Pujar sobre una propiedad apenas reservada también es disputarla: se abre la subasta.
                    $changes += ['status' => AuctionStatus::Abierta, 'contested_at' => $now, 'ends_at' => $this->deadline($now, (int) $cfg['duration_seconds'])];
                } elseif (! $auction->flash && $end = AuctionRules::extendedEnd($auction->ends_at, $now, $auction->extensions, (int) $cfg['snipe_window_seconds'], (int) $cfg['snipe_extend_seconds'], (int) $cfg['max_extensions'])) {
                    $changes += ['ends_at' => $end->ceilSecond(), 'extensions' => $auction->extensions + 1];
                }
                $auction->forceFill($changes)->save();

                return [$auction, MatchPlayer::where('match_id', $auction->match_id)->where('user_id', $user->id)->firstOrFail(), false];
            }, attempts: 3);
        } catch (GameException $e) {
            if ($e->errorCode === 'subasta_terminada') {
                $this->settle($auctionId); // venció mientras se pujaba: se cierra ahora
            }
            throw $e;
        }

        if (! $replayed) {
            Announcer::auction($auction);
        }

        return new BidResult($auction, $wallet->cash, $wallet->reserved, $replayed);
    }

    /**
     * Cierra la subasta SI ya venció (si no, no hace nada). Seguro de llamar desde cualquier lado y varias veces:
     * el navegador, el reloj del servidor o una lectura pueden pedirlo a la vez; solo el primero cierra.
     * Una subasta que vence DESPUÉS del fin de la partida no se cobra: la cancela el cierre de la partida (MatchService::finish).
     */
    public function settle(int $auctionId): ?Auction
    {
        $first = Auction::find($auctionId);
        if (! $first || ! $first->isActive() || $first->ends_at->greaterThan(now())) {
            return $first; // no existe, ya está cerrada, o todavía no venció: sin tomar ningún bloqueo (el endpoint es público)
        }

        $outcome = DB::transaction(function () use ($auctionId, $first) {
            $match = GameMatch::query()->sharedLock()->find($first->match_id);
            if (! $match || $match->status !== MatchStatus::Running || $first->ends_at->greaterThan($match->ends_at)) {
                return null; // la partida ya cerró (y canceló sus subastas) o va a cerrar antes de que esta termine
            }
            $property = Property::query()->lockForUpdate()->find($first->property_id);
            $auction = Auction::query()->lockForUpdate()->find($auctionId);
            if (! $auction->isActive() || $auction->ends_at->greaterThan(now())) {
                return null; // otro la cerró antes, o la extendieron mientras tanto
            }

            if ($auction->leader_id === null) {
                // Relámpago sin pujas: nadie paga ni cobra, la propiedad sigue libre.
                $auction->forceFill(['status' => AuctionStatus::Cancelada, 'active_property_id' => null, 'closed_at' => now()])->save();

                return ['auction' => $auction, 'sold' => false];
            }
            $wallet = MatchPlayer::where('match_id', $auction->match_id)->where('user_id', $auction->leader_id)->lockForUpdate()->firstOrFail();
            $this->economy->settleIncome($match, $wallet);
            $now = now();
            $taken = DB::table('match_properties')->where('match_id', $auction->match_id)->where('property_id', $property->id)->exists();
            $ok = ! $taken && $wallet->left_at === null && $wallet->cash >= $auction->current_bid && $wallet->reserved >= $auction->current_bid;

            if (! $ok) {
                // No debería ocurrir (la plata está reservada). Si pasa, se libera todo y se cancela, sin tocar saldos.
                Log::error('Subasta cancelada: no se pudo cobrar', ['auction' => $auction->id]);
                $this->release($wallet->id, min($wallet->reserved, $auction->current_bid));
                $auction->forceFill(['status' => AuctionStatus::Cancelada, 'active_property_id' => null, 'closed_at' => $now])->save();

                return ['auction' => $auction, 'sold' => false];
            }

            $cash = $wallet->cash - $auction->current_bid;
            DB::table('match_players')->where('id', $wallet->id)->update([
                'cash' => $cash, 'reserved' => $wallet->reserved - $auction->current_bid, 'updated_at' => $now->toDateTimeString(),
            ]);
            DB::table('match_properties')->insert([
                'match_id' => $auction->match_id, 'property_id' => $property->id, 'owner_id' => $auction->leader_id,
                'bought_at' => $now->toDateTimeString(), 'price_paid' => $auction->current_bid,
            ]);
            LedgerEntry::forceCreate([
                'match_id' => $auction->match_id, 'user_id' => $auction->leader_id, 'type' => LedgerType::Compra, 'amount' => -$auction->current_bid,
                'balance_after' => $cash, 'property_id' => $property->id, 'idempotency_key' => "subasta-{$auction->id}",
            ]);
            $auction->forceFill([
                'status' => AuctionStatus::Cerrada, 'winner_id' => $auction->leader_id, 'active_property_id' => null, 'closed_at' => $now,
            ])->save();

            return ['auction' => $auction, 'sold' => true];
        }, attempts: 3);

        if ($outcome === null) {
            return Auction::find($auctionId);
        }

        $auction = $outcome['auction'];
        Announcer::auction($auction);
        if ($outcome['sold']) {
            $name = User::whereKey($auction->winner_id)->value('name');
            Announcer::owner($auction->match_id, $auction->property_id, $auction->winner_id, $name);
            // Disputada (hubo subasta de verdad) = "ganó la subasta"; si nadie la disputó, fue una compra al precio de lista.
            RoomNotices::purchase($auction->match_id, (string) $name, $auction->property_id, $auction->current_bid, auction: $auction->contested_at !== null, actorId: $auction->winner_id);
        }

        return $auction;
    }

    /**
     * Cierra las vencidas, hasta `$limit` por pasada. El reloj del servidor usa el máximo; las lecturas públicas, pocas
     * (cada cierre emite avisos en vivo y no conviene que un GET haga mucho trabajo).
     */
    public function settleDue(int $limit = 50, ?int $matchId = null): int
    {
        $ids = Auction::query()->whereNotNull('active_property_id')->where('ends_at', '<=', now()->toDateTimeString())
            ->when($matchId !== null, fn ($q) => $q->where('match_id', $matchId))
            ->orderBy('ends_at')->limit($limit)->pluck('id');

        $closed = 0;
        foreach ($ids as $id) {
            try {
                if ($this->settle($id)?->isActive() === false) {
                    $closed++;
                }
            } catch (\Throwable $e) {
                report($e); // una subasta con problemas no frena a las demás; se reintenta en la próxima vuelta
            }
        }

        return $closed;
    }

    /**
     * Cancela las subastas activas de una partida (todas, o solo las que lidera `$leaderId`) y libera la plata reservada.
     * Se llama DENTRO de la transacción de MatchService (que ya tiene la partida en exclusiva). Devuelve las subastas canceladas
     * para que quien llama las anuncie DESPUÉS de confirmar.
     *
     * @return list<Auction>
     */
    public function cancelActive(int $matchId, ?int $leaderId = null): array
    {
        $auctions = Auction::query()->where('match_id', $matchId)->whereNotNull('active_property_id')
            ->when($leaderId !== null, fn ($q) => $q->where('leader_id', $leaderId))
            ->orderBy('id')->lockForUpdate()->get();

        $now = now()->toDateTimeString();
        foreach ($auctions as $a) {
            if ($a->leader_id !== null) {
                DB::table('match_players')->where('match_id', $matchId)->where('user_id', $a->leader_id)
                    ->update(['reserved' => DB::raw('reserved - '.(int) $a->current_bid), 'updated_at' => $now]);
            }
            $a->forceFill(['status' => AuctionStatus::Cancelada, 'active_property_id' => null, 'closed_at' => $now])->save();
        }

        return $auctions->all();
    }

    /** @return list<array<string, mixed>> */
    public function activeForPublic(int $matchId): array
    {
        return Auction::query()->where('match_id', $matchId)->whereNotNull('active_property_id')->with('leader:id,name')->orderBy('id')->get()
            ->map(fn (Auction $a) => $a->toPublic())->all();
    }

    public function hasDue(?int $matchId = null): bool
    {
        return Auction::query()->whereNotNull('active_property_id')->where('ends_at', '<=', now()->toDateTimeString())
            ->when($matchId !== null, fn ($q) => $q->where('match_id', $matchId))->exists();
    }

    /**
     * Plazo en segundos ENTEROS, redondeado hacia arriba: la base guarda `ends_at` sin fracciones, y así el plazo que se
     * le muestra a los jugadores es exactamente el que se guarda y nunca dura menos que lo configurado.
     */
    private function deadline(CarbonInterface $from, int $seconds): CarbonInterface
    {
        return $from->copy()->addSeconds($seconds)->ceilSecond();
    }

    private function reserve(int $walletId, int $amount): void
    {
        DB::table('match_players')->where('id', $walletId)->update(['reserved' => DB::raw('reserved + '.(int) $amount), 'updated_at' => now()->toDateTimeString()]);
    }

    private function release(int $walletId, int $amount): void
    {
        DB::table('match_players')->where('id', $walletId)->update(['reserved' => DB::raw('reserved - '.(int) $amount), 'updated_at' => now()->toDateTimeString()]);
    }

    private function recordBid(int $auctionId, int $userId, int $amount): void
    {
        AuctionBid::forceCreate(['auction_id' => $auctionId, 'user_id' => $userId, 'amount' => $amount]);
    }
}
