<?php

namespace App\Models;

use App\Economy\AuctionRules;
use App\Enums\OfferStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Solo OfferService cambia una oferta. Nada asignable en masa. */
class Offer extends Model
{
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'status' => OfferStatus::class,
            'min_price' => 'integer',
            'buy_now_price' => 'integer',
            'current_bid' => 'integer',
            'sold_price' => 'integer',
            'bids_count' => 'integer',
            'ends_at' => 'datetime',
            'decide_until' => 'datetime',
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

    public function seller(): BelongsTo
    {
        return $this->belongsTo(User::class, 'seller_id');
    }

    public function leader(): BelongsTo
    {
        return $this->belongsTo(User::class, 'leader_id');
    }

    public function bids(): HasMany
    {
        return $this->hasMany(OfferBid::class);
    }

    public function isActive(): bool
    {
        return $this->status->isActive();
    }

    /** Lo que puede ver cualquiera (canal público y GET de la partida): ids, apodos y montos. Nada de saldos. @return array<string, mixed> */
    public function toPublic(): array
    {
        $this->loadMissing('seller:id,name', 'leader:id,name');
        // La mejora viaja con la propiedad: el comprador tiene que ver qué compra.
        $up = \Illuminate\Support\Facades\DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')
            ->where('mp.match_id', $this->match_id)->where('mp.property_id', $this->property_id)->first(['p.kind', 'mp.level', 'mp.branch']);
        $level = (int) ($up->level ?? 0);

        return [
            'level' => $level,
            'branch' => $up->branch ?? null,
            'label' => $level > 0 ? \App\Economy\Upgrades::option($up->kind, $level, $up->branch)['label'] : null,
            'id' => $this->id,
            'match_id' => $this->match_id,
            'property_id' => $this->property_id,
            'status' => $this->status->value,
            'seller_id' => $this->seller_id,
            'seller' => $this->seller?->name,
            'min_price' => $this->min_price,
            'buy_now_price' => $this->buy_now_price,
            'current_bid' => $this->current_bid,
            'min_next' => $this->isActive() ? AuctionRules::offerMinNext($this->current_bid, $this->min_price, $this->buy_now_price) : null,
            'bids_count' => $this->bids_count,
            'leader_id' => $this->leader_id,
            'leader' => $this->leader?->name,
            'sold_price' => $this->sold_price,
            'ends_at' => $this->ends_at->getTimestampMs(),
            'decide_until' => $this->decide_until->getTimestampMs(),
            'server_now' => now()->getTimestampMs(),
        ];
    }
}
