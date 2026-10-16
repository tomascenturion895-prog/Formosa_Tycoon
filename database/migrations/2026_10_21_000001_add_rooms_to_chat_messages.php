<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Dos chats: GLOBAL (match_id NULL, como hasta ahora) y SALA (match_id = la partida).
 *  - match_id: la sala a la que pertenece el mensaje. Si la partida se borra, se van sus mensajes (ON DELETE CASCADE).
 *  - kind: 'usuario' (lo escribió una persona) o 'sistema' (aviso automático del juego: compras, entradas, tiempo...).
 *    Un mensaje de sistema no tiene autor (user_id NULL), solo existe en una sala y no se puede reportar ni silenciar.
 *  - event_key: clave de un aviso de sistema que debe salir UNA sola vez por sala (inicio, fin, "quedan 10 min").
 *    Único por (sala, clave); en los mensajes de personas es NULL (los NULL no chocan entre sí).
 *  - Índices: (match_id, id) para leer el historial de un canal en orden, (match_id, created_at) para la retención por canal.
 *
 * Reversible: al volver atrás se borran los mensajes de sala (si no, pasarían a verse en el chat global).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->unsignedBigInteger('match_id')->nullable()->after('id');
            $table->enum('kind', ['usuario', 'sistema'])->default('usuario')->after('match_id');
            $table->string('event_key', 40)->nullable()->after('client_key');
        });
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->unsignedBigInteger('user_id')->nullable()->change(); // los avisos de sistema no tienen autor
            $table->index(['match_id', 'id'], 'chat_messages_match_id_id_index');
            $table->index(['match_id', 'created_at'], 'chat_messages_match_created_index');
            $table->unique(['match_id', 'event_key'], 'chat_messages_match_event_unique');
            $table->foreign('match_id')->references('id')->on('matches')->cascadeOnDelete();
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            // Autor y tipo van juntos, y un aviso de sistema siempre pertenece a una sala.
            DB::statement("ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_consistent CHECK ((kind = 'sistema' AND user_id IS NULL AND match_id IS NOT NULL) OR (kind = 'usuario' AND user_id IS NOT NULL))");
        }
    }

    public function down(): void
    {
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE chat_messages DROP CONSTRAINT '.(DB::getDriverName() === 'mariadb' ? 'IF EXISTS ' : '').'chat_messages_kind_consistent');
        } elseif (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_kind_consistent');
        }
        // Sin esto, lo escrito en las salas pasaría a verse en el chat global.
        DB::table('chat_messages')->whereNotNull('match_id')->delete();

        Schema::table('chat_messages', function (Blueprint $table) {
            $table->dropForeign(['match_id']);
            $table->dropUnique('chat_messages_match_event_unique');
            $table->dropIndex('chat_messages_match_created_index');
            $table->dropIndex('chat_messages_match_id_id_index');
        });
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->dropColumn(['match_id', 'kind', 'event_key']);
            $table->unsignedBigInteger('user_id')->nullable(false)->change();
        });
    }
};
