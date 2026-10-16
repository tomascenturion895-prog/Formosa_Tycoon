<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * DEPRECADO (K1): el dinero ahora es por partida y vive en `match_players.cash`. La tabla `wallets` se conserva solo como
 * historia del mundo único; ningún servicio la lee ni la escribe.
 *
 * El saldo NUNCA se asigna a mano: solo EconomyService (y AuctionService al cerrar) lo cambian, dentro de una
 * transacción y con un movimiento. `reserved` es lo comprometido por pujas ganadoras todavía abiertas.
 */
class Wallet extends Model
{
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return ['balance' => 'integer', 'reserved' => 'integer'];
    }

    /** Lo que se puede gastar ahora: el saldo menos lo reservado por subastas que se están ganando. */
    public function available(): int
    {
        return $this->balance - $this->reserved;
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
