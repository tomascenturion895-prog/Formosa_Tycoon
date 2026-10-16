import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hashSeed, mulberry32, SCALES, TRACKS, STEPS_PER_BAR, BAR_FORM, FORM, degreeToMidi, chordMidi, midiToHz, planBar, eventsForStep, layersFor, bpmOf, stepSeconds,
    selectTrack, TENSION_MS, createSequencer, parseMusicPref, parseVolume, volumeToGain, MUSIC_CAP, duckFor, stingEvents, sessionSeed, CELLS,
} from '../../resources/js/map/music-model.js';

const pcs = (scale, root) => new Set(scale.map((s) => (root + s) % 12));

test('semillas: el generador es reproducible y distinto para otra semilla', () => {
    const a = mulberry32(hashSeed('a', 1));
    const b = mulberry32(hashSeed('a', 1));
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notEqual(mulberry32(hashSeed('a', 2))(), mulberry32(hashSeed('a', 1))());
    for (let i = 0; i < 100; i++) { const v = a(); assert.ok(v >= 0 && v < 1); }
});

test('teoría: grados a MIDI saltan de octava y los acordes son tríadas (V con séptima)', () => {
    const maj = SCALES.mayor;
    assert.equal(degreeToMidi(60, maj, 0), 60);
    assert.equal(degreeToMidi(60, maj, 7), 72);
    assert.equal(degreeToMidi(60, maj, -1), 59);
    assert.deepEqual(chordMidi(60, maj, 0), [60, 64, 67]);
    assert.deepEqual(chordMidi(60, maj, 4), [67, 71, 74]);
    assert.deepEqual(chordMidi(60, maj, 4, { seventh: true }), [67, 71, 74, 77]);
    assert.equal(midiToHz(69), 440);
    assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
});

test('compases: el planificador es determinístico por (pista, semilla, compás)', () => {
    for (const t of Object.keys(TRACKS)) {
        assert.deepEqual(planBar(t, 42, 5), planBar(t, 42, 5));
    }
    assert.notDeepEqual(planBar('partida', 42, 0).melody, planBar('partida', 43, 0).melody);
});

test('variación: no repite igual cada 8 compases ni cada vuelta de la forma', () => {
    const sig = (track, seed, from) => Array.from({ length: BAR_FORM }, (_, i) => planBar(track, seed, from + i).melody.map((n) => `${n.step}:${n.midi}`).join(',')).join('|');
    const cycle = BAR_FORM * FORM.length;
    const sections = new Set();
    for (let s = 0; s < FORM.length * 3; s++) sections.add(sig('partida', 7, s * BAR_FORM));
    assert.ok(sections.size >= FORM.length * 3 - 1, 'las secciones casi nunca se repiten textualmente');
    assert.notEqual(sig('partida', 7, 0), sig('partida', 7, cycle));
});

test('melodía: solo notas de la escala de la pista, dentro del compás y sin solaparse', () => {
    for (const [name, t] of Object.entries(TRACKS)) {
        const ok = pcs(SCALES[t.scale], t.root % 12);
        for (let bar = 0; bar < BAR_FORM * FORM.length * 2; bar++) {
            const { melody } = planBar(name, 11, bar);
            let end = 0;
            for (const n of melody) {
                assert.ok(ok.has(n.midi % 12), `${name} compás ${bar}: ${n.midi} fuera de la escala`);
                assert.ok(n.step >= 0 && n.step + n.len <= STEPS_PER_BAR, `${name} compás ${bar}: nota fuera del compás`);
                assert.ok(n.step >= end, `${name} compás ${bar}: notas solapadas`);
                end = n.step + n.len;
                assert.ok(n.midi >= 55 && n.midi <= 90, `registro razonable (${n.midi})`);
            }
        }
    }
});

