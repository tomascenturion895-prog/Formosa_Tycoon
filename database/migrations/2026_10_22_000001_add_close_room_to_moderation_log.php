<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Un moderador puede cerrar una sala trabada desde la ficha de la partida: esa decisión queda en el registro de moderación
 * (`moderation_log`) como 'cerrar_sala', con el número y el nombre de la sala en `detail`. Solo se agrega un valor al final de la lista.
 */
return new class extends Migration
{
    private const OLD = ['ocultar', 'auto_ocultar', 'restaurar', 'descartar', 'silenciar', 'levantar_silencio', 'rol'];

    private const NEW = ['ocultar', 'auto_ocultar', 'restaurar', 'descartar', 'silenciar', 'levantar_silencio', 'rol', 'cerrar_sala'];

    public function up(): void
    {
        Schema::table('moderation_log', fn (Blueprint $t) => $t->enum('action', self::NEW)->change());
    }

    public function down(): void
    {
        DB::table('moderation_log')->where('action', 'cerrar_sala')->exists()
            && throw new RuntimeException('Hay cierres de sala en el registro de moderación: no se puede volver atrás sin perder historia.');
        Schema::table('moderation_log', fn (Blueprint $t) => $t->enum('action', self::OLD)->change());
    }
};
