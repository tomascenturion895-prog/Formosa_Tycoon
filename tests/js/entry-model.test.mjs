import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntry, destinationAfter } from '../../resources/js/map/entry-model.js';

const user = { id: 1, name: 'Ana' };
const none = { match: null, last_finished_match_id: null };
const active = (code, status = 'lobby') => ({ match: { id: 7, code, status }, last_finished_match_id: null });

test('explorar siempre se queda', () => {
    assert.deepEqual(resolveEntry({ page: 'explorar', code: null, user: null, current: null }), { action: 'stay' });
    assert.deepEqual(resolveEntry({ page: 'explorar', code: null, user, current: none }), { action: 'stay' });
});

test('el visitante va al lobby con el código cargado y el aviso de ingresar', () => {
    assert.deepEqual(resolveEntry({ page: 'partida', code: 'ABC123', user: null, current: null }), { action: 'redirect', url: '/mapa?codigo=ABC123&aviso=ingresar' });
});

test('mi sala o mi partida en juego se quedan', () => {
    assert.equal(resolveEntry({ page: 'partida', code: 'ABC123', user, current: active('ABC123', 'lobby') }).action, 'stay');
    assert.equal(resolveEntry({ page: 'partida', code: 'ABC123', user, current: active('ABC123', 'running') }).action, 'stay');
});

test('si mi partida es otra, me lleva a su dirección', () => {
    assert.deepEqual(resolveEntry({ page: 'partida', code: 'ZZZ999', user, current: active('ABC123') }), { action: 'redirect', url: '/partida/ABC123' });
});

test('el código en minúsculas o con espacios es el mismo', () => {
    assert.equal(resolveEntry({ page: 'partida', code: ' abc123 ', user, current: active('ABC123') }).action, 'stay');
    assert.equal(resolveEntry({ page: 'partida', code: 'abc123', user, current: active('abc123') }).action, 'stay');
    assert.equal(resolveEntry({ page: 'partida', code: 'abc123', user: null, current: null }).url, '/mapa?codigo=ABC123&aviso=ingresar');
});

test('sin partida activa pero con una terminada, pide comprobar si es esa', () => {
    assert.deepEqual(resolveEntry({ page: 'partida', code: 'ABC123', user, current: { match: null, last_finished_match_id: 41 } }), { action: 'check-finished', finishedId: 41 });
});

test('una sala ajena o inexistente va al lobby con el aviso de sala', () => {
    assert.deepEqual(resolveEntry({ page: 'partida', code: 'ABC123', user, current: none }), { action: 'redirect', url: '/mapa?codigo=ABC123&aviso=sala' });
    // sin lectura del estado (error de red) tampoco se rompe: se manda al lobby
    assert.equal(resolveEntry({ page: 'partida', code: 'ABC123', user, current: null }).action, 'redirect');
});

test('un código raro se escapa en la dirección', () => {
    assert.equal(resolveEntry({ page: 'partida', code: 'a&b=c', user, current: none }).url, '/mapa?codigo=A%26B%3DC&aviso=sala');
});

test('destinos al salir, abandonar, jugar otra vez o vencer la sala', () => {
    assert.equal(destinationAfter('left'), '/mapa');
    assert.equal(destinationAfter('abandoned'), '/mapa');
    assert.equal(destinationAfter('again'), '/mapa');
    assert.equal(destinationAfter('expired'), '/mapa?aviso=vencida');
    assert.equal(destinationAfter('algo-raro'), '/mapa');
});