test('melodía: los tiempos fuertes caen en notas del acorde', () => {
    for (const name of ['partida', 'lobby', 'tension']) {
        for (let bar = 0; bar < 16; bar++) {
            const p = planBar(name, 3, bar);
            const chordPcs = new Set(p.chord.map((m) => m % 12));
            for (const n of p.melody) {
                if (n.step % 6 === 0 && !(bar % BAR_FORM === BAR_FORM - 1)) {
                    assert.ok(chordPcs.has(n.midi % 12), `${name} compás ${bar} paso ${n.step}: ${n.midi} no es del acorde`);
                }
            }
        }
    }
});

test('forma: las secciones "pregunta" terminan en la dominante y las "respuesta" en la tónica', () => {
    const t = TRACKS.partida;
    // Ah (compases 0-7) termina en V; Af (8-15) termina en I
    assert.equal(planBar('partida', 5, 7).deg, 4);
    assert.equal(planBar('partida', 5, 15).deg, 0);
    const last = (bar) => { const m = planBar('partida', 5, bar).melody; return m[m.length - 1].midi % 12; };
    assert.equal(last(15), t.root % 12, 'la respuesta cierra en la tónica');
    assert.equal(last(7), (t.root + 7) % 12, 'la pregunta cierra en la dominante');
});

test('eventos: bombo solo en los pulsos 1 y 2 (pasos 0 y 6), bajo con la raíz en el paso 0', () => {
    for (let bar = 0; bar < 8; bar++) {
        for (let s = 0; s < STEPS_PER_BAR; s++) {
            const ev = eventsForStep('partida', 9, bar * STEPS_PER_BAR + s);
            const hasBombo = ev.some((e) => e.voice === 'bombo');
            assert.equal(hasBombo, s === 0 || s === 6, `paso ${s}`);
            if (s === 0) {
                const bajo = ev.find((e) => e.voice === 'bajo');
                assert.equal(bajo.midi % 12, planBar('partida', 9, bar).chord[0] % 12);
            }
        }
    }
});

test('capas: lobby sin bombo ni escobilla; noche sin acordeón; partida con todo', () => {
    const voices = (track, intensity = 0, bars = 4) => {
        const set = new Set();
        for (let s = 0; s < bars * STEPS_PER_BAR; s++) for (const e of eventsForStep(track, 1, s, intensity)) set.add(e.voice);
        return set;
    };
    const lobby = voices('lobby');
    assert.ok(lobby.has('acordeon') && lobby.has('guitarra') && lobby.has('bajo'));
    assert.ok(!lobby.has('bombo') && !lobby.has('escobilla'));
    const noche = voices('noche');
    assert.ok(!noche.has('acordeon') && noche.has('caja') && noche.has('pad'));
    const partida = voices('partida');
    for (const v of ['acordeon', 'guitarra', 'bajo', 'bombo', 'escobilla']) assert.ok(partida.has(v), v);
});

test('tensión: con la intensidad se suman capas y sube el tempo', () => {
    const count = (k) => { let n = 0; for (let s = 0; s < 4 * STEPS_PER_BAR; s++) n += eventsForStep('tension', 1, s, k).length; return n; };
    assert.ok(count(0.1) < count(0.45));
    assert.ok(count(0.45) < count(0.7));
    assert.ok(count(0.7) < count(0.95));
    assert.equal(layersFor('tension', 0).tic, 0);
    assert.equal(layersFor('tension', 0.5).tic, 1);
    assert.equal(layersFor('tension', 0.9).ticDoble, 1);
    assert.equal(bpmOf('tension', 0), 100);
    assert.equal(bpmOf('tension', 1), 128);
    assert.ok(bpmOf('tension', 0.5) > 100 && bpmOf('tension', 0.5) < 128);
    assert.equal(bpmOf('tension', 7), 128, 'se acota');
    assert.equal(bpmOf('partida', 1), TRACKS.partida.bpm, 'las demás pistas no cambian de tempo');
    assert.ok(bpmOf('lobby') < bpmOf('partida') && bpmOf('noche') < bpmOf('lobby'), 'la noche es la más lenta');
});

