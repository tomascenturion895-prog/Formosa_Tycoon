<?php

namespace App\Formosa;

/**
 * Convierte elementos de Overpass (`out tags geom`) en el ENTORNO de la ciudad 3D, como GeoJSON:
 * agua, ríos, plazas, parques, canchas, usos del suelo, edificios emblemáticos y mobiliario de calle.
 * Puro (sin base de datos ni red). Cada feature lleva `{kind, name|null, osm_id}` y, según el tipo,
 * `landuse`, `landmark` o `width`. Las geometrías degeneradas se descartan; las coordenadas van con 6 decimales.
 */
final class EnvironmentBuilder
{
    /** Tipos que son superficies (Polygon/MultiPolygon). */
    private const AREA_KINDS = ['water', 'park', 'plaza', 'pitch', 'playground', 'landuse'];

    /** Tipos que son puntos. */
    private const POINT_KINDS = ['signal', 'bus_stop', 'crossing'];

    /**
     * @param  list<array<string, mixed>>  $elements
     * @param  array{south: float, west: float, north: float, east: float}|null  $clip  si viene, las superficies se recortan
     *         a esta caja y lo que queda afuera se descarta (el río Paraguay entero mide cientos de kilómetros)
     * @return array{type: string, features: list<array<string, mixed>>}
     */
    public static function build(array $elements, ?array $clip = null): array
    {
        $features = [];
        $seen = [];
        foreach ($elements as $el) {
            if (! is_array($el) || ! isset($el['type'])) {
                continue;
            }
            $tags = is_array($el['tags'] ?? null) ? $el['tags'] : [];
            $class = self::classify($tags, (string) $el['type']);
            if ($class === null) {
                continue;
            }
            $key = $el['type'].':'.($el['id'] ?? '?');
            if (isset($seen[$key])) {
                continue; // la misma cosa repetida en el archivo
            }
            $seen[$key] = true;

            $props = ['kind' => $class['kind'], 'name' => TextClean::line($tags['name'] ?? null, 120), 'osm_id' => is_numeric($el['id'] ?? null) ? (int) $el['id'] : 0] + $class['extra'];
            foreach (self::geometries($el, $class['kind']) as $geometry) {
                if ($clip !== null && ($geometry = self::clip($geometry, $clip)) === null) {
                    continue;
                }
                $features[] = ['type' => 'Feature', 'properties' => $props, 'geometry' => $geometry];
            }
        }

        return ['type' => 'FeatureCollection', 'features' => $features];
    }

    /**
     * Qué es un elemento según sus etiquetas, o null si no interesa.
     *
     * @param  array<string, mixed>  $tags
     * @return array{kind: string, extra: array<string, mixed>}|null
     */
    public static function classify(array $tags, string $type = 'way'): ?array
    {
        $t = fn (string $k): string => is_scalar($tags[$k] ?? null) ? strtolower(trim((string) $tags[$k])) : '';
        $name = TextClean::line($tags['name'] ?? null, 120) ?? '';

        // Mobiliario de calle: solo como punto.
        if ($type === 'node') {
            if ($t('highway') === 'traffic_signals') {
                return ['kind' => 'signal', 'extra' => []];
            }
            if ($t('highway') === 'bus_stop') {
                return ['kind' => 'bus_stop', 'extra' => []];
            }
            if ($t('highway') === 'crossing') {
                return ['kind' => 'crossing', 'extra' => []];
            }
        }
        if ($t('public_transport') === 'platform' && ($t('bus') === 'yes' || $t('highway') === 'bus_stop' || $type === 'node')) {
            return ['kind' => 'bus_stop', 'extra' => []];
        }

        // Agua.
        if (in_array($t('waterway'), ['river', 'stream', 'canal'], true)) {
            $width = self::meters($t('width'));

            return ['kind' => 'river', 'extra' => $width !== null ? ['width' => $width] : []];
        }
        if ($t('natural') === 'water' || $t('waterway') === 'riverbank' || ($t('water') !== '' && $t('natural') !== 'wetland')) {
            return ['kind' => 'water', 'extra' => []];
        }

        // Plazas, parques y canchas. Una plaza puede estar mapeada como parque: manda el nombre.
        if ($t('place') === 'square') {
            return ['kind' => 'plaza', 'extra' => []];
        }
        if (in_array($t('leisure'), ['park', 'garden'], true)) {
            return ['kind' => preg_match('/^plaza\b/iu', $name) ? 'plaza' : 'park', 'extra' => []];
        }
        if ($t('leisure') === 'pitch') {
            return ['kind' => 'pitch', 'extra' => []];
        }
        if ($t('leisure') === 'playground') {
            return ['kind' => 'playground', 'extra' => []];
        }

        // Edificios emblemáticos.
        $landmark = self::landmark($tags, $name);
        if ($landmark !== null) {
            return ['kind' => 'landmark', 'extra' => ['landmark' => $landmark]];
        }

        // Usos del suelo (pasto, barrio, campo, monte, cementerio…).
        $landuse = $t('landuse');
        if ($landuse !== '' && preg_match('/^[a-z_]{2,40}$/', $landuse)) {
            return ['kind' => 'landuse', 'extra' => ['landuse' => $landuse]];
        }

        return null;
    }

