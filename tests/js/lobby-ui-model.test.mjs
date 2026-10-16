import test from 'node:test';
import assert from 'node:assert/strict';
import { initials, seats, seatLabel, skeletonCount } from '../../resources/js/lobby/lobby-ui-model.js';

test('iniciales: dos palabras dan dos letras en mayúscula', () => {
    assert.equal(initials('Ana Pérez'), 'AP');
    assert.equal(initials('  tomás   ignacio  centurion '), 'TI');
});

test('iniciales: una palabra da una o dos letras; vacío o raro da un signo neutro', () => {
    assert.equal(initials('Beto'), 'BE');
    assert.equal(initials('Z'), 'Z');
    assert.equal(initials(''), '?');
    assert.equal(initials(null), '?');
    assert.equal(initials('😀 Ana'), 'AN'); // el emoji se ignora
    assert.equal(initials('😀'), '?');
});

test('cupos: un punto por lugar, ocupados primero, nunca más que el cupo', () => {
    assert.deepEqual(seats(2, 4), [true, true, false, false]);
    assert.deepEqual(seats(0, 3), [false, false, false]);
    assert.deepEqual(seats(9, 3), [true, true, true]);
    assert.deepEqual(seats(-1, 2), [false, false]);
});

test('cupos: el texto para lectores de pantalla dice cuántos faltan', () => {
    assert.equal(seatLabel(2, 4), '2 de 4 jugadores, faltan 2');
    assert.equal(seatLabel(3, 4), '3 de 4 jugadores, falta 1');
    assert.equal(seatLabel(4, 4), '4 de 4 jugadores, sala llena');
});

test('skeleton: cantidad acotada', () => {
    assert.equal(skeletonCount(undefined), 3);
    assert.equal(skeletonCount(0), 1);
    assert.equal(skeletonCount(50), 6);
    assert.equal(skeletonCount(4), 4);
});
