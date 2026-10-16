<?php

namespace App\Support;

use App\Economy\VoiceService;
use App\Enums\PropertyKind;
use App\Formosa\MapSnapshot;
use App\Models\User;

/**
 * Configuración PÚBLICA que el navegador recibe en `window.__MAP_CONFIG__`. Solo lo necesario para pintar la pantalla:
 * nada de correo ni saldo (el saldo viene de /api/yo). La usan el lobby (`forLobby`) y la pantalla de juego (`forGame`).
 */
class PublicConfig
{
    /** Todo lo del lobby más lo que necesita el mapa. */
    public static function forGame(?User $user): array
    {
        return self::forLobby($user) + [
            'center' => config('formosa.center'),
            'zoom' => config('formosa.zoom'),
            'data' => ['reasons' => config('formosa.data.report_reasons')],
            // Archivos estáticos de public/data (null = no hay: el navegador usa la API). Ver MapSnapshot.
            'static' => ['propiedades' => MapSnapshot::propertiesUrl(), 'calles' => MapSnapshot::roadsUrl()],
        ];
    }

    /** Lo que usan el lobby y las guías: reglas del juego para los textos, usuario, enlaces y tiempo real. Sin datos del mapa. */
    public static function forLobby(?User $user): array
    {
        $kinds = [];
        foreach (PropertyKind::cases() as $kind) {
            $cfg = config("formosa.kinds.{$kind->value}");
            $kinds[$kind->value] = ['label' => $cfg['label'], 'color' => $cfg['color'], 'height' => $cfg['height']];
        }

        return [
            'kinds' => $kinds,
            'auction' => [
                'dispute' => (int) config('formosa.auction.dispute_seconds'),
                'duration' => (int) config('formosa.auction.duration_seconds'),
            ],
            'economy' => [
                'startCash' => (int) config('formosa.match.start_cash'),
                'sellRatio' => (float) config('formosa.economy.sell_ratio'),
            ],
            'match' => [
                'durationMinutes' => (int) config('formosa.match.duration_minutes'),
                'minutesPerDay' => (int) config('formosa.match.minutes_per_day'),
                'daysTotal' => intdiv((int) config('formosa.match.duration_minutes'), max(1, (int) config('formosa.match.minutes_per_day'))),
                'minCapacity' => (int) config('formosa.match.min_capacity'),
                'maxCapacity' => (int) config('formosa.match.max_capacity'),
                'defaultCapacity' => (int) config('formosa.match.default_capacity'),
                'minPlayers' => (int) config('formosa.match.min_players'),
                'nameMax' => (int) config('formosa.match.name_max'),
                'lobbyTtlMinutes' => (int) config('formosa.match.lobby_ttl_minutes'),
                'points' => config('formosa.match.points'),
            ],
            // Reglas de combos: el navegador las usa solo para mostrar pistas (el ingreso real lo calcula el servidor).
            'combos' => ['zoneDeg' => (float) config('formosa.combos.zone_deg'), 'zoneTiers' => config('formosa.combos.zone_tiers'), 'variety' => (float) config('formosa.combos.variety')],
            'events' => ['enabled' => (bool) config('formosa.events.enabled'), 'perMatch' => (int) config('formosa.events.per_match'), 'durationDays' => (int) config('formosa.events.duration_days'), 'announceDays' => (int) config('formosa.events.announce_days')],
            // Reglas que solo se usan para escribir las guías (el servidor es quien las aplica).
            'bank' => [
                'ratePct' => (int) config('formosa.bank.rate_pct'),
                'latePct' => (int) config('formosa.bank.late_pct'),
                'maxSharePct' => (int) config('formosa.bank.max_share_pct'),
                'maxLoans' => (int) config('formosa.bank.max_loans'),
                'minAmount' => (int) config('formosa.bank.min_amount'),
                'terms' => array_map('intval', (array) config('formosa.bank.terms')),
            ],
            'offers' => [
                'durationSeconds' => (int) config('formosa.offers.duration_seconds'),
                'decideSeconds' => (int) config('formosa.offers.decide_seconds'),
                'feePct' => (int) config('formosa.offers.fee_pct'),
                'minPrice' => (int) config('formosa.offers.min_price'),
            ],
            'sprint' => [
                'enabled' => (bool) config('formosa.sprint.enabled'),
                'seconds' => (int) config('formosa.sprint.seconds'),
                'incomePct' => (float) config('formosa.sprint.income_pct'),
                'flashInterval' => (int) config('formosa.sprint.flash_interval'),
                'flashSeconds' => (int) config('formosa.sprint.flash_seconds'),
                'flashStartPct' => (int) config('formosa.sprint.flash_start_pct'),
                'comebackPct' => (int) config('formosa.sprint.comeback_pct'),
                'blockLoans' => (bool) config('formosa.sprint.block_loans'),
            ],
            'voice' => app(VoiceService::class)->clientConfig(),
            // Hora de la ciudad: dentro de una partida la calcula el navegador desde `started_at` de ESA partida (ver /api/partidas/actual);
            // `serverNow` sirve para corregir la diferencia entre el reloj del navegador y el del servidor.
            'clock' => ['minutesPerDay' => (int) config('formosa.clock.minutes_per_day'), 'serverNow' => now()->getTimestampMs()],
            'chat' => [
                'max' => (int) config('formosa.chat.max_length'),
                'reasons' => config('formosa.chat.report_reasons'),
                'mute_minutes' => config('formosa.chat.mute_minutes'),
            ],
            // Solo lo necesario para pintar la pantalla; nada de correo ni saldo.
            'user' => $user ? ['id' => $user->id, 'name' => $user->name, 'moderator' => $user->isModerator(), 'verified' => $user->hasVerifiedEmail()] : null,
            'urls' => ['login' => route('login'), 'registro' => route('registro'), 'logout' => route('logout')],
            // Datos PÚBLICOS para que el navegador se conecte al tiempo real (la clave pública no es el secreto).
            'reverb' => config('broadcasting.default') === 'reverb' ? [
                'key' => config('broadcasting.connections.reverb.key'),
                'host' => config('formosa.realtime.host'),
                'port' => config('formosa.realtime.port'),
                'scheme' => config('formosa.realtime.scheme'),
            ] : null,
        ];
    }
}
