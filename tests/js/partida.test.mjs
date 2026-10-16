import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MINUTE, serverOffset, formatCountdown, spokenCountdown, matchClock, dayLabel, crossedWarnings, warningLevel,
    standings, projectCash, paybackDays, paybackText, ago, lobbyExpiry,
} from '../../resources/js/map/partida.js';

const match = (over = {}) => ({ status: 'running', started_at: 1_000_000, ends_at: 1_000_000 + 40 * MINUTE, minutes_per_day: 2, days_total: 20, ...over });

test('formato de la cuenta regresiva', () => {
    assert.equal(formatCountdown(40 * MINUTE), '40:00');
    assert.equal(formatCountdown(39 * MINUTE + 5_000), '39:05');
    assert.equal(formatCountdown(59_001), '1:00');           // redondea hacia arriba: nunca muestra 0:00 con tiempo
    assert.equal(formatCountdown(1), '0:01');
    assert.equal(formatCountdown(0), '0:00');
    assert.equal(formatCountdown(-5_000), '0:00');
    assert.equal(formatCountdown(NaN), '0:00');
    assert.equal(formatCountdown(3_723_000), '1:02:03');
});

test('cuenta regresiva hablada para lectores de pantalla', () => {
    assert.equal(spokenCountdown(61_000), '1 minuto y 1 segundo');
    assert.equal(spokenCountdown(5 * MINUTE), '5 minutos');
    assert.equal(spokenCountdown(45_000), '45 segundos');
    assert.equal(spokenCountdown(0), '0 segundos');
});

test('corrección de deriva: el reloj local se alinea con server_now', () => {
    const local = 1_700_000_000_000;
    const offset = serverOffset(local + 90_000, local);       // el dispositivo atrasa 90 s
    assert.equal(offset, 90_000);
    assert.equal(local + offset, local + 90_000);
    assert.equal(serverOffset(undefined, local), 0);          // sin dato del servidor: sin corrección
    assert.equal(serverOffset(local - 5_000, local), -5_000); // dispositivo adelantado
});

test('reloj de partida: día N de 20 y tiempo restante', () => {
    const m = match();
    let c = matchClock(m, m.started_at);
    assert.equal(c.day, 1);
    assert.equal(c.gameDay, 0);
    assert.equal(c.remainingMs, 40 * MINUTE);
    assert.equal(dayLabel(c), 'Día 1/20');
    c = matchClock(m, m.started_at + 2 * MINUTE - 1);
    assert.equal(c.day, 1);
    c = matchClock(m, m.started_at + 2 * MINUTE);
    assert.equal(c.day, 2);
    assert.equal(c.gameDay, 1);
    c = matchClock(m, m.started_at + 39 * MINUTE);
    assert.equal(c.day, 20);
    assert.equal(c.remainingMs, MINUTE);
    assert.equal(c.running, true);
    assert.ok(Math.abs(c.progress - 39 / 40) < 1e-9);
});

test('reloj de partida: al vencer queda en el día 20, sin tiempo y terminada', () => {
    const m = match();
    const c = matchClock(m, m.ends_at + 50_000);
    assert.equal(c.over, true);
    assert.equal(c.running, false);
    assert.equal(c.remainingMs, 0);
    assert.equal(c.day, 20);
    assert.equal(c.gameDay, 20);
    assert.equal(matchClock(match({ status: 'finished' }), m.started_at + MINUTE).over, true);
});

test('reloj de partida: la sala (sin started_at) no tiene reloj', () => {
    const c = matchClock({ status: 'lobby', started_at: null, ends_at: null, minutes_per_day: 2, days_total: 20 }, 123);
    assert.equal(c.running, false);
    assert.equal(c.remainingMs, null);
    assert.equal(c.day, 0);
    assert.equal(c.daysTotal, 20);
});

test('avisos de los últimos 5 min y 1 min: se disparan una sola vez al cruzar el umbral', () => {
    assert.deepEqual(crossedWarnings(6 * MINUTE, 4 * MINUTE), ['cinco']);
    assert.deepEqual(crossedWarnings(4 * MINUTE, 3 * MINUTE), []);
    assert.deepEqual(crossedWarnings(70_000, 59_000), ['uno']);
    assert.deepEqual(crossedWarnings(6 * MINUTE, 30_000), ['cinco', 'uno']);   // la pestaña estuvo dormida
    assert.deepEqual(crossedWarnings(5 * MINUTE + 1, 5 * MINUTE), ['cinco']);
    assert.deepEqual(crossedWarnings(null, 100), []);
    assert.equal(warningLevel(10 * MINUTE), 'normal');
    assert.equal(warningLevel(5 * MINUTE), 'cinco');
    assert.equal(warningLevel(61_000), 'cinco');
    assert.equal(warningLevel(60_000), 'uno');
    assert.equal(warningLevel(0), 'uno');
    assert.equal(warningLevel(null), 'normal');
});

