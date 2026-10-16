import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STEP_DEFS, LOAD_STEPS, LOAD_STEPS_GUEST, CITY_STEPS, createProgress, TIPS, pickTips, tipAt, introMode, sceneVariant, matchNote, enterLabel, progressText,
} from '../../resources/js/map/intro-model.js';

test('progreso: empieza en 0, cada paso suma su peso y termina en 1', () => {
    const p = createProgress(LOAD_STEPS);
    assert.equal(p.value(), 0);
    assert.equal(p.complete(), false);
    const total = LOAD_STEPS.reduce((s, id) => s + STEP_DEFS[id].w, 0);
    p.done('mapa');
    assert.ok(Math.abs(p.value() - STEP_DEFS.mapa.w / total) < 1e-9);
    p.done('propiedades');
    assert.ok(Math.abs(p.value() - (STEP_DEFS.mapa.w + STEP_DEFS.propiedades.w) / total) < 1e-9);
    for (const id of LOAD_STEPS) p.done(id);
    assert.equal(p.value(), 1);
    assert.equal(p.complete(), true);
});

test('progreso: ponderado (propiedades pesa más que calles) y nunca retrocede', () => {
    const p = createProgress(LOAD_STEPS);
    p.done('calles');
    const a = p.value();
    const q = createProgress(LOAD_STEPS);
    q.done('propiedades');
    assert.ok(q.value() > a, 'un paso de más peso adelanta más la barra');
    p.set('propiedades', 0.5);
    const b = p.value();
    p.set('propiedades', 0.2); // un valor menor no baja
    assert.equal(p.value(), b);
    p.done('mapa'); p.done('mapa'); // repetir un paso no suma dos veces
    const total = LOAD_STEPS.reduce((s, id) => s + STEP_DEFS[id].w, 0);
    assert.ok(Math.abs(p.value() - (STEP_DEFS.calles.w + STEP_DEFS.propiedades.w * 0.5 + STEP_DEFS.mapa.w) / total) < 1e-9);
});

test('progreso: un visitante no espera los pasos de la partida y llega a 1 igual', () => {
    const p = createProgress(LOAD_STEPS_GUEST);
    assert.deepEqual(p.ids(), ['mapa', 'propiedades', 'calles', 'dibujo']);
    for (const id of LOAD_STEPS_GUEST) p.done(id);
    assert.equal(p.value(), 1);
    p.done('partida'); // un paso que no se espera se ignora
    assert.equal(p.value(), 1);
});

test('progreso: la etiqueta es la del primer paso pendiente', () => {
    const p = createProgress(LOAD_STEPS);
    assert.equal(p.label(), 'Armando el mapa…');
    p.done('mapa');
    assert.equal(p.label(), 'Leyendo las propiedades…');
    for (const id of LOAD_STEPS) p.done(id);
    assert.equal(p.label(), 'Todo listo');
    assert.deepEqual(createProgress(CITY_STEPS).pending(), CITY_STEPS);
});

test('progreso: valores fuera de rango o raros se acotan', () => {
    const p = createProgress(['mapa', 'calles']);
    p.set('mapa', 7);
    p.set('calles', -3);
    assert.ok(p.value() > 0 && p.value() < 1);
    p.set('calles', 'x');
    assert.ok(Number.isFinite(p.value()));
});

test('tips: misma semilla, mismo orden; otra semilla, otro orden; sin repetir', () => {
    const a = pickTips('7:2026-10-15');
    const b = pickTips('7:2026-10-15');
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, TIPS.length);
    const c = pickTips('8:2026-10-15');
    assert.notDeepEqual(a, c);
    assert.deepEqual([...a].sort(), [...TIPS].sort());
});

test('tips: el conteo se acota y la rotación da la vuelta', () => {
    assert.equal(pickTips('x', 3).length, 3);
    assert.equal(pickTips('x', 0).length, 1);
    assert.equal(pickTips('x', 999).length, TIPS.length);
    const list = pickTips('x', 3);
    assert.equal(tipAt(list, 3), list[0]);
    assert.equal(tipAt(list, -1), list[2]);
});

test('tips: hablan de la estrategia real del juego (días de 2 minutos, subastas, patrimonio)', () => {
    const all = TIPS.join(' ');
    assert.match(all, /2 minutos/);
    assert.match(all, /subasta/i);
    assert.match(all, /patrimonio/i);
    for (const t of TIPS) assert.ok(t.length > 30 && t.length < 190, t);
});

test('modo: automatización o moderación = ninguna; ya vista o recarga = corta; si no, completa', () => {
    assert.equal(introMode({}), 'full');
    assert.equal(introMode({ webdriver: true }), 'none');
    assert.equal(introMode({ hasPropertyParam: true }), 'none');
    assert.equal(introMode({ seen: true }), 'short');
    assert.equal(introMode({ warm: true }), 'short');
    assert.equal(introMode({ param: '0', seen: false }), 'none');
    assert.equal(introMode({ param: '1', webdriver: true, seen: true }), 'full');
    assert.equal(introMode({ param: 'corta', webdriver: true }), 'short');
});

test('variante de la escena: atardecer de 16 a 20, sol saliendo el resto del día', () => {
    assert.equal(sceneVariant(9), 'amanecer');
    assert.equal(sceneVariant(15.9), 'amanecer');
    assert.equal(sceneVariant(16), 'atardecer');
    assert.equal(sceneVariant(19.5), 'atardecer');
    assert.equal(sceneVariant(20), 'amanecer');
    assert.equal(sceneVariant(NaN), 'amanecer');
});

test('textos: partida en curso, sala y botón de entrada', () => {
    assert.equal(matchNote({ status: 'running' }, '23:10'), 'Tu partida: 23:10 restantes');
    assert.equal(matchNote({ status: 'lobby', name: 'Sala de Ana' }, ''), 'Tu sala te espera: Sala de Ana');
    assert.equal(matchNote({ status: 'lobby' }, ''), 'Tu sala te espera');
    assert.equal(matchNote(null, ''), '');
    assert.equal(matchNote({ status: 'finished' }, ''), '');
    assert.equal(enterLabel({ status: 'running' }), 'Volver a la partida');
    assert.equal(enterLabel({ status: 'lobby' }), 'Volver a la sala');
    assert.equal(enterLabel(null), 'Tocá para jugar');
    assert.equal(progressText('Armando el mapa…', 0.426), 'Armando el mapa… 43 %');
    assert.equal(progressText('x', 7), 'x 100 %');
});
