<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use LogicException;

/** Puja. Solo se agregan; editar o borrar una es un error de programación (igual que el libro de movimientos). */
class AuctionBid extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('Las pujas no se editan.'));
        static::deleting(fn () => throw new LogicException('Las pujas no se borran.'));
    }

    protected function casts(): array
    {
        return ['amount' => 'integer', 'created_at' => 'datetime'];
    }
}
