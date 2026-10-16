<?php

namespace Tests\Unit;

use App\Economy\Accrual;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

class AccrualTest extends TestCase
{
    private function t(string $s): CarbonImmutable
    {
        return CarbonImmutable::parse($s, 'UTC');
    }

    public function test_paga_proporcional_a_los_dias_de_juego(): void
    {
        // 1200 por día de juego, día de 120 s: medio día (60 s) = 600
        $this->assertSame(['amount' => 600, 'carry' => 0], Accrual::settle(1200, 0, 60, 120));
        // un día y cuarto
        $this->assertSame(['amount' => 1500, 'carry' => 0], Accrual::settle(1200, 0, 150, 120));
    }

    public function test_lo_que_no_completa_un_peso_queda_de_resto_y_no_se_pierde(): void
    {
        // 50 por día, día de 120 s, 100 s = 41,67 pesos -> paga 41, resto 4000 - 41*120 = 80
        $a = Accrual::settle(50, 0, 100, 120);
        $this->assertSame(['amount' => 41, 'carry' => 80], $a);
        // los 20 s siguientes suman 1000 pesos-segundo: 80 + 1000 = 1080 = 9 pesos justos
        $b = Accrual::settle(50, $a['carry'], 20, 120);
        $this->assertSame(['amount' => 9, 'carry' => 0], $b);
        // en total, 120 s * 50 / 120 = 50 pesos exactos
        $this->assertSame(50, $a['amount'] + $b['amount']);
    }

    public function test_liquidar_en_pedacitos_da_lo_mismo_que_de_una_vez(): void
    {
        $once = Accrual::settle(777, 0, 3600, 120)['amount'];
        $total = 0;
        $carry = 0;
        for ($i = 0; $i < 3600; $i += 7) { // pasos de 7 s (el último más corto)
            $step = min(7, 3600 - $i);
            ['amount' => $a, 'carry' => $carry] = Accrual::settle(777, $carry, $step, 120);
            $total += $a;
        }
        $this->assertSame($once, $total);
    }

    public function test_el_resto_siempre_es_menor_que_un_dia_en_segundos(): void
    {
        foreach ([1, 13, 999, 123456] as $income) {
            foreach ([1, 59, 61, 1000] as $secs) {
                $this->assertLessThan(120, Accrual::settle($income, 119, $secs, 120)['carry']);
            }
        }
    }

    public function test_segundos_nunca_es_negativo_ni_sin_fecha(): void
    {
        $now = $this->t('2026-10-14 10:00:00');
        $this->assertSame(0, Accrual::seconds(null, $now));
        $this->assertSame(0, Accrual::seconds($this->t('2026-10-14 11:00:00'), $now)); // reloj en el futuro
        $this->assertSame(90, Accrual::seconds($this->t('2026-10-14 09:58:30'), $now));
        $this->assertSame(0, Accrual::settle(100, 0, -50, 120)['amount']);
    }

    public function test_numeros_grandes_no_pierden_precision(): void
    {
        $this->assertSame(40_000_000 * 20, Accrual::settle(40_000_000, 0, 2400, 120)['amount']); // 20 días de juego
    }
}
