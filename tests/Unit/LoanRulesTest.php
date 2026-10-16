<?php

namespace Tests\Unit;

use App\Economy\LoanRules;
use PHPUnit\Framework\TestCase;

/** Reglas puras de los préstamos: cuotas, interés, mora y pagos anticipados. */
class LoanRulesTest extends TestCase
{
    public function test_capital_diario_redondeado_hacia_arriba(): void
    {
        $this->assertSame(2000, LoanRules::dailyPrincipal(10000, 5));
        $this->assertSame(334, LoanRules::dailyPrincipal(1000, 3));
        $this->assertSame(1, LoanRules::dailyPrincipal(1, 20));
    }

    public function test_interes_sobre_el_capital_pendiente(): void
    {
        $this->assertSame(300, LoanRules::interest(10000, 3));
        $this->assertSame(31, LoanRules::interest(1001, 3)); // hacia arriba
        $this->assertSame(1, LoanRules::interest(1, 3));
        $this->assertSame(0, LoanRules::interest(0, 3));
    }

    public function test_tope_segun_patrimonio(): void
    {
        $this->assertSame(50000, LoanRules::maxNew(100000, 50));
        $this->assertSame(0, LoanRules::maxNew(-500, 50));
        $this->assertSame(0, LoanRules::maxNew(0, 50));
    }

    public function test_un_dia_normal_cobra_interes_y_capital(): void
    {
        $r = LoanRules::day(10000, 0, 2000, 5, 1, 3, 2, 99999);

        $this->assertSame(['interest' => 300, 'principal' => 2000, 'surcharge' => 0, 'due' => 2300, 'paid' => 2300, 'paid_interest' => 300, 'balance' => 8000, 'arrears' => 0], $r);
    }

    public function test_el_ultimo_dia_del_plazo_devuelve_todo_el_capital(): void
    {
        $r = LoanRules::day(2000, 0, 2000, 5, 5, 3, 2, 99999);
        $this->assertSame(0, $r['balance']);

        // Con mora, pasado el plazo, se devuelve todo lo que quede.
        $r = LoanRules::day(2500, 0, 2000, 5, 6, 3, 2, 99999);
        $this->assertSame(0, $r['balance']);
        $this->assertSame(2500, $r['principal']);
    }

    public function test_lo_que_no_alcanza_queda_como_mora_y_el_capital_igual_baja(): void
    {
        $r = LoanRules::day(10000, 0, 2000, 5, 1, 3, 2, 1000); // debe 2.300, tiene 1.000

        $this->assertSame(1000, $r['paid']);
        $this->assertSame(300, $r['paid_interest']);  // primero lo atrasado (nada), después el interés (300); el resto, al capital
        $this->assertSame(8000, $r['balance']);
        $this->assertSame(1300, $r['arrears']);
    }

    public function test_la_mora_suma_recargo_y_se_cobra_primero(): void
    {
        $r = LoanRules::day(8000, 1300, 2000, 5, 2, 3, 2, 99999);

        $this->assertSame(26, $r['surcharge']);      // 2 % de 1.300
        $this->assertSame(1326 + 240 + 2000, $r['due']);
        $this->assertSame(0, $r['arrears']);
        $this->assertSame(6000, $r['balance']);
    }

    public function test_sin_plata_la_mora_crece(): void
    {
        $r = LoanRules::day(8000, 1300, 2000, 5, 2, 3, 2, 0);

        $this->assertSame(0, $r['paid']);
        $this->assertSame(1326 + 240 + 2000, $r['arrears']);
    }

    public function test_un_pago_anticipado_va_primero_a_lo_atrasado(): void
    {
        $this->assertSame(['paid' => 1500, 'balance' => 8000, 'arrears' => 0], LoanRules::prepay(8000, 1500, 1500, 99999));
        $this->assertSame(['paid' => 3000, 'balance' => 6500, 'arrears' => 0], LoanRules::prepay(8000, 1500, 3000, 99999));
        $this->assertSame(['paid' => 9500, 'balance' => 0, 'arrears' => 0], LoanRules::prepay(8000, 1500, null, 99999));
        $this->assertSame(['paid' => 400, 'balance' => 8000, 'arrears' => 1100], LoanRules::prepay(8000, 1500, null, 400)); // solo lo que hay
        $this->assertSame(['paid' => 0, 'balance' => 8000, 'arrears' => 1500], LoanRules::prepay(8000, 1500, null, 0));
    }

    public function test_dias_completos_transcurridos(): void
    {
        $this->assertSame(0, LoanRules::daysElapsed(119, 120));
        $this->assertSame(1, LoanRules::daysElapsed(120, 120));
        $this->assertSame(2, LoanRules::daysElapsed(359, 120));
        $this->assertSame(0, LoanRules::daysElapsed(-5, 120));
    }
}
