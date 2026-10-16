<?php

namespace Tests\Unit;

use App\Economy\AuctionRules;
use Carbon\Carbon;
use PHPUnit\Framework\TestCase;

class AuctionRulesTest extends TestCase
{
    public function test_el_minimo_es_el_piso_cuando_el_porcentaje_da_menos(): void
    {
        $this->assertSame(100, AuctionRules::minIncrement(1000, 5, 100)); // 5% = 50, gana el piso
    }

    public function test_el_minimo_es_el_porcentaje_cuando_supera_al_piso(): void
    {
        $this->assertSame(500, AuctionRules::minIncrement(10000, 5, 100));
        $this->assertSame(10500, AuctionRules::minNextBid(10000, 5, 100));
    }

    public function test_el_porcentaje_se_redondea_hacia_arriba_y_sin_decimales(): void
    {
        $this->assertSame(551, AuctionRules::minIncrement(11001, 5, 100)); // 550,05 -> 551
    }

    public function test_una_puja_en_la_ventana_final_extiende_el_cierre(): void
    {
        $now = Carbon::parse('2026-10-15 10:00:20');
        $end = Carbon::parse('2026-10-15 10:00:25'); // quedan 5 s, ventana de 10

        $new = AuctionRules::extendedEnd($end, $now, 0, window: 10, extend: 10, maxExtensions: 6);

        $this->assertSame('2026-10-15 10:00:30', $new?->toDateTimeString());
    }

    public function test_una_puja_antes_de_la_ventana_no_extiende(): void
    {
        $now = Carbon::parse('2026-10-15 10:00:00');
        $end = Carbon::parse('2026-10-15 10:00:30'); // quedan 30 s

        $this->assertNull(AuctionRules::extendedEnd($end, $now, 0, 10, 10, 6));
    }

    public function test_no_extiende_si_el_nuevo_plazo_no_es_posterior(): void
    {
        $now = Carbon::parse('2026-10-15 10:00:20');
        $end = Carbon::parse('2026-10-15 10:00:30'); // quedan 10 s: now + 10 = mismo cierre

        $this->assertNull(AuctionRules::extendedEnd($end, $now, 0, 10, 10, 6));
    }

    public function test_el_tope_de_extensiones_evita_subastas_eternas(): void
    {
        $now = Carbon::parse('2026-10-15 10:00:20');
        $end = Carbon::parse('2026-10-15 10:00:25');

        $this->assertNull(AuctionRules::extendedEnd($end, $now, 6, 10, 10, 6));
        $this->assertNotNull(AuctionRules::extendedEnd($end, $now, 5, 10, 10, 6));
    }

    public function test_no_extiende_una_subasta_que_ya_venció(): void
    {
        $now = Carbon::parse('2026-10-15 10:00:31');
        $end = Carbon::parse('2026-10-15 10:00:30');

        $this->assertNull(AuctionRules::extendedEnd($end, $now, 0, 10, 10, 6));
    }
}
