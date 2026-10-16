<?php

namespace App\Models;

use App\Enums\MatchStatus;
use Carbon\CarbonInterface;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Una partida (sala). Se llama GameMatch porque `match` es palabra reservada de PHP. Solo MatchService cambia su estado.
 * Reloj de juego: la hora dentro de la partida es función de (ahora - started_at), no de la hora absoluta del servidor.
 */
class GameMatch extends Model
{
    protected $table = 'matches';

    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'status' => MatchStatus::class,
            'is_public' => 'boolean',
            'capacity' => 'integer',
            'min_players' => 'integer',
            'start_cash' => 'integer',
            'minutes_per_day' => 'integer',
            'duration_minutes' => 'integer',
            'lobby_expires_at' => 'datetime',
            'started_at' => 'datetime',
            'ends_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'creator_id');
    }

    public function players(): HasMany
    {
        return $this->hasMany(MatchPlayer::class, 'match_id');
    }

    public function isRunning(): bool
    {
        return $this->status === MatchStatus::Running;
    }

    /** Está en juego Y todavía no llegó la hora de cierre (pasada la hora, solo falta que alguien la cierre). */
    public function isLive(?CarbonInterface $now = null): bool
    {
        return $this->isRunning() && $this->ends_at->greaterThan($now ?? now());
    }

    /** Segundos reales que dura un día de juego. */
    public function secondsPerDay(): int
    {
        return $this->minutes_per_day * 60;
    }

    /** Día de juego (con decimales) en `$now`: 0 al empezar, `duration/minutes_per_day` al terminar. Null si todavía no empezó. */
    public function gameDay(?CarbonInterface $now = null): ?float
    {
        if ($this->started_at === null) {
            return null;
        }
        $now ??= now();
        $end = $this->ends_at ?? $now;
        $t = $now->greaterThan($end) ? $end : $now;
        $elapsed = max(0, $this->started_at->diffInSeconds($t, false));

        return round($elapsed / $this->secondsPerDay(), 4);
    }

    /**
     * Lo público de la partida (ids, nombres y tiempos en milisegundos). `server_now` permite al navegador usar la hora del servidor.
     *
     * @return array<string, mixed>
     */
    public function toPublic(?int $players = null): array
    {
        $now = now();

        return [
            'id' => $this->id,
            'code' => $this->code,
            'name' => $this->name,
            'status' => $this->status->value,
            'is_public' => $this->is_public,
            'capacity' => $this->capacity,
            'min_players' => $this->min_players,
            'players' => $players,
            'creator_id' => $this->creator_id,
            'start_cash' => $this->start_cash,
            'minutes_per_day' => $this->minutes_per_day,
            'duration_minutes' => $this->duration_minutes,
            'days_total' => intdiv($this->duration_minutes, max(1, $this->minutes_per_day)),
            'lobby_expires_at' => $this->status === MatchStatus::Lobby ? $this->lobby_expires_at->getTimestampMs() : null,
            'started_at' => $this->started_at?->getTimestampMs(),
            'ends_at' => $this->ends_at?->getTimestampMs(),
            'finished_at' => $this->finished_at?->getTimestampMs(),
            'game_day' => $this->status === MatchStatus::Running || $this->status === MatchStatus::Finished ? $this->gameDay($now) : null,
            // Eventos activos y el próximo anunciado (solo mientras se juega).
            'events' => $this->status === MatchStatus::Running ? \App\Economy\MatchEvents::view($this, $now->getTimestamp()) : null,
            'server_now' => $now->getTimestampMs(),
        ];
    }
}
