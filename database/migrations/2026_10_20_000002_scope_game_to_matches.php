<?php

use App\Enums\PropertyKind;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * K1: el libro de movimientos y las subastas pasan a ser DE UNA PARTIDA, y el ingreso de las propiedades pasa de "por hora real"
 * a "por día de juego".
 *
 *  - ledger_entries.match_id: saldo del jugador en la partida = SUMA de sus movimientos en esa partida. La clave de idempotencia
 *    es única por (partida, jugador). Las filas viejas (mundo único) quedan con match_id NULL como historia.
 *  - auctions.match_id: una subasta activa por (partida, propiedad). Las subastas activas del mundo viejo se cancelan.
 *  - properties.income_per_hour -> income_per_day (se recalcula con las tasas nuevas de config/formosa.php).
 *  - DEPRECADO (no se usa más, se deja por la historia): wallets, properties.owner_id / owned_at / last_collected_at.
 *    Los dueños ahora viven en match_properties. Se limpian los dueños del mundo viejo para que el catálogo quede libre.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ledger_entries', function (Blueprint $table) {
            $table->unsignedBigInteger('match_id')->nullable()->after('user_id');
            $table->dropUnique(['user_id', 'idempotency_key']);
            $table->unique(['match_id', 'user_id', 'idempotency_key'], 'ledger_match_user_key_unique');
            $table->index(['match_id', 'user_id', 'id'], 'ledger_match_user_id_index');
            $table->foreign('match_id')->references('id')->on('matches')->restrictOnDelete();
        });

        // Las subastas activas del mundo viejo no tienen partida: se cancelan (la plata reservada vivía en wallets, ya sin uso).
        DB::table('auctions')->whereNotNull('active_property_id')->update(['status' => 'cancelada', 'active_property_id' => null, 'closed_at' => now()->toDateTimeString()]);

        Schema::table('auctions', function (Blueprint $table) {
            $table->unsignedBigInteger('match_id')->nullable()->after('id');
            $table->dropUnique(['active_property_id']);
            $table->unique(['match_id', 'active_property_id'], 'auctions_match_active_unique');
            $table->index(['match_id', 'status', 'ends_at'], 'auctions_match_status_ends_index');
            $table->foreign('match_id')->references('id')->on('matches')->restrictOnDelete();
        });

        Schema::table('properties', function (Blueprint $table) {
            $table->renameColumn('income_per_hour', 'income_per_day');
        });
        foreach (PropertyKind::cases() as $kind) {
            $rate = (float) config("formosa.kinds.{$kind->value}.rate_per_day");
            DB::table('properties')->where('kind', $kind->value)->update(['income_per_day' => DB::raw('ROUND(price * '.$rate.')')]);
        }
        DB::table('properties')->whereNotNull('owner_id')->update(['owner_id' => null, 'owned_at' => null, 'last_collected_at' => null]);
    }

    public function down(): void
    {
        Schema::table('properties', function (Blueprint $table) {
            $table->renameColumn('income_per_day', 'income_per_hour');
        });

        Schema::table('auctions', function (Blueprint $table) {
            $table->dropForeign(['match_id']);
            $table->dropIndex('auctions_match_status_ends_index');
            $table->dropUnique('auctions_match_active_unique');
            $table->unique('active_property_id');
            $table->dropColumn('match_id');
        });

        Schema::table('ledger_entries', function (Blueprint $table) {
            $table->dropForeign(['match_id']);
            $table->dropIndex('ledger_match_user_id_index');
            $table->dropUnique('ledger_match_user_key_unique');
            $table->unique(['user_id', 'idempotency_key']);
            $table->dropColumn('match_id');
        });
    }
};
