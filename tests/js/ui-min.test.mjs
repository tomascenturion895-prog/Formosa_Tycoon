import test from 'node:test';
import assert from 'node:assert/strict';
import { miniText } from '../../resources/js/map/ui-min.js';

test('miniText: con partida muestra cuenta regresiva y efectivo', () => {
    assert.equal(miniText('39:26', '$ 34.410', true), '39:26 · $ 34.410');
});
test('miniText: sin partida no muestra nada', () => {
    assert.equal(miniText('40:00', '…', false), '');
});
