import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRemainingMs, incomePerMinute, leaderGap, gapText, afterBuy, paybackShare } from '../../resources/js/map/panel-model.js';

const money = (n) => `$ ${n}`;
const rows = (list) => list.map(([name, net_worth, position, isMe = false, abandoned = false]) => ({ name, net_worth, position, isMe, abandoned }));

test('dayRemainingMs: lo que falta del día en curso', () => {
    assert.equal(dayRemainingMs({ running: true, dayFraction: 0.25 }, 2), 90_000);
    assert.equal(dayRemainingMs({ running: true, dayFraction: 0 }, 2), 120_000);
});
test('dayRemainingMs: partida que no corre o datos raros dan 0', () => {
    assert.equal(dayRemainingMs({ running: false, dayFraction: 0.5 }, 2), 0);
    assert.equal(dayRemainingMs(null, 2), 0);
    assert.equal(dayRemainingMs({ running: true, dayFraction: 0.5 }, 0), 0);
    assert.equal(dayRemainingMs({ running: true, dayFraction: 7 }, 2), 0);
});

test('incomePerMinute: ingreso diario repartido en los minutos del día', () => {
    assert.equal(incomePerMinute(8500, 2), 4250);
    assert.equal(incomePerMinute(0, 2), 0);
    assert.equal(incomePerMinute(8500, 0), 0);
});

test('leaderGap: atrás del líder', () => {
    const g = leaderGap(rows([['LordTiamat', 64448, 1], ['Kieru', 63605, 2], ['Lexi', 61083, 3, true]]));
    assert.deepEqual(g, { kind: 'behind', amount: 3365, name: 'LordTiamat' });
    assert.equal(gapText(g, money), 'A $ 3365 del 1.º (LordTiamat)');
});
test('leaderGap: en el 1.º puesto muestra la ventaja sobre el que sigue', () => {
    const g = leaderGap(rows([['Lexi', 70000, 1, true], ['Kieru', 63605, 2], ['Lord', 60000, 3]]));
    assert.deepEqual(g, { kind: 'lead', amount: 6395, name: 'Kieru' });
    assert.equal(gapText(g, money), 'Vas 1.º con $ 6395 sobre Kieru');
});
test('leaderGap: empatado en el 1.º puesto no da ventaja negativa', () => {
    const g = leaderGap(rows([['Lexi', 5000, 1, true], ['Kieru', 5000, 1]]));
    assert.deepEqual(g, { kind: 'lead', amount: 0, name: 'Kieru' });
});
test('leaderGap: sin rivales activos o si abandonó, no hay comparación', () => {
    assert.equal(leaderGap(rows([['Lexi', 5000, 1, true]])), null);
    assert.equal(leaderGap(rows([['Lexi', 5000, 2, true, true], ['Kieru', 9000, 1]])), null);
    assert.equal(leaderGap([]), null);
    assert.equal(gapText(null, money), '');
});
test('leaderGap: los que abandonaron no cuentan como líder', () => {
    const g = leaderGap(rows([['Fantasma', 99999, 3, false, true], ['Kieru', 63605, 1], ['Lexi', 61083, 2, true]]));
    assert.deepEqual(g, { kind: 'behind', amount: 2522, name: 'Kieru' });
});

test('afterBuy: cuánto queda, o cuánto falta', () => {
    assert.deepEqual(afterBuy(27083, 6000), { ok: true, left: 21083, missing: 0 });
    assert.deepEqual(afterBuy(5000, 6000), { ok: false, left: -1000, missing: 1000 });
    assert.deepEqual(afterBuy(6000, 6000), { ok: true, left: 0, missing: 0 });
});

test('paybackShare: días de recupero y parte de la partida que ocupan', () => {
    assert.deepEqual(paybackShare(6000, 1500, 20), { days: 4, share: 0.2, late: false });
});
test('paybackShare: avisa si no se alcanza a recuperar en lo que queda', () => {
    const r = paybackShare(6000, 1500, 20, 3);
    assert.equal(r.late, true);
    assert.equal(r.days, 4);
});
test('paybackShare: tope en 1 y sin ingreso devuelve null', () => {
    assert.equal(paybackShare(100000, 100, 20).share, 1);
    assert.equal(paybackShare(6000, 0, 20), null);
    assert.equal(paybackShare(0, 1500, 20), null);
    assert.equal(paybackShare(6000, 1500, 0), null);
});
