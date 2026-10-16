<?php

namespace Database\Seeders;

use App\Economy\MatchService;
use App\Formosa\DemoDistrict;
use App\Formosa\EnvironmentBuilder;
use App\Formosa\EnvironmentStore;
use App\Formosa\PropertyBuilder;
use App\Formosa\RoadsStore;
use App\Models\GameMatch;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Barrio inventado (con calles y entorno 3D) + cuatro jugadores de ejemplo en una sala abierta, para ver el mapa sin importar datos reales.
 * Solo corre en local/testing: nunca siembra datos de ejemplo en producción.
 */
class DemoSeeder extends Seeder
{
    public const DISTRICT = 'demo-microcentro';

    public function run(): void
    {
        if (! app()->environment(['local', 'testing'])) {
            $this->command?->warn('DemoSeeder solo corre en local/testing.');

            return;
        }

        $demo = DemoDistrict::elements(config('formosa.center.lat'), config('formosa.center.lng'));
        $result = PropertyBuilder::build($demo['buildings'], self::DISTRICT);
        $now = now()->toDateTimeString();

        DB::transaction(function () use ($result, $now) {
            foreach (array_chunk($result['rows'], 500) as $chunk) {
                DB::table('properties')->upsert(
                    array_map(fn ($r) => $r + ['created_at' => $now, 'updated_at' => $now], $chunk),
                    ['osm_type', 'osm_id'],
                    ['district', 'kind', 'footprint', 'name', 'street', 'area_m2', 'lat', 'lng', 'geometry', 'price', 'income_per_day', 'updated_at'],
                );
            }
        });
        RoadsStore::put(PropertyBuilder::roads($demo['roads']));
        EnvironmentStore::put(EnvironmentBuilder::build($demo['environment']));

        // Jugadores de ejemplo: nadie inicia sesión con ellos (contraseña al azar).
        $users = collect(['Ana', 'Beto', 'Carla', 'Diego'])->map(fn ($name) => User::firstOrCreate(
            ['email' => strtolower($name).'@demo.formosa.test'],
            ['name' => 'Demo '.$name, 'password' => Hash::make(Str::random(40))],
        ));

        // Una sala de ejemplo abierta, con los cuatro jugadores adentro, para ver el listado de salas sin armar nada.
        // Los dueños ya no se siembran: dependen de cada partida (se compran jugando).
        if (! GameMatch::query()->where('name', 'Sala demo')->exists()) {
            $matches = app(MatchService::class);
            $room = $matches->create($users[0], 'Sala demo', 8);
            foreach ($users->slice(1) as $u) {
                $matches->join($u, $room->code);
            }
        }
    }
}
