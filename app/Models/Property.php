<?php

namespace App\Models;

use App\Enums\PropertyKind;
use Illuminate\Database\Eloquent\Model;

/**
 * Un edificio del mapa que se puede comprar. La geometría y los datos de OSM los escribe SOLO el importador.
 * El dueño NO está acá: depende de la partida y vive en `match_properties`. Las columnas owner_id / owned_at /
 * last_collected_at del mundo único están DEPRECADAS (la migración 2026_10_20_000002 las deja vacías). `income_per_day` es
 * el ingreso por DÍA DE JUEGO.
 */
class Property extends Model
{
    // Nada asignable en masa: ni dueño ni precio entran por formularios.
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'kind' => PropertyKind::class,
            'geometry' => 'array',
            'area_m2' => 'float',
            'lat' => 'float',
            'lng' => 'float',
            'price' => 'integer',
            'income_per_day' => 'integer',
        ];
    }
}
