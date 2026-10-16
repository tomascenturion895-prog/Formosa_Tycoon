import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOption, blockReason, sellWarning } from '../../resources/js/map/upgrades-model.js';

const money = (n) => `$${n}`;
const opt = (over = {}) => ({ level: 1, branch: null, label: 'Reformada', cost: 5000, gross: 3500, maintenance: 125, net: 3375, payback_days: 5.714, ...over });

test('describeOption: textos con costo, neto, mantenimiento y recupero', () => {
    const d = describeOption(opt(), money, 20);
    assert.equal(d.title, 'Reformada (nivel 1)');
    assert.equal(d.costText, 'Cuesta $5000');
    assert.equal(d.netText, 'Ingreso neto: $3375 por día');
    assert.equal(d.maintText, 'Mantenimiento: $125 por día');
    assert.equal(d.paybackText, 'Se recupera en 5,7 días');
    assert.equal(d.warn, '');
});

test('describeOption: avisa si no llega a recuperarse antes del final', () => {
    const d = describeOption(opt({ payback_days: 8 }), money, 3);
    assert.match(d.warn, /terminar la partida/);
    assert.equal(describeOption(opt({ payback_days: 8 }), money, 8).warn, '');
});

test('describeOption: sin recupero calculable', () => {
    const d = describeOption(opt({ payback_days: null }), money, 20);
    assert.match(d.paybackText, /no se recupera/i);
    assert.equal(d.warn, '');
});

test('describeOption: el nivel 2 nombra la especialización y el mantenimiento en cero se dice', () => {
    assert.equal(describeOption(opt({ level: 2, branch: 'a', label: 'Resort' }), money, 20).title, 'Resort (nivel 2)');
    assert.equal(describeOption(opt({ maintenance: 0 }), money, 20).maintText, 'Sin mantenimiento');
});

test('blockReason: el primer motivo que corresponde, en orden', () => {
    const ok = { playing: true, mine: true, busy: false, available: 9000, cost: 5000, inAuction: false, inOffer: false };
    assert.equal(blockReason(ok, money), '');
    assert.match(blockReason({ ...ok, playing: false }, money), /no está en juego/);
    assert.match(blockReason({ ...ok, mine: false }, money), /tuyas/);
    assert.match(blockReason({ ...ok, inAuction: true }, money), /subasta/);
    assert.match(blockReason({ ...ok, inOffer: true }, money), /oferta/);
    assert.match(blockReason({ ...ok, busy: true }, money), /momento/);
    assert.equal(blockReason({ ...ok, available: 3000 }, money), 'Te faltan $2000.');
});

test('sellWarning: solo avisa si hay mejora', () => {
    assert.equal(sellWarning(0), '');
    assert.match(sellWarning(1), /perdés la mejora/);
    assert.match(sellWarning(2), /perdés la mejora/);
});
