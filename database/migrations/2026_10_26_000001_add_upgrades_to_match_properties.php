<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Mejoras de propiedades (ver docs/superpowers/specs/2026-10-16-profundidad-propiedades-design.md).
 *  - match_properties.level: 0 sin mejora, 1 "Reformada", 2 especialización. branch: 'a' o 'b', solo en el nivel 2.
 *    upgrade_paid: pesos realmente pagados en mejoras (cuenta para el patrimonio). Las filas existentes quedan en nivel 0.
 *  - ledger_entries: movimiento nuevo "mejora" (resta, siempre nombra la propiedad). La regla de signos de la base se amplía.
 */
return new class extends Migration
{
    private const OLD = ['alta', 'compra', 'cobro', 'venta', 'prestamo', 'cuota'];

    private const NEW = ['alta', 'compra', 'cobro', 'venta', 'prestamo', 'cuota', 'mejora'];

    private const RULE_OLD = "(type = 'compra' AND amount < 0 AND property_id IS NOT NULL) OR (type IN ('alta', 'cobro') AND amount > 0) OR (type = 'venta' AND amount > 0 AND property_id IS NOT NULL) OR (type = 'prestamo' AND amount > 0) OR (type = 'cuota' AND amount < 0)";

    public function up(): void
    {
        Schema::table('match_properties', function (Blueprint $table) {
            $table->unsignedTinyInteger('level')->default(0);
            $table->char('branch', 1)->nullable();
            $table->unsignedInteger('upgrade_paid')->default(0);
        });
        // Ojo: un CHECK con NULL se da por cumplido, por eso la rama del nivel 2 pide IS NOT NULL explícito.
        if ($this->hasChecks()) {
            DB::statement('ALTER TABLE match_properties ADD CONSTRAINT match_properties_level_ok CHECK (level BETWEEN 0 AND 2)');
            DB::statement("ALTER TABLE match_properties ADD CONSTRAINT match_properties_branch_ok CHECK ((level < 2 AND branch IS NULL) OR (level = 2 AND branch IS NOT NULL AND branch IN ('a', 'b')))");
            DB::statement('ALTER TABLE match_properties ADD CONSTRAINT match_properties_paid_ok CHECK ((level = 0 AND upgrade_paid = 0) OR (level > 0 AND upgrade_paid > 0))');
        }

        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::NEW)->change());
        $this->addSignRule(self::RULE_OLD." OR (type = 'mejora' AND amount < 0 AND property_id IS NOT NULL)");
    }

    public function down(): void
    {
        DB::table('ledger_entries')->where('type', 'mejora')->exists()
            && throw new RuntimeException('Hay mejoras en el libro: no se puede volver atrás sin perder historia.');
        $this->dropSignRule();
        Schema::table('ledger_entries', fn (Blueprint $t) => $t->enum('type', self::OLD)->change());
        $this->addSignRule(self::RULE_OLD);

        if ($this->hasChecks()) {
            foreach (['level_ok', 'branch_ok', 'paid_ok'] as $name) {
                $this->dropCheck('match_properties', "match_properties_{$name}");
            }
        }
        Schema::table('match_properties', fn (Blueprint $t) => $t->dropColumn(['level', 'branch', 'upgrade_paid']));
    }

    private function hasChecks(): bool
    {
        return in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true);
    }

    private function dropCheck(string $table, string $name): void
    {
        DB::statement(DB::getDriverName() === 'mysql' ? "ALTER TABLE {$table} DROP CHECK {$name}" : "ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$name}");
    }

    private function dropSignRule(): void
    {
        if ($this->hasChecks()) {
            $this->dropCheck('ledger_entries', 'ledger_sign_by_type');
        }
    }

    private function addSignRule(string $rule): void
    {
        if ($this->hasChecks()) {
            DB::statement("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_sign_by_type CHECK ({$rule})");
        }
    }
};
