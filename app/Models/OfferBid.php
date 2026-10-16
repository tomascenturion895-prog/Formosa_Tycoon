<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Una oferta hecha. Solo se agregan (las escribe OfferService). */
class OfferBid extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['*'];

    protected function casts(): array
    {
        return ['amount' => 'integer', 'created_at' => 'datetime'];
    }
}
