<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Venta al banco: un movimiento nuevo del libro, "venta", que suma plata y siempre nombra la propiedad vendida.
 * La regla de signos de la base se amplía para incluirlo.
 */
return new class extends Migration
{
    private const OLD = ['alta', 'compra', 'cobro'];

    private const NEW = ['alta', 'compra', 'cobro', 'venta'];

    public function up(): void
    {
        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::NEW)->change());
        $this->addSignRule("(type = 'compra' AND amount < 0 AND property_id IS NOT NULL) OR (type IN ('alta', 'cobro') AND amount > 0) OR (type = 'venta' AND amount > 0 AND property_id IS NOT NULL)");
    }

    public function down(): void
    {
        DB::table('ledger_entries')->where('type', 'venta')->exists()
            && throw new RuntimeException('Hay ventas en el libro: no se puede volver atrás sin perder historia.');
        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::OLD)->change());
        $this->addSignRule("(type = 'compra' AND amount < 0 AND property_id IS NOT NULL) OR (type IN ('alta', 'cobro') AND amount > 0)");
    }

    private function dropSignRule(): void
    {
        $driver = DB::getDriverName();
        if ($driver === 'mariadb') {
            DB::statement('ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_sign_by_type');
        } elseif ($driver === 'mysql') {
            DB::statement('ALTER TABLE ledger_entries DROP CHECK ledger_sign_by_type');
        } elseif ($driver === 'pgsql') {
            DB::statement('ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_sign_by_type');
        }
    }

    private function addSignRule(string $rule): void
    {
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_sign_by_type CHECK ({$rule})");
        }
    }
};
