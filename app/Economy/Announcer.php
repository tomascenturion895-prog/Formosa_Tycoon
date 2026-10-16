<?php

namespace App\Economy;

use App\Events\ActivityFeed;
use App\Events\AuctionUpdated;
use App\Events\LobbyChanged;
use App\Events\MatchFinished;
use App\Events\MatchPlayersChanged;
use App\Events\MatchStarted;
use App\Events\OfferUpdated;
use App\Events\PropertyOwnerChanged;
use App\Models\Auction;
use App\Models\GameMatch;
use App\Models\Offer;

/**
 * Avisos en vivo (Reverb). Salen SIEMPRE después de confirmar la operación y, si el servidor de tiempo real está caído,
 * se registra el error pero nunca se rompe la compra, la subasta ni el cierre de la partida.
 */
final class Announcer
{
    /** Cambió el dueño de una propiedad en una partida (`$ownerId` null = quedó libre). Sube la versión del estado de ESA partida. */
    public static function owner(int $matchId, int $propertyId, ?int $ownerId, ?string $ownerName): void
    {
        OwnersVersion::bump($matchId);
        rescue(fn () => event(new PropertyOwnerChanged($matchId, $propertyId, $ownerId, $ownerName)), report: true);
    }

    /**
     * Aviso de actividad para el feed del mapa (ver ActivityFeed). Igual que los demás: después de confirmar y sin romper nada.
     *
     * @param  array<string, mixed>  $item
     */
    public static function activity(array $item): void
    {
        rescue(fn () => event(new ActivityFeed($item)), report: true);
    }

    public static function auction(Auction $auction): void
    {
        rescue(fn () => event(AuctionUpdated::from($auction)), report: true);
    }

    public static function offer(Offer $offer): void
    {
        rescue(fn () => event(OfferUpdated::from($offer)), report: true);
    }

    /** @param array<string, mixed> $data */
    public static function players(int $matchId, string $action, array $data = []): void
    {
        rescue(fn () => event(new MatchPlayersChanged($matchId, ['action' => $action] + $data)), report: true);
    }

    public static function started(GameMatch $match): void
    {
        $public = $match->toPublic();
        rescue(fn () => event(new MatchStarted($match->id, [
            'started_at' => $public['started_at'], 'ends_at' => $public['ends_at'], 'minutes_per_day' => $public['minutes_per_day'], 'server_now' => $public['server_now'],
        ])), report: true);
    }

    public static function finished(GameMatch $match): void
    {
        rescue(fn () => event(new MatchFinished($match->id, ['finished_at' => $match->finished_at?->getTimestampMs(), 'server_now' => now()->getTimestampMs()])), report: true);
    }

    /** El listado de salas abiertas cambió. `$open` = la sala sigue en el listado. */
    public static function lobby(GameMatch $match, int $players, bool $open): void
    {
        rescue(fn () => event(new LobbyChanged($match->toPublic($players), $open && $match->is_public)), report: true);
    }
}
