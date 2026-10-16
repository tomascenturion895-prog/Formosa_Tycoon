<?php

namespace App\Formosa;

/** Limpieza de textos que no son de confianza (OpenStreetMap, formularios): una línea, sin caracteres de control, recortada. */
final class TextClean
{
    public static function line(mixed $value, int $max = 120): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $value = trim((string) preg_replace('/[\x00-\x1F\x7F\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}]+/u', ' ', $value));
        $value = trim((string) preg_replace('/\s{2,}/u', ' ', $value));

        return $value === '' ? null : mb_substr($value, 0, $max);
    }
}
