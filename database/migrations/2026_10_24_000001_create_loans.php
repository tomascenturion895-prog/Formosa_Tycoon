<?php

use App\Enums\LoanStatus;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Banco: préstamos con interés que se devuelven por día de juego.
 *  - loans: una fila por préstamo. `balance` = capital que falta devolver, `arrears` = lo que ya venció y no se pudo pagar (mora).
 *    Deuda del jugador = balance + arrears de sus préstamos abiertos.
 *  - ledger_entries: dos movimientos nuevos, "prestamo" (suma) y "cuota" (resta). La regla de signos de la base se amplía.
 */
return new class extends Migration
{
    private const OLD = ['alta', 'compra', 'cobro', 'venta'];

    private const NEW = ['alta', 'compra', 'cobro', 'venta', 'prestamo', 'cuota'];

    private const RULE_OLD = "(type = 'compra' AND amount < 0 AND property_id IS NOT NULL) OR (type IN ('alta', 'cobro') AND amount > 0) OR (type = 'venta' AND amount > 0 AND property_id IS NOT NULL)";

    public function up(): void
    {
        Schema::create('loans', function (Blueprint $table) {
            $table->id();
            $table->foreignId('match_id')->constrained('matches')->restrictOnDelete();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->enum('status', LoanStatus::values());
            $table->unsignedBigInteger('principal');
            $table->unsignedBigInteger('balance');
            $table->unsignedBigInteger('arrears')->default(0);
            $table->unsignedBigInteger('daily_principal');
            $table->unsignedSmallInteger('term_days');
            $table->unsignedSmallInteger('rate_pct');
            $table->unsignedSmallInteger('days_charged')->default(0);
            $table->unsignedBigInteger('interest_paid')->default(0);
            $table->dateTime('taken_at');
            $table->dateTime('closed_at')->nullable();
            $table->timestamps();

            $table->index(['match_id', 'user_id', 'status']);
            $table->index('status');
        });

        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::NEW)->change());
        $this->addSignRule(self::RULE_OLD." OR (type = 'prestamo' AND amount > 0) OR (type = 'cuota' AND amount < 0)");

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE loans ADD CONSTRAINT loans_amounts CHECK (principal > 0 AND daily_principal > 0 AND term_days > 0 AND balance <= principal)');
            DB::statement("ALTER TABLE loans ADD CONSTRAINT loans_closed_clear CHECK (status <> 'pagado' OR (balance = 0 AND arrears = 0))");
        }
    }

    public function down(): void
    {
        DB::table('ledger_entries')->whereIn('type', ['prestamo', 'cuota'])->exists()
            && throw new RuntimeException('Hay préstamos en el libro: no se puede volver atrás sin perder historia.');
        Schema::dropIfExists('loans');
        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::OLD)->change());
        $this->addSignRule(self::RULE_OLD);
    }

    private function dropSignRule(): void
    {
        $driver = DB::getDriverName();
        if ($driver === 'mariadb' || $driver === 'pgsql') {
            DB::statement('ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_sign_by_type');
        } elseif ($driver === 'mysql') {
            DB::statement('ALTER TABLE ledger_entries DROP CHECK ledger_sign_by_type');
        }
    }

    private function addSignRule(string $rule): void
    {
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_sign_by_type CHECK ({$rule})");
        }
    }
};
