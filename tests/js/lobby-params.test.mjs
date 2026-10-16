import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLobbyParams, NOTICES } from '../../resources/js/lobby/params.js';

test('el código de la dirección se normaliza a mayúsculas', () => {
    assert.equal(parseLobbyParams('?codigo=abc123').code, 'ABC123');
    assert.equal(parseLobbyParams('?codigo=%20abc123%20').code, 'ABC123');
});

test('un código inválido se descarta', () => {
    assert.equal(parseLobbyParams('?codigo=a!').code, null);
    assert.equal(parseLobbyParams('?codigo=abc').code, null);
    assert.equal(parseLobbyParams('?codigo=' + 'A'.repeat(13)).code, null);
    assert.equal(parseLobbyParams('').code, null);
});

test('los avisos conocidos traen su texto y los desconocidos no', () => {
    assert.equal(parseLobbyParams('?aviso=sala').notice, NOTICES.sala);
    assert.equal(parseLobbyParams('?aviso=vencida').notice, NOTICES.vencida);
    assert.equal(parseLobbyParams('?aviso=ingresar').notice, NOTICES.ingresar);
    assert.equal(parseLobbyParams('?aviso=__proto__').notice, null);
    assert.equal(parseLobbyParams('?aviso=otra').notice, null);
});

test('los textos de aviso son oraciones completas', () => {
    for (const t of Object.values(NOTICES)) {
        assert.ok(t.length > 10 && t.endsWith('.'));
    }
});
