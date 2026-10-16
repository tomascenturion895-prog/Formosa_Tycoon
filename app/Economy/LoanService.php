<?php

namespace App\Economy;

use App\Enums\LedgerType;
use App\Enums\LoanStatus;
use App\Enums\MatchStatus;
use App\Models\GameMatch;
use App\Models\LedgerEntry;
use App\Models\Loan;
use App\Models\MatchPlayer;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;

/**
 * Banco: préstamos con interés que se devuelven por día de juego. Todo es DE UNA PARTIDA y PRIVADO de quien lo pide.
 *
 * Reglas:
 *  - El préstamo entra al efectivo al instante (libro: "prestamo"). Cada día de juego completo se cobra una cuota automática
 *    (libro: "cuota"): interés sobre el capital pendiente + parte del capital (capital / plazo). El último día del plazo se
 *    devuelve todo lo que quede. Ver LoanRules.
 *  - El cobro es PEREZOSO, igual que el ingreso: EconomyService::settleIncome lo hace (con el jugador bloqueado) antes de cualquier
 *    cambio de dinero, y el reloj del servidor lo adelanta para todos (`chargeDue`). Un día se cobra una sola vez (`days_charged`
 *    y la clave "cuota-{préstamo}-{día}" única en el libro).
 *  - Lo que no alcanza queda como MORA y suma un recargo diario. Con mora no se puede pedir otro préstamo. No hay embargo.
 *  - Se cobra del efectivo LIBRE (sin lo reservado por subastas y ofertas), así nunca se rompe una reserva.
 *  - La deuda (capital + mora) se descuenta del patrimonio: cuenta para los puestos y los puntos al terminar la partida.
 *  - Quien abandona la partida no sigue pagando (sus préstamos se cancelan; igual pierde la partida).
 *  - Orden de bloqueos como siempre: partida (compartido) -> jugador. El préstamo se toma con el jugador ya bloqueado.
 */
class LoanService
{
    // ------------------------------------------------------------------ pedir y pagar

