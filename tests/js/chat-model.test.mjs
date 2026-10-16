import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TABS, createFeed, isSystem, isOwn, countsAsUnread, badgeText, tabLabel, toggleLabel, totalUnread, pickTab, stepTab,
    roomTransition, composerText, chatErrorText,
} from '../../resources/js/map/chat-model.js';

const user = (id, uid = 7, body = 'hola') => ({ id, kind: 'usuario', match_id: null, user_id: uid, user: 'Ana', body, at: 1 });
const sys = (id, body = 'Ana compró una casa por $10.000') => ({ id, kind: 'sistema', match_id: 5, user_id: null, user: null, body, at: 1 });

test('el canal ordena por número, no repite y avisa si llegó fuera de orden', () => {
    const f = createFeed();
    assert.equal(f.add(user(10)), 'nuevo');
    assert.equal(f.add(user(12)), 'nuevo');
    assert.equal(f.add(user(10)), 'repetido');
    assert.equal(f.add(user(11)), 'tarde');
    assert.deepEqual(f.sorted().map((m) => m.id), [10, 11, 12]);
    assert.equal(f.lastId(), 12);
    assert.equal(f.size, 3);
});

test('mensajes inválidos no entran', () => {
    const f = createFeed();
    for (const bad of [null, undefined, {}, { id: 'x' }, { id: 1.5 }, { id: 0 }, { id: -3 }, { id: NaN }]) {
        assert.equal(f.add(bad), 'invalido');
    }
    assert.equal(f.size, 0);
});

test('el tope saca los más viejos y quitar uno lo borra', () => {
    const f = createFeed(3);
    [1, 2, 3, 4, 5].forEach((i) => f.add(user(i)));
    assert.deepEqual(f.trim(), [1, 2]);
    assert.deepEqual(f.sorted().map((m) => m.id), [3, 4, 5]);
    assert.equal(f.remove(4), true);
    assert.equal(f.remove(4), false);
    assert.deepEqual(f.sorted().map((m) => m.id), [3, 5]);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f.lastId(), 0);
});

test('dos canales no comparten estado', () => {
    const sala = createFeed();
    const global = createFeed();
    sala.add(user(1));
    assert.equal(global.size, 0);
    assert.equal(global.add(user(1)), 'nuevo'); // el mismo número en otro canal no es repetido: son listas distintas
});

test('los avisos del juego no tienen autor y no son "míos"', () => {
    assert.equal(isSystem(sys(1)), true);
    assert.equal(isSystem(user(1)), false);
    assert.equal(isOwn(user(1, 7), 7), true);
    assert.equal(isOwn(user(1, 8), 7), false);
    assert.equal(isOwn(sys(1), 7), false);
    assert.equal(isOwn(user(1, 7), null), false);
});

test('no leídos: solo mensajes ajenos de personas y solo si no se están mirando', () => {
    const base = { userId: 7, open: true, tabActive: true, hidden: false };
    assert.equal(countsAsUnread(user(1, 8), base), false);                        // lo estoy viendo
    assert.equal(countsAsUnread(user(1, 8), { ...base, open: false }), true);      // chat cerrado
    assert.equal(countsAsUnread(user(1, 8), { ...base, tabActive: false }), true); // estoy en la otra pestaña
    assert.equal(countsAsUnread(user(1, 8), { ...base, hidden: true }), true);     // ventana oculta
    assert.equal(countsAsUnread(user(1, 7), { ...base, open: false }), false);     // el mío
    assert.equal(countsAsUnread(sys(1), { ...base, open: false }), false);         // un aviso del juego no suma
    assert.equal(countsAsUnread(null, base), false);
});

test('insignias y nombres accesibles', () => {
    assert.equal(badgeText(0), '');
    assert.equal(badgeText(3), '3');
    assert.equal(badgeText(99), '99');
    assert.equal(badgeText(100), '99+');
    assert.equal(badgeText(-4), '');
    assert.equal(badgeText('x'), '');
    assert.equal(tabLabel('sala', 0), 'Sala');
    assert.equal(tabLabel('sala', 1), 'Sala, 1 mensaje sin leer');
    assert.equal(tabLabel('global', 5), 'Global, 5 mensajes sin leer');
    assert.equal(toggleLabel({ sala: 0, global: 0 }), 'Chat');
    assert.equal(toggleLabel({ sala: 1, global: 0 }), 'Chat, 1 mensaje sin leer');
    assert.equal(toggleLabel({ sala: 2, global: 3 }), 'Chat, 5 mensajes sin leer');
    assert.equal(totalUnread({ sala: 2, global: 3 }), 5);
    assert.equal(totalUnread(null), 0);
});

