import test from 'node:test';
import assert from 'node:assert/strict';
import { menuItems, GUIDES } from '../../resources/js/guides/guides-model.js';
import { createGuideState, STORAGE_KEY } from '../../resources/js/guides/guides-state.js';

const cfg = { match: { durationMinutes: 40 }, economy: {}, auction: {}, combos: {} };
const ctx = { cfg, user: { id: 1 } };
const memory = (initial = {}) => ({ getItem: (k) => initial[k] ?? null, setItem: (k, v) => { initial[k] = v; } });

test('respeta_el_orden_y_el_lugar', () => {
    const items = menuItems('lobby', createGuideState(memory()), ctx);
    assert.deepEqual(items.map((i) => i.id), GUIDES.filter((g) => g.place === 'lobby').map((g) => g.id));
    assert.ok(items.every((i) => i.title && i.summary));
    assert.deepEqual(menuItems('no-hay', createGuideState(memory()), ctx), []);
});

test('etiqueta_nuevo_actualizada_y_vista', () => {
    const first = GUIDES.find((g) => g.place === 'lobby');
    const state = createGuideState(memory({ [STORAGE_KEY]: JSON.stringify({ [first.id]: first.version }) }));
    const items = menuItems('lobby', state, ctx);
    assert.equal(items[0].status, 'seen');
    assert.ok(items.slice(1).every((i) => i.status === 'new'));
    const old = createGuideState(memory({ [STORAGE_KEY]: JSON.stringify({ [first.id]: first.version - 1 || 1 }) }));
    // una versión anterior a la actual figura como actualizada (si la guía está en v1 se simula con una versión mayor al catálogo)
    const bumped = { ...first, version: first.version + 1 };
    assert.equal(old.status(bumped), 'updated');
});
