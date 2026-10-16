import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneKey, zonePct, nextTier, zoneHint, comboLines } from '../../resources/js/map/combos.js';

const rules = { zoneDeg: 0.0025, zoneTiers: { 3: 0.1, 5: 0.2, 8: 0.3 }, variety: 0.1 };

test('zoneKey da lo mismo que Combos::zoneKey de PHP (mismos valores calculados allá)', () => {
    assert.equal(zoneKey(-26.18, -58.17, 0.0025), '-10472:-23268');
    assert.equal(zoneKey(-26.1801, -58.1725, 0.0025), '-10473:-23269');
    assert.equal(zoneKey(-26.1799, -58.1699, 0.0025), '-10472:-23268');
});

test('zonePct y nextTier siguen los escalones', () => {
    assert.equal(zonePct(2, rules.zoneTiers), 0);
    assert.equal(zonePct(3, rules.zoneTiers), 0.1);
    assert.equal(zonePct(7, rules.zoneTiers), 0.2);
    assert.equal(zonePct(9, rules.zoneTiers), 0.3);
    assert.deepEqual(nextTier(3, rules.zoneTiers), { need: 5, pct: 0.2 });
    assert.equal(nextTier(8, rules.zoneTiers), null);
});

const at = { lat: -26.18, lng: -58.17 };
const near = (n) => Array.from({ length: n }, () => ({ lat: -26.1799, lng: -58.1699 }));

test('zoneHint: libre, cuenta la propiedad que se mira', () => {
    assert.match(zoneHint(at, near(2), false, rules), /Con esta tendrías 3 en la zona: todas rendirían \+10 %/);
    assert.match(zoneHint(at, near(0), false, rules), /con 3 propiedades juntas.*Tenés 0/);
});

test('zoneHint: propia, no se cuenta dos veces', () => {
    assert.match(zoneHint(at, near(3), true, rules), /tenés 3 en esta zona y todas rinden \+10 %.*Con 5 suben a \+20 %/);
    assert.match(zoneHint(at, near(1), true, rules), /Tenés 1 en esta zona. Con 3/);
});

test('zoneHint: sin reglas no dice nada', () => {
    assert.equal(zoneHint(at, near(3), true, undefined), '');
});

const money = (n) => `$ ${n}`;
test('comboLines: zonas, variedad completa o lo que falta', () => {
    const c = { zones: [{ bonus: 300, ids: [1, 2, 3], pct: 0.1 }], variety: false, variety_bonus: 0 };
    const l = comboLines(c, new Set(['casa', 'comercio']), rules, money);
    assert.equal(l[0], '1 zona con combo: +$ 300 por día.');
    assert.match(l[1], /Variedad: si sumás los tipos que faltan \(supermercado, hotel\).*\+10 %/);
    assert.match(comboLines({ zones: [], variety: true, variety_bonus: 500 }, new Set(), rules, money)[0], /Variedad completa.*\+\$ 500/);
    assert.deepEqual(comboLines(null, new Set(), rules, money), []);
});
