<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Aviso de un jugador: "los datos de esta propiedad están desactualizados". No cambia nada solo. */
class PropertyReport extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];
}
