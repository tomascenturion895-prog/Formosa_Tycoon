<?php

namespace App\Formosa;

use App\Enums\PropertyKind;

/**
 * Convierte elementos de Overpass (JSON con `out tags geom`) en filas de propiedades y en las calles del mapa.
 * Puro (sin base de datos ni red): se prueba con archivos de ejemplo.
 */
final class PropertyBuilder
{
    private const ROAD_TYPES = [
        'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian',
        'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
    ];

    /**
     * @param  list<array<string, mixed>>  $elements
     * @return array{rows: list<array<string, mixed>>, stats: array<string, int>}
     */
    public static function build(array $elements, string $district): array
    {
        $containers = []; // polígonos candidatos
        $pois = [];       // puntos (comercios, hoteles) mapeados como nodo

        foreach ($elements as $el) {
            $tags = is_array($el['tags'] ?? null) ? $el['tags'] : [];
            $type = $el['type'] ?? null;

            if ($type === 'way' && isset($el['id'], $el['geometry']) && is_array($el['geometry'])) {
                $ring = self::ringFrom($el['geometry']);
                if ($ring === null) {
                    continue;
                }
                $m = Geo::areaAndCentroid($ring);
                $kind = Classifier::classify($tags, $m['area']);
                if ($kind === null && ! isset($tags['building'])) {
                    continue; // ni edificio ni propiedad
                }
                $containers[] = [
                    'id' => (int) $el['id'],
                    'tags' => $tags,
                    'ring' => $ring,
                    'bbox' => Geo::bbox($ring),
                    'area' => $m['area'],
                    'lng' => $m['lng'],
                    'lat' => $m['lat'],
                    'kind' => $kind,
                    'name' => self::clean($tags['name'] ?? null),
                ];
            } elseif ($type === 'node' && isset($el['id'], $el['lat'], $el['lon'])) {
                $kind = Classifier::classify($tags, null);
                if ($kind !== null) {
                    $pois[] = ['id' => (int) $el['id'], 'lng' => (float) $el['lon'], 'lat' => (float) $el['lat'], 'tags' => $tags, 'kind' => $kind, 'name' => self::clean($tags['name'] ?? null)];
                }
            }
        }

        $merged = 0;
        $synthetic = [];
        foreach ($pois as $poi) {
            $host = self::containerFor($containers, $poi['lng'], $poi['lat']);
            if ($host === null) {
                $synthetic[] = $poi;

                continue;
            }
            $stronger = $containers[$host]['kind'] === null || $poi['kind']->priority() > $containers[$host]['kind']->priority();
            $containers[$host]['kind'] = PropertyKind::strongest($containers[$host]['kind'], $poi['kind']);
            $containers[$host]['name'] = $stronger
                ? ($poi['name'] ?? $containers[$host]['name'])
                : ($containers[$host]['name'] ?? $poi['name']);
            $merged++;
        }

        $rows = [];
        $stats = ['casa' => 0, 'comercio' => 0, 'supermercado' => 0, 'hotel' => 0, 'edificios_sin_tipo' => 0, 'puntos_en_edificio' => $merged, 'puntos_sinteticos' => count($synthetic)];

        foreach ($containers as $c) {
            if ($c['kind'] === null) {
                $stats['edificios_sin_tipo']++;

                continue;
            }
            $rows[] = self::row('way', $c['id'], $district, $c['kind'], 'osm', $c['name'], $c['tags'], $c['area'], $c['lng'], $c['lat'], $c['ring']);
            $stats[$c['kind']->value]++;
        }

        $side = (float) config('formosa.synthetic_footprint_m');
        foreach ($synthetic as $p) {
            $ring = Geo::squareAround($p['lng'], $p['lat'], $side);
            $rows[] = self::row('node', $p['id'], $district, $p['kind'], 'sintetica', $p['name'], $p['tags'], $side * $side, $p['lng'], $p['lat'], $ring);
            $stats[$p['kind']->value]++;
        }

        return ['rows' => $rows, 'stats' => $stats];
    }

    /**
     * Calles para dibujar en el mapa, como GeoJSON.
     *
     * @param  list<array<string, mixed>>  $elements
     * @return array{type: string, features: list<array<string, mixed>>}
     */
    public static function roads(array $elements): array
    {
        $features = [];
        foreach ($elements as $el) {
            $highway = $el['tags']['highway'] ?? null;
            if (($el['type'] ?? null) !== 'way' || ! in_array($highway, self::ROAD_TYPES, true) || ! isset($el['geometry']) || count($el['geometry']) < 2) {
                continue;
            }
            $coords = [];
            foreach ($el['geometry'] as $pt) {
                if (isset($pt['lat'], $pt['lon'])) {
                    $coords[] = [round((float) $pt['lon'], 6), round((float) $pt['lat'], 6)];
                }
            }
            if (count($coords) < 2) {
                continue;
            }
            $features[] = [
                'type' => 'Feature',
                'properties' => ['highway' => $highway, 'name' => self::clean($el['tags']['name'] ?? null)] + self::roadTags($el['tags'], $el['id'] ?? 0),
                'geometry' => ['type' => 'LineString', 'coordinates' => $coords],
            ];
        }

        return ['type' => 'FeatureCollection', 'features' => $features];
    }

