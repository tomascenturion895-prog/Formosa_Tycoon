<?php

namespace App\Economy;

/** Reglas puras del chat (sin base de datos): cómo se limpia un mensaje antes de guardarlo. */
final class ChatRules
{
    /**
     * Deja el texto en una sola línea, sin caracteres invisibles ni de control. Devuelve null si no es UTF-8 válido.
     *
     * Se quitan los caracteres de "formato" (ancho cero, y sobre todo los que invierten el sentido de lectura, con los
     * que alguien podría hacer pasar un texto por otro) y las marcas combinantes en cadena ("z̷̢a̶l̸g̵o̷"), que ensucian la pantalla.
     */
    public static function clean(string $raw): ?string
    {
        if (! mb_check_encoding($raw, 'UTF-8')) {
            return null;
        }
        $text = preg_replace('/\s+/u', ' ', $raw);
        $text = preg_replace('/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u', '', (string) $text);
        // Rellenos que se ven en blanco pero no son espacios ni de "formato" (hangul, braille vacío, relleno jemer).
        $text = preg_replace('/[\x{115F}\x{1160}\x{3164}\x{FFA0}\x{2800}\x{17B4}\x{17B5}]/u', '', (string) $text);
        $text = preg_replace('/(\p{M}{2})\p{M}+/u', '$1', (string) $text);
        if ($text === null) {
            return null;
        }

        // Tiene que quedar algo que se vea: una letra, un número, un signo o un símbolo (los emojis son símbolos).
        return preg_match('/[\p{L}\p{N}\p{P}\p{S}]/u', $text) === 1 ? trim($text) : '';
    }
}
