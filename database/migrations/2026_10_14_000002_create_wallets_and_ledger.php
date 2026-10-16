<?php

use App\Enums\LedgerType;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Una billetera por jugador. El saldo solo lo cambia EconomyService, siempre junto con un movimiento del libro.
        Schema::create('wallets', function (Blueprint $table) {
            $table->id();
            // RESTRICT: no se borra un usuario con plata ni historia sin decidirlo a propósito.
            $table->foreignId('user_id')->unique()->constrained()->restrictOnDelete();
            $table->unsignedBigInteger('balance')->default(0);
            $table->timestamps();
        });

        // Libro de movimientos: solo se agregan filas, nunca se editan ni se borran.
        // Invariante: wallets.balance = SUMA(amount) de sus movimientos.
        Schema::create('ledger_entries', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->enum('type', LedgerType::values());
            $table->bigInteger('amount');                          // con signo: compra negativa, cobro positivo
            $table->unsignedBigInteger('balance_after');
            $table->foreignId('property_id')->nullable()->constrained()->restrictOnDelete();
            // Reintentar la misma operación con la misma clave devuelve el mismo resultado, sin repetirla.
            $table->string('idempotency_key', 64)->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['user_id', 'idempotency_key']);
            $table->index(['user_id', 'id']);
            $table->index('property_id');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE wallets ADD CONSTRAINT wallets_balance_nonneg CHECK (balance >= 0)');
            DB::statement('ALTER TABLE ledger_entries ADD CONSTRAINT ledger_amount_nonzero CHECK (amount <> 0)');
            // Una compra siempre resta, un cobro y un alta siempre suman, y la compra/cobro de una propiedad la nombra.
            DB::statement("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_sign_by_type CHECK ((type = 'compra' AND amount < 0 AND property_id IS NOT NULL) OR (type IN ('alta', 'cobro') AND amount > 0))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('ledger_entries');
        Schema::dropIfExists('wallets');
    }
};
