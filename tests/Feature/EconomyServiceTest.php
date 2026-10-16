<?php

namespace Tests\Feature;

use App\Economy\EconomyService;
use App\Economy\GameException;
use App\Enums\LedgerType;
use App\Events\PropertyOwnerChanged;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\MatchPlayer;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use LogicException;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Economía DENTRO de una partida: compra, venta, ingreso automático por días de juego y libro. */
class EconomyServiceTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private EconomyService $economy;

    private GameMatch $match;

    private User $ana;

    private User $beto;

    protected function setUp(): void
    {
        parent::setUp();
        $this->economy = app(EconomyService::class);
        config(['formosa.match.minutes_per_day' => 2]); // 1 día de juego = 120 s reales
        Carbon::setTestNow('2026-10-14 10:00:00');
        $this->ana = User::factory()->create(['name' => 'Ana']);
        $this->beto = User::factory()->create(['name' => 'Beto']);
        $this->match = $this->startedMatch([$this->ana, $this->beto], 5000);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_al_iniciar_cada_jugador_recibe_el_mismo_dinero_una_sola_vez(): void
    {
        $this->assertSame(5000, $this->cash($this->match, $this->ana));
        $this->assertSame(5000, $this->cash($this->match, $this->beto));
        $this->assertSame(1, LedgerEntry::where('match_id', $this->match->id)->where('user_id', $this->ana->id)->where('type', LedgerType::Alta)->count());
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_comprar_descuenta_asigna_dueno_y_deja_movimiento(): void
    {
        Event::fake([PropertyOwnerChanged::class]);
        $p = $this->makeProperty(price: 1200);

        $r = $this->economy->buy($this->ana, $this->match->id, $p->id, 'k1');

        $this->assertSame([1200, 3800, false], [$r->price, $r->balance, $r->replayed]);
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $p));
        $this->assertDatabaseHas('match_properties', ['match_id' => $this->match->id, 'property_id' => $p->id, 'owner_id' => $this->ana->id, 'price_paid' => 1200]);
        $this->assertDatabaseHas('ledger_entries', ['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'compra', 'amount' => -1200, 'balance_after' => 3800, 'property_id' => $p->id]);
        Event::assertDispatched(PropertyOwnerChanged::class, fn ($e) => $e->matchId === $this->match->id && $e->propertyId === $p->id && $e->ownerId === $this->ana->id && $e->ownerName === 'Ana');
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_no_se_puede_comprar_una_propiedad_ocupada(): void
    {
        $p = $this->makeProperty(price: 1000);
        $this->economy->buy($this->ana, $this->match->id, $p->id);

        try {
            $this->economy->buy($this->beto, $this->match->id, $p->id);
            $this->fail('debía fallar');
        } catch (GameException $e) {
            $this->assertSame('ocupada', $e->errorCode);
            $this->assertSame(409, $e->status);
        }
        $this->assertSame(5000, $this->cash($this->match, $this->beto), 'el perdedor no paga');
        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $p));
    }

    public function test_comprar_lo_propio_da_un_aviso_distinto(): void
    {
        $p = $this->makeProperty(price: 1000);
        $this->economy->buy($this->ana, $this->match->id, $p->id);

        $this->expectExceptionObject(GameException::taken(true));
        $this->economy->buy($this->ana, $this->match->id, $p->id);
    }

    public function test_sin_saldo_no_se_mueve_nada(): void
    {
        $p = $this->makeProperty(price: 5001);

        try {
            $this->economy->buy($this->ana, $this->match->id, $p->id);
            $this->fail('debía fallar');
        } catch (GameException $e) {
            $this->assertSame('saldo_insuficiente', $e->errorCode);
            $this->assertSame(['precio' => 5001, 'saldo' => 5000, 'faltan' => 1], $e->context);
        }
        $this->assertNull($this->ownerOf($this->match, $p));
        $this->assertSame(5000, $this->cash($this->match, $this->ana));
        $this->assertSame(0, LedgerEntry::where('type', LedgerType::Compra)->count());
    }

    public function test_una_propiedad_inexistente_da_404(): void
    {
        try {
            $this->economy->buy($this->ana, $this->match->id, 999999);
            $this->fail('debía fallar');
        } catch (GameException $e) {
            $this->assertSame([404, 'propiedad_inexistente'], [$e->status, $e->errorCode]);
        }
    }

    public function test_quien_no_juega_la_partida_no_puede_comprar(): void
    {
        $afuera = User::factory()->create();
        $p = $this->makeProperty();

        try {
            $this->economy->buy($afuera, $this->match->id, $p->id);
            $this->fail('debía fallar');
        } catch (GameException $e) {
            $this->assertSame(['no_estas_en_partida', 403], [$e->errorCode, $e->status]);
        }
        $this->assertNull($this->ownerOf($this->match, $p));
    }

    public function test_no_se_compra_en_una_partida_que_no_esta_en_juego(): void
    {
        $p = $this->makeProperty();
        Carbon::setTestNow($this->match->ends_at->copy()->addSecond());

        $this->expectExceptionObject(GameException::matchNotRunning());
        $this->economy->buy($this->ana, $this->match->id, $p->id);
    }

    public function test_reintentar_con_la_misma_clave_no_cobra_dos_veces(): void
    {
        $p = $this->makeProperty(price: 1000);

        $first = $this->economy->buy($this->ana, $this->match->id, $p->id, 'clave-1');
        $again = $this->economy->buy($this->ana, $this->match->id, $p->id, 'clave-1');

        $this->assertFalse($first->replayed);
        $this->assertTrue($again->replayed);
        $this->assertSame([$first->propertyId, $first->price, 4000], [$again->propertyId, $again->price, $again->balance]);
        $this->assertSame(1, LedgerEntry::where('type', LedgerType::Compra)->count());
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_el_reintento_que_llega_despues_de_la_compra_recibe_el_mismo_resultado_y_sin_clave_un_aviso(): void
    {
        $p = $this->makeProperty(price: 1000);
        $this->economy->buy($this->ana, $this->match->id, $p->id, 'clave-A');

        // Con clave conocida: repetición. Con otra clave o sin clave: "ya es tuya" (es otra intención).
        $this->assertTrue($this->economy->buy($this->ana, $this->match->id, $p->id, 'clave-A')->replayed);
        $this->expectExceptionObject(GameException::taken(true));
        $this->economy->buy($this->ana, $this->match->id, $p->id, 'clave-B');
    }

    public function test_si_el_tiempo_real_falla_la_compra_igual_queda_hecha(): void
    {
        // Reverb apuntando a un puerto donde no escucha nadie, con cola sync: el envío falla en el acto.
        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.options.host' => '127.0.0.1',
            'broadcasting.connections.reverb.options.port' => 1,
            'broadcasting.connections.reverb.options.scheme' => 'http',
            'broadcasting.connections.reverb.options.useTLS' => false,
            'queue.default' => 'sync',
        ]);
        app()->forgetInstance('Illuminate\Broadcasting\BroadcastManager');
        $p = $this->makeProperty(price: 1000);

        $r = $this->economy->buy($this->ana, $this->match->id, $p->id);

        $this->assertSame($this->ana->id, $this->ownerOf($this->match, $p));
        $this->assertSame(4000, $r->balance);
    }

    // ------------------------------------------------------------------ ingreso automático por días de juego

    public function test_el_ingreso_se_liquida_solo_por_dias_de_juego_al_actuar(): void
    {
        $p = $this->makeProperty(price: 1000, income: 1200); // 1200 por día de juego = 10 por segundo real
        $this->economy->buy($this->ana, $this->match->id, $p->id);
        $this->assertSame(4000, $this->cash($this->match, $this->ana));

        Carbon::setTestNow('2026-10-14 10:01:00'); // 60 s = medio día de juego = 600
        $q = $this->makeProperty(price: 100);
        $this->economy->buy($this->ana, $this->match->id, $q->id); // actuar liquida el ingreso primero

        $this->assertSame(4000 + 600 - 100, $this->cash($this->match, $this->ana));
        $this->assertDatabaseHas('ledger_entries', ['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'cobro', 'amount' => 600]);
        $this->assertTrue($this->player($this->match, $this->ana)->last_settled_at->equalTo(now()));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_liquidar_dos_veces_en_el_mismo_instante_no_paga_de_mas(): void
    {
        $p = $this->makeProperty(price: 1000, income: 1200);
        $this->economy->buy($this->ana, $this->match->id, $p->id);
        Carbon::setTestNow('2026-10-14 10:00:30');

        $player = fn () => MatchPlayer::where('match_id', $this->match->id)->where('user_id', $this->ana->id)->first();
        $first = DB::transaction(fn () => $this->economy->settleIncome($this->match->fresh(), $player()));
        $second = DB::transaction(fn () => $this->economy->settleIncome($this->match->fresh(), $player()));

        $this->assertSame([300, 0], [$first, $second]);
        $this->assertSame(1, LedgerEntry::where('user_id', $this->ana->id)->where('type', LedgerType::Cobro)->count());
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_liquidar_muchas_veces_da_lo_mismo_que_una_sola_sin_perder_fracciones(): void
    {
        // 100 por día de juego con días de 120 s: 100/120 de peso por segundo (no entero). En los 2400 s de la partida son 2000.
        $p = $this->makeProperty(price: 1000, income: 100);
        $this->economy->buy($this->ana, $this->match->id, $p->id);
        $total = 0;
        for ($i = 1; $i <= 24; $i++) { // 24 acciones, una cada 100 s (cada una paga una fracción)
            Carbon::setTestNow(Carbon::parse('2026-10-14 10:00:00')->addSeconds(100 * $i));
            DB::transaction(function () use (&$total) {
                $player = MatchPlayer::where('match_id', $this->match->id)->where('user_id', $this->ana->id)->first();
                $total += $this->economy->settleIncome($this->match->fresh(), $player);
            });
        }

        $this->assertSame(intdiv(100 * 2400, 120), $total); // 2000 exactos en 2400 s
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_el_ingreso_no_pasa_de_la_hora_de_cierre(): void
    {
        $p = $this->makeProperty(price: 1000, income: 1200);
        $this->economy->buy($this->ana, $this->match->id, $p->id);

        Carbon::setTestNow($this->match->ends_at->copy()->addHours(5)); // mucho después del fin
        DB::transaction(fn () => $this->economy->settleIncome($this->match->fresh(), $this->player($this->match, $this->ana)));

        // 40 min = 2400 s de partida - 0 s hasta la compra = 2400 s * 10 = 24.000
        $this->assertSame(4000 + 24000, $this->cash($this->match, $this->ana));
    }

    public function test_el_ingreso_de_un_jugador_no_toca_al_otro(): void
    {
        $p1 = $this->makeProperty(price: 1000, income: 1200);
        $p2 = $this->makeProperty(price: 1000, income: 600);
        $this->economy->buy($this->ana, $this->match->id, $p1->id);
        $this->economy->buy($this->beto, $this->match->id, $p2->id);

        Carbon::setTestNow('2026-10-14 10:02:00'); // 1 día de juego exacto
        $s = $this->economy->snapshot($this->ana, $this->match);

        $this->assertSame(4000 + 1200, $s['cash']);
        $this->assertSame(4000, $this->cash($this->match, $this->ana), 'leer no escribe: el dinero guardado sigue igual hasta que se actúe');
        $this->assertSame(1200, $s['income_per_day']);
        $this->assertSame(4000, $this->cash($this->match, $this->beto));
    }

    // ------------------------------------------------------------------ venta

    public function test_vender_acredita_lo_acumulado_mas_el_reembolso_y_libera_la_propiedad(): void
    {
        config(['formosa.economy.sell_ratio' => 0.6]);
        $p = $this->makeProperty(price: 1000, income: 1200);
        $this->economy->buy($this->ana, $this->match->id, $p->id);

        Carbon::setTestNow('2026-10-14 10:00:30'); // 300 acumulados
        $r = $this->economy->sell($this->ana, $this->match->id, $p->id, 'venta-1');

        $this->assertSame([600, 300, 4000 + 300 + 600, false], [$r['refund'], $r['collected'], $r['balance'], $r['replayed']]);
        $this->assertNull($this->ownerOf($this->match, $p));
        $this->assertLedgerMatchesCash($this->match);

        // Repetir con la misma clave no vende de nuevo.
        $again = $this->economy->sell($this->ana, $this->match->id, $p->id, 'venta-1');
        $this->assertTrue($again['replayed']);
        $this->assertSame(1, LedgerEntry::where('type', LedgerType::Venta)->count());
    }

    public function test_no_se_vende_lo_ajeno_ni_lo_libre(): void
    {
        $p = $this->makeProperty(price: 1000);
        $this->economy->buy($this->ana, $this->match->id, $p->id);

        $this->expectExceptionObject(GameException::notYours());
        $this->economy->sell($this->beto, $this->match->id, $p->id);
    }

    // ------------------------------------------------------------------ libro

    public function test_el_libro_no_se_puede_editar_ni_borrar(): void
    {
        $entry = LedgerEntry::firstOrFail();

        try {
            $entry->amount = 1;
            $entry->save();
            $this->fail('debía fallar');
        } catch (LogicException) {
            $this->assertTrue(true);
        }
        $this->expectException(LogicException::class);
        $entry->delete();
    }

    public function test_la_base_rechaza_dinero_negativo_y_signos_incoherentes(): void
    {
        if (! in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            $this->markTestSkipped('CHECK solo se agrega en mysql/mariadb/pgsql.');
        }

        try {
            DB::table('match_players')->where('user_id', $this->ana->id)->update(['cash' => DB::raw('cash - 999999')]);
            $this->fail('el dinero negativo debía rechazarse');
        } catch (\Illuminate\Database\QueryException) {
            $this->assertTrue(true);
        }
        $this->expectException(\Illuminate\Database\QueryException::class);
        DB::table('ledger_entries')->insert(['match_id' => $this->match->id, 'user_id' => $this->ana->id, 'type' => 'compra', 'amount' => 50, 'balance_after' => 1]); // una compra no puede sumar
    }

    public function test_los_combos_suben_el_ingreso_por_dia_y_se_cobran(): void
    {
        config(['formosa.combos.zone_tiers' => [3 => 0.10, 5 => 0.20, 8 => 0.30]]);
        $props = [];
        foreach ([1, 2, 3] as $n) {
            $props[] = $this->makeProperty(price: 1000, income: 1000, kind: 'casa', lat: -26.18, lng: -58.17 + $n * 0.0001); // misma zona
        }
        foreach ($props as $p) {
            $this->economy->buy($this->ana, $this->match->id, $p->id);
        }

        $this->assertSame(3300, $this->economy->incomePerDay($this->match->id, $this->ana->id)); // 3000 + 10 % de zona
        $snap = $this->economy->snapshot($this->ana, $this->match);
        $this->assertSame(3300, $snap['income_per_day']);
        $this->assertSame(300, $snap['combos']['bonus']);

        $before = $this->cash($this->match, $this->ana);
        Carbon::setTestNow('2026-10-14 10:02:00'); // un día de juego
        $this->economy->settleIncome($this->match->fresh(), $this->player($this->match, $this->ana));
        $this->assertSame($before + 3300, $this->cash($this->match, $this->ana));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_un_evento_cambia_el_ingreso_solo_durante_su_ventana_y_se_liquida_por_tramos(): void
    {
        config(['formosa.events.enabled' => true]);
        $event = \App\Economy\MatchEvents::forMatch($this->match)[0];
        $start = $this->match->started_at->getTimestamp();
        $before = $event['start'] - $start;
        $this->assertGreaterThan(0, $before);

        $prop = $this->makeProperty(price: 1000, income: 1200, kind: $event['kind']);
        $this->economy->buy($this->ana, $this->match->id, $prop->id);

        // Antes del evento rinde lo normal; adentro, con el multiplicador.
        Carbon::setTestNow(Carbon::createFromTimestamp($event['start'] - 1));
        $this->assertSame(1200, $this->economy->incomePerDay($this->match->id, $this->ana->id));
        Carbon::setTestNow(Carbon::createFromTimestamp($event['start']));
        $this->assertSame((int) floor(1200 * (1 + $event['pct'])), $this->economy->incomePerDay($this->match->id, $this->ana->id));

        // Liquidar de una vez, pasando por todo el evento, da lo mismo que tramo a tramo.
        $window = $event['end'] - $event['start'];
        $expected = intdiv(1200 * $before, 120) + intdiv((int) floor(1200 * (1 + $event['pct'])) * $window, 120);
        $cashBefore = $this->cash($this->match, $this->ana);
        Carbon::setTestNow(Carbon::createFromTimestamp($event['end']));
        $this->economy->settleIncome($this->match->fresh(), $this->player($this->match, $this->ana));
        $this->assertSame($cashBefore + $expected, $this->cash($this->match, $this->ana));
        $this->assertLedgerMatchesCash($this->match);
    }

    public function test_otros_tipos_de_propiedad_no_cambian_con_el_evento(): void
    {
        config(['formosa.events.enabled' => true]);
        $event = \App\Economy\MatchEvents::forMatch($this->match)[0];
        $other = $event['kind'] === 'hotel' ? 'casa' : 'hotel';
        $prop = $this->makeProperty(price: 1000, income: 1200, kind: $other);
        $this->economy->buy($this->ana, $this->match->id, $prop->id);
        Carbon::setTestNow(Carbon::createFromTimestamp($event['start'] + 5));
        $this->assertSame(1200, $this->economy->incomePerDay($this->match->id, $this->ana->id));
    }
}
