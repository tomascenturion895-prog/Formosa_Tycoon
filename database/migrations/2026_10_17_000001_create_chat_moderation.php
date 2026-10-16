<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Moderación del chat.
 *  - users.role: 'jugador' (por defecto) o 'moderador'. No se asigna desde ningún formulario: solo con `moderador:asignar`.
 *  - chat_messages.hidden_*: un mensaje oculto deja de mostrarse a todos, pero se conserva (para revisarlo o restaurarlo).
 *    `hidden_by` es NULL cuando lo ocultaron los reportes y no una persona.
 *  - chat_reports: una fila por (mensaje, quien reporta). Único: reportar dos veces no suma.
 *  - chat_mutes: silencios. Solo se agregan (historial); uno está vigente si no se levantó y no venció.
 *  - moderation_log: quién hizo qué y cuándo (ocultar, restaurar, silenciar…), con copia del texto. NO se borra con el mensaje:
 *    es la prueba ante un reclamo o un moderador que se pasa.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->enum('role', ['jugador', 'moderador'])->default('jugador');
        });

        Schema::table('chat_messages', function (Blueprint $table) {
            $table->timestamp('hidden_at')->nullable();
            $table->foreignId('hidden_by')->nullable()->constrained('users')->restrictOnDelete();
            $table->enum('hidden_reason', ['reportes', 'moderador'])->nullable();
            // Un moderador ya lo revisó (restauró o descartó): los reportes siguientes no lo vuelven a ocultar solos.
            $table->timestamp('reviewed_at')->nullable();
        });

        Schema::create('chat_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('message_id')->constrained('chat_messages')->cascadeOnDelete(); // al vencer el mensaje, se van sus reportes
            $table->foreignId('reporter_id')->constrained('users')->restrictOnDelete();
            $table->string('reason', 20); // los motivos válidos viven en config/formosa.php (se validan al reportar)
            $table->enum('status', ['abierto', 'resuelto', 'descartado'])->default('abierto');
            $table->foreignId('resolved_by')->nullable()->constrained('users')->restrictOnDelete();
            $table->timestamp('resolved_at')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['message_id', 'reporter_id']);
            $table->index(['status', 'message_id']);
            $table->index('reporter_id');
        });

        Schema::create('chat_mutes', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->foreignId('muted_by')->constrained('users')->restrictOnDelete();
            $table->string('reason', 120)->nullable();
            $table->dateTime('expires_at');
            $table->dateTime('lifted_at')->nullable();
            $table->foreignId('lifted_by')->nullable()->constrained('users')->restrictOnDelete();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['user_id', 'expires_at']);
            $table->index('muted_by');
        });

        Schema::create('moderation_log', function (Blueprint $table) {
            $table->id();
            $table->foreignId('actor_id')->nullable()->constrained('users')->restrictOnDelete(); // NULL = el sistema (ocultado automático)
            $table->enum('action', ['ocultar', 'auto_ocultar', 'restaurar', 'descartar', 'silenciar', 'levantar_silencio', 'rol']);
            $table->unsignedBigInteger('message_id')->nullable(); // sin FK a propósito: el registro sobrevive a la limpieza del chat
            $table->foreignId('target_user_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->string('detail', 400)->nullable(); // copia del texto del mensaje, duración del silencio, etc.
            $table->timestamp('created_at')->useCurrent();

            $table->index('created_at');
            $table->index('actor_id');
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_hidden_consistent CHECK ((hidden_at IS NULL AND hidden_reason IS NULL AND hidden_by IS NULL) OR (hidden_at IS NOT NULL AND hidden_reason IS NOT NULL AND ((hidden_reason = \'moderador\') = (hidden_by IS NOT NULL))))');
            DB::statement('ALTER TABLE chat_reports ADD CONSTRAINT chat_reports_resolved_consistent CHECK ((status = \'abierto\' AND resolved_at IS NULL) OR (status <> \'abierto\' AND resolved_at IS NOT NULL))');
            DB::statement('ALTER TABLE chat_mutes ADD CONSTRAINT chat_mutes_lift_consistent CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))');
        }
    }

    public function down(): void
    {
        // Primero la restricción CHECK (referencia columnas que se van a borrar); en MariaDB no existe sin IF EXISTS si el paso falló a medias.
        if (in_array(DB::getDriverName(), ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE chat_messages DROP CONSTRAINT '.(DB::getDriverName() === 'mariadb' ? 'IF EXISTS ' : '').'chat_messages_hidden_consistent');
        }
        Schema::dropIfExists('moderation_log');
        Schema::dropIfExists('chat_mutes');
        Schema::dropIfExists('chat_reports');
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->dropConstrainedForeignId('hidden_by');
            $table->dropColumn(['hidden_at', 'hidden_reason', 'reviewed_at']);
        });
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('role');
        });
    }
};
