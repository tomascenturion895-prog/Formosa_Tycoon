<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use LogicException;

/** Silencio de un jugador en el chat. Historial: se agrega y se "levanta" (lifted_at), nunca se borra. */
class ChatMute extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected static function booted(): void
    {
        static::deleting(fn () => throw new LogicException('Los silencios no se borran: se levantan.'));
    }

    protected function casts(): array
    {
        return ['created_at' => 'datetime', 'expires_at' => 'datetime', 'lifted_at' => 'datetime'];
    }
}