test('compás de 6/8: 12 semicorcheas, un pulso son 6 y la duración sale del tempo', () => {
    assert.equal(STEPS_PER_BAR, 12);
    assert.ok(Math.abs(stepSeconds(60) - 1 / 6) < 1e-12); // 60 pulsos/min -> un pulso = 1 s = 6 pasos
    for (const cell of Object.values(CELLS)) {
        let end = 0;
        for (const [start, len] of cell) { assert.ok(start >= end && start + len <= 12); end = start + len; }
    }
});

test('selección de pista según el estado del juego', () => {
    assert.deepEqual(selectTrack({}), { pista: 'lobby', intensidad: 0, sting: null });
    assert.equal(selectTrack({ enPartida: true, restanteMs: 20 * 60_000 }).pista, 'partida');
    assert.equal(selectTrack({ enPartida: true, restanteMs: TENSION_MS + 1 }).pista, 'partida');
    const t = selectTrack({ enPartida: true, restanteMs: TENSION_MS });
    assert.equal(t.pista, 'tension');
    assert.equal(t.intensidad, 0);
    assert.ok(Math.abs(selectTrack({ enPartida: true, restanteMs: 150_000 }).intensidad - 0.5) < 1e-9);
    assert.equal(selectTrack({ enPartida: true, restanteMs: 0 }).intensidad, 1);
    assert.equal(selectTrack({ enPartida: true, restanteMs: 60_000, noche: true, es3d: true }).pista, 'tension', 'la tensión pisa a la noche');
    assert.equal(selectTrack({ enPartida: true, restanteMs: 30 * 60_000, noche: true, es3d: true }).pista, 'noche');
    assert.equal(selectTrack({ enPartida: true, restanteMs: 30 * 60_000, noche: true, es3d: false }).pista, 'partida', 'la noche suave es solo en 3D');
    assert.equal(selectTrack({ noche: true, es3d: true }).pista, 'noche');
    assert.equal(selectTrack({ resultado: 'victoria', enPartida: true }).sting, 'victoria');
    assert.equal(selectTrack({ resultado: 'derrota' }).sting, 'derrota');
    assert.equal(selectTrack({ enPartida: true, restanteMs: null }).pista, 'partida');
});

test('planificador: agenda por adelantado sin pasarse del horizonte y con tiempos parejos', () => {
    let clock = 0;
    const timers = [];
    const got = [];
    const seq = createSequencer({
        now: () => clock, bpm: () => 60, lookahead: 0.3, tickMs: 40,
        setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {},
        emit: (step, time) => got.push({ step, time }),
    });
    seq.start(0.1);
    assert.ok(got.length > 0 && got.every((g) => g.time < 0.1 + 0.3 + 1e-9), 'solo lo que cae en el horizonte');
    const spp = stepSeconds(60);
    for (let i = 1; i < got.length; i++) assert.ok(Math.abs(got[i].time - got[i - 1].time - spp) < 1e-12);
    // pasa el tiempo: cada tic agenda lo siguiente, sin saltear ni repetir pasos
    for (let i = 0; i < 100; i++) { clock += 0.04; timers.shift()?.(); }
    assert.deepEqual(got.map((g) => g.step), got.map((_, i) => i), 'pasos consecutivos');
    assert.ok(got[got.length - 1].time <= clock + 0.3 + spp);
    seq.stop();
    const n = got.length;
    clock += 5; timers.splice(0).forEach((f) => f());
    assert.equal(got.length, n, 'detenido no agenda más');
});

test('planificador: si el hilo se congela no dispara una ráfaga, retoma desde ahora', () => {
    let clock = 0;
    const timers = [];
    const got = [];
    const seq = createSequencer({ now: () => clock, bpm: () => 90, setTimer: (f) => timers.push(f), clearTimer: () => {}, emit: (s, t) => got.push({ s, t }) });
    seq.start(0);
    const before = got.length;
    clock = 60; // un minuto congelado
    timers.shift()();
    const burst = got.length - before;
    assert.ok(burst < 20, `sin ráfaga (agendó ${burst})`);
    assert.ok(got[got.length - 1].t >= 60 - 0.5, 'las notas nuevas son del presente');
});

