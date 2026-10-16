<?php

namespace App\Economy;

use App\Models\GameMatch;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Avisos automáticos del juego en el chat de la SALA (mensajes de sistema): compras, ventas, entradas y salidas, tiempo y fin.
 *
 * Reglas:
 *  - Se emiten DESPUÉS de confirmar la operación (igual que Announcer) y NUNCA la rompen: cualquier falla, hasta armar el
 *    texto, se registra y se sigue. Una compra no se revierte ni se demora porque el chat falle.
 *  - Una línea corta por hecho, en rioplatense, con montos formateados ($150.000).
 *  - Los que deben salir una sola vez por partida (inicio, fin, tiempo) llevan una clave de evento: aunque dos procesos lo
 *    pidan a la vez, la base guarda uno solo.
 *  - Solo van a la sala. El chat global no recibe avisos del juego.
 *  - Los hechos de propiedades (compra, venta, reclamo, disputa) además salen como ActivityFeed para las tarjetas del mapa. Esas
 *    tarjetas NO duplican el chat: reclamo y disputa no escriben en el chat (solo el cierre, que es lo que importa guardar).
 */
final class RoomNotices
{
    /** Compra directa, o reclamo que nadie disputó (`$auction` false), o subasta ganada (`$auction` true). */
    public static function purchase(int $matchId, string $buyer, int $propertyId, int $price, bool $auction = false, ?int $actorId = null): void
    {
        self::say($matchId, fn () => $auction
            ? "{$buyer} ganó la subasta de ".self::propertyLabel($propertyId).' por '.self::money($price)
            : "{$buyer} compró ".self::propertyLabel($propertyId).' por '.self::money($price));
        self::feed($matchId, $auction ? 'subasta_ganada' : 'compra', $actorId, $buyer, $propertyId, $price);
    }

    public static function sale(int $matchId, string $seller, int $propertyId, int $refund, ?int $actorId = null): void
    {
        self::say($matchId, fn () => "{$seller} vendió ".self::propertyLabel($propertyId).' al banco por '.self::money($refund));
        self::feed($matchId, 'venta', $actorId, $seller, $propertyId, $refund);
    }

    /** Alguien reservó una propiedad libre (corre la ventana de disputa). Solo tarjeta: el chat espera al cierre. */
    public static function claimed(int $matchId, string $name, int $propertyId, int $price, ?int $actorId = null): void
    {
        self::feed($matchId, 'reclamo', $actorId, $name, $propertyId, $price);
    }

    /** Alguien le disputó una reserva a otro jugador y se abrió la subasta. Solo tarjeta. */
    public static function contested(int $matchId, string $name, int $propertyId, int $price, ?int $actorId = null): void
    {
        self::feed($matchId, 'disputa', $actorId, $name, $propertyId, $price);
    }

    /** El dueño puso una propiedad en oferta. Solo tarjeta (el chat espera al cierre). */
    public static function offerOpened(int $matchId, string $seller, int $propertyId, int $minPrice, ?int $actorId = null): void
    {
        self::feed($matchId, 'oferta_abierta', $actorId, $seller, $propertyId, $minPrice);
    }

    /** Venta entre jugadores (aceptó el dueño o alguien pagó el "comprá ya"). */
    public static function offerSold(int $matchId, string $seller, string $buyer, int $propertyId, int $price, ?int $actorId = null): void
    {
        self::say($matchId, fn () => "{$seller} le vendió ".self::propertyLabel($propertyId)." a {$buyer} por ".self::money($price));
        self::feed($matchId, 'oferta_vendida', $actorId, $seller, $propertyId, $price, $buyer);
    }

    /** `$what`: joined (entró a la sala), left (salió de la sala de espera) o abandoned (abandonó la partida en juego). */
    public static function player(int $matchId, string $name, string $what): void
    {
        self::say($matchId, fn () => match ($what) {
            'joined' => "{$name} entró a la sala",
            'left' => "{$name} salió de la sala",
            'abandoned' => "{$name} abandonó la partida",
        });
    }

