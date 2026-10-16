import test from 'node:test';
import assert from 'node:assert/strict';
import { pctText, activeText, nextText, hudLines, stateKey, whatsNew, changeAt, propertyNote } from '../../resources/js/map/events-model.js';

const DAY = 120000;
const feria = { key: 'feria', label: 'Feria en el centro', kind: 'comercio', pct: 0.3, start: 1000 * DAY, end: 1003 * DAY };
const crisis = { key: 'crisis', label: 'Crisis de alquileres', kind: 'casa', pct: -0.2, start: 1010 * DAY, end: 1013 * DAY };

test('pctText muestra signo', () => {
    assert.equal(pctText(0.3), '+30 %');
    assert.equal(pctText(-0.2), '−20 %');
});

test('activeText y nextText cuentan los días que faltan', () => {
    assert.equal(activeText(feria, 1000 * DAY, DAY), 'Feria en el centro: los comercios rinden +30 %. Quedan 3 días.');
    assert.match(activeText(feria, 1002.5 * DAY, DAY), /Quedan menos de 1 día/);
    assert.match(nextText(crisis, 1009.4 * DAY, DAY), /Próximo: Crisis de alquileres \(las casas −20 %\) en menos de 1 día/);
});

test('hudLines: activos primero, luego el anunciado', () => {
    const lines = hudLines({ active: [feria], next: crisis }, 1001 * DAY, DAY);
    assert.deepEqual(lines.map((l) => l.kind), ['active', 'next']);
    assert.deepEqual(hudLines(null, 0, DAY), []);
    assert.deepEqual(hudLines({ active: [], next: null }, 0, DAY), []);
});

test('stateKey y whatsNew detectan lo que empezó y lo anunciado', () => {
    const a = { active: [], next: crisis };
    const b = { active: [crisis], next: null };
    assert.equal(stateKey(a), 'n:crisis');
    assert.equal(stateKey(b), 'a:crisis');
    assert.deepEqual(whatsNew(null, a), { started: [], announced: crisis });
    assert.deepEqual(whatsNew(a, b), { started: [crisis], announced: null });
    assert.deepEqual(whatsNew(b, b), { started: [], announced: null });
});

test('changeAt: el más cercano entre fin de activo e inicio de anunciado', () => {
    assert.equal(changeAt({ active: [feria], next: crisis }), feria.end);
    assert.equal(changeAt({ active: [], next: crisis }), crisis.start);
    assert.equal(changeAt({ active: [], next: null }), null);
    assert.equal(changeAt(undefined), null);
});

test('propertyNote: solo para el tipo afectado', () => {
    const ev = { active: [feria], next: crisis };
    assert.match(propertyNote(ev, 'comercio', 1001 * DAY, DAY), /Evento activo: Feria en el centro.*\+30 %/);
    assert.match(propertyNote(ev, 'casa', 1009.5 * DAY, DAY), /Se viene: Crisis de alquileres.*−20 %/);
    assert.equal(propertyNote(ev, 'hotel', 1001 * DAY, DAY), '');
    assert.equal(propertyNote(null, 'hotel', 0, DAY), '');
});

// ---- eventos por zona y sprint final
import { isSprint, minSec, sprintMult, inZone, zoneFeatures } from '../../resources/js/map/events-model.js';

const zonal = { key: 'feria', label: 'Feria', kind: 'comercio', pct: 0.3, zone: '1:2', bounds: [10, 20, 11, 21], start: 0, end: 5 * DAY };
const sprint = { key: 'sprint', label: 'Sprint final', kind: null, pct: 1, zone: null, bounds: null, start: 0, end: 300000 };

test('el sprint se cuenta en minutos y segundos y dice cuánto rinde', () => {
    assert.equal(isSprint(sprint), true);
    assert.equal(minSec(299000), '4:59');
    assert.equal(minSec(0), '0:00');
    assert.equal(sprintMult(1), 'x2');
    assert.equal(sprintMult(0.5), '+50 %');
    assert.equal(activeText(sprint, 1000, DAY), 'Sprint final: todo rinde x2. Quedan 4:59.');
});

test('un evento de zona lo dice en el texto', () => {
    assert.match(activeText(zonal, 0, DAY), /Feria: los comercios de la zona marcada rinden \+30 %/);
    assert.match(nextText(zonal, 0, DAY), /Próximo: Feria \(los comercios de la zona marcada \+30 %\)/);
});

test('inZone: dentro, fuera, sin zona y sin posición', () => {
    assert.equal(inZone(zonal, [10.5, 20.5]), true);
    assert.equal(inZone(zonal, [11.5, 20.5]), false);
    assert.equal(inZone(zonal, null), false);
    assert.equal(inZone(sprint, null), true);
});

test('propertyNote respeta la zona y no repite el sprint', () => {
    const ev = { active: [zonal, sprint], next: null };
    assert.match(propertyNote(ev, 'comercio', 0, DAY, [10.5, 20.5]), /Feria/);
    assert.equal(propertyNote(ev, 'comercio', 0, DAY, [50, 50]), '');
    assert.equal(propertyNote(ev, 'casa', 0, DAY, [10.5, 20.5]), '');
});

test('zoneFeatures: un recuadro por evento con zona y colores por tipo', () => {
    const fc = zoneFeatures({ active: [zonal, sprint, { ...zonal, key: 'crisis', pct: -0.2 }], next: { ...zonal, key: 'boom', pct: 0.25 } });
    assert.deepEqual(fc.features.map((f) => [f.properties.key, f.properties.color]), [['feria', '#2f9e44'], ['crisis', '#e03131'], ['boom', '#1c7ed6']]);
    assert.deepEqual(fc.features[0].geometry.coordinates[0][0], [10, 20]);
    assert.equal(zoneFeatures(null).features.length, 0);
});