test('posiciones: patrimonio desc, luego propiedades, luego nombre', () => {
    const rows = standings([
        { user_id: 1, name: 'Zoe', net_worth: 50_000, properties: 1 },
        { user_id: 2, name: 'Ana', net_worth: 80_000, properties: 2 },
        { user_id: 3, name: 'Beto', net_worth: 50_000, properties: 3 },
    ], 1);
    assert.deepEqual(rows.map((r) => r.name), ['Ana', 'Beto', 'Zoe']);
    assert.deepEqual(rows.map((r) => r.position), [1, 2, 2]);   // Beto y Zoe empatan en patrimonio: mismo puesto
    assert.equal(rows.find((r) => r.name === 'Zoe').isMe, true);
    assert.equal(rows.find((r) => r.name === 'Ana').isMe, false);
});

test('posiciones: empate triple y puesto siguiente (1, 1, 3)', () => {
    const rows = standings([
        { user_id: 1, name: 'A', net_worth: 10, properties: 0 },
        { user_id: 2, name: 'B', net_worth: 10, properties: 0 },
        { user_id: 3, name: 'C', net_worth: 5, properties: 0 },
    ]);
    assert.deepEqual(rows.map((r) => r.position), [1, 1, 3]);
});

test('posiciones: quien abandonó va al final aunque tenga más patrimonio, y no empata', () => {
    const rows = standings([
        { user_id: 1, name: 'Fugado', net_worth: 99_000, properties: 5, abandoned: true },
        { user_id: 2, name: 'Ana', net_worth: 60_000, properties: 0 },
    ]);
    assert.deepEqual(rows.map((r) => r.name), ['Ana', 'Fugado']);
    assert.deepEqual(rows.map((r) => r.position), [1, 2]);
});

test('posiciones: no modifica la lista original y tolera vacío', () => {
    const src = [{ user_id: 1, name: 'A', net_worth: 1 }, { user_id: 2, name: 'B', net_worth: 2 }];
    standings(src);
    assert.equal(src[0].name, 'A');
    assert.deepEqual(standings([]), []);
    assert.deepEqual(standings(undefined), []);
});

test('efectivo proyectado: suma el ingreso por día de juego transcurrido', () => {
    const m = match();
    // 1.330 por día; pasan 30 s reales = 0,25 día de juego
    assert.equal(projectCash(44_332, 1_330, m.started_at, m.started_at + 30_000, m), 44_332 + Math.floor(1_330 * 0.25));
    assert.equal(projectCash(1_000, 0, 0, 10 * MINUTE, m), 1_000);
    assert.equal(projectCash(1_000, 500, 10, 5, m), 1_000);   // el tiempo no retrocede
});

test('efectivo proyectado: no pasa del fin de la partida', () => {
    const m = match();
    const atEnd = projectCash(0, 1_000, m.ends_at - 2 * MINUTE, m.ends_at, m);
    assert.equal(atEnd, 1_000);                                // un día de juego
    assert.equal(projectCash(0, 1_000, m.ends_at - 2 * MINUTE, m.ends_at + 10 * MINUTE, m), atEnd);
});

test('recupero en días de juego', () => {
    assert.equal(paybackDays(10_000, 1_330), 7.5);
    assert.equal(paybackDays(10_000, 0), null);
    assert.equal(paybackText(10_000, 1_330), '7,5 días de juego');
    assert.equal(paybackText(10_000, 10_000), '1 día de juego');
    assert.equal(paybackText(10_000, 0), '—');
});

test('tiempo transcurrido y vencimiento de la sala', () => {
    const now = 10 * 86_400_000;
    assert.equal(ago(now - 10_000, now), 'recién');
    assert.equal(ago(now - 5 * 60_000, now), 'hace 5 min');
    assert.equal(ago(now - 3 * 3_600_000, now), 'hace 3 h');
    assert.equal(ago(now - 86_400_000, now), 'ayer');
    assert.equal(ago(now - 3 * 86_400_000, now), 'hace 3 días');
    assert.equal(lobbyExpiry({ lobby_expires_at: 5_000 }, 2_000), 3_000);
    assert.equal(lobbyExpiry({ lobby_expires_at: 5_000 }, 9_000), 0);
    assert.equal(lobbyExpiry({ lobby_expires_at: null }, 1), null);
});