test('planificador: el tempo puede cambiar sobre la marcha (tensión creciente)', () => {
    let clock = 0;
    let bpm = 100;
    const got = [];
    const timers = [];
    const seq = createSequencer({ now: () => clock, bpm: () => bpm, setTimer: (f) => timers.push(f), clearTimer: () => {}, emit: (s, t) => got.push(t) });
    seq.start(0);
    for (let i = 0; i < 50; i++) { clock += 0.04; timers.shift()?.(); }
    const slowGap = got[got.length - 1] - got[got.length - 2];
    bpm = 128;
    for (let i = 0; i < 50; i++) { clock += 0.04; timers.shift()?.(); }
    const fastGap = got[got.length - 1] - got[got.length - 2];
    assert.ok(fastGap < slowGap);
    assert.ok(Math.abs(fastGap - stepSeconds(128)) < 1e-9);
});

test('preferencias: música activa salvo que se apague; volumen acotado; ganancia baja y segura', () => {
    assert.equal(parseMusicPref(null), true);
    assert.equal(parseMusicPref('si'), true);
    assert.equal(parseMusicPref('no'), false);
    // navegador automatizado (webdriver): sin preferencia guardada arranca apagada; una preferencia explícita manda
    assert.equal(parseMusicPref(null, true), false);
    assert.equal(parseMusicPref('si', true), true);
    assert.equal(parseMusicPref('no', false), false);
    assert.equal(parseVolume(null), 0.6);
    assert.equal(parseVolume(''), 0.6);
    assert.equal(parseVolume('40'), 0.4);
    assert.equal(parseVolume('0.25'), 0.25);
    assert.equal(parseVolume('999'), 1);
    assert.equal(parseVolume('-3'), 0);
    assert.equal(parseVolume('abc'), 0.6);
    assert.equal(volumeToGain(0), 0);
    assert.equal(volumeToGain(1), MUSIC_CAP);
    assert.ok(MUSIC_CAP <= 0.6, 'tope bajo');
    assert.ok(volumeToGain(0.5) < volumeToGain(0.8));
    assert.equal(volumeToGain(5), MUSIC_CAP);
});

test('ducking: baja la música con los efectos importantes y no con los comunes', () => {
    for (const k of ['ganaste', 'perdiste', 'fin', 'compra', 'superado', 'aviso']) {
        const d = duckFor(k);
        assert.ok(d.gain > 0 && d.gain < 1 && d.ms > 0, k);
    }
    assert.ok(duckFor('ganaste').gain < duckFor('compra').gain, 'más fuerte cuanto más importante');
    assert.equal(duckFor('chat'), null);
    assert.equal(duckFor('puja'), null);
});

test('stings: victoria y derrota tienen notas, duración y y todo arranca dentro de su duración', () => {
    for (const k of ['victoria', 'derrota']) {
        const { dur, events } = stingEvents(k);
        assert.ok(events.length >= 6 && dur > 2 && dur < 5);
        for (const e of events) assert.ok(e.t >= 0 && e.t < dur, `${k} ${e.voice} t=${e.t}`);
        for (const e of events.filter((x) => x.voice === 'acordeon')) assert.ok(e.t + e.dur <= dur, 'la melodía entra completa en la duración');
    }
    assert.ok(stingEvents('victoria').events.some((e) => e.voice === 'bombo'));
    // la victoria sube y la derrota baja
    const a = stingEvents('victoria').events.filter((e) => e.voice === 'acordeon').map((e) => e.midi);
    const d = stingEvents('derrota').events.filter((e) => e.voice === 'acordeon').map((e) => e.midi);
    assert.ok(a[1] > a[0] && d[1] < d[0]);
});

test('semilla de sesión: estable en una partida, distinta entre partidas', () => {
    assert.equal(sessionSeed(5, 1), sessionSeed(5, 2), 'todos los de una sala escuchan la misma variación');
    assert.notEqual(sessionSeed(5, 1), sessionSeed(6, 1));
    assert.notEqual(sessionSeed(null, 1), sessionSeed(null, 2), 'en el lobby depende del jugador');
});
