<?php

namespace App\Console\Commands;

use App\Economy\OwnersVersion;
use App\Economy\PropertyCorrectionService;
use App\Enums\PropertyKind;
use App\Formosa\EnvironmentBuilder;
use App\Formosa\EnvironmentStore;
use App\Formosa\OverpassClient;
use App\Formosa\PropertyBuilder;
use App\Formosa\RoadsStore;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Throwable;

class ImportFormosa extends Command
{
    protected $signature = 'formosa:importar
        {--distrito= : Clave de una zona de config/formosa.php (por defecto, la zona por defecto)}
        {--archivo= : JSON de Overpass con edificios y comercios, en vez de descargarlo}
        {--calles-archivo= : JSON de Overpass con calles, en vez de descargarlo}
        {--entorno-archivo= : JSON de Overpass con el entorno 3D (agua, plazas, semáforos…), en vez de descargarlo}
        {--simular : Muestra qué se importaría sin guardar nada}
        {--ausentes=nada : Qué hacer con los comercios que YA NO figuran en OpenStreetMap: "nada" (solo avisar) o "casa" (pasan a ser casas sin nombre)}
        {--forzar : Aplica --ausentes=casa aunque la descarga traiga muchos menos edificios que los que hay (puede ser una descarga cortada)}';

    protected $description = 'Importa edificios, comercios y calles de OpenStreetMap como propiedades del juego';

    /** Columnas que el importador puede actualizar. El dueño y los cobros NUNCA se tocan al re-importar. */
    private const UPDATABLE = ['district', 'kind', 'footprint', 'name', 'street', 'area_m2', 'lat', 'lng', 'geometry', 'price', 'income_per_day', 'updated_at'];

    /** Lo único que se actualiza en una propiedad corregida a mano (o en subasta): la forma del edificio, no el rubro, el nombre ni el precio. */
    private const UPDATABLE_FROZEN = ['district', 'footprint', 'street', 'area_m2', 'lat', 'lng', 'geometry', 'updated_at'];

