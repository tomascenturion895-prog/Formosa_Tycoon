import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideState, STORAGE_KEY } from '../../resources/js/guides/guides-state.js';

const memory = (initial = {}) => {
    const data = { ...initial };
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
};
const g = (id, over = {}) => ({ id, place: 'lobby', version: 1, auto: true, ...over });

test('marca_y_lee', () => {
    const st = memory();
    const state = createGuideState(st);
    assert.equal(state.status(g('a')), 'new');
    state.mark(g('a'));
    assert.equal(state.status(g('a')), 'seen');
    assert.deepEqual(JSON.parse(st.data[STORAGE_KEY]), { a: 1 });
    assert.equal(createGuideState(st).status(g('a')), 'seen', 'sobrevive a una instancia nueva');
});

test('version_nueva_queda_actualizada', () => {
    const state = createGuideState(memory({ [STORAGE_KEY]: '{"a":1}' }));
    assert.equal(state.status(g('a', { version: 2 })), 'updated');
    state.mark(g('a', { version: 2 }));
    assert.equal(state.status(g('a', { version: 2 })), 'seen');
});

test('pendingAuto_devuelve_solo_auto_no_vistas_en_orden', () => {
    const state = createGuideState(memory({ [STORAGE_KEY]: '{"b":1}' }));
    const catalog = [g('a'), g('b'), g('c', { auto: false }), g('d', { place: 'sala' }), g('e')];
    const got = state.pendingAuto('lobby', { catalog });
    assert.deepEqual(got.map((x) => x.id), ['a', 'e']);
});

test('pendingAuto_respeta_available', () => {
    const state = createGuideState(memory());
    const catalog = [g('a', { available: () => false }), g('b')];
    assert.deepEqual(state.pendingAuto('lobby', { catalog }).map((x) => x.id), ['b']);
});

test('storage_que_lanza_no_rompe', () => {
    const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } };
    const state = createGuideState(boom);
    assert.equal(state.status(g('a')), 'new');
    assert.doesNotThrow(() => state.mark(g('a')));
    assert.equal(state.status(g('a')), 'seen', 'en la sesión queda marcada aunque no se pueda guardar');
});

for (const raw of ['abc', '[]', 'null', '{"x":"y"}', '{"x":1.5}', '{"x":-1}', '5']) {
    test(`contenido_corrupto_se_trata_como_vacio ${raw}`, () => {
        const state = createGuideState(memory({ [STORAGE_KEY]: raw }));
        assert.equal(state.status(g('x')), 'new');
        assert.doesNotThrow(() => state.mark(g('x')));
        assert.equal(state.status(g('x')), 'seen');
    });
}

test('sin_storage', () => {
    const state = createGuideState(null);
    assert.equal(state.status(g('a')), 'new');
    state.mark(g('a'));
    assert.equal(state.status(g('a')), 'seen');
});
