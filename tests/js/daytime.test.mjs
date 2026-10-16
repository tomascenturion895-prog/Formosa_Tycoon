import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameHours, phaseAt, hhmm, lightAt, tintHex, EXPLORE_MINUTES_PER_DAY } from '../../resources/js/map/daytime.js';

const MIN = 60_000;

test('24 minutos reales son un día completo de juego', () => {
    assert.equal(gameHours(0), 0);
    assert.equal(gameHours(1 * MIN), 1);           // 1 minuto real = 1 hora de juego
    assert.equal(gameHours(1000), 1 / 60);          // 1 segundo real = 1 minuto de juego
    assert.equal(gameHours(24 * MIN), 0);           // vuelve a empezar
    assert.equal(gameHours(25.5 * MIN), 1.5);
});

test('la duración del día se puede configurar', () => {
    assert.equal(gameHours(30 * MIN, 60), 12);      // con días de 60 minutos, a la media hora es mediodía
});

test('nunca da horas negativas (relojes antes de 1970 o desfasados)', () => {
    const h = gameHours(-5 * MIN);
    assert.ok(h >= 0 && h < 24);
    assert.equal(h, 19);
});

test('franjas: madrugada, día, tarde y noche', () => {
    assert.equal(phaseAt(0).key, 'madrugada');
    assert.equal(phaseAt(5.99).key, 'madrugada');
    assert.equal(phaseAt(6).key, 'dia');
    assert.equal(phaseAt(12.99).key, 'dia');
    assert.equal(phaseAt(13).key, 'tarde');
    assert.equal(phaseAt(19.99).key, 'tarde');
    assert.equal(phaseAt(20).key, 'noche');
    assert.equal(phaseAt(23.99).key, 'noche');
});

test('hora en formato 24 h', () => {
    assert.equal(hhmm(0), '00:00');
    assert.equal(hhmm(7 + 5 / 60), '07:05');
    assert.equal(hhmm(23.999), '23:59');
});

test('mediodía: sol alto, sin luces, colores normales', () => {
    const l = lightAt(13);
    assert.ok(l.sun.elevation > 0.95);
    assert.ok(l.night < 0.01);
    assert.ok(l.lights < 0.01);
    assert.deepEqual(l.tint.map((v) => Math.round(v * 100)), [100, 100, 100]);
});

test('medianoche: noche cerrada, luces encendidas, todo azulado y oscuro', () => {
    const l = lightAt(0.5);
    assert.ok(l.sun.elevation < -0.5);
    assert.ok(l.night > 0.99);
    assert.ok(l.lights > 0.99);
    assert.ok(l.tint[2] > l.tint[0], 'tinte azul');
    assert.ok(l.tint[0] < 0.5);
});

test('atardecer: luz cálida y las luces se van prendiendo', () => {
    const l = lightAt(19.4);
    assert.ok(l.warm > 0.5);
    assert.ok(l.tint[0] > l.tint[2], 'tinte cálido');
    assert.ok(l.lights > 0.3);
});

test('la luz cambia de forma continua (sin saltos bruscos minuto a minuto)', () => {
    let prev = lightAt(0);
    for (let m = 1; m < 1440; m++) {
        const cur = lightAt(m / 60);
        assert.ok(Math.abs(cur.night - prev.night) < 0.05, `salto de noche a las ${hhmm(m / 60)}`);
        assert.ok(Math.abs(cur.tint[0] - prev.tint[0]) < 0.05, `salto de color a las ${hhmm(m / 60)}`);
        prev = cur;
    }
});

test('el sol sale por el este y se pone por el oeste', () => {
    assert.ok(Math.abs(lightAt(6.6).sun.azimuth - Math.PI / 2) < 0.05);
    assert.ok(Math.abs(lightAt(19.4).sun.azimuth - (3 * Math.PI) / 2) < 0.05);
});

test('tinte de colores', () => {
    assert.equal(tintHex('#ffffff', [1, 1, 1]), '#ffffff');
    assert.equal(tintHex('#ffffff', [0.5, 0.5, 0.5]), '#808080');
    assert.equal(tintHex('#204080', [2, 2, 2]), '#4080ff');
});

// ---- Reloj de partida (2 min = 1 día de juego) y modo exploración
import { matchHours, cityHours, START_HOUR } from '../../resources/js/map/daytime.js';

test('partida: arranca al amanecer y 2 minutos reales son un día de juego', () => {
    const t0 = 1_000_000_000_000;
    assert.equal(START_HOUR, 6);
    assert.equal(matchHours(t0, t0, 2), 6);
    assert.equal(matchHours(t0 + 30_000, t0, 2), 12);        // 30 s = un cuarto de día = +6 h
    assert.equal(matchHours(t0 + 60_000, t0, 2), 18);
    assert.equal(matchHours(t0 + 90_000, t0, 2), 0);         // medianoche
    assert.equal(matchHours(t0 + 2 * MIN, t0, 2), 6);        // dio la vuelta: amanecer del día 2
    assert.equal(matchHours(t0 + 40 * MIN - 1, t0, 2) < 6.01, true);
});

test('partida: con el reloj del servidor adelantado o antes del inicio queda en la hora de arranque', () => {
    const t0 = 5_000_000;
    assert.equal(matchHours(t0 - 10_000, t0, 2), 6);
    assert.ok(matchHours(t0 + 12_345, t0, 2) >= 0 && matchHours(t0 + 12_345, t0, 2) < 24);
});

test('partida: otro largo de día de juego', () => {
    assert.equal(matchHours(60_000, 0, 4), 12);              // día de 4 min: al minuto va un cuarto -> 6 + 6
});

test('cityHours: usa la partida si hay una iniciada; si no, el ciclo lento de exploración', () => {
    const now = 7 * MIN;
    assert.equal(cityHours(now, null), gameHours(now, 24));
    assert.equal(cityHours(now, { started_at: null, minutes_per_day: 2 }), gameHours(now, 24));  // sala: todavía no hay reloj
    assert.equal(cityHours(now, { started_at: now - 30_000, minutes_per_day: 2 }), 12);
    assert.equal(cityHours(now, undefined, 12), gameHours(now, 12));
});

test('cityHours: la hora de la partida no depende de la hora absoluta del servidor', () => {
    const a = cityHours(3 * MIN + 10_000, { started_at: 3 * MIN, minutes_per_day: 2 });
    const b = cityHours(99 * MIN + 10_000, { started_at: 99 * MIN, minutes_per_day: 2 });
    assert.equal(a, b);
});

test('exploración: el ciclo lento es de 24 minutos por día (1 minuto real = 1 hora de la ciudad), no el de la partida', () => {
    assert.equal(EXPLORE_MINUTES_PER_DAY, 24);
    assert.equal(cityHours(0, null), 0);
    assert.equal(cityHours(60_000, null), 1);
    assert.equal(cityHours(12 * 60_000, null), 12);
});