    public function handle(OverpassClient $overpass, PropertyCorrectionService $corrections): int
    {
        $ausentes = (string) $this->option('ausentes');
        if (! in_array($ausentes, ['nada', 'casa'], true)) {
            $this->components->error('--ausentes acepta "nada" o "casa".');

            return self::FAILURE;
        }

        $key = $this->option('distrito') ?: config('formosa.default_district');
        $bbox = config("formosa.districts.{$key}");
        if (! $bbox) {
            $this->components->error("La zona '{$key}' no existe en config/formosa.php.");

            return self::FAILURE;
        }

        try {
            $this->components->info("Zona: {$key}");
            $elements = $this->option('archivo')
                ? $this->readJson($this->option('archivo'))
                : $this->download('edificios y comercios', fn () => $overpass->buildingsAndPlaces($bbox));
            $roadElements = $this->option('calles-archivo')
                ? $this->readJson($this->option('calles-archivo'))
                : ($this->option('archivo') ? [] : $this->download('calles', fn () => $overpass->roads($bbox)));
        } catch (Throwable $e) {
            $this->components->error($e->getMessage());

            return self::FAILURE;
        }

        $result = PropertyBuilder::build($elements, $key);
        $roads = PropertyBuilder::roads($roadElements);
        // Recortado a la zona ampliada: el río Paraguay o un campo enorme no tienen que viajar enteros al navegador.
        $environment = EnvironmentBuilder::build($this->environmentElements($overpass, $bbox), OverpassClient::expand($bbox, (float) config('formosa.environment.margin_m', 500)));

        $this->table(['Tipo', 'Cantidad'], collect($result['stats'])->map(fn ($v, $k) => [$k, $v])->values()->all());
        $this->line(count($result['rows']).' propiedades · '.count($roads['features']).' tramos de calle');
        $this->line(count($environment['features']).' elementos del entorno 3D'.$this->environmentSummary($environment));

        // Qué cambiaría respecto de lo que ya hay: se calcula siempre, así --simular muestra lo mismo que se aplicaría.
        $plan = $this->plan($result['rows'], $key);
        $this->table(['Comparación con lo que ya hay', 'Cantidad'], [
            ['Propiedades nuevas', count($plan['new'])],
            ['Cambian de rubro o nombre', count($plan['changed'])],
            ['Sin cambios', $plan['same']],
            ['Protegidas (corregidas a mano o en subasta): solo se actualiza la forma', count($plan['frozen'])],
            ['Ya no figuran en OpenStreetMap (comercios)', count($plan['absent'])],
        ]);
        if ($plan['transitions'] !== []) {
            $this->table(['Cambio de rubro', 'Cantidad'], collect($plan['transitions'])->sortDesc()->map(fn ($n, $t) => [$t, $n])->values()->all());
        }

        if ($ausentes === 'casa' && $plan['absent'] !== [] && ! $this->option('forzar') && $this->looksTruncated($plan['existing'], count($result['rows']))) {
            $this->components->error(sprintf('La descarga trae %d edificios y la base tiene %d: puede estar cortada, y pasar a casa todo lo que "falta" sería un desastre. Reintentá más tarde, o usá --forzar si estás seguro.', count($result['rows']), $plan['existing']));

            return self::FAILURE;
        }

        if ($this->option('simular')) {
            $this->components->warn('Modo simular: no se guardó nada.');

            return self::SUCCESS;
        }
        if ($result['rows'] === []) {
            $this->components->warn('No hay nada para importar. ¿La zona tiene datos en OpenStreetMap?');

            return self::SUCCESS;
        }

        // Si cambia el ingreso de una propiedad con dueño, antes se le acredita lo que había acumulado a la tarifa vieja.
        foreach ($plan['pay_first'] as $id) {
            $corrections->settle($id);
        }

        $now = now()->toDateTimeString();
        DB::transaction(function () use ($result, $now, $plan) {
            $frozen = array_flip($plan['frozen']);
            $normal = [];
            $kept = [];
            foreach ($result['rows'] as $r) {
                $row = $r + ['created_at' => $now, 'updated_at' => $now];
                isset($frozen[$r['osm_type'].':'.$r['osm_id']]) ? $kept[] = $row : $normal[] = $row;
            }
            foreach (array_chunk($normal, 500) as $chunk) {
                DB::table('properties')->upsert($chunk, ['osm_type', 'osm_id'], self::UPDATABLE);
            }
            foreach (array_chunk($kept, 500) as $chunk) {
                DB::table('properties')->upsert($chunk, ['osm_type', 'osm_id'], self::UPDATABLE_FROZEN);
            }
        });
        if ($roads['features'] !== []) {
            RoadsStore::put($roads);
        }
        if ($environment['features'] !== []) {
            EnvironmentStore::put($environment);
        }

        $moved = 0;
        if ($ausentes === 'casa') {
            foreach ($plan['absent'] as $id) {
                $moved += $corrections->reclassifyFromOsm($id, PropertyKind::Casa, null, 'Ya no figura en OpenStreetMap') ? 1 : 0;
            }
            $this->line("{$moved} comercios que ya no figuran pasaron a ser casas.");
        } elseif ($plan['absent'] !== []) {
            $this->components->warn(count($plan['absent']).' comercios ya no figuran en OpenStreetMap y se dejaron como estaban. Para pasarlos a casa: php artisan formosa:importar --ausentes=casa');
        }

        if ($plan['new'] !== [] || $plan['changed'] !== [] || $moved > 0) {
            OwnersVersion::bumpCatalog(); // los mapas abiertos vuelven a leer las propiedades
        }

        $this->components->info('Listo. Abrí /mapa para verlo.');

        return self::SUCCESS;
    }

