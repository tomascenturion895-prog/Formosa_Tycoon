<?php

namespace App\Formosa;

/**
 * Barrio SINTÉTICO (inventado) con el mismo formato que devuelve Overpass. Sirve para ver y probar el mapa
 * antes de importar los datos reales, y para pruebas automáticas. No representa lugares reales de Formosa.
 */
final class DemoDistrict
{
    private const BASE_ID = 9_000_000_000_000;

    public const BLOCKS_X = 8;

    public const BLOCKS_Y = 6;

    private const BLOCK = 100.0;   // metros de lado de cada manzana

    private const STREET = 20.0;   // ancho de calle

    private const DEPTH = 30.0;    // profundidad de cada lote

    /** Plaza San Martín: 2×2 manzanas (columnas 3-4, filas 4-5), cruzada por el bulevar. */
    private const PLAZA_BLOCKS = [[3, 4], [4, 4], [3, 5], [4, 5]];

    /** Plaza chica genérica (una manzana). */
    private const SMALL_PLAZA_BLOCK = [1, 1];

    /** Separación entre las dos manos del bulevar (metros entre ejes). */
    private const BOULEVARD_GAP = 14.0;

    /**
     * Edificios emblemáticos (metros locales: x0, y0, x1, y1). Los lotes que se superponen no se generan.
     *
     * @var array<string, array{0: float, 1: float, 2: float, 3: float, 4: array<string, string>}>
     */
    private const LANDMARKS = [
        'catedral' => [605.0, 615.0, 645.0, 690.0, ['building' => 'cathedral', 'amenity' => 'place_of_worship', 'religion' => 'christian', 'name' => 'Catedral Demo']],
        'casa_gobierno' => [605.0, 490.0, 685.0, 570.0, ['building' => 'government', 'office' => 'government', 'name' => 'Casa de Gobierno Demo']],
        'estacion' => [850.0, 255.0, 930.0, 320.0, ['building' => 'train_station', 'historic' => 'railway_station', 'name' => 'Estación Demo']],
    ];

