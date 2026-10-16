import test from 'node:test';
import assert from 'node:assert/strict';
import { manualSections } from '../../resources/js/guides/manual-model.js';
import { GUIDES, PLACES } from '../../resources/js/guides/guides-model.js';
import { STORAGE_KEY } from '../../resources/js/guides/guides-state.js';

const cfg = {
    auction: { dispute: 5, duration: 30 }, economy: { startCash: 60000, sellRatio: 0.6 },
    match: { durationMinutes: 40, minutesPerDay: 2, daysTotal: 20, minCapacity: 2, maxCapacity: 8, lobbyTtlMinutes: 15, points: { places: { 1: 100 }, other: 15 } },
    combos: { zoneTiers: { 3: 0.1 }, variety: 0.1 }, events: { enabled: true, perMatch: 4, durationDays: 3, announceDays: 1 },
    bank: { ratePct: 3, latePct: 2, maxSharePct: 50, maxLoans: 2, minAmount: 1000, terms: [5, 10, 20] },
    offers: { durationSeconds: 120, decideSeconds: 45, feePct: 5, minPrice: 100 },
    sprint: { enabled: true, seconds: 300, incomePct: 1, flashInterval: 60, flashSeconds: 20, flashStartPct: 60, comebackPct: 10, blockLoans: true },
    voice: { enabled: true },
};
const ctx = { cfg, user: { id: 1 } };

test('cinco_secciones_en_orden', () => {
    const s = manualSections(ctx);
    assert.deepEqual(s.map((x) => x.place), PLACES);
    assert.deepEqual(s.map((x) => x.label), ['Lobby', 'Sala de espera', 'Partida', 'Resultados', 'Explorar la ciudad']);
    assert.ok(s.every((x) => x.guides.length > 0));
});

test('los_pasos_no_traen_targets_y_coinciden_con_los_de_cada_guia', () => {
    for (const section of manualSections(ctx)) {
        for (const g of section.guides) {
            const real = GUIDES.find((x) => x.id === g.id).steps(ctx);
            assert.deepEqual(g.steps, real.map(({ title, text }) => ({ title, text })), g.id);
            assert.ok(g.steps.every((s) => !('targets' in s)));
            assert.ok(g.title && g.summary);
        }
    }
});

test('no_incluye_guias_no_disponibles', () => {
    const ids = (c) => manualSections({ cfg: c, user: null }).flatMap((s) => s.guides.map((g) => g.id));
    assert.ok(ids(cfg).includes('partida-banco'));
    assert.ok(!ids({ ...cfg, bank: undefined }).includes('partida-banco'));
});

test('no_marca_nada_como_visto', () => {
    const writes = [];
    const spy = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
    globalThis.localStorage = spy;
    manualSections(ctx);
    delete globalThis.localStorage;
    assert.deepEqual(writes, []);
    assert.ok(STORAGE_KEY);
});
