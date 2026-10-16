<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Partidas de 40 minutos por salas (K1). El mundo único y persistente se reemplaza por partidas independientes:
 *  - matches: la sala. Estados lobby -> running -> finished (o expired si nadie la inició a tiempo). Nunca se borran.
 *  - match_players: un jugador en una partida, con SU dinero. `active_user_id` vale user_id mientras la partida está
 *    en lobby/running y el jugador no se fue, y NULL después: con el índice único, la base garantiza UNA sola partida activa por jugador.
 *  - match_properties: dueños DE ESA partida (solo filas de propiedades con dueño; libre = ausencia). La clave primaria
 *    (match_id, property_id) garantiza un solo dueño por propiedad y partida; la FK compuesta exige que el dueño juegue esa partida.
 *  - users: puntos del ranking global (se suman al terminar cada partida) y contadores.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('matches', function (Blueprint $table) {
            $table->id();
            $table->string('code', 6)->unique();
            $table->string('name', 60);
            $table->boolean('is_public')->default(true);
            $table->enum('status', ['lobby', 'running', 'finished', 'expired'])->default('lobby');
            $table->unsignedTinyInteger('capacity');
            $table->unsignedTinyInteger('min_players');
            // RESTRICT: ni los usuarios ni las partidas se borran sin decidirlo a propósito (hay historia y ranking).
            $table->foreignId('creator_id')->constrained('users')->restrictOnDelete();
            $table->unsignedBigInteger('start_cash');
            $table->unsignedSmallInteger('minutes_per_day');
            $table->unsignedSmallInteger('duration_minutes');
            $table->dateTime('lobby_expires_at');
            $table->dateTime('started_at')->nullable();
            $table->dateTime('ends_at')->nullable();
            $table->dateTime('finished_at')->nullable();
            $table->timestamps();

            $table->index(['status', 'is_public', 'id']);
            $table->index(['status', 'ends_at']);
        });

        Schema::create('match_players', function (Blueprint $table) {
            $table->id();
            $table->foreignId('match_id')->constrained('matches')->restrictOnDelete();
            $table->foreignId('user_id')->constrained('users')->restrictOnDelete();
            $table->unsignedBigInteger('cash')->default(0);
            // Plata comprometida por quien va ganando una subasta (disponible = cash - reserved).
            $table->unsignedBigInteger('reserved')->default(0);
            // Resto de pesos-segundo del ingreso (< segundos por día de juego): así el ingreso se liquida exacto, sin perder fracciones.
            $table->unsignedBigInteger('income_carry')->default(0);
            $table->dateTime('last_settled_at')->nullable();
            $table->dateTime('joined_at');
            $table->dateTime('left_at')->nullable();
            $table->boolean('abandoned')->default(false);
            $table->unsignedBigInteger('active_user_id')->nullable()->unique();
            $table->unsignedSmallInteger('final_rank')->nullable();
            $table->unsignedBigInteger('final_net_worth')->nullable();
            $table->unsignedSmallInteger('final_properties')->nullable();
            $table->unsignedSmallInteger('points_awarded')->nullable();
            $table->timestamps();

            $table->unique(['match_id', 'user_id']);
            $table->index('user_id');
        });

        Schema::create('match_properties', function (Blueprint $table) {
            $table->unsignedBigInteger('match_id');
            $table->unsignedBigInteger('property_id');
            $table->unsignedBigInteger('owner_id');
            $table->dateTime('bought_at');
            $table->unsignedBigInteger('price_paid');

            $table->primary(['match_id', 'property_id']);
            $table->index(['match_id', 'owner_id']);
            $table->index('property_id');
            // Los dueños son estado derivado de la partida: si se purgara una partida, se van con ella.
            $table->foreign('match_id')->references('id')->on('matches')->cascadeOnDelete();
            $table->foreign('property_id')->references('id')->on('properties')->restrictOnDelete();
            $table->foreign(['match_id', 'owner_id'])->references(['match_id', 'user_id'])->on('match_players')->restrictOnDelete();
        });

        Schema::table('users', function (Blueprint $table) {
            $table->unsignedInteger('rank_points')->default(0);
            $table->unsignedInteger('matches_played')->default(0);
            $table->unsignedInteger('matches_won')->default(0);
            $table->index(['rank_points', 'matches_won']);
        });

        if (in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            DB::statement('ALTER TABLE matches ADD CONSTRAINT matches_capacity_ok CHECK (capacity >= 1 AND min_players >= 1 AND min_players <= capacity)');
            DB::statement("ALTER TABLE matches ADD CONSTRAINT matches_times_by_status CHECK ((status IN ('lobby', 'expired') AND started_at IS NULL AND ends_at IS NULL AND finished_at IS NULL) OR (status = 'running' AND started_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > started_at AND finished_at IS NULL) OR (status = 'finished' AND started_at IS NOT NULL AND ends_at IS NOT NULL AND finished_at IS NOT NULL))");
            DB::statement('ALTER TABLE match_players ADD CONSTRAINT match_players_reserved_le_cash CHECK (reserved <= cash)');
            // La partida activa solo existe mientras el jugador no se fue.
            DB::statement('ALTER TABLE match_players ADD CONSTRAINT match_players_active_key CHECK (active_user_id IS NULL OR (active_user_id = user_id AND left_at IS NULL))');
            DB::statement('ALTER TABLE match_players ADD CONSTRAINT match_players_final_pair CHECK ((final_rank IS NULL) = (final_net_worth IS NULL))');
            DB::statement('ALTER TABLE match_properties ADD CONSTRAINT match_properties_price_pos CHECK (price_paid > 0)');
        }
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropIndex(['rank_points', 'matches_won']);
            $table->dropColumn(['rank_points', 'matches_played', 'matches_won']);
        });
        Schema::dropIfExists('match_properties');
        Schema::dropIfExists('match_players');
        Schema::dropIfExists('matches');
    }
};