    /**
     * Compara lo descargado con lo que ya hay en la zona.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{new: list<string>, changed: list<string>, same: int, frozen: list<string>, absent: list<int>, pay_first: list<int>, transitions: array<string, int>, existing: int}
     */
    private function plan(array $rows, string $district): array
    {
        $existing = DB::table('properties')->where('district', $district)
            ->get(['id', 'osm_type', 'osm_id', 'kind', 'name', 'footprint', 'income_per_day', 'edited_at'])
            ->keyBy(fn ($e) => $e->osm_type.':'.$e->osm_id);
        $inAuction = array_flip(DB::table('auctions')->whereNotNull('active_property_id')->pluck('active_property_id')->all());
        // Propiedades que alguien tiene AHORA en una partida en juego: si cambia su ingreso, primero se les acredita lo acumulado.
        $owned = array_flip(DB::table('match_properties as mp')->join('matches as m', 'm.id', '=', 'mp.match_id')->where('m.status', 'running')->distinct()->pluck('mp.property_id')->all());

        $new = $changed = $frozen = $payFirst = [];
        $transitions = [];
        $same = 0;
        $seen = [];
        foreach ($rows as $r) {
            $key = $r['osm_type'].':'.$r['osm_id'];
            $seen[$key] = true;
            $e = $existing->get($key);
            if ($e === null) {
                $new[] = $key;

                continue;
            }
            if ($e->edited_at !== null || isset($inAuction[$e->id])) {
                $frozen[] = $key;

                continue;
            }
            if ($e->kind !== $r['kind'] || $e->name !== $r['name']) {
                $changed[] = $key;
                if ($e->kind !== $r['kind']) {
                    $transitions["{$e->kind} → {$r['kind']}"] = ($transitions["{$e->kind} → {$r['kind']}"] ?? 0) + 1;
                }
            } else {
                $same++;
            }
            if (isset($owned[$e->id]) && (int) $e->income_per_day !== (int) $r['income_per_day']) {
                $payFirst[] = (int) $e->id;
            }
        }

        $absent = [];
        foreach ($existing as $key => $e) {
            if (! isset($seen[$key]) && $e->kind !== PropertyKind::Casa->value && $e->edited_at === null && ! isset($inAuction[$e->id])) {
                $absent[] = (int) $e->id;
            }
        }

        return ['new' => $new, 'changed' => $changed, 'same' => $same, 'frozen' => $frozen, 'absent' => $absent, 'pay_first' => $payFirst, 'transitions' => $transitions, 'existing' => $existing->count()];
    }

    private function looksTruncated(int $existing, int $downloaded): bool
    {
        return $existing > 0 && $downloaded < $existing * (float) config('formosa.data.import_min_ratio');
    }

    /**
     * Elementos del entorno 3D. Es un extra: si no se pueden leer o descargar se avisa y la importación sigue
     * (se conserva el entorno guardado antes). Con --archivo y sin --entorno-archivo no se descarga, igual que las calles.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bbox
     * @return list<array<string, mixed>>
     */
    private function environmentElements(OverpassClient $overpass, array $bbox): array
    {
        try {
            if ($this->option('entorno-archivo')) {
                return $this->readJson($this->option('entorno-archivo'));
            }
            if ($this->option('archivo')) {
                return [];
            }

            return $this->download('el entorno 3D (agua, plazas, semáforos…)', fn () => $overpass->environment($bbox));
        } catch (Throwable $e) {
            $this->components->warn('No se pudo obtener el entorno 3D (se sigue sin él): '.$e->getMessage());

            return [];
        }
    }

    private function environmentSummary(array $environment): string
    {
        $counts = array_count_values(array_map(fn ($f) => (string) $f['properties']['kind'], $environment['features']));
        if ($counts === []) {
            return '';
        }
        arsort($counts);

        return ' ('.implode(', ', array_map(fn ($k, $n) => "{$k} {$n}", array_keys($counts), $counts)).')';
    }

    private function download(string $what, callable $fetch): array
    {
        $this->line("Descargando {$what} de Overpass…");

        return $fetch();
    }

    private function readJson(string $path): array
    {
        if (! is_file($path)) {
            throw new \RuntimeException("No existe el archivo: {$path}");
        }
        $json = json_decode((string) file_get_contents($path), true);
        if (! is_array($json)) {
            throw new \RuntimeException("El archivo no es un JSON válido: {$path}");
        }

        return $json['elements'] ?? $json;
    }
}
