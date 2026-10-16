<?php

namespace App\Formosa;

/**
 * Geometría mínima sobre coordenadas [lng, lat]. Sin dependencias: se puede probar sin Laravel.
 * Para áreas usa una proyección plana local (equirectangular), de sobra precisa a escala de edificio.
 */
final class Geo
{
    private const EARTH_RADIUS_M = 6371008.8;

    /**
     * Superficie (m²) y centroide de un anillo de coordenadas [[lng, lat], ...].
     *
     * @param  list<array{0: float, 1: float}>  $ring
     * @return array{area: float, lng: float, lat: float}
     */
    public static function areaAndCentroid(array $ring): array
    {
        $ring = self::close($ring);
        $n = count($ring) - 1; // vértices distintos
        if ($n < 3) {
            return ['area' => 0.0, ...self::average($ring)];
        }

        [$lng0, $lat0] = $ring[0];
        $kx = cos(deg2rad($lat0)) * (M_PI / 180) * self::EARTH_RADIUS_M;
        $ky = (M_PI / 180) * self::EARTH_RADIUS_M;

        $a2 = 0.0; // doble del área con signo
        $cx = 0.0;
        $cy = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $x1 = ($ring[$i][0] - $lng0) * $kx;
            $y1 = ($ring[$i][1] - $lat0) * $ky;
            $x2 = ($ring[$i + 1][0] - $lng0) * $kx;
            $y2 = ($ring[$i + 1][1] - $lat0) * $ky;
            $cross = $x1 * $y2 - $x2 * $y1;
            $a2 += $cross;
            $cx += ($x1 + $x2) * $cross;
            $cy += ($y1 + $y2) * $cross;
        }

        if (abs($a2) < 1e-9) { // polígono degenerado (todos los puntos en línea)
            return ['area' => 0.0, ...self::average($ring)];
        }

        return [
            'area' => abs($a2) / 2,
            'lng' => $lng0 + ($cx / (3 * $a2)) / $kx,
            'lat' => $lat0 + ($cy / (3 * $a2)) / $ky,
        ];
    }

    /** ¿El punto cae dentro del anillo? (rayo horizontal, par-impar). */
    public static function pointInRing(float $lng, float $lat, array $ring): bool
    {
        $inside = false;
        $n = count($ring);
        for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
            [$xi, $yi] = $ring[$i];
            [$xj, $yj] = $ring[$j];
            if ((($yi > $lat) !== ($yj > $lat)) && ($lng < ($xj - $xi) * ($lat - $yi) / ($yj - $yi) + $xi)) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }

    /** Caja [oeste, sur, este, norte] de un anillo. */
    public static function bbox(array $ring): array
    {
        $lngs = array_column($ring, 0);
        $lats = array_column($ring, 1);

        return [min($lngs), min($lats), max($lngs), max($lats)];
    }

    /** Anillo cuadrado de `$sideM` metros de lado centrado en un punto, cerrado. */
    public static function squareAround(float $lng, float $lat, float $sideM): array
    {
        $half = $sideM / 2;
        $dLat = rad2deg($half / self::EARTH_RADIUS_M);
        $dLng = rad2deg($half / (self::EARTH_RADIUS_M * cos(deg2rad($lat))));

        return [
            [$lng - $dLng, $lat - $dLat],
            [$lng + $dLng, $lat - $dLat],
            [$lng + $dLng, $lat + $dLat],
            [$lng - $dLng, $lat + $dLat],
            [$lng - $dLng, $lat - $dLat],
        ];
    }

    /** Desplaza un punto `$dxM` metros al este y `$dyM` al norte. */
    public static function offset(float $lng, float $lat, float $dxM, float $dyM): array
    {
        return [
            $lng + rad2deg($dxM / (self::EARTH_RADIUS_M * cos(deg2rad($lat)))),
            $lat + rad2deg($dyM / self::EARTH_RADIUS_M),
        ];
    }

    /** Cierra el anillo si no lo está. */
    public static function close(array $ring): array
    {
        if ($ring !== [] && $ring[0] !== $ring[count($ring) - 1]) {
            $ring[] = $ring[0];
        }

        return $ring;
    }

    /** @return array{lng: float, lat: float} */
    private static function average(array $ring): array
    {
        $n = max(1, count($ring));

        return ['lng' => array_sum(array_column($ring, 0)) / $n, 'lat' => array_sum(array_column($ring, 1)) / $n];
    }
}
