<?php

use App\Enums\OfferStatus;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Ofertas entre jugadores: el dueño de una propiedad fija un mínimo y un "comprá ya" y los demás ofertan en el medio.
 *  - offers: una fila por oferta. `active_property_id` vale lo mismo que property_id mientras está abierta y NULL después; con el
 *    índice único (partida, propiedad) la base garantiza UNA sola oferta abierta por propiedad en cada partida.
 *  - offer_bids: ofertas, solo se agregan. (offer_id, amount) único: cada una tiene que superar a la anterior.
 * La plata de quien va ganando queda en match_players.reserved (igual que en las subastas).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('offers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('match_id')->constrained('matches')->restrictOnDelete();
            $table->foreignId('property_id')->constrained()->restrictOnDelete();
            $table->foreignId('seller_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('leader_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->foreignId('buyer_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->enum('status', OfferStatus::values());
            $table->unsignedBigInteger('min_price');
            $table->unsignedBigInteger('buy_now_price');
            $table->unsignedBigInteger('current_bid')->nullable();
            $table->unsignedBigInteger('sold_price')->nullable();
            $table->unsignedSmallInteger('bids_count')->default(0);
            $table->dateTime('ends_at');          // hasta cuándo se puede ofertar
            $table->dateTime('decide_until');     // hasta cuándo puede aceptar el dueño; después se cierra sin venta
            $table->dateTime('closed_at')->nullable();
            $table->unsignedBigInteger('active_property_id')->nullable();
            $table->timestamps();

            $table->unique(['match_id', 'active_property_id'], 'offers_match_active_unique');
            $table->index(['match_id', 'status', 'decide_until'], 'offers_match_status_index');
            $table->index(['seller_id', 'status']);
            $table->index(['leader_id', 'status']);
        });

        Schema::create('offer_bids', function (Blueprint $table) {
            $table->id();
            $table->foreignId('offer_id')->constrained()->restrictOnDelete();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->unsignedBigInteger('amount');
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['offer_id', 'amount']);
            $table->index('user_id');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement("ALTER TABLE offers ADD CONSTRAINT offers_active_key CHECK ((status = 'abierta' AND active_property_id = property_id) OR (status <> 'abierta' AND active_property_id IS NULL))");
            DB::statement('ALTER TABLE offers ADD CONSTRAINT offers_prices CHECK (min_price > 0 AND buy_now_price > min_price)');
            DB::statement('ALTER TABLE offers ADD CONSTRAINT offers_bid_range CHECK (current_bid IS NULL OR (current_bid >= min_price AND current_bid < buy_now_price))');
            DB::statement("ALTER TABLE offers ADD CONSTRAINT offers_buyer_iff_sold CHECK ((status = 'vendida') = (buyer_id IS NOT NULL))");
            DB::statement('ALTER TABLE offers ADD CONSTRAINT offers_decide_after_end CHECK (decide_until >= ends_at)');
            DB::statement('ALTER TABLE offer_bids ADD CONSTRAINT offer_bids_amount_pos CHECK (amount > 0)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('offer_bids');
        Schema::dropIfExists('offers');
    }
};
