<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * El ingreso pasa de "por minuto" a "por hora": el juego es lento (se vuelve a cobrar cada tanto) y un entero por
 * minuto redondeaba mal los rendimientos chicos. Se conserva el valor equivalente (x60); al re-importar se recalcula.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('properties', function (Blueprint $table) {
            $table->renameColumn('income_per_min', 'income_per_hour');
        });
        DB::table('properties')->update(['income_per_hour' => DB::raw('income_per_hour * 60')]);
    }

    public function down(): void
    {
        DB::table('properties')->update(['income_per_hour' => DB::raw('ROUND(income_per_hour / 60)')]);
        Schema::table('properties', function (Blueprint $table) {
            $table->renameColumn('income_per_hour', 'income_per_min');
        });
    }
};
