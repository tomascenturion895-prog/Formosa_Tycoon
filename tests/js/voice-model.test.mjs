import test from 'node:test';
import assert from 'node:assert/strict';
import {
    shouldOffer, peersFrom, cleanSignal, speakingStep, rmsLevel, micButton, statusText, micErrorText, iceServersFrom, retryDelay, MAX_SIGNAL_BYTES,
} from '../../resources/js/map/voice-model.js';

test('llama siempre el de número menor, y nunca los dos', () => {
    assert.equal(shouldOffer(3, 7), true);
    assert.equal(shouldOffer(7, 3), false);
    assert.equal(shouldOffer('3', 7), true);
});

test('peersFrom saca a uno mismo, repetidos y datos inválidos, ordena y recorta', () => {
    const members = [{ id: 5, name: 'E' }, { id: 2, name: 'B' }, { id: 5, name: 'dup' }, { id: 1, name: 'yo' }, { name: 'sin id' }, null, { id: 3 }];
    assert.deepEqual(peersFrom(members, 1).map((p) => p.id), [2, 3, 5]);
    assert.deepEqual(peersFrom(members, 1, 2).map((p) => p.id), [2, 3]);
    assert.deepEqual(peersFrom(undefined, 1), []);
});

test('cleanSignal acepta lo válido y descarta lo ajeno', () => {
    const ok = { from: 2, to: 1, kind: 'offer', sid: 'a', sdp: 'v=0' };
    assert.deepEqual(cleanSignal(ok, 1, new Set([2])), { from: 2, to: 1, kind: 'offer', sid: 'a', sdp: 'v=0', candidate: undefined });
    assert.equal(cleanSignal({ ...ok, to: 9 }, 1), null, 'no es para mí');
    assert.equal(cleanSignal({ ...ok, from: 1 }, 1), null, 'de mí mismo');
    assert.equal(cleanSignal(ok, 1, new Set([5])), null, 'quien no está en la voz');
    assert.equal(cleanSignal({ ...ok, kind: 'hack' }, 1), null);
    assert.equal(cleanSignal({ ...ok, sdp: 12 }, 1), null);
    assert.equal(cleanSignal({ ...ok, sdp: 'x'.repeat(MAX_SIGNAL_BYTES) }, 1), null, 'demasiado grande');
    assert.equal(cleanSignal({ from: 2, to: 1, kind: 'ice', candidate: 'texto' }, 1), null);
    assert.ok(cleanSignal({ from: 2, to: 1, kind: 'ice', candidate: { candidate: 'a' } }, 1));
    assert.ok(cleanSignal({ from: 2, to: 1, kind: 'bye' }, 1));
    assert.equal(cleanSignal(null, 1), null);
    assert.equal(cleanSignal('x', 1), null);
});

test('speakingStep: enciende, se sostiene un rato y apaga sin parpadeo', () => {
    let s = { on: false, lastLoud: 0 };
    s = speakingStep(s, 0.01, 100);
    assert.equal(s.on, false);
    s = speakingStep(s, 0.1, 200);
    assert.equal(s.on, true);
    s = speakingStep(s, 0.025, 300);   // entre los dos umbrales: sigue
    assert.equal(s.on, true);
    s = speakingStep(s, 0.0, 400);     // silencio, pero dentro del sostén
    assert.equal(s.on, true);
    s = speakingStep(s, 0.0, 900);     // pasó el sostén
    assert.equal(s.on, false);
    assert.equal(speakingStep({ on: false, lastLoud: 0 }, 0.025, 1000).on, false, 'por debajo del umbral de encendido no arranca');
});

test('rmsLevel: silencio = 0, señal fuerte > umbral', () => {
    assert.equal(rmsLevel(new Uint8Array(0)), 0);
    assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0);
    assert.ok(rmsLevel(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 200 : 56))) > 0.4);
});

test('textos de los botones y del estado', () => {
    assert.equal(micButton('off').pressed, false);
    assert.equal(micButton('on').pressed, true);
    assert.equal(micButton('asking').disabled, true);
    assert.match(micButton('off', { peers: 0 }).title, /nadie más/);
    assert.match(micButton('off', { peers: 2 }).title, /hablar/);
    assert.equal(statusText({ live: false, peers: 0, mic: 'off', deaf: false }), 'Voz · conectando…');
    assert.equal(statusText({ live: true, peers: 0, mic: 'off', deaf: false }), 'Voz · solo vos por ahora');
    assert.equal(statusText({ live: true, peers: 2, mic: 'on', deaf: true }), 'Voz · 3 en la sala · hablando · sin sonido');
});

test('errores del micrófono', () => {
    assert.match(micErrorText({ name: 'NotAllowedError' }), /permiso/);
    assert.match(micErrorText({ name: 'NotFoundError' }), /ningún micrófono/);
    assert.match(micErrorText({ name: 'NotReadableError' }), /ocupado/);
    assert.match(micErrorText({}), /No se pudo/);
    assert.match(micErrorText({ name: 'NotAllowedError' }, false), /https/);
});

test('iceServersFrom y retryDelay', () => {
    assert.deepEqual(iceServersFrom([{ urls: ['stun:a'] }, { urls: [] }, null, { urls: 'stun:b' }, {}]), [{ urls: ['stun:a'] }, { urls: 'stun:b' }]);
    assert.deepEqual(iceServersFrom(null), []);
    assert.equal(retryDelay(0), 2000);
    assert.equal(retryDelay(2), 8000);
    assert.equal(retryDelay(10), 20000);
});
