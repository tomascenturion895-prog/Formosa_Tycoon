<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Fase 4: chat.
 *  - Solo se agregan mensajes (no se editan). Se borran únicamente por antigüedad (`chat:limpiar`).
 *  - (user_id, client_key) único: si el navegador reintenta el mismo envío (doble toque, red lenta), no se duplica.
 *  - created_at indexado (limpieza) y (user_id, created_at) (control de mensajes repetidos sin recorrer todo lo del jugador).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('chat_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->string('client_key', 64);
            $table->string('body', 280);
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['user_id', 'client_key']);
            $table->index('created_at');
            $table->index(['user_id', 'created_at']); // control de mensajes repetidos
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_body_len CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 280)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('chat_messages');
    }
};
