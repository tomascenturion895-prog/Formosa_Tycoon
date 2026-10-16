<?php

namespace Tests\Support;

use App\Economy\MatchService;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\Property;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** Ayudas comunes de las pruebas de partidas: propiedades, jugadores y partidas en juego. */
trait PlaysMatches
{
    /** Inserta una propiedad. `$income` es por DÍA DE JUEGO. Sin `$lat`/`$lng`, cada una cae en su propia zona (así no activa combos sin querer). */
    protected function makeProperty(int $price = 10000, int $income = 0, string $kind = 'casa', ?float $lat = null, ?float $lng = null): Property
    {
        $id = DB::table('properties')->count() + 1;
        DB::table('properties')->insert([
            'osm_type' => 'way', 'osm_id' => $id, 'district' => 'test', 'kind' => $kind, 'footprint' => 'osm',
            'area_m2' => 100, 'lat' => $lat ?? -26.18 - $id * 0.01, 'lng' => $lng ?? -58.17,
            'geometry' => json_encode(['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]),
            'price' => $price, 'income_per_day' => $income, 'created_at' => now(), 'updated_at' => now(),
        ]);

        return Property::where('osm_id', $id)->firstOrFail();
    }

    /**
     * Crea y arranca una partida con estos jugadores (el primero la crea). Dinero inicial `$startCash` para todos.
     * Usa el flujo real: crear sala, unirse por código e iniciar.
     *
     * @param  list<User>  $users
     */
    protected function startedMatch(array $users, int $startCash = 30000, ?int $capacity = null): GameMatch
    {
        config(['formosa.match.start_cash' => $startCash, 'formosa.match.min_players' => 1]);
        $svc = app(MatchService::class);
        $match = $svc->create($users[0], 'Sala de prueba', $capacity);
        foreach (array_slice($users, 1) as $u) {
            $svc->join($u, $match->code);
        }

        return $svc->start($users[0], $match->id);
    }

    protected function player(GameMatch $match, User $user): MatchPlayer
    {
        return MatchPlayer::where('match_id', $match->id)->where('user_id', $user->id)->firstOrFail();
    }

    protected function cash(GameMatch $match, User $user): int
    {
        return (int) $this->player($match, $user)->cash;
    }

    /** Dueño de la propiedad en la partida (null = libre). */
    protected function ownerOf(GameMatch $match, Property|int $property): ?int
    {
        $id = $property instanceof Property ? $property->id : $property;
        $owner = DB::table('match_properties')->where('match_id', $match->id)->where('property_id', $id)->value('owner_id');

        return $owner === null ? null : (int) $owner;
    }

    /** Invariante central: el dinero de cada jugador en la partida es la suma de su libro. */
    protected function assertLedgerMatchesCash(GameMatch $match): void
    {
        foreach (MatchPlayer::where('match_id', $match->id)->get() as $p) {
            $this->assertSame((int) $p->cash, (int) LedgerEntry::where('match_id', $match->id)->where('user_id', $p->user_id)->sum('amount'), "libro != dinero (usuario {$p->user_id})");
        }
    }
}
