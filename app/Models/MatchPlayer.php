<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Un jugador en una partida, con SU dinero. `cash` nunca se asigna a mano: solo EconomyService (y AuctionService al cerrar)
 * lo cambian, dentro de una transacción y con un movimiento del libro. `reserved` es lo comprometido por pujas ganadoras abiertas.
 */
class MatchPlayer extends Model
{
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'cash' => 'integer',
            'reserved' => 'integer',
            'income_carry' => 'integer',
            'last_settled_at' => 'datetime',
            'joined_at' => 'datetime',
            'left_at' => 'datetime',
            'abandoned' => 'boolean',
            'final_rank' => 'integer',
            'final_net_worth' => 'integer',
            'final_properties' => 'integer',
            'points_awarded' => 'integer',
        ];
    }

    /** Lo que se puede gastar ahora: el dinero menos lo reservado por subastas que se están ganando. */
    public function available(): int
    {
        return $this->cash - $this->reserved;
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function match(): BelongsTo
    {
        return $this->belongsTo(GameMatch::class, 'match_id');
    }
}
