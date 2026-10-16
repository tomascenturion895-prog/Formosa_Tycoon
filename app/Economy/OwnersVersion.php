<?php

namespace App\Economy;

use Illuminate\Support\Facades\Cache;

/**
 * "Versión" de quién es dueño de qué EN CADA PARTIDA. Cada vez que una propiedad cambia de dueño en una partida se sube el
 * número de ESA partida, y /api/partidas/{id}/propiedades/estado guarda su respuesta bajo esa versión: mientras nadie
 * compre nada, los mapas de la sala pidiendo el estado cuestan una sola consulta.
 *
 * Se sube DESPUÉS de confirmar la compra: un lector que arme la respuesta justo antes del commit la guarda bajo
 * la versión vieja, que el aumento deja de usar.
 */
final class OwnersVersion
{
    private const KEY = 'map.owners.version';
    private const CATALOG = 'map.catalog.version';

    private static function key(int $matchId): string
    {
        return self::KEY.'.'.$matchId;
    }

    public static function current(int $matchId): int
    {
        return self::read(self::key($matchId));
    }

    public static function bump(int $matchId): void
    {
        Cache::add(self::key($matchId), self::seed());
        Cache::increment(self::key($matchId));
    }

    /**
     * "Versión" de los datos fijos de las propiedades (rubro, nombre, precio): sube cuando un moderador corrige una.
     * Los mapas abiertos la comparan y, si se perdieron un aviso en vivo, vuelven a leer las propiedades.
     */
    public static function catalog(): int
    {
        return self::read(self::CATALOG);
    }

    public static function bumpCatalog(): int
    {
        Cache::add(self::CATALOG, self::seed());
        $n = (int) Cache::increment(self::CATALOG);
        // El estado de cada partida lleva el número del catálogo: su caché y su ETag dependen de él (ver MatchController::propertyState).

        return $n;
    }

    private static function read(string $key): int
    {
        $value = Cache::get($key);
        if ($value === null) {
            Cache::add($key, self::seed());
            $value = Cache::get($key);
        }

        return (int) $value;
    }

    /**
     * Punto de partida de cada contador: la hora en milisegundos, no cero. Si la caché se vacía (cache:clear, reinicio de
     * Redis), el contador arranca desde un número que nunca usó antes; con cero volvería a repetir los ETag de antes y
     * los navegadores que los guardaron seguirían mostrando datos viejos (un 304 "sin cambios" sobre un estado que sí cambió).
     */
    private static function seed(): int
    {
        return (int) (microtime(true) * 1000);
    }
}
