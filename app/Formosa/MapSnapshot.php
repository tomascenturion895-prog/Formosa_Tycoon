<?php

namespace App\Formosa;

use App\Economy\OwnersVersion;
use App\Models\Property;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Datos fijos del mapa (propiedades y calles) como ARCHIVOS ESTÁTICOS en `public/data`, con la versión en el nombre.
 *
 * Por qué: `php artisan serve` atiende un pedido a la vez. Si las propiedades (varios MB) salen de Laravel, cada primera carga de un
 * jugador ocupa al único hilo (arrancar el framework, leer la caché, comprimir) y las compras y pujas de los demás esperan. Un archivo
 * de `public/` lo entrega el propio servidor de PHP sin arrancar nada. Como el nombre cambia cuando cambian los datos (re-importación o
 * corrección de un moderador), el navegador puede guardarlo para siempre.
 *
 * Se generan la primera vez que se pide la dirección (o con `php artisan mapa:publicar`) y se borran las versiones viejas.
 */
final class MapSnapshot
{
    public static function enabled(): bool
    {
        return (bool) config('formosa.map.static');
    }

    /** Versión del catálogo: cambia con una re-importación o una corrección de moderador. Dos correcciones en el mismo segundo no repiten. */
    public static function propertiesEtag(): string
    {
        $stamp = DB::table('properties')->selectRaw('COUNT(*) AS n, MAX(updated_at) AS last')->first();

        return md5(($stamp->n ?? 0).'|'.($stamp->last ?? '').'|'.OwnersVersion::catalog());
    }

    /** GeoJSON de todas las propiedades, sin dueño (el dueño va en el estado de la partida, que cambia seguido). */
    public static function propertiesJson(): string
    {
        return json_encode(
            ['type' => 'FeatureCollection', 'features' => iterator_to_array(self::features(), false)],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
        );
    }

    /** Dirección pública del archivo de propiedades (lo genera si falta), o null si los estáticos están apagados o no se pudo escribir. */
    public static function propertiesUrl(): ?string
    {
        return self::enabled() ? self::publish('propiedades', self::propertiesEtag(), fn () => self::propertiesJson()) : null;
    }

    /** Ídem para las calles. La versión es la fecha del archivo importado. */
    public static function roadsUrl(): ?string
    {
        if (! self::enabled() || ($at = RoadsStore::lastModified()) === null) {
            return null;
        }

        return self::publish('calles', (string) $at, fn () => json_encode(RoadsStore::get(), JSON_UNESCAPED_SLASHES));
    }

    /** Genera lo que falte (para `php artisan mapa:publicar` y para dejarlo listo antes de la primera partida). @return array<string, string|null> */
    public static function publishAll(): array
    {
        return ['propiedades' => self::propertiesUrl(), 'calles' => self::roadsUrl()];
    }

    /** @param  callable(): string  $build */
    private static function publish(string $name, string $version, callable $build): ?string
    {
        $dir = public_path('data');
        $file = "{$name}-{$version}.json";
        $path = $dir.DIRECTORY_SEPARATOR.$file;
        try {
            if (! is_file($path)) {
                File::ensureDirectoryExists($dir);
                $tmp = $path.'.'.bin2hex(random_bytes(4)).'.tmp';
                File::put($tmp, $build());
                rename($tmp, $path); // atómico: nadie lee un archivo a medio escribir
                foreach (glob("{$dir}/{$name}-*.json") ?: [] as $old) {
                    if ($old !== $path) {
                        @unlink($old); // versiones anteriores
                    }
                }
            }
        } catch (\Throwable $e) {
            report($e); // disco lleno o sin permisos: se sigue con la API de siempre

            return null;
        }

        return "/data/{$file}";
    }

    /** @return \Generator<int, array<string, mixed>> */
    private static function features(): \Generator
    {
        foreach (Property::query()->select(['id', 'kind', 'name', 'street', 'area_m2', 'price', 'income_per_day', 'geometry'])->orderBy('id')->cursor() as $p) {
            yield [
                'type' => 'Feature',
                'id' => $p->id,
                'properties' => [
                    'id' => $p->id,
                    'kind' => $p->kind->value,
                    'name' => $p->name,
                    'street' => $p->street,
                    'area' => $p->area_m2,
                    'price' => $p->price,
                    'income' => $p->income_per_day,
                ],
                'geometry' => $p->geometry,
            ];
        }
    }
}
