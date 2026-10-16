<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use LogicException;

/** Historial de correcciones de propiedades. Solo se agregan filas. */
class PropertyEdit extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('El historial de correcciones no se edita.'));
        static::deleting(fn () => throw new LogicException('El historial de correcciones no se borra.'));
    }
}
