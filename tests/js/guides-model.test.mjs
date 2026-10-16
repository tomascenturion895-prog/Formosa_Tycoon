import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDES, PLACES, guidesFor, guideById, pointsText } from '../../resources/js/guides/guides-model.js';

const cfg = {
    kinds: {}, auction: { dispute: 5, duration: 30 },
    economy: { startCash: 60000, sellRatio: 0.6 },
    match: { durationMinutes: 40, minutesPerDay: 2, daysTotal: 20, minCapacity: 2, maxCapacity: 8, defaultCapacity: 4, minPlayers: 2, lobbyTtlMinutes: 15,
        points: { places: { 1: 100, 2: 60, 3: 35 }, other: 15, property_bonus: 1, property_bonus_cap: 20 } },
    combos: { zoneDeg: 0.0025, zoneTiers: { 3: 0.1, 5: 0.2, 8: 0.3 }, variety: 0.1 },
    events: { enabled: true, perMatch: 4, durationDays: 3, announceDays: 1 },
    bank: { ratePct: 2, latePct: 5, maxSharePct: 50, maxLoans: 3, minAmount: 1000, terms: [5, 10, 20] },
    offers: { durationSeconds: 90, decideSeconds: 30, feePct: 5, minPrice: 500 },
    sprint: { enabled: true, seconds: 180, incomePct: 1, flashInterval: 60, flashSeconds: 20, flashStartPct: 50, comebackPct: 10, blockLoans: true },
    voice: { enabled: true }, chat: { max: 200 },
};
const off = { ...cfg, events: { enabled: false }, sprint: { enabled: false }, voice: { enabled: false }, bank: undefined };
const users = [{ id: 1, name: 'Ana' }, null];
const bad = /undefined|NaN|\[object|null/;

for (const [label, c] of [['completa', cfg], ['funciones apagadas', off]]) {
    for (const user of users) {
        test(`cada_guia_arma_pasos_con_la_configuracion_real (${label}, ${user ? 'con cuenta' : 'visitante'})`, () => {
            for (const guide of GUIDES) {
                const ctx = { cfg: c, user };
                if (guide.available && !guide.available(ctx)) continue;
                const steps = guide.steps(ctx);
                assert.ok(steps.length > 0, `${guide.id} sin pasos`);
                for (const s of steps) {
                    assert.ok(s.title && s.text, `${guide.id}: paso vacío`);
                    assert.doesNotMatch(`${s.title} ${s.text}`, bad, `${guide.id}: ${s.title}`);
                    assert.ok(Array.isArray(s.targets) && s.targets.every((t) => typeof t === 'string'), `${guide.id}: targets`);
                }
            }
        });
    }
}

test('con_funciones_apagadas_no_quedan_pasos_vacios', () => {
    const all = GUIDES.filter((g) => !g.available || g.available({ cfg: off, user: { id: 1 } })).flatMap((g) => g.steps({ cfg: off, user: { id: 1 } })).map((s) => s.text).join('\n');
    assert.doesNotMatch(all, /eventos al azar/);
    assert.doesNotMatch(all, /Voz de la sala/);
    assert.doesNotMatch(all, /Sprint final|relámpago/i);
});

test('ids_unicos_y_una_guia_auto_por_lugar_como_minimo', () => {
    const ids = GUIDES.map((g) => g.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const g of GUIDES) {
        assert.ok(PLACES.includes(g.place), `${g.id}: lugar ${g.place}`);
        assert.ok(Number.isInteger(g.version) && g.version >= 1);
        assert.ok(g.title && g.summary);
    }
    for (const place of PLACES) {
        assert.ok(GUIDES.some((g) => g.place === place && g.auto), `lugar ${place} sin guía automática`);
    }
});

test('los_textos_usan_los_numeros_reales', () => {
    const ctx = { cfg, user: { id: 1 } };
    const bienvenida = guideById('lobby-bienvenida').steps(ctx).map((s) => s.text).join(' ');
    assert.match(bienvenida, /40 minutos/);
    assert.match(bienvenida, /60\.000/);
    const comprar = guideById('partida-comprar').steps(ctx).map((s) => s.text).join(' ');
    assert.match(comprar, /5 segundos/);
    assert.match(comprar, /60 %/);
    const rank = guideById('lobby-ranking').steps(ctx).map((s) => s.text).join(' ');
    assert.match(rank, /100 \/ 60 \/ 35 y 15 del 4\.º en adelante/);
    const espera = guideById('sala-espera').steps(ctx).map((s) => s.text).join(' ');
    assert.match(espera, /15 minutos/);
});

test('sin_tiempo_de_disputa_la_compra_es_directa', () => {
    const t = guideById('partida-comprar').steps({ cfg: { ...cfg, auction: { dispute: 0 } }, user: { id: 1 } }).map((s) => s.text).join(' ');
    assert.match(t, /tocá Comprar/);
});

test('guidesFor_filtra_por_lugar_y_available', () => {
    assert.ok(guidesFor('lobby', { cfg, user: null }).every((g) => g.place === 'lobby'));
    assert.deepEqual(guidesFor('inexistente', { cfg, user: null }), []);
    assert.equal(guideById('no-existe'), undefined);
});

test('el_visitante_ve_como_crear_cuenta_en_explorar', () => {
    const visitor = guideById('explorar').steps({ cfg, user: null }).map((s) => s.text).join(' ');
    const player = guideById('explorar').steps({ cfg, user: { id: 1 } }).map((s) => s.text).join(' ');
    assert.match(visitor, /cuenta/);
    assert.ok(guideById('explorar').steps({ cfg, user: null }).some((s) => s.targets.includes('.hud-guest')));
    assert.ok(!guideById('explorar').steps({ cfg, user: { id: 1 } }).some((s) => s.targets.includes('.hud-guest')));
    assert.ok(player.length > 0);
});

test('pointsText_arma_el_texto_desde_la_configuracion', () => {
    assert.equal(pointsText(cfg.match.points), '100 / 60 / 35 y 15 del 4.º en adelante');
    assert.equal(pointsText(undefined), 'según tu puesto');
});

// ---------------------------------------------------------------- Etapa 3: guías de partida
const text = (id, c = cfg, user = { id: 1 }) => guideById(id).steps({ cfg: c, user }).map((s) => `${s.title} ${s.text}`).join(' ');

test('hay_quince_guias_y_las_de_partida_no_son_automaticas', () => {
    assert.equal(GUIDES.length, 15);
    for (const id of ['partida-subastas', 'partida-ofertas', 'partida-combos-eventos', 'partida-banco', 'partida-social', 'partida-herramientas']) {
        const g = guideById(id);
        assert.ok(g, id);
        assert.equal(g.place, 'partida');
        assert.equal(g.auto, false);
        assert.equal(g.version, 1);
    }
});

test('banco_incluye_tasa_plazos_y_maximos', () => {
    const t = text('partida-banco');
    assert.match(t, /2 %/);
    assert.match(t, /5 \/ 10 \/ 20 días/);
    assert.match(t, /3 préstamos/);
    assert.match(t, /50 %/);
    assert.match(t, /5 % por día/, 'recargo por mora');
});

test('banco_no_aparece_si_falta_cfg_bank', () => {
    assert.ok(!guidesFor('partida', { cfg: off, user: { id: 1 } }).some((g) => g.id === 'partida-banco'));
    assert.ok(guidesFor('partida', { cfg, user: { id: 1 } }).some((g) => g.id === 'partida-banco'));
});

test('ofertas_menciona_la_comision', () => {
    const t = text('partida-ofertas');
    assert.match(t, /5 %/);
    assert.match(t, /90 segundos/);
    assert.match(t, /30 segundos/);
    assert.match(t, /Comprá ya/);
});

test('subastas_usa_la_duracion_y_el_relampago_solo_si_hay_sprint', () => {
    const on = text('partida-subastas');
    assert.match(on, /30 segundos/);
    assert.match(on, /relámpago/i);
    assert.match(on, /20 segundos/);
    assert.doesNotMatch(text('partida-subastas', { ...cfg, sprint: { enabled: false } }), /relámpago/i);
});

test('combos_eventos_incluye_sprint_solo_si_esta_encendido', () => {
    const on = text('partida-combos-eventos');
    assert.match(on, /3 o más → \+10 %, 5 o más → \+20 %, 8 o más → \+30 %/);
    assert.match(on, /cuatro tipos/);
    assert.match(on, /4 eventos al azar que duran 3 días/);
    assert.match(on, /x2/);
    assert.match(on, /10 %/);
    const noSprint = text('partida-combos-eventos', { ...cfg, sprint: { enabled: false } });
    assert.doesNotMatch(noSprint, /Sprint/i);
    const noEvents = text('partida-combos-eventos', { ...cfg, events: { enabled: false } });
    assert.doesNotMatch(noEvents, /eventos al azar/);
    assert.match(noEvents, /Zona/);
});

test('social_habla_de_voz_solo_si_esta_habilitada_y_hay_cuenta', () => {
    assert.match(text('partida-social'), /Voz de la sala/);
    assert.doesNotMatch(text('partida-social', { ...cfg, voice: { enabled: false } }), /Voz de la sala/);
    assert.doesNotMatch(text('partida-social', cfg, null), /Voz de la sala/);
});

test('herramientas_cubre_3d_ajustes_ocultar_y_reloj', () => {
    const t = text('partida-herramientas');
    for (const word of [/3D/, /Ajustes/, /tecla H/, /reloj/i, /música/i]) assert.match(t, word);
});
