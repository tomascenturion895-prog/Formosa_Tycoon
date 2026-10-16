<?php

use App\Enums\PropertyKind;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('properties', function (Blueprint $table) {
            $table->id();

            // Identidad en OpenStreetMap: re-importar actualiza la misma fila, nunca la duplica.
            $table->enum('osm_type', ['way', 'node']);
            $table->unsignedBigInteger('osm_id');

            $table->string('district', 40);
            $table->enum('kind', PropertyKind::values());
            // 'osm' = polígono real; 'sintetica' = cuadrado alrededor de un comercio mapeado solo como punto.
            $table->enum('footprint', ['osm', 'sintetica'])->default('osm');

            // Datos públicos del lugar. Nunca nombres de personas ni número de casa (privacidad).
            $table->string('name', 120)->nullable();
            $table->string('street', 120)->nullable();

            $table->decimal('area_m2', 10, 1)->default(0);
            $table->decimal('lat', 9, 6);
            $table->decimal('lng', 9, 6);
            $table->json('geometry');

            // Pesos ficticios, enteros (sin decimales: nada de float para dinero).
            $table->unsignedBigInteger('price');
            $table->unsignedBigInteger('income_per_min');

            // Dueño actual. RESTRICT: no se puede borrar un usuario que todavía tiene propiedades;
            // hay que liberarlas a propósito (así no se pierde dinero ni historia sin querer).
            $table->foreignId('owner_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->timestamp('owned_at')->nullable();
            $table->timestamp('last_collected_at')->nullable();

            $table->timestamps();

            $table->unique(['osm_type', 'osm_id']);
            $table->index(['district', 'kind']);
        });

        // Reglas que la base misma hace cumplir (SQLite, usado en los tests, no permite agregarlas después de crear la tabla).
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE properties ADD CONSTRAINT properties_price_positive CHECK (price > 0)');
            DB::statement('ALTER TABLE properties ADD CONSTRAINT properties_area_nonneg CHECK (area_m2 >= 0)');
            // Dueño y fecha de compra van juntos: o están los dos o no está ninguno.
            DB::statement('ALTER TABLE properties ADD CONSTRAINT properties_owner_pair CHECK ((owner_id IS NULL AND owned_at IS NULL) OR (owner_id IS NOT NULL AND owned_at IS NOT NULL))');
            // Solo una propiedad con dueño puede tener un cobro.
            DB::statement('ALTER TABLE properties ADD CONSTRAINT properties_collect_needs_owner CHECK (owner_id IS NOT NULL OR last_collected_at IS NULL)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('properties');
    }
};
