<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Datos del mapa corregidos a mano.
 *  - properties.edited_at / edited_by: un moderador verificó o corrigió el rubro y el nombre. Mientras estén,
 *    re-importar desde OpenStreetMap NO los pisa (la geometría sí se sigue actualizando). Van juntos: o están los dos o ninguno.
 *  - property_edits: historial de correcciones (qué había y qué quedó, quién y por qué). Solo se agrega, nunca se edita.
 *  - property_reports: avisos de jugadores de "estos datos están desactualizados". Un aviso por jugador y propiedad.
 *    No cambian nada solos: los revisa un moderador.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('properties', function (Blueprint $table) {
            $table->timestamp('edited_at')->nullable();
            $table->foreignId('edited_by')->nullable()->constrained('users')->restrictOnDelete();
        });

        Schema::create('property_edits', function (Blueprint $table) {
            $table->id();
            $table->foreignId('property_id')->constrained()->restrictOnDelete();
            $table->foreignId('actor_id')->nullable()->constrained('users')->restrictOnDelete(); // NULL = lo hizo la re-importación
            $table->enum('source', ['moderador', 'osm']);
            $table->string('old_kind', 20);
            $table->string('new_kind', 20);
            $table->string('old_name', 120)->nullable();
            $table->string('new_name', 120)->nullable();
            $table->unsignedBigInteger('old_price');
            $table->unsignedBigInteger('new_price');
            $table->unsignedInteger('old_income');
            $table->unsignedInteger('new_income');
            $table->unsignedBigInteger('paid_out')->default(0); // lo acumulado que se le acreditó al dueño al cambiar el ingreso
            $table->string('reason', 120)->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['property_id', 'id']);
            $table->index('actor_id');
        });

        Schema::create('property_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('property_id')->constrained()->cascadeOnDelete();
            $table->foreignId('reporter_id')->constrained('users')->restrictOnDelete();
            $table->string('reason', 20); // los motivos válidos viven en config/formosa.php
            $table->string('note', 140)->nullable();
            $table->enum('status', ['abierto', 'resuelto', 'descartado'])->default('abierto');
            $table->foreignId('resolved_by')->nullable()->constrained('users')->restrictOnDelete();
            $table->timestamp('resolved_at')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['property_id', 'reporter_id']);
            $table->index(['status', 'property_id']);
            $table->index('reporter_id');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE properties ADD CONSTRAINT properties_edited_pair CHECK ((edited_at IS NULL) = (edited_by IS NULL))');
            DB::statement("ALTER TABLE property_reports ADD CONSTRAINT property_reports_resolved_consistent CHECK ((status = 'abierto' AND resolved_at IS NULL) OR (status <> 'abierto' AND resolved_at IS NOT NULL))");
        }
    }

    public function down(): void
    {
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE properties DROP CONSTRAINT '.(DB::getDriverName() === 'mariadb' ? 'IF EXISTS ' : '').'properties_edited_pair');
        }
        Schema::dropIfExists('property_reports');
        Schema::dropIfExists('property_edits');
        Schema::table('properties', function (Blueprint $table) {
            $table->dropConstrainedForeignId('edited_by');
            $table->dropColumn('edited_at');
        });
    }
};
