<?php

namespace App\Models;

use App\Enums\LedgerType;
use Illuminate\Database\Eloquent\Model;
use LogicException;

/** Movimiento de la billetera. Solo se agregan; editar o borrar uno es un error de programación. */
class LedgerEntry extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('El libro de movimientos no se edita.'));
        static::deleting(fn () => throw new LogicException('El libro de movimientos no se borra.'));
    }

    protected function casts(): array
    {
        return [
            'type' => LedgerType::class,
            'amount' => 'integer',
            'balance_after' => 'integer',
            'created_at' => 'datetime',
        ];
    }
}