    /** catedral|casa_gobierno|estacion|museo|iglesia|monumento|puerto|otro, o null si no es emblemático. */
    private static function landmark(array $tags, string $name): ?string
    {
        $t = fn (string $k): string => is_scalar($tags[$k] ?? null) ? strtolower(trim((string) $tags[$k])) : '';
        $worship = $t('amenity') === 'place_of_worship';
        $monument = in_array($t('historic'), ['monument', 'memorial'], true);
        $museum = $t('tourism') === 'museum';
        $named = $t('building') !== '' && preg_match('/catedral|casa de gobierno|estaci[oó]n|museo|iglesia|parroquia|puerto|terminal/iu', $name);

        if (! $worship && ! $monument && ! $museum && ! $named) {
            return null;
        }
        // Una estación de servicio no es la estación de tren.
        if ($t('amenity') === 'fuel' || preg_match('/estaci[oó]n de servicio/iu', $name)) {
            return null;
        }
        if ($worship && $name === '') {
            return null;
        }

        return match (true) {
            (bool) preg_match('/catedral/iu', $name) || $t('building') === 'cathedral' => 'catedral',
            (bool) preg_match('/casa de gobierno/iu', $name) => 'casa_gobierno',
            (bool) preg_match('/estaci[oó]n/iu', $name) || $t('building') === 'train_station' || $t('railway') === 'station' => 'estacion',
            $museum || (bool) preg_match('/museo/iu', $name) => 'museo',
            $monument => 'monumento',
            (bool) preg_match('/puerto/iu', $name) => 'puerto',
            $worship || (bool) preg_match('/iglesia|parroquia/iu', $name) => 'iglesia',
            default => 'otro',
        };
    }

    /**
     * Geometrías GeoJSON de un elemento según su tipo. Un río mapeado como relación da una línea por miembro.
     *
     * @return list<array<string, mixed>>
     */
    private static function geometries(array $el, string $kind): array
    {
        $type = $el['type'];

        if ($type === 'node') {
            if (! isset($el['lat'], $el['lon']) || ! is_numeric($el['lat']) || ! is_numeric($el['lon'])) {
                return [];
            }
            $point = ['type' => 'Point', 'coordinates' => [round((float) $el['lon'], 6), round((float) $el['lat'], 6)]];

            // Una superficie mapeada como punto no se puede dibujar como superficie; un emblemático o una parada sí.
            return in_array($kind, self::AREA_KINDS, true) || $kind === 'river' ? [] : [$point];
        }

        if ($type === 'way') {
            $line = self::line($el['geometry'] ?? null);
            if ($line === null) {
                return [];
            }
            if ($kind === 'river') {
                return [['type' => 'LineString', 'coordinates' => $line]];
            }
            if (in_array($kind, self::POINT_KINDS, true)) {
                return [['type' => 'Point', 'coordinates' => self::centroidPoint($line)]];
            }
            $ring = self::ring($line);

            return $ring === null ? [] : [['type' => 'Polygon', 'coordinates' => [$ring]]];
        }

        if ($type === 'relation') {
            $members = is_array($el['members'] ?? null) ? $el['members'] : [];
            if ($kind === 'river') {
                $out = [];
                foreach ($members as $m) {
                    if (($m['type'] ?? null) === 'way' && ($line = self::line($m['geometry'] ?? null)) !== null) {
                        $out[] = ['type' => 'LineString', 'coordinates' => $line];
                    }
                }

                return $out;
            }
            if (in_array($kind, self::POINT_KINDS, true)) {
                return [];
            }

            return self::multipolygon($members);
        }

        return [];
    }

