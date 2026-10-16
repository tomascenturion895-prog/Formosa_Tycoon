import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerNet, suggestPrices, validatePrices, phase, isDue, roleOf, bidCheck, timerText, statusText, outcomeNotice, upgradeLine } from '../../resources/js/map/offers-model.js';

const money = (n) => `$${n}`;
const clock = (ms) => `${Math.ceil(ms / 1000)}s`;
const offer = (over = {}) => ({
    id: 1, status: 'abierta', seller_id: 1, seller: 'Ana', leader_id: null, leader: null, min_price: 8000, buy_now_price: 20000,
    current_bid: null, min_next: 8000, ends_at: 1000, decide_until: 1500, sold_price: null, ...over,
});

test('sellerNet: comisión redondeada hacia abajo, como el servidor', () => {
    assert.deepEqual(sellerNet(10000, 5), { fee: 500, net: 9500 });
    assert.deepEqual(sellerNet(199, 5), { fee: 9, net: 190 });
    assert.deepEqual(sellerNet(1000, -3), { fee: 0, net: 1000 });
});

test('suggestPrices: mínimo en el precio de lista, comprá ya un 50 % arriba y siempre mayor', () => {
    assert.deepEqual(suggestPrices(10000), { min: 10000, max: 15000 });
    const tiny = suggestPrices(100);
    assert.ok(tiny.max > tiny.min);
    assert.ok(suggestPrices(0).min >= 100);
});

test('validatePrices: motivos claros', () => {
    assert.equal(validatePrices(8000, 20000), '');
    assert.match(validatePrices(NaN, 20000), /pesos/);
    assert.match(validatePrices(50, 20000), /al menos 100/);
    assert.match(validatePrices(8000, 8000), /mayor/);
    assert.match(validatePrices(1.5, 20000), /pesos/);
});

test('phase e isDue: ofertando, decidiendo, vencida y cerrada', () => {
    const o = offer({ leader_id: 2, current_bid: 9000 });
    assert.equal(phase(o, 999), 'ofertando');
    assert.equal(phase(o, 1000), 'decidiendo');
    assert.equal(phase(o, 1500), 'vencida');
    assert.equal(phase(offer({ status: 'vendida' }), 0), 'cerrada');
    assert.equal(isDue(o, 1499), false);
    assert.equal(isDue(o, 1500), true);
    assert.equal(isDue(offer(), 1000), true); // sin ofertas se cierra al vencer el plazo de ofertar
    assert.equal(isDue(offer({ status: 'cerrada' }), 9999), false);
});

test('roleOf: dueño, líder, visitante e invitado', () => {
    const o = offer({ leader_id: 2 });
    assert.equal(roleOf(o, 1), 'owner');
    assert.equal(roleOf(o, 2), 'leader');
    assert.equal(roleOf(o, 3), 'visitor');
    assert.equal(roleOf(o, null), 'guest');
});

test('bidCheck: solo en fase de ofertas, y cuenta lo que falta', () => {
    const o = offer({ min_next: 8400, leader_id: 2, current_bid: 8000 });
    assert.deepEqual(bidCheck(o, { meId: 3, available: 10000, now: 10 }), { can: true, missing: 0 });
    assert.deepEqual(bidCheck(o, { meId: 3, available: 8000, now: 10 }), { can: false, missing: 400 });
    assert.deepEqual(bidCheck(o, { meId: 2, available: 400, now: 10 }), { can: true, missing: 0 }); // su reserva de 8.000 cuenta
    assert.equal(bidCheck(o, { meId: 1, available: 99999, now: 10 }).can, false); // el dueño no oferta
    assert.equal(bidCheck(o, { meId: 3, available: 99999, now: 1200 }).can, false); // ya pasó el plazo de ofertar
    assert.equal(bidCheck(o, { meId: null, available: 99999, now: 10 }).can, false);
});

test('timerText y statusText siguen la fase', () => {
    const o = offer({ leader_id: 2, leader: 'Beto', current_bid: 9000 });
    assert.equal(timerText(o, 0, clock), 'Se ofrece por 1s más');
    assert.equal(timerText(o, 1000, clock), 'Ana decide en 1s');
    assert.equal(timerText(o, 1600, clock), 'Cerrando…');
    assert.match(statusText(o, 1, 0, money), /Beto ofreció \$9000/);
    assert.match(statusText(o, 1, 1100, money), /Elegí/);
    assert.match(statusText(o, 2, 0, money), /Vas ganando/);
    assert.match(statusText(offer(), 3, 0, money), /entre \$8000 y \$20000/);
});

test('outcomeNotice: avisos para cada parte', () => {
    const ctx = { money, label: 'Casa', feePct: 5 };
    const prev = offer({ leader_id: 2, current_bid: 9000 });
    assert.match(outcomeNotice(prev, offer({ leader_id: 3, leader: 'Cami', current_bid: 9500 }), 2, ctx).text, /Te superaron en Casa: \$9500 de Cami/);
    assert.match(outcomeNotice(null, offer({ leader_id: 2, leader: 'Beto', current_bid: 9000 }), 1, ctx).text, /Beto ofertó \$9000/);
    const sold = offer({ status: 'vendida', leader_id: 2, sold_price: 10000 });
    assert.match(outcomeNotice(prev, sold, 1, ctx).text, /Vendiste Casa por \$10000 \(cobrás \$9500\)/);
    assert.match(outcomeNotice(prev, sold, 2, ctx).text, /Compraste Casa/);
    assert.equal(outcomeNotice(prev, sold, 3, ctx), null);
    assert.match(outcomeNotice(prev, offer({ status: 'cerrada' }), 2, ctx).text, /se liberó tu plata/);
    assert.match(outcomeNotice(prev, offer({ status: 'cancelada' }), 2, ctx).text, /Retiraron/);
    assert.match(outcomeNotice(null, offer({ status: 'cerrada' }), 1, ctx).text, /sin venta/);
    assert.equal(outcomeNotice(prev, offer({ leader_id: 2 }), 2, ctx), null); // no hay novedad para quien sigue ganando
    assert.equal(outcomeNotice(prev, sold, null, ctx), null);
});

test('upgradeLine: la tarjeta de oferta dice qué mejora trae la propiedad', () => {
    assert.equal(upgradeLine(offer({ level: 2, branch: 'a', label: 'Alquiler turístico' })), 'Alquiler turístico (nivel 2)');
    assert.equal(upgradeLine(offer({ level: 1, branch: null, label: 'Reformada' })), 'Reformada (nivel 1)');
    assert.equal(upgradeLine(offer({ level: 0, branch: null, label: null })), '');
    assert.equal(upgradeLine(offer()), ''); // ofertas viejas sin esos campos
});
