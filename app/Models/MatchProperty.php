<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Dueño de una propiedad EN UNA PARTIDA. Clave compuesta (match_id, property_id): no hay `id`. Solo los servicios la escriben. */
class MatchProperty extends Model
{
    protected $table = 'match_properties';

    public $incrementing = false;

    public $timestamps = false;

    protected $primaryKey = null;

    protected $guarded = ['*'];

    protected function casts(): array
    {
        return ['price_paid' => 'integer', 'bought_at' => 'datetime'];
    }
}