    /**
     * Recorta una geometría a la caja. Polígonos: Sutherland–Hodgman por anillo. Puntos y líneas: se descartan si
     * quedan completamente afuera (una línea que entra y sale se deja entera). Null si no queda nada.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $box
     */
    private static function clip(array $geometry, array $box): ?array
    {
        [$w, $s, $e, $n] = [(float) $box['west'], (float) $box['south'], (float) $box['east'], (float) $box['north']];
        $inside = fn (array $p): bool => $p[0] >= $w && $p[0] <= $e && $p[1] >= $s && $p[1] <= $n;

        switch ($geometry['type']) {
            case 'Point':
                return $inside($geometry['coordinates']) ? $geometry : null;
            case 'LineString':
                foreach ($geometry['coordinates'] as $p) {
                    if ($inside($p)) {
                        return $geometry;
                    }
                }

                return null;
            case 'Polygon':
                $ring = self::clipRing($geometry['coordinates'][0], $w, $s, $e, $n);

                return $ring === null ? null : ['type' => 'Polygon', 'coordinates' => [$ring]];
            case 'MultiPolygon':
                $rings = [];
                foreach ($geometry['coordinates'] as $poly) {
                    if (($ring = self::clipRing($poly[0], $w, $s, $e, $n)) !== null) {
                        $rings[] = $ring;
                    }
                }
                if ($rings === []) {
                    return null;
                }

                return count($rings) === 1
                    ? ['type' => 'Polygon', 'coordinates' => [$rings[0]]]
                    : ['type' => 'MultiPolygon', 'coordinates' => array_map(fn ($r) => [$r], $rings)];
        }

        return $geometry;
    }

    /** @param  list<array{0: float, 1: float}>  $ring  anillo cerrado */
    private static function clipRing(array $ring, float $w, float $s, float $e, float $n): ?array
    {
        [$minX, $minY, $maxX, $maxY] = Geo::bbox($ring);
        if ($minX >= $w && $maxX <= $e && $minY >= $s && $maxY <= $n) {
            return $ring; // entero adentro: no se toca
        }
        if ($maxX < $w || $minX > $e || $maxY < $s || $minY > $n) {
            return null; // entero afuera
        }

        $pts = array_slice($ring, 0, -1);
        // Cada borde: [eje (0 = x, 1 = y), límite, ¿se queda lo mayor o igual?]
        foreach ([[0, $w, true], [0, $e, false], [1, $s, true], [1, $n, false]] as [$axis, $limit, $keepAbove]) {
            $in = fn (array $p): bool => $keepAbove ? $p[$axis] >= $limit : $p[$axis] <= $limit;
            $out = [];
            $count = count($pts);
            for ($i = 0; $i < $count; $i++) {
                $cur = $pts[$i];
                $prev = $pts[($i + $count - 1) % $count];
                if ($in($cur)) {
                    if (! $in($prev)) {
                        $out[] = self::cut($prev, $cur, $axis, $limit);
                    }
                    $out[] = $cur;
                } elseif ($in($prev)) {
                    $out[] = self::cut($prev, $cur, $axis, $limit);
                }
            }
            $pts = $out;
            if (count($pts) < 3) {
                return null;
            }
        }

        $clean = [];
        foreach ($pts as $p) {
            $p = [round($p[0], 6), round($p[1], 6)];
            if ($clean === [] || $clean[count($clean) - 1] !== $p) {
                $clean[] = $p;
            }
        }
        if (count($clean) < 3) {
            return null;
        }

        return self::ring(Geo::close($clean));
    }

    /** Punto donde el segmento a→b cruza la recta eje = límite. */
    private static function cut(array $a, array $b, int $axis, float $limit): array
    {
        $t = ($limit - $a[$axis]) / ($b[$axis] - $a[$axis]);
        $p = [$a[0] + ($b[0] - $a[0]) * $t, $a[1] + ($b[1] - $a[1]) * $t];
        $p[$axis] = $limit;

        return $p;
    }