    /**
     * Edificios y comercios, calles y entorno 3D, todo con el formato de Overpass. Las calles estrenan las etiquetas
     * que usa el 3D: un bulevar de dos manos (dos vías de sentido único), calles de tierra y una peatonal; el entorno
     * trae un río, dos plazas, emblemáticos, semáforos y paradas de colectivo.
     *
     * @return array{buildings: list<array<string, mixed>>, roads: list<array<string, mixed>>, environment: list<array<string, mixed>>}
     */
    public static function elements(float $centerLat, float $centerLng): array
    {
        $pitch = self::BLOCK + self::STREET;
        $width = self::BLOCKS_X * $pitch - self::STREET;
        $height = self::BLOCKS_Y * $pitch - self::STREET;
        [$lng0, $lat0] = Geo::offset($centerLng, $centerLat, -$width / 2, -$height / 2);

        $pt = fn (float $x, float $y): array => Geo::offset($lng0, $lat0, $x, $y);
        $poly = function (float $x, float $y, float $w, float $h) use ($pt): array {
            return array_map(
                fn ($p) => ['lat' => $p[1], 'lon' => $p[0]],
                [$pt($x, $y), $pt($x + $w, $y), $pt($x + $w, $y + $h), $pt($x, $y + $h), $pt($x, $y)],
            );
        };

        // Rectángulos (metros locales) donde NO va ningún lote: las plazas y los emblemáticos.
        $blocked = [];
        foreach ([...self::PLAZA_BLOCKS, self::SMALL_PLAZA_BLOCK] as [$bx, $by]) {
            $blocked[] = [$bx * $pitch, $by * $pitch, $bx * $pitch + self::BLOCK, $by * $pitch + self::BLOCK];
        }
        foreach (self::LANDMARKS as $l) {
            $blocked[] = [$l[0], $l[1], $l[2], $l[3]];
        }
        $free = function (float $x0, float $y0, float $x1, float $y1) use ($blocked): bool {
            foreach ($blocked as [$bx0, $by0, $bx1, $by1]) {
                if ($x0 < $bx1 && $x1 > $bx0 && $y0 < $by1 && $y1 > $by0) {
                    return false;
                }
            }

            return true;
        };

        $all = []; // [elemento, x0, y0, x1, y1]: se filtran al final, así los ids no cambian
        $id = self::BASE_ID;
        $lotW = self::BLOCK / 6;

        for ($by = 0; $by < self::BLOCKS_Y; $by++) {
            for ($bx = 0; $bx < self::BLOCKS_X; $bx++) {
                $x0 = $bx * $pitch;
                $y0 = $by * $pitch;
                $street = 'Calle '.($by + 1);
                $skip = [];

                foreach ([0, 1] as $row) {
                    $ly = $row === 0 ? $y0 : $y0 + self::BLOCK - self::DEPTH;
                    for ($lot = 0; $lot < 6; $lot++) {
                        if (isset($skip[$row][$lot])) {
                            continue;
                        }
                        $h = ($bx * 31 + $by * 17 + $row * 7 + $lot * 13) % 100;
                        $id++;
                        $lx = $x0 + $lot * $lotW;

                        // Un supermercado (2 lotes de ancho) cada tanto.
                        if ($row === 0 && $lot === 0 && ($bx + $by * 3) % 11 === 0) {
                            $all[] = [['type' => 'way', 'id' => $id, 'tags' => ['building' => 'supermarket', 'shop' => 'supermarket', 'name' => "Supermercado Demo {$id}", 'addr:street' => $street], 'geometry' => $poly($lx, $ly, $lotW * 2, self::DEPTH)], $lx, $ly, $lx + $lotW * 2, $ly + self::DEPTH];
                            $skip[0][1] = true;

                            continue;
                        }
                        // Un hotel (2 lotes de ancho) cada tanto.
                        if ($row === 1 && $lot === 2 && ($bx * 5 + $by) % 13 === 2) {
                            $all[] = [['type' => 'way', 'id' => $id, 'tags' => ['building' => 'hotel', 'tourism' => 'hotel', 'name' => "Hotel Demo {$id}", 'addr:street' => $street], 'geometry' => $poly($lx, $ly, $lotW * 2, self::DEPTH)], $lx, $ly, $lx + $lotW * 2, $ly + self::DEPTH];
                            $skip[1][3] = true;

                            continue;
                        }

                        $tags = ['addr:street' => $street];
                        if ($h < 62) {
                            $tags['building'] = 'house';
                        } elseif ($h < 74) {
                            $tags += ['building' => 'retail', 'shop' => 'convenience', 'name' => "Comercio Demo {$id}"];
                        } else {
                            $tags['building'] = 'yes'; // genérico: casa por tamaño
                        }
                        // Casa dentro del lote, con fondo variable (8 a 17 m) para que no todas cuesten lo mismo; el frente queda sobre la calle.
                        $depth = 8.0 + ($h % 4) * 3;
                        $dy = $row === 0 ? 0.0 : self::DEPTH - $depth;
                        $all[] = [['type' => 'way', 'id' => $id, 'tags' => $tags, 'geometry' => $poly($lx + 2, $ly + $dy, $lotW - 4, $depth)], $lx + 2, $ly + $dy, $lx + $lotW - 2, $ly + $dy + $depth];

                        // Algunos edificios genéricos tienen un comercio mapeado como punto adentro.
                        if ($h >= 74 && $h < 79) {
                            $id++;
                            $py = $row === 0 ? $ly + 4 : $ly + self::DEPTH - 4; // adentro aun de la casa menos profunda (8 m)
                            [$plng, $plat] = $pt($lx + $lotW / 2, $py);
                            $all[] = [['type' => 'node', 'id' => $id, 'lat' => $plat, 'lon' => $plng, 'tags' => ['shop' => 'bakery', 'name' => "Panadería Demo {$id}"]], $lx + 2, $py, $lx + $lotW - 2, $py];
                        }
                    }
                }

                // Un kiosco mapeado como punto en la esquina (en la calle, fuera de todo edificio).
                if (($bx + $by) % 7 === 3) {
                    $id++;
                    [$plng, $plat] = $pt($x0 - self::STREET / 2, $y0 - self::STREET / 2);
                    $all[] = [['type' => 'node', 'id' => $id, 'lat' => $plat, 'lon' => $plng, 'tags' => ['shop' => 'kiosk', 'name' => "Kiosco Demo {$id}"]], $x0 - self::STREET / 2, $y0 - self::STREET / 2, $x0 - self::STREET / 2, $y0 - self::STREET / 2];
                }
            }
        }

        $buildings = [];
        foreach ($all as [$el, $x0, $y0, $x1, $y1]) {
            if ($free($x0, $y0, max($x1, $x0 + 0.01), max($y1, $y0 + 0.01))) {
                $buildings[] = $el;
            }
        }

        $line = fn (array $points): array => array_map(fn ($p) => (fn ($ll) => ['lat' => $ll[1], 'lon' => $ll[0]])($pt($p[0], $p[1])), $points);
        $half = self::STREET / 2;

        // Calles: la misma grilla de siempre (7 + 9 = 16 vías), con estos cambios:
        // - la calle 6 es el bulevar "Avenida 25 de Mayo": dos vías de mano única separadas por un cantero;
        // - la calle V5 es la peatonal "Rivadavia" y termina en la Plaza San Martín (no la cruza);
        // - la calle 7 (borde norte) y la V9 (borde este, junto al río) son una sola vía: la "Avenida Costanera";
        // - las calles V2 y V8 son de tierra.
        $roads = [];
        $rid = self::BASE_ID + 5_000_000;
        $boulevardY = 5 * $pitch - $half;
        for ($by = 0; $by <= self::BLOCKS_Y - 1; $by++) {
            $y = $by * $pitch - $half;
            if ($by === 5) {
                $tags = ['highway' => 'primary', 'name' => 'Avenida 25 de Mayo', 'oneway' => 'yes', 'lanes' => '2', 'surface' => 'asphalt', 'maxspeed' => '40', 'width' => '7'];
                // Se maneja por la derecha: hacia el este por la mano sur, hacia el oeste por la mano norte.
                $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => $tags, 'geometry' => $line([[-$half, $y - self::BOULEVARD_GAP / 2], [$width + $half, $y - self::BOULEVARD_GAP / 2]])];
                $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => $tags, 'geometry' => $line([[$width + $half, $y + self::BOULEVARD_GAP / 2], [-$half, $y + self::BOULEVARD_GAP / 2]])];

                continue;
            }
            $tags = $by % 3 === 0
                ? ['highway' => 'primary', 'name' => 'Calle '.($by + 1), 'surface' => 'asphalt', 'lanes' => '2', 'maxspeed' => '40']
                : ['highway' => 'residential', 'name' => 'Calle '.($by + 1), 'surface' => 'asphalt'];
            $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => $tags, 'geometry' => $line([[-$half, $y], [$width + $half, $y]])];
        }
        $top = self::BLOCKS_Y * $pitch - $half;
        for ($bx = 0; $bx <= self::BLOCKS_X - 1; $bx++) {
            $x = $bx * $pitch - $half;
            if ($bx === 4) {
                $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => ['highway' => 'pedestrian', 'name' => 'Rivadavia', 'surface' => 'paving_stones'], 'geometry' => $line([[$x, -$half], [$x, 4 * $pitch - $half]])];

                continue;
            }
            $tags = match (true) {
                $bx === 0 => ['highway' => 'secondary', 'name' => 'Calle V1', 'surface' => 'asphalt', 'maxspeed' => '40'],
                in_array($bx, [1, 7], true) => ['highway' => 'residential', 'name' => 'Calle V'.($bx + 1), 'surface' => 'unpaved'],
                default => ['highway' => 'residential', 'name' => 'Calle V'.($bx + 1), 'surface' => 'asphalt'],
            };
            $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => $tags, 'geometry' => $line([[$x, -$half], [$x, $top]])];
        }
        $east = self::BLOCKS_X * $pitch - $half;
        $roads[] = ['type' => 'way', 'id' => ++$rid, 'tags' => ['highway' => 'secondary', 'name' => 'Avenida Costanera', 'surface' => 'asphalt', 'lanes' => '2', 'maxspeed' => '60'], 'geometry' => $line([[-$half, $top], [$east, $top], [$east, -$half]])];

        // Entorno 3D.
        $env = [];
        $eid = self::BASE_ID + 7_000_000;
        $closed = fn (array $points): array => $line([...$points, $points[0]]);
        $rect = fn (float $x0, float $y0, float $x1, float $y1): array => $closed([[$x0, $y0], [$x1, $y0], [$x1, $y1], [$x0, $y1]]);

        // El río, al este de la costanera (la orilla oeste ondula un poco).
        $env[] = ['type' => 'way', 'id' => ++$eid, 'tags' => ['natural' => 'water', 'water' => 'river', 'name' => 'Río Paraguay'], 'geometry' => $closed([
            [$east + 60, -500], [$east + 40, -200], [$east + 55, 100], [$east + 35, 400], [$east + 50, 700], [$east + 65, 1000], [$east + 50, 1200],
            [$east + 650, 1200], [$east + 650, -500],
        ])];
        $env[] = ['type' => 'way', 'id' => ++$eid, 'tags' => ['landuse' => 'grass'], 'geometry' => $rect($east + 8, -400, $east + 32, $top + 300)];

        // Plaza San Martín: las 4 manzanas y la calle que había entre ellas; el bulevar la cruza por el medio.
        [$px0, $py0] = [3 * $pitch, 4 * $pitch];
        $env[] = ['type' => 'way', 'id' => ++$eid, 'tags' => ['leisure' => 'park', 'name' => 'Plaza San Martín'], 'geometry' => $rect($px0, $py0, $px0 + 2 * self::BLOCK + self::STREET, $py0 + 2 * self::BLOCK + self::STREET)];
        // Plaza chica genérica.
        [$sx, $sy] = self::SMALL_PLAZA_BLOCK;
        $env[] = ['type' => 'way', 'id' => ++$eid, 'tags' => ['leisure' => 'park', 'name' => 'Plaza Libertad'], 'geometry' => $rect($sx * $pitch, $sy * $pitch, $sx * $pitch + self::BLOCK, $sy * $pitch + self::BLOCK)];

        foreach (self::LANDMARKS as [$x0, $y0, $x1, $y1, $tags]) {
            $env[] = ['type' => 'way', 'id' => ++$eid, 'tags' => $tags, 'geometry' => $rect($x0, $y0, $x1, $y1)];
        }

        // Semáforos en los cruces del bulevar (menos donde cruza la plaza) y paradas de colectivo.
        $node = function (float $x, float $y, array $tags) use ($pt, &$eid): array {
            [$lng, $lat] = $pt($x, $y);

            return ['type' => 'node', 'id' => ++$eid, 'lat' => $lat, 'lon' => $lng, 'tags' => $tags];
        };
        foreach ([1, 2, 3, 5, 6, 7] as $bx) {
            $env[] = $node($bx * $pitch - $half, $boulevardY, ['highway' => 'traffic_signals']);
        }
        $env[] = $node(60, $boulevardY - self::BOULEVARD_GAP / 2 - 6, ['highway' => 'bus_stop', 'name' => 'Parada 25 de Mayo y V1']);
        $env[] = $node(300, $boulevardY - self::BOULEVARD_GAP / 2 - 6, ['highway' => 'bus_stop', 'name' => 'Parada Plaza San Martín']);
        $env[] = $node(780, $boulevardY + self::BOULEVARD_GAP / 2 + 6, ['highway' => 'bus_stop', 'name' => 'Parada Casa de Gobierno']);
        $env[] = $node(-$half + 6, 300, ['highway' => 'bus_stop']);
        $env[] = $node(4 * $pitch - $half, 3 * $pitch - $half - 6, ['highway' => 'crossing', 'crossing' => 'zebra']);
        $env[] = $node(4 * $pitch - $half, 2 * $pitch - $half - 6, ['highway' => 'crossing', 'crossing' => 'zebra']);

        return ['buildings' => $buildings, 'roads' => $roads, 'environment' => $env];
    }
}
