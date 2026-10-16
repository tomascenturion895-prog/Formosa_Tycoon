<?php

namespace App\Models;

use App\Economy\AuctionRules;
use App\Enums\AuctionStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Solo AuctionService cambia una subasta. Nada asignable en masa. */
class Auction extends Model
{
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'status' => AuctionStatus::class,
            'list_price' => 'integer',
            'current_bid' => 'integer',
            'extensions' => 'integer',
            'flash' => 'boolean',
            'ends_at' => 'datetime',
            'contested_at' => 'datetime',
            'closed_at' => 'datetime',
        ];
    }

    public function match(): BelongsTo
    {
        return $this->belongsTo(GameMatch::class, 'match_id');
    }

    public function property(): BelongsTo
    {
        return $this->belongsTo(Property::class);
    }

    public function leader(): BelongsTo
    {
        return $this->belongsTo(User::class, 'leader_id');
    }

    public function winner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'winner_id');
    }

    public function bids(): HasMany
    {
        return $this->hasMany(AuctionBid::class);
    }

    public function isActive(): bool
    {
        return $this->status->isActive();
    }

    /**
     * Lo que puede ver cualquiera (va por el canal público y por GET /api/partidas/{id}/subastas): ids, apodos y montos.
     * `ends_at` va en milisegundos y el navegador lo compara con la hora del servidor, no con la suya.
     *
     * @return array<string, mixed>
     */
    public function toPublic(): array
    {
        $this->loadMissing('leader:id,name');

        return [
            'id' => $this->id,
            'match_id' => $this->match_id,
            'property_id' => $this->property_id,
            'status' => $this->status->value,
            'list_price' => $this->list_price,
            'current_bid' => $this->current_bid,
            'min_next' => $this->isActive() ? ($this->leader_id === null ? $this->current_bid : AuctionRules::minNextBid($this->current_bid, ...AuctionRules::configured())) : null,
            'flash' => (bool) $this->flash,
            'leader_id' => $this->leader_id,
            'leader' => $this->leader?->name,
            'contested' => $this->contested_at !== null,
            'ends_at' => $this->ends_at->getTimestampMs(),
            'server_now' => now()->getTimestampMs(),
        ];
    }
}
