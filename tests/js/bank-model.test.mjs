import test from 'node:test';
import assert from 'node:assert/strict';
import { interestOf, dailyPrincipal, preview, nextDue, clampAmount, blockText, progressText, repaidShare, buttonText } from '../../resources/js/map/bank-model.js';

const money = (n) => `$${n}`;

test('interés y capital diario: mismo redondeo que el servidor', () => {
    assert.equal(interestOf(10000, 3), 300);
    assert.equal(interestOf(1001, 3), 31);
    assert.equal(interestOf(1, 3), 1);
    assert.equal(interestOf(0, 3), 0);
    assert.equal(dailyPrincipal(10000, 5), 2000);
    assert.equal(dailyPrincipal(1000, 3), 334);
});

test('preview: 10.000 a 5 días con 3 %', () => {
    const p = preview(10000, 5, 3);
    assert.equal(p.dailyPrincipal, 2000);
    assert.equal(p.firstDue, 2300);
    assert.equal(p.lastDue, 2060);
    assert.equal(p.totalInterest, 900); // 300 + 240 + 180 + 120 + 60
    assert.equal(p.total, 10900);
});

test('preview: el último día devuelve lo que quede aunque el redondeo sobre', () => {
    const p = preview(1000, 3, 3); // capital diario 334, 334, 332
    assert.equal(p.total, 1000 + p.totalInterest);
    assert.ok(p.lastDue > 0);
});

test('nextDue: cuota del día siguiente, con mora y último día', () => {
    const loan = { days_charged: 1, term_days: 5, balance: 8000, arrears: 0, daily_principal: 2000, rate_pct: 3 };
    assert.equal(nextDue(loan), 240 + 2000);
    assert.equal(nextDue({ ...loan, arrears: 1300 }), 1300 + 26 + 240 + 2000);
    assert.equal(nextDue({ ...loan, days_charged: 4, balance: 2000 }), 60 + 2000);
    assert.equal(nextDue({ ...loan, days_charged: 7, balance: 500 }), 15 + 500); // pasado el plazo: todo el capital
});

test('clampAmount: dentro del rango y sin romperse con basura', () => {
    assert.equal(clampAmount(5000, 1000, 50000), 5000);
    assert.equal(clampAmount(50, 1000, 50000), 1000);
    assert.equal(clampAmount(99999, 1000, 50000), 50000);
    assert.equal(clampAmount('abc', 1000, 50000), 1000);
    assert.equal(clampAmount(2500.9, 1000, 50000), 2500);
    assert.equal(clampAmount(5000, 1000, 500), 0); // no alcanza ni el mínimo
});

test('blockText: un motivo por cada bloqueo', () => {
    const s = (blocked) => ({ blocked, rules: { max_loans: 2, min_amount: 1000 } });
    assert.match(blockText(s('con_mora'), money), /atrasadas/);
    assert.match(blockText(s('tope'), money), /2 préstamos/);
    assert.match(blockText(s('sin_cupo'), money), /\$1000/);
    assert.match(blockText(s('sprint'), money), /sprint/);
    assert.equal(blockText(s(null), money), '');
});

test('textos de avance y botón', () => {
    const loan = { principal: 10000, balance: 6000, days_charged: 2, term_days: 5 };
    assert.equal(progressText(loan), 'día 2 de 5');
    assert.equal(repaidShare(loan), 0.4);
    assert.equal(repaidShare({ principal: 0, balance: 0 }), 1);
    assert.equal(buttonText(0, money), 'Banco');
    assert.equal(buttonText(5000, money), 'Banco · debés $5000');
});
