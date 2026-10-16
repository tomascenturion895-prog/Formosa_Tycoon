<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Reporte de un mensaje por parte de un jugador. Lo escribe solo ModerationService. */
class ChatReport extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected function casts(): array
    {
        return ['created_at' => 'datetime', 'resolved_at' => 'datetime'];
    }
}
