<?php

namespace Tests\Unit;

use App\Economy\ChatRules;
use PHPUnit\Framework\TestCase;

class ChatRulesTest extends TestCase
{
    public function test_junta_espacios_y_saltos_de_linea_en_una_sola_linea(): void
    {
        $this->assertSame('hola que tal', ChatRules::clean("  hola \n\n que\t tal  "));
    }

    public function test_conserva_acentos_enie_y_emojis(): void
    {
        $this->assertSame('¡Qué lindo día en Formosa, ñandú! 🌞', ChatRules::clean('¡Qué lindo día en Formosa, ñandú! 🌞'));
    }

    public function test_quita_caracteres_invisibles_y_de_inversion_de_lectura(): void
    {
        $this->assertSame('hola', ChatRules::clean("ho\u{200B}la"));            // ancho cero
        $this->assertSame('abc', ChatRules::clean("a\u{202E}b\u{202C}c"));       // RLO / PDF: dan vuelta el texto que sigue
        $this->assertSame('ab', ChatRules::clean("a\u{0007}b"));                 // control
    }

    public function test_corta_las_cadenas_de_marcas_combinantes(): void
    {
        $zalgo = 'e'.str_repeat("\u{0301}", 40);

        $this->assertSame('e'."\u{0301}\u{0301}", ChatRules::clean($zalgo));
    }

    public function test_texto_que_no_es_utf8_se_rechaza(): void
    {
        $this->assertNull(ChatRules::clean("hola \xC3\x28"));
    }

    public function test_solo_invisibles_queda_vacio(): void
    {
        $this->assertSame('', ChatRules::clean("\u{200B} \u{200E}\n"));
    }

    public function test_no_toca_etiquetas_html_porque_el_cliente_muestra_texto_plano(): void
    {
        $this->assertSame('<b>x</b> & "y"', ChatRules::clean('<b>x</b> & "y"'));
    }

    public function test_los_rellenos_en_blanco_no_cuentan_como_contenido(): void
    {
        $this->assertSame('', ChatRules::clean("\u{3164}\u{115F}\u{1160}\u{FFA0}\u{2800}"));
        $this->assertSame('', ChatRules::clean(" \u{2800} \u{17B4} "));
        $this->assertSame('hola', ChatRules::clean("ho\u{3164}la"));
    }

    public function test_un_emoji_solo_es_contenido_valido(): void
    {
        $this->assertSame('👍', ChatRules::clean('👍'));
        $this->assertSame('?', ChatRules::clean(' ? '));
    }
}
