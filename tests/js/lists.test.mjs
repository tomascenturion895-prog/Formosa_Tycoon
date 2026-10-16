import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingModel, historyModel, RANKING_NOTE } from '../../resources/js/map/lists.js';

const players = [
    { id: 1, position: 1, name: 'Beto', matches: 3, wins: 2, points: 250 },
    { id: 2, position: 2, name: 'Ana', matches: 1, wins: 0, points: 60 },
    { id: 3, position: 3, name: 'Cami', matches: 1, wins: 0, points: 35 },
];

test('el ranking numera, marca mi fila y escribe las cuentas en plural', () => {
    const m = rankingModel({ players, mine: null, user: { id: 2, name: 'Ana' } });
    assert.equal(m.rows.length, 3);
    assert.equal(m.rows[0].lead, 1);
    assert.equal(m.rows[0].title, 'Beto');
    assert.equal(m.rows[0].sub, '3 partidas · 2 victorias');
    assert.equal(m.rows[1].sub, '1 partida · 0 victorias');
    assert.equal(m.rows[0].value, '250');
    assert.equal(m.rows[0].small, 'puntos');
    assert.deepEqual(m.rows.map((r) => r.me), [false, true, false]);
    assert.equal(m.note, RANKING_NOTE);
});

test('el ranking agrega mi posición si no estoy en la tabla', () => {
    const mine = { ranking: { position: 7, matches: 2, wins: 0, points: 12 } };
    const m = rankingModel({ players, mine, user: { id: 9, name: 'Ana' } });
    assert.equal(m.rows.length, 4);
    const last = m.rows[3];
    assert.equal(last.title, 'Ana (vos)');
    assert.equal(last.lead, '7');
    assert.equal(last.me, true);
    assert.ok(m.note.startsWith('Tu posición: 7.º con 12 puntos. '));
    assert.ok(m.note.endsWith(RANKING_NOTE));
});

test('un punto se escribe en singular', () => {
    const mine = { ranking: { position: 40, matches: 1, wins: 0, points: 1 } };
    assert.ok(rankingModel({ players: [], mine, user: { id: 9, name: 'Ana' } }).note.startsWith('Tu posición: 40.º con 1 punto. '));
});

test('el ranking de visitante no agrega filas ni posición', () => {
    const m = rankingModel({ players, mine: null, user: null });
    assert.equal(m.rows.length, 3);
    assert.equal(m.note, RANKING_NOTE);
});

test('el historial vacío no tiene nota', () => {
    assert.deepEqual(historyModel({ matches: [], nowMs: 0 }), { note: '', rows: [] });
});

test('el historial cuenta partidas, victorias y puntos, y marca las abandonadas', () => {
    const now = 1_000_000_000_000;
    const matches = [
        { name: 'Sala A', rank: 1, abandoned: false, players: 4, finished_at: now - 120_000, properties: 5, points: 105, net_worth: 250000 },
        { name: 'Sala B', rank: 3, abandoned: true, players: 3, finished_at: now - 7_200_000, properties: 1, points: 0, net_worth: 1000 },
    ];
    const m = historyModel({ matches, nowMs: now });
    assert.equal(m.note, '2 partidas · 1 victoria · 105 puntos');
    assert.equal(m.rows[0].lead, '1.º');
    assert.equal(m.rows[0].me, true);
    assert.equal(m.rows[0].value, '+105');
    assert.equal(m.rows[0].sub, 'de 4 · hace 2 min · 5 propiedades');
    assert.equal(m.rows[1].lead, '–');
    assert.equal(m.rows[1].me, false);
    assert.equal(m.rows[1].sub, 'Abandonada · hace 2 h · 1 propiedad');
});
