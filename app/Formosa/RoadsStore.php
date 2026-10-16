<?php

namespace App\Formosa;

use Illuminate\Support\Facades\Storage;

/** Guarda y lee las calles (GeoJSON) en el disco local de la app. */
final class RoadsStore
{
    public static function put(array $featureCollection): void
    {
        Storage::disk('local')->put(config('formosa.roads_file'), json_encode($featureCollection, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }

    public static function empty(): array
    {
        return ['type' => 'FeatureCollection', 'features' => []];
    }

    public static function get(): array
    {
        $disk = Storage::disk('local');
        $path = config('formosa.roads_file');
        if (! $disk->exists($path)) {
            return self::empty();
        }
        $data = json_decode($disk->get($path), true);

        return is_array($data) && ($data['type'] ?? null) === 'FeatureCollection' ? $data : self::empty();
    }

    public static function lastModified(): ?int
    {
        $disk = Storage::disk('local');
        $path = config('formosa.roads_file');

        return $disk->exists($path) ? $disk->lastModified($path) : null;
    }
}