    /**
     * Pide un préstamo.
     *
     * @throws GameException
     */
    public function take(User $user, int $matchId, int $amount, int $termDays): Loan
    {
        $cfg = config('formosa.bank');
        if (! in_array($termDays, array_map('intval', $cfg['terms']), true)) {
            throw GameException::loanTerm();
        }
        if ($amount < (int) $cfg['min_amount']) {
            throw GameException::loanAmount((int) $cfg['min_amount']);
        }
        $economy = app(EconomyService::class);

        return DB::transaction(function () use ($user, $matchId, $amount, $termDays, $cfg, $economy) {
            $match = $economy->liveMatch($matchId);
            if (config('formosa.sprint.block_loans') && app(SprintService::class)->isOn($match)) {
                throw GameException::loanSprint();
            }
            $player = $economy->lockPlayer($matchId, $user->id);
            $economy->settleIncome($match, $player); // incluye cobrar las cuotas vencidas

            $open = Loan::where('match_id', $matchId)->where('user_id', $user->id)->where('status', LoanStatus::Abierto->value)->lockForUpdate()->get();
            if ($open->contains(fn (Loan $l) => $l->arrears > 0)) {
                throw GameException::loanArrears();
            }
            if ($open->count() >= (int) $cfg['max_loans']) {
                throw GameException::tooManyLoans((int) $cfg['max_loans']);
            }
            $max = LoanRules::maxNew($this->netWorthOf($matchId, $user->id, $player->cash, (int) $open->sum(fn (Loan $l) => $l->debt())), (int) $cfg['max_share_pct']);
            if ($amount > $max) {
                throw GameException::loanTooBig($max);
            }

            $now = now()->startOfSecond();
            $loan = new Loan;
            $loan->forceFill([
                'match_id' => $matchId, 'user_id' => $user->id, 'status' => LoanStatus::Abierto, 'principal' => $amount, 'balance' => $amount,
                'arrears' => 0, 'daily_principal' => LoanRules::dailyPrincipal($amount, $termDays), 'term_days' => $termDays,
                'rate_pct' => (int) $cfg['rate_pct'], 'taken_at' => $now,
            ])->save();

            $cash = $player->cash + $amount;
            DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => $now->toDateTimeString()]);
            LedgerEntry::forceCreate([
                'match_id' => $matchId, 'user_id' => $user->id, 'type' => LedgerType::Prestamo, 'amount' => $amount,
                'balance_after' => $cash, 'idempotency_key' => "prestamo-{$loan->id}",
            ]);

            return $loan;
        }, attempts: 3);
    }

    /**
     * Paga de más (o cancela) un préstamo: primero lo atrasado y después el capital. `$amount` null = todo lo que se pueda.
     *
     * @throws GameException
     */
    public function repay(User $user, int $matchId, int $loanId, ?int $amount): Loan
    {
        $economy = app(EconomyService::class);

        return DB::transaction(function () use ($user, $matchId, $loanId, $amount, $economy) {
            $match = $economy->liveMatch($matchId);
            $player = $economy->lockPlayer($matchId, $user->id);
            $economy->settleIncome($match, $player);

            $loan = Loan::where('id', $loanId)->where('match_id', $matchId)->where('user_id', $user->id)->lockForUpdate()->first() ?? throw GameException::loanNotFound();
            if (! $loan->isOpen()) {
                throw GameException::loanClosed();
            }
            $r = LoanRules::prepay($loan->balance, $loan->arrears, $amount, max(0, $player->available()));
            if ($r['paid'] <= 0) {
                throw GameException::nothingToPay();
            }

            $cash = $player->cash - $r['paid'];
            DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => now()->toDateTimeString()]);
            LedgerEntry::forceCreate([
                'match_id' => $matchId, 'user_id' => $user->id, 'type' => LedgerType::Cuota, 'amount' => -$r['paid'], 'balance_after' => $cash,
                'idempotency_key' => "pago-{$loan->id}-".(int) (microtime(true) * 1000000),
            ]);
            $loan->forceFill(['balance' => $r['balance'], 'arrears' => $r['arrears']]);
            if ($r['balance'] === 0 && $r['arrears'] === 0) {
                $loan->forceFill(['status' => LoanStatus::Pagado, 'closed_at' => now()]);
            }
            $loan->save();

            return $loan;
        }, attempts: 3);
    }

    // ------------------------------------------------------------------ cobro por día

    /**
     * Cobra las cuotas de los días de juego que ya pasaron, hasta `$until` (nunca más allá del cierre). Lo llama
     * EconomyService::settleIncome con la partida y `$player` ya bloqueados. Actualiza `$player` en memoria. Devuelve lo cobrado.
     */
    public function charge(GameMatch $match, MatchPlayer $player, CarbonInterface $until): int
    {
        $loans = Loan::where('match_id', $match->id)->where('user_id', $player->user_id)->where('status', LoanStatus::Abierto->value)->orderBy('id')->lockForUpdate()->get();
        if ($loans->isEmpty()) {
            return 0;
        }
        $cfg = config('formosa.bank');
        $end = $match->ends_at !== null && $until->greaterThan($match->ends_at) ? $match->ends_at : $until;
        $spd = $match->secondsPerDay();
        $cash = $player->cash;
        $total = 0;

        foreach ($loans as $loan) {
            $days = LoanRules::daysElapsed(Accrual::seconds($loan->taken_at, $end), $spd);
            if ($days <= $loan->days_charged) {
                continue;
            }
            for ($d = $loan->days_charged + 1; $d <= $days; $d++) {
                $r = LoanRules::day($loan->balance, $loan->arrears, $loan->daily_principal, $loan->term_days, $d, $loan->rate_pct, (int) $cfg['late_pct'], max(0, $cash - $player->reserved));
                if ($r['paid'] > 0) {
                    $cash -= $r['paid'];
                    $total += $r['paid'];
                    LedgerEntry::forceCreate([
                        'match_id' => $match->id, 'user_id' => $player->user_id, 'type' => LedgerType::Cuota, 'amount' => -$r['paid'],
                        'balance_after' => $cash, 'idempotency_key' => "cuota-{$loan->id}-{$d}",
                    ]);
                }
                $loan->forceFill(['balance' => $r['balance'], 'arrears' => $r['arrears'], 'days_charged' => $d, 'interest_paid' => $loan->interest_paid + $r['paid_interest']]);
                if ($r['balance'] === 0 && $r['arrears'] === 0) {
                    $loan->forceFill(['status' => LoanStatus::Pagado, 'closed_at' => now()]);
                    break;
                }
            }
            $loan->save();
        }

        if ($total > 0) {
            DB::table('match_players')->where('id', $player->id)->update(['cash' => $cash, 'updated_at' => now()->toDateTimeString()]);
            $player->forceFill(['cash' => $cash])->syncOriginal();
        }

        return $total;
    }

    /**
     * Pasada del reloj del servidor: cobra a quien le toca (en cada partida en juego) aunque no haga nada. Cada jugador va en su propia
     * transacción; si uno falla se sigue con el resto. Devuelve cuántos jugadores se cobraron.
     */
    public function chargeDue(int $limit = 200): int
    {
        $due = [];
        $rows = Loan::query()->join('matches as m', 'm.id', '=', 'loans.match_id')->where('loans.status', LoanStatus::Abierto->value)
            ->where('m.status', MatchStatus::Running->value)->orderBy('loans.id')
            ->get(['loans.match_id', 'loans.user_id', 'loans.taken_at', 'loans.days_charged', 'm.minutes_per_day', 'm.ends_at']);
        foreach ($rows as $r) {
            $spd = (int) $r->minutes_per_day * 60;
            $end = min(now()->getTimestamp(), \Carbon\Carbon::parse($r->ends_at)->getTimestamp());
            if (LoanRules::daysElapsed($end - \Carbon\Carbon::parse($r->taken_at)->getTimestamp(), $spd) > (int) $r->days_charged) {
                $due["{$r->match_id}:{$r->user_id}"] = [(int) $r->match_id, (int) $r->user_id];
            }
        }

        $economy = app(EconomyService::class);
        $done = 0;
        foreach (array_slice($due, 0, $limit) as [$matchId, $userId]) {
            try {
                DB::transaction(function () use ($economy, $matchId, $userId) {
                    $match = $economy->liveMatch($matchId);
                    $player = $economy->lockPlayer($matchId, $userId);
                    $economy->settleIncome($match, $player);
                }, attempts: 3);
                $done++;
            } catch (\Throwable $e) {
                if (! $e instanceof GameException) {
                    report($e); // una partida que cerró justo ahora (GameException) no es un problema
                }
            }
        }

        return $done;
    }

    // ------------------------------------------------------------------ lectura

    /**
     * Estado del banco para el jugador: sus préstamos, la deuda, cuánto puede pedir y las reglas. Cobra lo vencido antes de leer,
     * así lo que ve es lo que pasa de verdad.
     *
     * @return array<string, mixed>
     *
     * @throws GameException
     */
    public function summary(User $user, int $matchId): array
    {
        $economy = app(EconomyService::class);
        [$loans, $cash, $reserved] = DB::transaction(function () use ($user, $matchId, $economy) {
            $match = $economy->liveMatch($matchId);
            $player = $economy->lockPlayer($matchId, $user->id);
            $economy->settleIncome($match, $player);

            return [Loan::where('match_id', $matchId)->where('user_id', $user->id)->where('status', LoanStatus::Abierto->value)->orderBy('id')->get(), $player->cash, $player->reserved];
        }, attempts: 3);

        $cfg = config('formosa.bank');
        $debt = (int) $loans->sum(fn (Loan $l) => $l->debt());
        $max = LoanRules::maxNew($this->netWorthOf($matchId, $user->id, $cash, $debt), (int) $cfg['max_share_pct']);
        $arrears = (int) $loans->sum('arrears');
        $sprint = config('formosa.sprint.block_loans') && app(SprintService::class)->isOn(GameMatch::findOrFail($matchId));
        $block = match (true) {
            $sprint => 'sprint',
            $arrears > 0 => 'con_mora',
            $loans->count() >= (int) $cfg['max_loans'] => 'tope',
            $max < (int) $cfg['min_amount'] => 'sin_cupo',
            default => null,
        };

        return [
            'server_now' => now()->getTimestampMs(),
            'loans' => $loans->map(fn (Loan $l) => $l->toOwner())->all(),
            'debt' => $debt,
            'arrears' => $arrears,
            'cash' => $cash,
            'available' => max(0, $cash - $reserved),
            'max_new' => $max,
            'blocked' => $block,
            'rules' => [
                'rate_pct' => (int) $cfg['rate_pct'], 'late_pct' => (int) $cfg['late_pct'], 'max_share_pct' => (int) $cfg['max_share_pct'],
                'max_loans' => (int) $cfg['max_loans'], 'min_amount' => (int) $cfg['min_amount'], 'terms' => array_map('intval', $cfg['terms']),
            ],
        ];
    }

    /** Deuda de cada jugador de la partida (capital + mora de sus préstamos abiertos). @return array<int, int> user_id => deuda */
    public function debtsByUser(int $matchId): array
    {
        return Loan::where('match_id', $matchId)->where('status', LoanStatus::Abierto->value)->get(['user_id', 'balance', 'arrears'])
            ->groupBy('user_id')->map(fn ($g) => (int) $g->sum(fn ($l) => $l->balance + $l->arrears))->all();
    }

    public function debtOf(int $matchId, int $userId): int
    {
        return $this->debtsByUser($matchId)[$userId] ?? 0;
    }

    /** Cancela los préstamos abiertos de un jugador que abandona. Dentro de la transacción de MatchService. */
    public function cancelFor(int $matchId, int $userId): void
    {
        Loan::where('match_id', $matchId)->where('user_id', $userId)->where('status', LoanStatus::Abierto->value)
            ->update(['status' => LoanStatus::Cancelado->value, 'closed_at' => now()->toDateTimeString(), 'updated_at' => now()->toDateTimeString()]);
    }

    // ------------------------------------------------------------------ interno

    /** Patrimonio: efectivo + valor de las propiedades (lista + parte de lo invertido en mejoras, ver Upgrades::assetValue) - deuda. */
    public function netWorthOf(int $matchId, int $userId, int $cash, int $debt): int
    {
        $assets = (int) DB::table('match_properties as mp')->join('properties as p', 'p.id', '=', 'mp.property_id')
            ->where('mp.match_id', $matchId)->where('mp.owner_id', $userId)->get(['p.price', 'mp.upgrade_paid'])
            ->sum(fn ($r) => Upgrades::assetValue((int) $r->price, (int) $r->upgrade_paid));

        return $cash + $assets - $debt;
    }
}
