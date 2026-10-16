<?php

namespace App\Formosa;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/** Descarga datos de OpenStreetMap con la API Overpass. Respetá su política de uso: pocas consultas, con User-Agent propio. */
class OverpassClient
{
    private const COMMERCE_AMENITY = 'restaurant|cafe|bar|pub|fast_food|ice_cream|pharmacy|bank|marketplace';

    private const HOTEL_TOURISM = 'hotel|hostel|guest_house|motel|apartment';

    /** Nombres de edificios que se dibujan como emblemáticos en 3D (sin distinguir mayúsculas). */
    private const LANDMARK_NAMES = 'catedral|casa de gobierno|estaci[oó]n|museo|iglesia|parroquia|puerto|terminal';

    private const ROADS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

    /** @param  array{south: float, west: float, north: float, east: float}  $bbox */
    public function buildingsAndPlaces(array $bbox): array
    {
        $b = $this->bbox($bbox);
        $t = (int) config('formosa.overpass_timeout');
        $amenity = self::COMMERCE_AMENITY;
        $tourism = self::HOTEL_TOURISM;

        return $this->run(<<<QL
[out:json][timeout:{$t}];
(
  way["building"]({$b});
  way["shop"]({$b});
  way["tourism"~"^({$tourism})\$"]({$b});
  way["amenity"~"^({$amenity})\$"]({$b});
  node["shop"]({$b});
  node["tourism"~"^({$tourism})\$"]({$b});
  node["amenity"~"^({$amenity})\$"]({$b});
);
out tags geom;
QL);
    }

    /**
     * Calles de la zona AMPLIADA (ver `expand`): así las calles siguen más allá del borde de lo importado.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bbox
     */
    public function roads(array $bbox): array
    {
        $b = $this->bbox(self::expand($bbox, (float) config('formosa.environment.margin_m', 500)));
        $t = (int) config('formosa.overpass_timeout');
        $roads = self::ROADS;

        return $this->run(<<<QL
[out:json][timeout:{$t}];
way["highway"~"^({$roads})\$"]({$b});
out tags geom;
QL);
    }

    /**
     * Entorno para la ciudad 3D en la zona ampliada: agua y ríos, plazas y parques, canchas, usos del suelo,
     * edificios emblemáticos y mobiliario de calle (semáforos, paradas, cruces). Las relaciones (multipolígonos)
     * vienen con la geometría de sus miembros.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bbox
     */
    public function environment(array $bbox): array
    {
        $b = $this->bbox(self::expand($bbox, (float) config('formosa.environment.margin_m', 500)));
        $t = (int) config('formosa.overpass_timeout');
        $names = self::LANDMARK_NAMES;

        return $this->run(<<<QL
[out:json][timeout:{$t}];
(
  nwr["natural"="water"]({$b});
  nwr["waterway"="riverbank"]({$b});
  nwr["water"]({$b});
  way["waterway"~"^(river|stream|canal)\$"]({$b});
  nwr["leisure"~"^(park|garden|pitch|playground)\$"]({$b});
  nwr["place"="square"]({$b});
  nwr["landuse"]({$b});
  nwr["amenity"="place_of_worship"]["name"]({$b});
  nwr["building"]["name"~"{$names}",i]({$b});
  nwr["historic"~"^(monument|memorial)\$"]({$b});
  nwr["tourism"="museum"]({$b});
  node["highway"~"^(traffic_signals|bus_stop|crossing)\$"]({$b});
  nwr["public_transport"="platform"]({$b});
);
out tags geom;
QL);
    }

    /**
     * Agranda una caja `$meters` metros hacia cada lado.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bbox
     * @return array{south: float, west: float, north: float, east: float}
     */
    public static function expand(array $bbox, float $meters): array
    {
        if ($meters <= 0) {
            return $bbox;
        }
        $midLat = ((float) $bbox['south'] + (float) $bbox['north']) / 2;
        $dLat = rad2deg($meters / 6371008.8);
        $dLng = rad2deg($meters / (6371008.8 * cos(deg2rad($midLat))));

        return [
            'south' => round((float) $bbox['south'] - $dLat, 6),
            'west' => round((float) $bbox['west'] - $dLng, 6),
            'north' => round((float) $bbox['north'] + $dLat, 6),
            'east' => round((float) $bbox['east'] + $dLng, 6),
        ];
    }

    private function bbox(array $bbox): string
    {
        return implode(',', [$bbox['south'], $bbox['west'], $bbox['north'], $bbox['east']]);
    }

    /** @return list<array<string, mixed>> */
    private function run(string $query): array
    {
        $agent = config('formosa.user_agent').' ('.config('formosa.overpass_contact').')';

        $response = Http::withHeaders(['User-Agent' => $agent])
            ->timeout((int) config('formosa.overpass_timeout') + 30)
            // Overpass responde 429/504 cuando está ocupado: se reintenta con pausa. Un 400 (consulta mala) no se reintenta.
            ->retry(3, 8000, fn ($e) => $e instanceof ConnectionException || in_array($e->response?->status(), [429, 502, 503, 504], true), throw: false)
            ->asForm()
            ->post(config('formosa.overpass_url'), ['data' => $query]);

        if ($response->failed()) {
            throw new RuntimeException("Overpass respondió HTTP {$response->status()}: ".mb_substr($response->body(), 0, 300));
        }

        $json = $response->json();
        if (! is_array($json) || ! isset($json['elements'])) {
            throw new RuntimeException('Overpass devolvió una respuesta sin "elements".');
        }
        // Overpass a veces responde 200 con un aviso de que la consulta se cortó: los datos serían incompletos.
        if (isset($json['remark']) && str_contains((string) $json['remark'], 'runtime error')) {
            throw new RuntimeException('Overpass cortó la consulta: '.$json['remark']);
        }

        return $json['elements'];
    }
}
