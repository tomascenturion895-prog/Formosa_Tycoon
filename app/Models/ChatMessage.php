<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use LogicException;

/** Mensaje del chat. Solo se agregan; la limpieza por antigüedad borra con una consulta directa, nunca desde el modelo. */
class ChatMessage extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('Los mensajes no se editan.'));
        static::deleting(fn () => throw new LogicException('Los mensajes no se borran desde el modelo.'));
    }

    protected function casts(): array
    {
        return ['created_at' => 'datetime', 'match_id' => 'integer', 'user_id' => 'integer'];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function isSystem(): bool
    {
        return $this->kind === 'sistema';
    }

    /**
     * Lo que ve quien puede leer el canal (lectura pública del global, o miembros de la sala y aviso en vivo): quién, qué y cuándo.
     * Nada de correo ni de otros datos. `kind` distingue lo que escribió una persona de un aviso del juego (sin autor).
     * `match_id` es null en el chat global y el número de la partida en una sala.
     *
     * @return array{id: int, kind: string, match_id: int|null, user_id: int|null, user: string|null, body: string, at: int}
     */
    public function toPublic(?string $userName): array
    {
        return self::shape($this->id, $this->kind, $this->match_id, $this->user_id, $userName, $this->body, $this->created_at->getTimestampMs());
    }

    /** La misma forma pública armada desde valores sueltos (lecturas por consulta directa). */
    public static function shape(int|string $id, ?string $kind, int|string|null $matchId, int|string|null $userId, ?string $userName, string $body, int $atMs): array
    {
        $system = $kind === 'sistema';

        return [
            'id' => (int) $id,
            'kind' => $system ? 'sistema' : 'usuario',
            'match_id' => $matchId === null ? null : (int) $matchId,
            'user_id' => $system || $userId === null ? null : (int) $userId,
            'user' => $system ? null : $userName,
            'body' => $body,
            'at' => $atMs,
        ];
    }
}
