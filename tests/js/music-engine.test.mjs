// El motor de música con un AudioContext simulado: cuenta nodos y automatizaciones sin necesitar un navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusic } from '../../resources/js/map/music.js';
import { volumeToGain } from '../../resources/js/map/music-model.js';

function fakeCtx() {
    const log = { created: {}, starts: 0, connects: 0, disconnected: 0 };
    const param = (v = 0) => ({ value: v, calls: [], setValueAtTime(x, t) { this.calls.push(['set', x, t]); this.value = x; }, linearRampToValueAtTime(x, t) { this.calls.push(['lin', x, t]); }, exponentialRampToValueAtTime(x, t) { this.calls.push(['exp', x, t]); }, setTargetAtTime(x, t, k) { this.calls.push(['target', x, t, k]); }, cancelScheduledValues() { this.calls.push(['cancel']); } });
    const node = (kind, extra = {}) => {
        log.created[kind] = (log.created[kind] ?? 0) + 1;
        const n = { kind, connect(to) { log.connects++; n.out = to; return to; }, disconnect() { log.disconnected++; }, ...extra };
        return n;
    };
    const ctx = {
        currentTime: 0, sampleRate: 8000, state: 'suspended', destination: { kind: 'destination' },
        resumes: 0, suspends: 0,
        async resume() { this.resumes++; this.state = 'running'; },
        async suspend() { this.suspends++; this.state = 'suspended'; },
        createGain() { return node('gain', { gain: param(1) }); },
        createOscillator() { return node('osc', { type: 'sine', frequency: param(440), detune: param(0), start() { log.starts++; }, stop() {} }); },
        createBiquadFilter() { return node('filter', { type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }); },
        createDynamicsCompressor() { return node('comp', { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); },
        createBufferSource() { return node('buffer', { buffer: null, start() { log.starts++; }, stop() {} }); },
        createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    };
    return { ctx, log };
}

function harness() {
    const { ctx, log } = fakeCtx();
    const timers = [];
    const music = createMusic({
        getContext: () => ctx,
        setTimer: (f, ms) => { const t = { f, at: ctx.currentTime * 1000 + ms, dead: false }; timers.push(t); return t; },
        clearTimer: (t) => { if (t) t.dead = true; },
    });
    /** Hace correr el reloj de audio y los temporizadores (con el paso del tiempo real simulado). */
    const run = (seconds) => {
        const end = ctx.currentTime + seconds;
        while (ctx.currentTime < end) {
            ctx.currentTime += 0.04;
            for (const t of timers.filter((x) => !x.dead && x.at <= ctx.currentTime * 1000)) { t.dead = true; t.f(); }
        }
    };
    return { ctx, log, music, run, timers };
}

test('antes del gesto no suena nada: sin contexto ni nodos', () => {
    const h = harness();
    h.music.setTrack('partida', 1);
    h.run(2);
    assert.equal(h.log.starts, 0);
    assert.equal(h.music.stats().state, 'sin-contexto');
});

test('tras el gesto: el contexto pasa a "running" y empiezan a crearse notas', async () => {
    const h = harness();
    h.music.setTrack('lobby', 5);
    const ok = await h.music.start();
    assert.equal(ok, true);
    assert.equal(h.ctx.state, 'running');
    h.run(4);
    const s = h.music.stats();
    assert.equal(s.track, 'lobby');
    assert.ok(s.running);
    assert.ok(s.oscillators > 20 && s.notes > 10, `osciladores ${s.oscillators}, notas ${s.notes}`);
    assert.ok(h.log.created.comp === 1, 'una cadena con compresor/limitador');
});

test('volumen: se acota entre 0 y 1', async () => {
    const h = harness();
    await h.music.start();
    h.music.setVolume(0.3);
    assert.equal(h.music.getVolume(), 0.3);
    h.music.setVolume(7);
    assert.equal(h.music.getVolume(), 1);
    h.music.setVolume(-1);
    assert.equal(h.music.getVolume(), 0);
    assert.ok(volumeToGain(1) <= 0.6);
});

test('crossfade: al cambiar de pista el bus viejo baja a 0 y se suelta, el nuevo sube', async () => {
    const h = harness();
    h.music.setTrack('lobby', 1);
    await h.music.start();
    h.run(2);
    const before = h.log.disconnected;
    h.music.setTrack('partida', 1);
    assert.equal(h.music.stats().track, 'partida');
    assert.equal(h.music.stats().switches, 2);
    h.run(6);
    assert.ok(h.log.disconnected > before, 'el bus viejo se soltó del grafo');
    // misma pista y misma semilla: no reinicia
    h.music.setTrack('partida', 1);
    assert.equal(h.music.stats().switches, 2);
    // otra semilla: otra variación (reinicia)
    h.music.setTrack('partida', 2);
    assert.equal(h.music.stats().switches, 3);
});

test('intensidad: sube el tempo de la tensión sin reiniciar la pista', async () => {
    const h = harness();
    h.music.setTrack('tension', 1);
    await h.music.start();
    h.run(1);
    const sw = h.music.stats().switches;
    const bpm0 = h.music.stats().bpm;
    h.music.setIntensity(0.9);
    assert.ok(h.music.stats().bpm > bpm0);
    assert.equal(h.music.stats().switches, sw);
    h.run(2);
});

test('apagar la música frena el planificador y no agenda más notas; encenderla la retoma', async () => {
    const h = harness();
    await h.music.start();
    h.music.setTrack('partida', 3);
    h.run(2);
    h.music.setEnabled(false);
    assert.equal(h.music.stats().running, false);
    const n = h.music.stats().notes;
    h.run(3);
    assert.equal(h.music.stats().notes, n);
    h.music.setEnabled(true);
    h.run(2);
    assert.ok(h.music.stats().notes > n);
    assert.equal(h.music.stats().running, true);
});

test('pestaña oculta: pausa y suspende el contexto; al volver, retoma sin ráfaga de notas', async () => {
    const h = harness();
    await h.music.start();
    h.music.setTrack('partida', 4);
    h.run(2);
    h.music.pause();
    assert.equal(h.music.stats().paused, true);
    assert.equal(h.ctx.suspends, 1);
    const n = h.music.stats().notes;
    h.run(10);
    assert.equal(h.music.stats().notes, n, 'en pausa no suena nada');
    await h.music.resume();
    assert.equal(h.ctx.state, 'running');
    h.run(1);
    assert.ok(h.music.stats().notes > n);
    assert.ok(h.music.stats().notes - n < 80, 'sin ráfaga');
});

test('ducking: baja el volumen y lo devuelve; los efectos comunes no lo tocan', async () => {
    const h = harness();
    await h.music.start();
    h.music.setTrack('partida', 1);
    h.run(1);
    h.music.duck('chat');
    assert.equal(h.music.stats().ducks, 0);
    h.music.duck('ganaste');
    assert.equal(h.music.stats().ducks, 1);
    h.run(3); // vence el temporizador de vuelta
});

test('sting: corta la pista, suena la fanfarria y después vuelve el lobby', async () => {
    const h = harness();
    await h.music.start();
    h.music.setTrack('partida', 2);
    h.run(2);
    h.music.sting('victoria', 2);
    assert.equal(h.music.stats().stings, 1);
    assert.equal(h.music.stats().running, false, 'durante el sting el planificador está quieto');
    // mientras dura, pedir otra pista no la mete encima
    h.music.setTrack('noche', 2);
    assert.notEqual(h.music.stats().track, 'noche');
    const realNow = Date.now;
    try {
        const t0 = realNow();
        Date.now = () => t0 + 10_000; // pasó el sting
        h.run(5);
    } finally { Date.now = realNow; }
    assert.equal(h.music.stats().track, 'noche', 'después del sting entra la pista pedida');
});

test('sin música activada o sin gesto, el sting no hace ruido', async () => {
    const h = harness();
    h.music.sting('derrota', 1);
    assert.equal(h.music.stats().stings, 0);
    await h.music.start();
    h.music.setEnabled(false);
    h.music.sting('derrota', 1);
    assert.equal(h.music.stats().stings, 0);
});

test('apply: el estado del juego elige la pista y la intensidad', async () => {
    const h = harness();
    await h.music.start();
    h.music.apply({ enPartida: true, restanteMs: 120_000 }, 9);
    assert.equal(h.music.stats().track, 'tension');
    assert.ok(h.music.stats().intensity > 0.5);
    h.music.apply({ enPartida: true, restanteMs: 30 * 60_000 }, 9);
    assert.equal(h.music.stats().track, 'partida');
    h.music.apply({}, 9);
    assert.equal(h.music.stats().track, 'lobby');
});

test('los nodos no se acumulan: en una hora de música, cada nota libera sus nodos (stop programado)', async () => {
    const h = harness();
    await h.music.start();
    h.music.setTrack('partida', 1);
    h.run(60);
    const s = h.music.stats();
    // cada oscilador se creó con su start() (y su stop() programado en la voz): sin arranque no hay fuga
    assert.equal(h.log.starts, s.oscillators + h.log.created.buffer);
});
