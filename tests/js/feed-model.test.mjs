import test from 'node:test';
import assert from 'node:assert/strict';
import { feedText, shouldShow, pushVisible, rememberKey, cardStyle, isKnownType, MAX_VISIBLE } from '../../resources/js/map/feed-model.js';

const money = (n) => `$ ${n}`;
const item = (over = {}) => ({ key: 'compra:7:1', type: 'compra', actor_id: 2, actor: 'Kieru', property_id: 7, label: 'Hotel Costanera', amount: 120000, ...over });

test('feedText: una frase por tipo', () => {
    assert.equal(feedText(item(), money), 'Kieru compró Hotel Costanera por $ 120000');
    assert.equal(feedText(item({ type: 'subasta_ganada' }), money), 'Kieru ganó la subasta de Hotel Costanera por $ 120000');
    assert.equal(feedText(item({ type: 'venta', amount: 600 }), money), 'Kieru vendió Hotel Costanera al banco por $ 600');
    assert.equal(feedText(item({ type: 'reclamo' }), money), 'Kieru reservó Hotel Costanera por $ 120000');
    assert.equal(feedText(item({ type: 'disputa' }), money), 'Kieru disputa Hotel Costanera y puja $ 120000');
    assert.equal(feedText(item({ type: 'oferta_abierta', amount: 8000 }), money), 'Kieru ofrece Hotel Costanera desde $ 8000');
    assert.equal(feedText(item({ type: 'oferta_vendida', other: 'Ana' }), money), 'Kieru le vendió Hotel Costanera a Ana por $ 120000');
    assert.equal(feedText(item({ type: 'oferta_vendida' }), money), 'Kieru le vendió Hotel Costanera a otro jugador por $ 120000');
});
test('feedText: sin nombre, sin etiqueta o monto raro no rompe', () => {
    assert.equal(feedText(item({ actor: undefined, label: '', amount: 'x' }), money), 'Alguien compró una propiedad por $ 0');
    assert.equal(feedText(item({ type: 'inventado' }), money), '');
});

test('shouldShow: solo tipos conocidos con lo básico', () => {
    const seen = new Set();
    assert.equal(shouldShow(item(), 1, seen), true);
    assert.equal(shouldShow(item({ type: 'inventado' }), 1, seen), false);
    assert.equal(shouldShow(item({ property_id: 'x' }), 1, seen), false);
    assert.equal(shouldShow(item({ key: '' }), 1, seen), false);
    assert.equal(shouldShow(null, 1, seen), false);
});
test('shouldShow: no muestra lo que hizo el propio jugador', () => {
    assert.equal(shouldShow(item({ actor_id: 1 }), 1, new Set()), false);
    assert.equal(shouldShow(item({ actor_id: 1 }), null, new Set()), true); // visitante: ve todo
});
test('shouldShow: no repite un aviso ya visto', () => {
    const seen = new Set();
    rememberKey(seen, 'compra:7:1');
    assert.equal(shouldShow(item(), 1, seen), false);
    assert.equal(shouldShow(item({ key: 'compra:7:2' }), 1, seen), true);
});

test('pushVisible: la más nueva al final y salen las más viejas', () => {
    let visible = [];
    const dropped = [];
    for (let i = 1; i <= MAX_VISIBLE + 2; i++) {
        const r = pushVisible(visible, { key: `k${i}` });
        visible = r.visible;
        dropped.push(...r.dropped.map((d) => d.key));
    }
    assert.deepEqual(visible.map((v) => v.key), ['k3', 'k4', 'k5']);
    assert.deepEqual(dropped, ['k1', 'k2']);
});
test('pushVisible: no modifica la lista original', () => {
    const base = [{ key: 'a' }];
    pushVisible(base, { key: 'b' });
    assert.equal(base.length, 1);
});

test('rememberKey: no crece sin límite y olvida las más viejas', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) rememberKey(seen, `k${i}`, 10);
    assert.equal(seen.size, 10);
    assert.equal(seen.has('k99'), true);
    assert.equal(seen.has('k0'), false);
});

test('cardStyle e isKnownType: tonos por tipo y desconocidos neutros', () => {
    assert.deepEqual(cardStyle('disputa'), { tag: 'Disputa', tone: 'red' });
    assert.equal(cardStyle('compra').tone, 'gold');
    assert.deepEqual(cardStyle('nada'), { tag: '', tone: 'grey' });
    assert.equal(isKnownType('venta'), true);
    assert.equal(isKnownType('toString'), false); // no hereda propiedades de Object
});
