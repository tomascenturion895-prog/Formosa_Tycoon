<?php

namespace App\Models;

use App\Enums\LoanStatus;
use Illuminate\Database\Eloquent\Model;

/** Solo LoanService cambia un préstamo. Nada asignable en masa. Es privado de quien lo pidió: nunca va por un canal público. */
class Loan extends Model
{
    protected $guarded = ['*'];

    protected function casts(): array
    {
        return [
            'status' => LoanStatus::class,
            'principal' => 'integer', 'balance' => 'integer', 'arrears' => 'integer', 'daily_principal' => 'integer',
            'term_days' => 'integer', 'rate_pct' => 'integer', 'days_charged' => 'integer', 'interest_paid' => 'integer',
            'taken_at' => 'datetime', 'closed_at' => 'datetime',
        ];
    }

    public function isOpen(): bool
    {
        return $this->status === LoanStatus::Abierto;
    }

    /** Lo que debe hoy: capital pendiente + lo atrasado. */
    public function debt(): int
    {
        return $this->balance + $this->arrears;
    }

    /** @return array<string, mixed> */
    public function toOwner(): array
    {
        return [
            'id' => $this->id, 'status' => $this->status->value, 'principal' => $this->principal, 'balance' => $this->balance,
            'arrears' => $this->arrears, 'debt' => $this->debt(), 'term_days' => $this->term_days, 'rate_pct' => $this->rate_pct,
            'daily_principal' => $this->daily_principal, 'days_charged' => $this->days_charged, 'interest_paid' => $this->interest_paid,
            'taken_at' => $this->taken_at->getTimestampMs(),
        ];
    }
}
