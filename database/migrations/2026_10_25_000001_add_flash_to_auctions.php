<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Sprint final: las subastas relámpago las abre el juego, no un jugador. Nacen sin quien las lidere (starter_id y leader_id
 * pasan a admitir NULL) y con `flash` en verdadero: duran poco, no se prorrogan y, si nadie puja, se cancelan sin tocar a nadie.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('auctions', function (Blueprint $table) {
            $table->boolean('flash')->default(false)->after('extensions');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE auctions MODIFY starter_id BIGINT UNSIGNED NULL, MODIFY leader_id BIGINT UNSIGNED NULL');
        } else {
            Schema::table('auctions', function (Blueprint $table) {
                $table->unsignedBigInteger('starter_id')->nullable()->change();
                $table->unsignedBigInteger('leader_id')->nullable()->change();
            });
        }
    }

    public function down(): void
    {
        // Sin vuelta atrás: hay subastas sin líder que no entrarían en las columnas NOT NULL.
    }
};
