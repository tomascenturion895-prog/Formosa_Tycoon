<?php

namespace App\Economy;

use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Ranking GLOBAL por puntos acumulados de partidas terminadas (ver MatchService::finish). Los puntos viven en `users`
 * (rank_points, matches_won, matches_played) y se suman de forma atómica al cerrar cada partida.
 * Desempate: más victorias, después menos partidas jugadas (mejor promedio), después el id (estable).
 */
class RankingService
{
    /**
     * Los mejores jugadores. Público: solo apodo, puntos, victorias y partidas. Se recalcula cada 15 s.
     *
     * @return list<array{position: int, id: int, name: string, points: int, wins: int, matches: int}>
     */
    public function leaderboard(): array
    {
        $size = (int) config('formosa.economy.ranking_size', 20);

        return Cache::remember("ranking.global.{$size}", 15, fn () => DB::table('users')->where('matches_played', '>', 0)
            ->orderByDesc('rank_points')->orderByDesc('matches_won')->orderBy('matches_played')->orderBy('id')->limit($size)
            ->get(['id', 'name', 'rank_points', 'matches_won', 'matches_played'])
            ->values()
            ->map(fn ($r, $i) => ['position' => $i + 1, 'id' => (int) $r->id, 'name' => $r->name, 'points' => (int) $r->rank_points, 'wins' => (int) $r->matches_won, 'matches' => (int) $r->matches_played])
            ->all());
    }

    /**
     * Puesto del jugador en el ranking global (null si todavía no terminó ninguna partida).
     *
     * @return array{position: int|null, points: int, wins: int, matches: int}
     */
    public function standing(User $user): array
    {
        $u = DB::table('users')->where('id', $user->id)->first(['rank_points', 'matches_won', 'matches_played']);
        $played = (int) ($u->matches_played ?? 0);
        $position = null;
        if ($played > 0) {
            $points = (int) $u->rank_points;
            $wins = (int) $u->matches_won;
            $position = 1 + DB::table('users')->where('matches_played', '>', 0)->where(function ($q) use ($points, $wins, $played, $user) {
                $q->where('rank_points', '>', $points)
                    ->orWhere(fn ($q) => $q->where('rank_points', $points)->where('matches_won', '>', $wins))
                    ->orWhere(fn ($q) => $q->where('rank_points', $points)->where('matches_won', $wins)->where('matches_played', '<', $played))
                    ->orWhere(fn ($q) => $q->where('rank_points', $points)->where('matches_won', $wins)->where('matches_played', $played)->where('id', '<', $user->id));
            })->count();
        }

        return ['position' => $position, 'points' => (int) ($u->rank_points ?? 0), 'wins' => (int) ($u->matches_won ?? 0), 'matches' => $played];
    }
}
