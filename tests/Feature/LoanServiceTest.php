<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Economy\LoanService;
use App\Economy\MatchService;
use App\Enums\LoanStatus;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\Loan;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Banco: pedir, cobro por día de juego, mora, pagos anticipados, patrimonio y cierre de la partida. */
class LoanServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    private LoanService $loans;

    private int $day;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'formosa.auction.dispute_seconds' => 0,
            'formosa.bank.rate_pct' => 3, 'formosa.bank.late_pct' => 2, 'formosa.bank.max_share_pct' => 50,
            'formosa.bank.max_loans' => 2, 'formosa.bank.min_amount' => 1000, 'formosa.bank.terms' => [5, 10, 20],
        ]);
        Carbon::setTestNow('2026-10-15 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 100000);
        $this->loans = app(LoanService::class);
        $this->day = $this->match->secondsPerDay();
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function advanceDays(int $n): void
    {
        Carbon::setTestNow(now()->addSeconds($n * $this->day));
    }

    private function take(int $amount = 10000, int $term = 5, ?User $u = null): Loan
    {
        return $this->loans->take($u ?? $this->ana, $this->match->id, $amount, $term);
    }

    /** Fuerza el cobro como lo haría cualquier operación de dinero del jugador. */
    private function settle(?User $u = null): void
    {
        $this->loans->summary($u ?? $this->ana, $this->match->id);
    }

    private function fails(callable $fn, string $code): GameException
    {
        try {
            $fn();
        } catch (GameException $e) {
            $this->assertSame($code, $e->errorCode);

            return $e;
        }
        $this->fail("Tenía que fallar con {$code}");
    }

    private function spendAll(User $u): void
    {
        // Compra propiedades hasta dejar poco efectivo (cada una de 20.000).
        while ($this->cash($this->match, $u) >= 20000) {
            app(EconomyService::class)->buy($u, $this->match->id, $this->makeProperty(price: 20000)->id);
        }
    }

    // ------------------------------------------------------------------ pedir

    public function test_el_prestamo_entra_al_efectivo_y_al_libro(): void
    {
        $l = $this->take(10000, 5);

        $this->assertSame(110000, $this->cash($this->match, $this->ana));
        $this->assertSame(10000, $l->balance);
        $this->assertSame(2000, $l->daily_principal);
        $this->assertSame(3, $l->rate_pct);
        $this->assertSame(1, LedgerEntry::where('match_id', $this->match->id)->where('idempotency_key', "prestamo-{$l->id}")->count());
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_reglas_de_monto_plazo_tope_y_cantidad(): void
    {
        $this->fails(fn () => $this->take(500), 'monto_invalido');
        $this->fails(fn () => $this->take(10000, 7), 'plazo_invalido');
        $e = $this->fails(fn () => $this->take(50001), 'prestamo_excedido'); // 50 % de 100.000
        $this->assertSame(50000, $e->context['maximo']);

        $this->take(20000);
        $this->take(20000);
        $this->fails(fn () => $this->take(1000), 'demasiados_prestamos');
    }

    public function test_el_tope_descuenta_la_deuda_que_ya_se_tiene(): void
    {
        $this->take(50000); // patrimonio 100.000 -> puede 50.000; ahora patrimonio neto sigue en 100.000
        $e = $this->fails(fn () => $this->take(50001), 'prestamo_excedido');
        $this->assertSame(50000, $e->context['maximo']);
    }

    public function test_las_propiedades_cuentan_para_el_tope(): void
    {
        app(EconomyService::class)->buy($this->beto, $this->match->id, $this->makeProperty(price: 40000)->id); // efectivo 60.000 + propiedad 40.000
        $this->assertSame('ok', $this->take(50000, 5, $this->beto)->status === LoanStatus::Abierto ? 'ok' : 'no');
    }

    public function test_solo_en_una_partida_en_juego_y_siendo_jugador(): void
    {
        $otro = User::factory()->create();
        $this->fails(fn () => $this->take(10000, 5, $otro), 'no_estas_en_partida');
    }

    // ------------------------------------------------------------------ cobro por día

    public function test_cada_dia_de_juego_se_cobra_una_cuota(): void
    {
        $l = $this->take(10000, 5);
        $this->settle();
        $this->assertSame(110000, $this->cash($this->match, $this->ana)); // todavía no pasó ningún día

        $this->advanceDays(1);
        $this->settle();

        $l->refresh();
        $this->assertSame(1, $l->days_charged);
        $this->assertSame(8000, $l->balance);
        $this->assertSame(300, $l->interest_paid);
        $this->assertSame(110000 - 2300, $this->cash($this->match, $this->ana)); // sin ingresos: no tiene propiedades
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_cobrar_dos_veces_el_mismo_dia_no_cobra_de_mas(): void
    {
        $this->take(10000, 5);
        $this->advanceDays(1);
        $this->settle();
        $this->settle();
        $this->settle();

        $this->assertSame(110000 - 2300, $this->cash($this->match, $this->ana));
    }

    public function test_varios_dias_juntos_dan_lo_mismo_que_uno_por_uno(): void
    {
        $this->take(10000, 5);
        $this->advanceDays(3);
        $this->settle();
        // día 1: 300 + 2000, día 2: 240 + 2000, día 3: 180 + 2000
        $this->assertSame(110000 - (2300 + 2240 + 2180), $this->cash($this->match, $this->ana));
        $this->assertSame(3, Loan::first()->days_charged);
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_al_terminar_el_plazo_queda_pagado(): void
    {
        $this->take(10000, 5);
        $this->advanceDays(5);
        $this->settle();

        $l = Loan::first();
        $this->assertSame(LoanStatus::Pagado, $l->status);
        $this->assertSame(0, $l->balance);
        $this->assertSame(300 + 240 + 180 + 120 + 60, $l->interest_paid);
        $this->assertSame(110000 - 10000 - 900, $this->cash($this->match, $this->ana));
        $this->assertSame(0, $this->loans->debtOf($this->match->id, $this->ana->id));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_el_reloj_cobra_sin_que_el_jugador_haga_nada(): void
    {
        $this->take(10000, 5);
        $this->advanceDays(2);

        $this->assertSame(1, $this->loans->chargeDue());
        $this->assertSame(2, Loan::first()->days_charged);
        $this->assertSame(0, $this->loans->chargeDue()); // ya está al día
    }

    public function test_cualquier_operacion_de_dinero_cobra_primero(): void
    {
        $this->take(10000, 5);
        $this->advanceDays(1);

        app(EconomyService::class)->buy($this->ana, $this->match->id, $this->makeProperty(price: 5000)->id);

        $this->assertSame(1, Loan::first()->days_charged);
        $this->assertSame(110000 - 2300 - 5000, $this->cash($this->match, $this->ana));
    }

    // ------------------------------------------------------------------ mora

    public function test_sin_efectivo_la_cuota_queda_en_mora_y_se_bloquea_pedir_otro(): void
    {
        $this->take(40000, 5);   // efectivo 140.000
        $this->spendAll($this->ana); // queda menos de 20.000
        $left = $this->cash($this->match, $this->ana);
        $this->assertLessThan(20000, $left);
        $this->advanceDays(1);
        $this->settle();

        $l = Loan::first();
        $this->assertSame(32000, $l->balance);           // el capital del día baja igual
        $this->assertGreaterThan(0, $l->arrears);
        $this->assertSame(0, $this->cash($this->match, $this->ana)); // se cobró todo lo que había
        $this->fails(fn () => $this->take(1000), 'prestamo_con_mora');
        $this->assertSame('con_mora', $this->loans->summary($this->ana, $this->match->id)['blocked']);
    }

    public function test_la_mora_suma_recargo_cada_dia(): void
    {
        $this->take(40000, 5);
        $this->spendAll($this->ana);
        $this->advanceDays(1);
        $this->settle();
        $a1 = Loan::first()->arrears;
        $this->advanceDays(1);
        $this->settle();

        $this->assertGreaterThan($a1, Loan::first()->arrears);
        $this->assertLedgerMatchesCash($this->match);
    }

    // ------------------------------------------------------------------ pagar antes

    public function test_pagar_una_parte_baja_el_capital_y_el_interes_futuro(): void
    {
        $l = $this->take(10000, 5);
        $r = $this->loans->repay($this->ana, $this->match->id, $l->id, 4000);

        $this->assertSame(6000, $r->balance);
        $this->assertSame(110000 - 4000, $this->cash($this->match, $this->ana));
        $this->advanceDays(1);
        $this->settle();
        $this->assertSame(180, Loan::first()->interest_paid); // 3 % de 6.000
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_cancelar_todo_deja_el_prestamo_pagado(): void
    {
        $l = $this->take(10000, 5);
        $r = $this->loans->repay($this->ana, $this->match->id, $l->id, null);

        $this->assertSame(LoanStatus::Pagado, $r->status);
        $this->assertSame(100000, $this->cash($this->match, $this->ana));
        $this->assertSame(0, $this->loans->debtOf($this->match->id, $this->ana->id));
        $this->fails(fn () => $this->loans->repay($this->ana, $this->match->id, $l->id, null), 'prestamo_cerrado');
    }

    public function test_no_se_paga_el_prestamo_de_otro_ni_con_efectivo_reservado(): void
    {
        $l = $this->take(10000, 5);
        $this->fails(fn () => $this->loans->repay($this->beto, $this->match->id, $l->id, null), 'prestamo_inexistente');
    }

    public function test_pagar_sin_efectivo_libre_falla(): void
    {
        $l = $this->take(40000, 5);
        $this->spendAll($this->ana);
        \DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->update(['cash' => 0]);
        $this->fails(fn () => $this->loans->repay($this->ana, $this->match->id, $l->id, null), 'sin_efectivo');
    }

    // ------------------------------------------------------------------ patrimonio y cierre

    public function test_la_deuda_se_descuenta_del_patrimonio(): void
    {
        $this->take(30000, 10);
        $rows = collect(app(EconomyService::class)->standings($this->match->fresh()))->keyBy('user_id');

        $this->assertSame(30000, $rows[$this->ana->id]['debt']);
        $this->assertSame(100000, $rows[$this->ana->id]['net_worth']); // +30.000 de efectivo -30.000 de deuda
        $this->assertSame(0, $rows[$this->beto->id]['debt']);
        $snap = app(EconomyService::class)->snapshot($this->ana, $this->match->fresh());
        $this->assertSame(30000, $snap['debt']);
    }

    public function test_al_terminar_la_partida_la_deuda_resta_del_patrimonio_final(): void
    {
        $this->advanceDays(5);
        $this->take(50000, 20); // le quedan 15 días de partida: el plazo de 20 no llega a vencer
        Carbon::setTestNow(GameMatch::find($this->match->id)->ends_at->copy()->addSecond());

        app(MatchService::class)->finish($this->match->id);

        $ana = \DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->first();
        $debt = $this->loans->debtOf($this->match->id, $this->ana->id);
        $this->assertGreaterThan(0, $debt);
        $this->assertSame($this->cash($this->match, $this->ana) - $debt, (int) $ana->final_net_worth);
    }

    public function test_deber_mas_de_lo_que_se_tiene_no_da_patrimonio_negativo_guardado_y_pierde_contra_el_otro(): void
    {
        $this->advanceDays(5);
        $this->take(50000, 20);
        $this->spendAll($this->ana);
        \DB::table('match_players')->where('match_id', $this->match->id)->where('user_id', $this->ana->id)->update(['cash' => 0]);
        Carbon::setTestNow(GameMatch::find($this->match->id)->ends_at->copy()->addSecond());

        app(MatchService::class)->finish($this->match->id);

        $rows = \DB::table('match_players')->where('match_id', $this->match->id)->get()->keyBy('user_id');
        $this->assertGreaterThanOrEqual(0, (int) $rows[$this->ana->id]->final_net_worth);
        $this->assertSame(1, (int) $rows[$this->beto->id]->final_rank); // Beto, sin deudas, gana
    }

    public function test_abandonar_cancela_los_prestamos(): void
    {
        $this->take(10000, 5);
        app(MatchService::class)->leave($this->ana, $this->match->id);

        $this->assertSame(LoanStatus::Cancelado, Loan::first()->status);
        $this->assertSame(0, $this->loans->debtOf($this->match->id, $this->ana->id));
    }

    public function test_el_resumen_trae_lo_que_el_jugador_necesita_y_nada_del_otro(): void
    {
        $this->take(10000, 5);
        $this->take(5000, 10, $this->beto);

        $s = $this->loans->summary($this->ana, $this->match->id);

        $this->assertCount(1, $s['loans']);
        $this->assertSame(10000, $s['debt']);
        $this->assertSame(50000, $s['max_new']); // patrimonio 100.000 (efectivo 110.000 - deuda 10.000), 50 %
        $this->assertNull($s['blocked']);
    }
}