    /**
     * Arma los anillos exteriores de un multipolígono uniendo los tramos de sus miembros `outer`.
     * Los huecos (`inner`) se ignoran: para el 3D alcanza con el contorno.
     *
     * @return list<array<string, mixed>>
     */
    private static function multipolygon(array $members): array
    {
        $segments = [];
        foreach ($members as $m) {
            if (($m['type'] ?? null) !== 'way' || ! in_array($m['role'] ?? '', ['outer', ''], true)) {
                continue;
            }
            $line = self::line($m['geometry'] ?? null);
            if ($line !== null) {
                $segments[] = $line;
            }
        }

        $rings = [];
        while ($segments !== []) {
            $current = array_shift($segments);
            // Se va pegando el tramo que empiece (o termine) donde termina el actual, hasta cerrar el anillo.
            while ($current[0] !== $current[count($current) - 1]) {
                $end = $current[count($current) - 1];
                $found = false;
                foreach ($segments as $i => $seg) {
                    if ($seg[0] === $end) {
                        $current = array_merge($current, array_slice($seg, 1));
                    } elseif ($seg[count($seg) - 1] === $end) {
                        $current = array_merge($current, array_slice(array_reverse($seg), 1));
                    } else {
                        continue;
                    }
                    unset($segments[$i]);
                    $found = true;
                    break;
                }
                if (! $found) {
                    break; // anillo incompleto (miembro faltante o cortado): se descarta
                }
            }
            $ring = self::ring($current, requireClosed: true);
            if ($ring !== null) {
                $rings[] = $ring;
            }
        }

        if ($rings === []) {
            return [];
        }
        if (count($rings) === 1) {
            return [['type' => 'Polygon', 'coordinates' => [$rings[0]]]];
        }

        return [['type' => 'MultiPolygon', 'coordinates' => array_map(fn ($r) => [$r], $rings)]];
    }

    /**
     * Puntos de Overpass → [[lng, lat], ...] redondeados, sin repetidos seguidos. Null si queda menos de 2 puntos.
     *
     * @return list<array{0: float, 1: float}>|null
     */
    private static function line(mixed $geometry): ?array
    {
        if (! is_array($geometry)) {
            return null;
        }
        $coords = [];
        foreach ($geometry as $pt) {
            if (! is_array($pt) || ! isset($pt['lat'], $pt['lon']) || ! is_numeric($pt['lat']) || ! is_numeric($pt['lon'])) {
                continue;
            }
            $c = [round((float) $pt['lon'], 6), round((float) $pt['lat'], 6)];
            if ($coords === [] || $coords[count($coords) - 1] !== $c) {
                $coords[] = $c;
            }
        }

        return count($coords) >= 2 ? $coords : null;
    }

    /**
     * Anillo cerrado, en sentido antihorario, con superficie real (al menos 1 m²). Null si es degenerado.
     *
     * @param  list<array{0: float, 1: float}>  $line
     */
    private static function ring(array $line, bool $requireClosed = true): ?array
    {
        if ($requireClosed && $line[0] !== $line[count($line) - 1]) {
            return null;
        }
        $ring = Geo::close($line);
        if (count($ring) < 4 || Geo::areaAndCentroid($ring)['area'] < 1.0) {
            return null;
        }
        $signed = 0.0;
        for ($i = 0, $n = count($ring) - 1; $i < $n; $i++) {
            $signed += $ring[$i][0] * $ring[$i + 1][1] - $ring[$i + 1][0] * $ring[$i][1];
        }

        return $signed < 0 ? array_reverse($ring) : $ring;
    }

    /** @param  list<array{0: float, 1: float}>  $line */
    private static function centroidPoint(array $line): array
    {
        $n = count($line);

        return [round(array_sum(array_column($line, 0)) / $n, 6), round(array_sum(array_column($line, 1)) / $n, 6)];
    }

    private static function meters(string $v): ?float
    {
        if (! preg_match('/^(\d+(?:[.,]\d+)?)\s*(m|mts?|metros?)?$/', $v, $m)) {
            return null;
        }
        $w = (float) str_replace(',', '.', $m[1]);

        return $w > 0 && $w <= 5000 ? round($w, 2) : null;
    }
}