test('pestaña activa: sin sala solo Global; con sala, la recordada o Sala', () => {
    assert.equal(pickTab({ saved: 'sala', hasRoom: false }), 'global');
    assert.equal(pickTab({ saved: null, hasRoom: false }), 'global');
    assert.equal(pickTab({ saved: null, hasRoom: true }), 'sala');
    assert.equal(pickTab({ saved: 'global', hasRoom: true }), 'global');
    assert.equal(pickTab({ saved: 'sala', hasRoom: true }), 'sala');
    assert.equal(pickTab({ saved: 'otra-cosa', hasRoom: true }), 'sala');
    assert.deepEqual(TABS, ['sala', 'global']);
});

test('flechas entre pestañas: circular y solo entre las disponibles', () => {
    assert.equal(stepTab('sala', 1, ['sala', 'global']), 'global');
    assert.equal(stepTab('global', 1, ['sala', 'global']), 'sala');
    assert.equal(stepTab('sala', -1, ['sala', 'global']), 'global');
    assert.equal(stepTab('global', 1, ['global']), 'global');
    assert.equal(stepTab('global', -1, []), 'global');
});

test('la sala acompaña a mi partida: se abre, cambia, queda en solo lectura o se cierra', () => {
    const lobby = { id: 5, status: 'lobby' };
    const running = { id: 5, status: 'running' };
    assert.equal(roomTransition(null, null).action, 'nada');
    assert.deepEqual(roomTransition(lobby, null), { action: 'abrir', id: 5, status: 'lobby' });
    assert.equal(roomTransition(running, { id: 5, status: 'lobby' }).action, 'nada');             // empezó la partida: misma sala
    assert.equal(roomTransition({ id: 6, status: 'lobby' }, { id: 5, status: 'running' }).action, 'cambiar');
    // Terminó o abandoné una partida EN JUEGO: queda para leer.
    assert.deepEqual(roomTransition(null, { id: 5, status: 'running' }), { action: 'solo-lectura', id: 5, status: 'finished' });
    assert.equal(roomTransition({ id: 5, status: 'finished' }, { id: 5, status: 'running' }).action, 'solo-lectura');
    assert.equal(roomTransition(null, { id: 5, status: 'finished', readonly: true }).action, 'nada');
    // Salí de la sala de espera, o venció: ya no soy de ese chat.
    assert.equal(roomTransition(null, { id: 5, status: 'lobby' }).action, 'cerrar');
    assert.equal(roomTransition({ id: 5, status: 'expired' }, { id: 5, status: 'lobby' }).action, 'cerrar');
});

test('el campo de escribir depende del canal y de si se puede', () => {
    assert.equal(composerText('sala', { writable: true }).disabled, false);
    assert.match(composerText('sala', { writable: true }).placeholder, /sala/);
    assert.equal(composerText('sala', { writable: false }).disabled, true);
    assert.match(composerText('sala', { writable: false }).placeholder, /solo lectura/);
    assert.equal(composerText('global', { writable: false }).disabled, false);   // el global siempre se puede (si hay sesión)
    assert.match(composerText('global').placeholder, /global/);
    assert.equal(composerText('global', { loggedIn: false }).disabled, true);
});

test('errores del chat en castellano', () => {
    assert.match(chatErrorText(null), /conexión/);
    assert.match(chatErrorText({ status: 429, data: {} }), /muy rápido/);
    assert.match(chatErrorText({ status: 403, data: {} }), /permiso/);
    assert.match(chatErrorText({ status: 409, data: { error: 'sala_solo_lectura' } }), /solo para leer/);
    assert.match(chatErrorText({ status: 403, data: { error: 'no_estas_en_partida' } }), /Ya no sos parte/);
    assert.match(chatErrorText({ status: 403, data: { error: 'silenciado', hasta: 1_700_000_000_000 } }, () => '12:30'), /silenció.*12:30/);
    assert.equal(chatErrorText({ status: 422, data: { errors: { mensaje: ['Muy largo'] } } }), 'Muy largo');
    assert.equal(chatErrorText({ status: 429, data: { error: 'mensaje_repetido', message: 'Ya dijiste eso.' } }), 'Ya dijiste eso.');
});