    /**
     * Etiquetas de OSM que usa la ciudad 3D (sentido, carriles, ancho, calzada…). Todas son opcionales para el
     * navegador: un archivo viejo trae solo highway y name. Los valores raros o ilegibles quedan en null.
     *
     * @param  array<string, mixed>  $tags
     * @return array{oneway: int, lanes: int|null, width: float|null, surface: string|null, maxspeed: int|null, junction: string|null, bridge: bool, osm_id: int}
     */
    public static function roadTags(array $tags, mixed $osmId = 0): array
    {
        $str = fn (string $k): string => is_scalar($tags[$k] ?? null) ? strtolower(trim((string) $tags[$k])) : '';

        $junction = in_array($str('junction'), ['roundabout', 'circular'], true) ? 'roundabout' : null;
        $oneway = match ($str('oneway')) {
            'yes', '1', 'true' => 1,
            '-1', 'reverse' => -1,
            'no', 'false', '0' => 0,
            default => $junction !== null ? 1 : 0, // una rotonda es mano única salvo que diga lo contrario
        };

        $lanes = preg_match('/^\s*(\d{1,2})\b/', $str('lanes'), $m) ? (int) $m[1] : null;
        if ($lanes !== null && ($lanes < 1 || $lanes > 12)) {
            $lanes = null;
        }

        return [
            'oneway' => $oneway,
            'lanes' => $lanes,
            'width' => self::meters($str('width')),
            'surface' => self::surface($str('surface')),
            'maxspeed' => self::speed($str('maxspeed')),
            'junction' => $junction,
            'bridge' => $str('bridge') !== '' && $str('bridge') !== 'no',
            'osm_id' => is_numeric($osmId) ? (int) $osmId : 0,
        ];
    }

    /** "7", "7 m", "7.5", "7,5" → metros. Pies u otras unidades, o valores absurdos → null. */
    private static function meters(string $v): ?float
    {
        if (! preg_match('/^(\d+(?:[.,]\d+)?)\s*(m|mts?|metros?)?$/', $v, $m)) {
            return null;
        }
        $w = (float) str_replace(',', '.', $m[1]);

        return $w > 0 && $w <= 100 ? round($w, 2) : null;
    }

    /** "40", "40 km/h" → 40; "25 mph" → km/h; "AR:urban", "none", "signals" → null. */
    private static function speed(string $v): ?int
    {
        if (! preg_match('/^(\d{1,3})\s*(km\/h|kmh|kph|mph)?$/', $v, $m)) {
            return null;
        }
        $s = (int) $m[1];
        if (($m[2] ?? '') === 'mph') {
            $s = (int) round($s * 1.609344);
        }

        return $s > 0 && $s <= 200 ? $s : null;
    }

    /** Lleva el `surface` de OSM a un vocabulario corto que entiende el 3D. Desconocido → null. */
    private static function surface(string $v): ?string
    {
        if ($v === '') {
            return null;
        }
        $base = explode(':', $v)[0]; // concrete:plates → concrete, paving_stones:30 → paving_stones

        return match ($base) {
            'asphalt', 'chipseal' => 'asphalt',
            'paved' => 'paved',
            'concrete' => 'concrete',
            'paving_stones', 'bricks', 'brick', 'interlock' => 'paving_stones',
            'sett', 'cobblestone', 'unhewn_cobblestone' => 'sett',
            'unpaved', 'compacted' => 'unpaved',
            'dirt', 'earth', 'mud', 'sand' => 'dirt',
            'gravel', 'fine_gravel', 'pebblestone', 'rock' => 'gravel',
            'ground', 'grass' => 'ground',
            default => null,
        };
    }

    /** @return list<array{0: float, 1: float}>|null */
    private static function ringFrom(array $geometry): ?array
    {
        $ring = [];
        foreach ($geometry as $pt) {
            if (! isset($pt['lat'], $pt['lon'])) {
                return null;
            }
            $ring[] = [(float) $pt['lon'], (float) $pt['lat']];
        }
        $ring = Geo::close($ring);

        return count($ring) >= 4 ? $ring : null;
    }

    /** Índice del polígono más chico que contiene el punto, o null. */
    private static function containerFor(array $containers, float $lng, float $lat): ?int
    {
        $best = null;
        foreach ($containers as $i => $c) {
            [$w, $s, $e, $n] = $c['bbox'];
            if ($lng < $w || $lng > $e || $lat < $s || $lat > $n) {
                continue;
            }
            if (Geo::pointInRing($lng, $lat, $c['ring']) && ($best === null || $c['area'] < $containers[$best]['area'])) {
                $best = $i;
            }
        }

        return $best;
    }

    private static function row(string $osmType, int $osmId, string $district, PropertyKind $kind, string $footprint, ?string $name, array $tags, float $area, float $lng, float $lat, array $ring): array
    {
        ['price' => $price, 'income' => $income] = Pricing::for($kind, $area);

        $coords = array_map(fn ($p) => [round($p[0], 6), round($p[1], 6)], $ring);

        return [
            'osm_type' => $osmType,
            'osm_id' => $osmId,
            'district' => $district,
            'kind' => $kind->value,
            'footprint' => $footprint,
            // Privacidad: las casas no llevan nombre (podría ser el de una persona); tampoco número de puerta.
            'name' => $kind === PropertyKind::Casa ? null : $name,
            'street' => self::clean($tags['addr:street'] ?? null),
            'area_m2' => round($area, 1),
            'lat' => round($lat, 6),
            'lng' => round($lng, 6),
            'geometry' => json_encode(['type' => 'Polygon', 'coordinates' => [$coords]], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            'price' => $price,
            'income_per_day' => $income,
        ];
    }

    /** Texto de OSM: sin caracteres de control, recortado, null si queda vacío. Es dato no confiable. */
    private static function clean(mixed $value): ?string
    {
        return TextClean::line($value, 120);
    }
}