    public static function started(GameMatch $match): void
    {
        self::say($match->id, fn () => "¡Arrancó la partida! Son {$match->duration_minutes} minutos. ¡Suerte!", 'inicio');
    }

    public static function timeLeft(int $matchId, int $minutes): void
    {
        self::say($matchId, fn () => $minutes === 1 ? 'Queda 1 minuto' : "Quedan {$minutes} minutos", "falta-{$minutes}");
    }

    /** Cierre: nombra a quien ganó (o a los empatados en el primer puesto). Lee los puestos que ya guardó el cierre. */
    public static function finished(int $matchId): void
    {
        self::say($matchId, function () use ($matchId) {
            $winners = DB::table('match_players as mp')->join('users as u', 'u.id', '=', 'mp.user_id')
                ->where('mp.match_id', $matchId)->where('mp.final_rank', 1)->where('mp.abandoned', false)
                ->orderBy('mp.id')->get(['u.name', 'mp.final_net_worth']);
            if ($winners->isEmpty()) {
                return 'Terminó la partida, sin ganador';
            }
            if ($winners->count() === 1) {
                return "Terminó la partida. Ganó {$winners[0]->name} con ".self::money((int) $winners[0]->final_net_worth).' de patrimonio';
            }

            return 'Terminó la partida. Empataron en el primer puesto: '.$winners->pluck('name')->implode(', ');
        }, 'fin');
    }

    // ------------------------------------------------------------------ texto

    /** $150.000 (punto de miles, sin decimales: son pesos enteros). */
    public static function money(int $amount): string
    {
        return '$'.number_format($amount, 0, ',', '.');
    }

    /**
     * Cómo nombrar una propiedad: su nombre real; si no tiene, "Casa de calle X" (o el rubro) y, sin calle, "una casa".
     * Nunca lleva número de puerta (no se guarda) ni datos de personas.
     */
    public static function propertyLabel(int $propertyId): string
    {
        $p = DB::table('properties')->where('id', $propertyId)->first(['name', 'street', 'kind']);
        if (! $p) {
            return 'una propiedad';
        }
        $name = trim((string) $p->name);
        if ($name !== '') {
            return mb_strlen($name) > 70 ? mb_substr($name, 0, 69).'…' : $name;
        }
        $kind = (string) $p->kind;
        $street = trim((string) $p->street);
        if ($street !== '') {
            return ucfirst(self::kindWord($kind)).' de calle '.(mb_strlen($street) > 50 ? mb_substr($street, 0, 49).'…' : $street);
        }

        return (in_array($kind, ['casa'], true) ? 'una ' : 'un ').self::kindWord($kind);
    }

    private static function kindWord(string $kind): string
    {
        return mb_strtolower((string) config("formosa.kinds.{$kind}.label", 'propiedad'));
    }

    // ------------------------------------------------------------------ interno

    /** Aviso para las tarjetas del mapa. Mismo criterio que `say`: nunca rompe la operación que ya se confirmó. */
    private static function feed(int $matchId, string $type, ?int $actorId, string $actor, int $propertyId, int $amount, ?string $other = null): void
    {
        try {
            $at = now()->getTimestampMs();
            Announcer::activity([
                'match_id' => $matchId,
                'key' => "{$type}:{$propertyId}:{$at}",
                'type' => $type,
                'actor_id' => $actorId,
                'actor' => $actor,
                'other' => $other,
                'property_id' => $propertyId,
                'kind' => DB::table('properties')->where('id', $propertyId)->value('kind'),
                'label' => self::propertyLabel($propertyId),
                'amount' => $amount,
                'at' => $at,
            ]);
        } catch (Throwable $e) {
            report($e);
        }
    }

    /** Arma el texto y lo manda al chat de la sala. Cualquier excepción se registra y se descarta. */
    private static function say(int $matchId, \Closure $text, ?string $eventKey = null): void
    {
        try {
            app(ChatService::class)->system($matchId, $text(), $eventKey);
        } catch (Throwable $e) {
            report($e);
        }
    }
}
