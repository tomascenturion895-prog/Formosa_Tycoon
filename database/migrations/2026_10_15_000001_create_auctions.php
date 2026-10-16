<?php

use App\Enums\AuctionStatus;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Fase 3: subastas.
 *  - wallets.reserved: plata comprometida por quien va ganando una subasta. Disponible = saldo - reservado.
 *  - auctions: una fila por disputa. `active_property_id` vale lo mismo que property_id mientras la subasta está
 *    activa y NULL después; con el índice único, la base garantiza UNA sola subasta activa por propiedad.
 *  - auction_bids: pujas, solo se agregan. (auction_id, amount) único: cada puja tiene que superar a la anterior.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('wallets', function (Blueprint $table) {
            $table->unsignedBigInteger('reserved')->default(0)->after('balance');
        });

        Schema::create('auctions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('property_id')->constrained()->restrictOnDelete();
            $table->foreignId('starter_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('leader_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('winner_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->enum('status', AuctionStatus::values());
            $table->unsignedBigInteger('list_price');
            $table->unsignedBigInteger('current_bid');
            $table->unsignedSmallInteger('extensions')->default(0);
            // Un solo plazo: en "disputa" es el fin de la ventana; en "abierta", el fin de la subasta.
            $table->dateTime('ends_at');
            $table->dateTime('contested_at')->nullable();
            $table->dateTime('closed_at')->nullable();
            $table->unsignedBigInteger('active_property_id')->nullable()->unique();
            $table->timestamps();

            $table->index(['status', 'ends_at']);
        });

        Schema::create('auction_bids', function (Blueprint $table) {
            $table->id();
            $table->foreignId('auction_id')->constrained()->restrictOnDelete();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->unsignedBigInteger('amount');
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['auction_id', 'amount']);
            $table->index('user_id');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE wallets ADD CONSTRAINT wallets_reserved_le_balance CHECK (reserved <= balance)');
            DB::statement("ALTER TABLE auctions ADD CONSTRAINT auctions_active_key CHECK ((status IN ('disputa', 'abierta') AND active_property_id = property_id) OR (status IN ('cerrada', 'cancelada') AND active_property_id IS NULL))");
            DB::statement('ALTER TABLE auctions ADD CONSTRAINT auctions_bid_floor CHECK (current_bid >= list_price AND list_price > 0)');
            DB::statement("ALTER TABLE auctions ADD CONSTRAINT auctions_winner_iff_closed CHECK ((status = 'cerrada') = (winner_id IS NOT NULL))");
            DB::statement('ALTER TABLE auction_bids ADD CONSTRAINT auction_bids_amount_pos CHECK (amount > 0)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('auction_bids');
        Schema::dropIfExists('auctions');
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE wallets DROP CONSTRAINT wallets_reserved_le_balance');
        }
        Schema::table('wallets', function (Blueprint $table) {
            $table->dropColumn('reserved');
        });
    }
};
