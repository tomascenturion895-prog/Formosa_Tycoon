<?php

namespace App\Formosa;

use Illuminate\Support\Facades\Storage;

/** Guarda y lee el entorno de la ciudad 3D (GeoJSON: agua, plazas, emblemáticos, semáforos…) en el disco local. */
final class EnvironmentStore
{
    public static function put(array $featureCollection): void
    {
        Storage::disk('local')->put(self::path(), json_encode($featureCollection, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    }

    public static function empty(): array
    {
        return ['type' => 'FeatureCollection', 'features' => []];
    }

    public static function get(): array
    {
        $disk = Storage::disk('local');
        if (! $disk->exists(self::path())) {
            return self::empty();
        }
        $data = json_decode((string) $disk->get(self::path()), true);

        return is_array($data) && ($data['type'] ?? null) === 'FeatureCollection' && is_array($data['features'] ?? null) ? $data : self::empty();
    }

    public static function lastModified(): ?int
    {
        $disk = Storage::disk('local');

        return $disk->exists(self::path()) ? $disk->lastModified(self::path()) : null;
    }

    private static function path(): string
    {
        return (string) config('formosa.environment_file', 'formosa/entorno.geojson');
    }
}
