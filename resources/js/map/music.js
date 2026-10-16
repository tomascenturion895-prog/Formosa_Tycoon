// Motor de música procedural con WebAudio: sintetiza acordeón, guitarra, bajo, bombo y escobillas con osciladores y ruido.
// No hay archivos de audio. La música (qué notas) sale de music-model.js; acá solo se fabrica el sonido.
//
// Cadena: voces -> bus de la pista -> ducking -> volumen -> compresor (limitador suave) -> salida.
// Cada pista tiene su propio bus: al cambiar de pista, el bus viejo baja y el nuevo sube (crossfade).
import {
    stepSeconds, bpmOf, eventsForStep, createSequencer, stingEvents, selectTrack, midiToHz, volumeToGain, duckFor, hashSeed, DEFAULT_VOLUME, TRACKS,
} from './music-model.js';

const FADE_S = 1.6; // duración de los crossfades

/**
 * @param {object} deps
 * @param {() => (AudioContext|null)} deps.getContext  contexto compartido con los efectos de sound.js
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
export function createMusic({ getContext, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
    let ctx = null;
    let chain = null;           // { duck, vol, comp }
    let noiseBuf = null;
    let enabled = true;
    let volume = DEFAULT_VOLUME;
    let paused = false;
    let started = false;
    let current = null;         // { name, bus, seed }
    let intensity = 0;
    let wanted = { name: 'lobby', seed: 1 };
    let stingTimer = null;
    let stingUntil = 0;
    let duckTimer = null;
    const nodes = { created: 0, oscillators: 0, buffers: 0 };
    const events = { notes: 0, steps: 0, switches: 0, stings: 0, ducks: 0 };

    const seq = createSequencer({
        now: () => ctx?.currentTime ?? 0,
        bpm: () => bpmOf(current?.name ?? 'lobby', intensity),
        setTimer,
        clearTimer,
        emit: (step, time) => {
            if (!current || !ctx || paused) return;
            events.steps += 1;
            for (const e of eventsForStep(current.name, current.seed, step, intensity)) {
                voice(e, time, current.bus, stepSeconds(bpmOf(current.name, intensity)));
            }
        },
    });

    // ------------------------------------------------------------ contexto y cadena de salida
    function ensureChain() {
        if (chain) return true;
        ctx = getContext?.() ?? null;
        if (!ctx) return false;
        const duck = ctx.createGain();
        const vol = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.knee.value = 12;
        comp.ratio.value = 5;
        comp.attack.value = 0.006;
        comp.release.value = 0.25;
        vol.gain.value = volumeToGain(volume);
        duck.connect(vol);
        vol.connect(comp);
        comp.connect(ctx.destination);
        chain = { duck, vol, comp };
        nodes.created += 3;
        return true;
    }

    function noise() {
        if (noiseBuf) return noiseBuf;
        const len = Math.floor(ctx.sampleRate * 0.5);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        let seed = 12345;
        for (let i = 0; i < len; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; // ruido reproducible
            d[i] = (seed / 4294967296) * 2 - 1;
        }
        nodes.buffers += 1;
        return noiseBuf;
    }

    function makeBus(startGain) {
        const g = ctx.createGain();
        g.gain.value = startGain;
        g.connect(chain.duck);
        nodes.created += 1;
        return g;
    }

    // ------------------------------------------------------------ voces
    const gainNode = () => { nodes.created += 1; return ctx.createGain(); };
    const osc = (type, freq, t0) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        nodes.created += 1;
        nodes.oscillators += 1;
        return o;
    };
    const filter = (type, freq, q = 0.7) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        nodes.created += 1;
        return f;
    };

    /** Envolvente de amplitud: ataque lineal corto, sostén y caída exponencial (sin clics). */
    function env(g, t0, peak, attack, hold, release) {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + attack);
        g.gain.setValueAtTime(peak, t0 + attack + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    }

    function accordion(midi, t0, dur, vel, bus, level = 0.2) {
        const f0 = midiToHz(midi);
        const g = gainNode();
        const lp = filter('lowpass', Math.min(5200, f0 * 6), 0.8);
        const body = filter('peaking', 1400, 1.2);
        body.gain.value = 4;
        env(g, t0, level * vel, 0.03, Math.max(0.02, dur - 0.05), 0.09);
        // "Lengüetas": dos serruchos apenas desafinados (el batido de un acordeón) más una cuadrada una octava abajo, suave
        const specs = [['sawtooth', f0, -7, 0.5], ['sawtooth', f0, 6, 0.5], ['square', f0 / 2, 0, 0.18]];
        const end = t0 + dur + 0.2;
        for (const [type, f, cents, k] of specs) {
            const o = osc(type, f, t0);
            o.detune.value = cents;
            const m = gainNode();
            m.gain.value = k;
            o.connect(m).connect(lp);
            o.start(t0);
            o.stop(end);
            if (type === 'sawtooth' && dur > 0.45) {
                // vibrato que entra de a poco, solo en las notas largas (un LFO propio que muere con la nota)
                const l = osc('sine', 5.4, t0);
                const depth = gainNode();
                depth.gain.setValueAtTime(0, t0);
                depth.gain.linearRampToValueAtTime(6, t0 + Math.min(0.5, dur)); // hasta ±6 centésimas
                l.connect(depth).connect(o.detune);
                l.start(t0);
                l.stop(end);
            }
        }
        lp.connect(body).connect(g).connect(bus);
    }

    function pluck(midi, t0, dur, vel, bus, level = 0.2) {
        const f0 = midiToHz(midi);
        const g = gainNode();
        const lp = filter('lowpass', 3400, 0.6);
        // el filtro se cierra rápido: ataque brillante y cuerpo cálido, como una cuerda de nylon
        lp.frequency.setValueAtTime(Math.min(4200, f0 * 8), t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(300, f0 * 1.6), t0 + 0.28);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(level * vel, t0 + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.35, dur));
        const a = osc('triangle', f0, t0);
        const b = osc('sawtooth', f0, t0);
        const mb = gainNode();
        mb.gain.value = 0.25;
        a.connect(lp);
        b.connect(mb).connect(lp);
        lp.connect(g).connect(bus);
        const end = t0 + Math.max(0.35, dur) + 0.05;
        a.start(t0); b.start(t0);
        a.stop(end); b.stop(end);
    }

    function bass(midi, t0, dur, vel, bus) {
        const f0 = midiToHz(midi);
        const g = gainNode();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.42 * vel, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.2, dur));
        const o = osc('triangle', f0, t0);
        const o2 = osc('sine', f0, t0);
        const lp = filter('lowpass', 520, 0.7);
        o.connect(lp);
        o2.connect(lp);
        lp.connect(g).connect(bus);
        const end = t0 + Math.max(0.2, dur) + 0.05;
        o.start(t0); o2.start(t0);
        o.stop(end); o2.stop(end);
    }

    function bombo(t0, vel, bus) {
        const g = gainNode();
        const o = osc('sine', 130, t0);
        o.frequency.exponentialRampToValueAtTime(48, t0 + 0.14);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.55 * vel, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.connect(g).connect(bus);
        o.start(t0);
        o.stop(t0 + 0.36);
        // el golpe del parche: un soplido de ruido grave muy corto
        const n = ctx.createBufferSource();
        n.buffer = noise();
        nodes.created += 1;
        const lp = filter('lowpass', 420, 0.5);
        const ng = gainNode();
        ng.gain.setValueAtTime(0.18 * vel, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
        n.connect(lp).connect(ng).connect(bus);
        n.start(t0, 0.1);
        n.stop(t0 + 0.06);
    }

    function brush(t0, vel, bus) {
        const n = ctx.createBufferSource();
        n.buffer = noise();
        nodes.created += 1;
        const hp = filter('highpass', 4200, 0.6);
        const g = gainNode();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.1 * vel, t0 + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
        n.connect(hp).connect(g).connect(bus);
        n.start(t0, 0.2);
        n.stop(t0 + 0.08);
    }

    function pad(chord, t0, dur, vel, bus) {
        const g = gainNode();
        const lp = filter('lowpass', 900, 0.5);
        const peak = 0.11 * vel;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.9, dur * 0.4));
        g.gain.setValueAtTime(peak, t0 + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.6);
        lp.connect(g).connect(bus);
        for (const midi of chord) {
            for (const cents of [-6, 6]) {
                const o = osc('triangle', midiToHz(midi), t0);
                o.detune.value = cents;
                o.connect(lp);
                o.start(t0);
                o.stop(t0 + dur + 0.7);
            }
        }
    }

    function box(midi, t0, dur, vel, bus) {
        // "caja de música" suave para la noche: seno con un parcial agudo que se apaga rápido
        const f0 = midiToHz(midi);
        const g = gainNode();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.14 * vel, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.5, dur));
        const a = osc('sine', f0, t0);
        const b = osc('sine', f0 * 3, t0);
        const gb = gainNode();
        gb.gain.setValueAtTime(0.25, t0);
        gb.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        a.connect(g);
        b.connect(gb).connect(g);
        g.connect(bus);
        const end = t0 + Math.max(0.5, dur) + 0.05;
        a.start(t0); b.start(t0);
        a.stop(end); b.stop(end);
    }

    function tick(t0, vel, bus) {
        const g = gainNode();
        const o = osc('square', 1900, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.05 * vel, t0 + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
        o.connect(g).connect(bus);
        o.start(t0);
        o.stop(t0 + 0.06);
    }

    /** Ejecuta un evento del modelo. `stepSec` = duración de una semicorchea; `time` en segundos del reloj de audio. */
    function voice(e, time, bus, stepSec) {
        const dur = (e.dur ?? 2) * stepSec;
        events.notes += 1;
        switch (e.voice) {
            case 'acordeon':
                accordion(e.midi, time, dur, e.vel, bus);
                if (e.harm != null) accordion(e.harm, time, dur, e.vel * 0.55, bus, 0.16);
                break;
            case 'guitarra':
                if (e.chord) {
                    const notes = e.up ? [...e.chord].reverse() : e.chord;
                    notes.forEach((m, i) => pluck(m, time + i * 0.011, dur, e.vel * (e.up ? 0.8 : 1), bus, 0.13));
                } else {
                    pluck(e.midi, time, dur, e.vel, bus, 0.16);
                }
                break;
            case 'bajo': bass(e.midi, time, dur, e.vel, bus); break;
            case 'bombo': bombo(time, e.vel, bus); break;
            case 'escobilla': brush(time, e.vel, bus); break;
            case 'pad': pad(e.chord, time, dur, e.vel, bus); break;
            case 'caja': box(e.midi, time, dur, e.vel, bus); break;
            case 'tic': tick(time, e.vel, bus); break;
            default: break;
        }
    }

    // ------------------------------------------------------------ pistas y crossfade
    function fadeOutBus(bus, seconds) {
        const t = ctx.currentTime;
        bus.gain.cancelScheduledValues(t);
        bus.gain.setValueAtTime(bus.gain.value, t);
        bus.gain.linearRampToValueAtTime(0.0001, t + seconds);
        // cuando termina de apagarse, se suelta del grafo (las notas que quedaban ya se extinguieron)
        setTimer(() => { try { bus.disconnect(); } catch { /* ya soltado */ } }, (seconds + 2.5) * 1000);
    }

    function startTrack(name, seed, { fade = FADE_S } = {}) {
        if (!ensureChain()) return false;
        const old = current;
        const bus = makeBus(0.0001);
        const t = ctx.currentTime;
        bus.gain.setValueAtTime(0.0001, t);
        bus.gain.linearRampToValueAtTime(1, t + fade);
        if (old) fadeOutBus(old.bus, fade);
        current = { name, seed, bus };
        events.switches += 1;
        if (!paused && enabled) seq.start(t + 0.06, 0);
        return true;
    }

    function applyWanted() {
        if (!started || !enabled || paused) return;
        if (Date.now() < stingUntil) return; // suena un sting: la pista nueva entra cuando termina
        if (!current || current.name !== wanted.name || current.seed !== wanted.seed) {
            startTrack(wanted.name, wanted.seed);
        }
    }

    function stopAll(fade = 0.4) {
        seq.stop();
        if (ctx && current) {
            fadeOutBus(current.bus, fade);
            current = null;
        }
    }

    // ------------------------------------------------------------ API
    return {
        /** Se llama desde un gesto del jugador (clic/tecla): destraba el audio y empieza a sonar si la música está activa. */
        async start() {
            if (!ensureChain()) return false;
            if (ctx.state === 'suspended') {
                try { await ctx.resume(); } catch { /* el navegador lo rechazó: otro gesto lo destrabará */ }
            }
            started = true;
            applyWanted();
            return ctx.state === 'running';
        },

        /** Prende o apaga la música (la pista actual se desvanece). */
        setEnabled(on) {
            enabled = !!on;
            if (!started) return;
            if (!enabled) {
                stopAll(0.5);
            } else {
                applyWanted();
            }
        },
        isEnabled: () => enabled,

        setVolume(v) {
            volume = Math.min(1, Math.max(0, v));
            if (chain) chain.vol.gain.setTargetAtTime(volumeToGain(volume), ctx.currentTime, 0.05);
        },
        getVolume: () => volume,

        /** Pide una pista; si ya está sonando la misma con la misma semilla no hace nada. */
        setTrack(name, seed = 1) {
            if (!TRACKS[name]) return;
            wanted = { name, seed };
            applyWanted();
        },

        /** Intensidad (0 a 1) de la pista de tensión: cambia el tempo y las capas sin cortar la música. */
        setIntensity(x) {
            intensity = Math.min(1, Math.max(0, x));
        },

        /** Aplica la selección completa del estado del juego (ver selectTrack). */
        apply(state, seed) {
            const s = selectTrack(state);
            intensity = s.intensidad;
            if (s.sting) {
                this.sting(s.sting, seed);
            } else {
                this.setTrack(s.pista, seed);
            }
        },

        /** Sting de resultado: la pista se apaga rápido, suena la fanfarria y después vuelve la pista que corresponda. */
        sting(kind, seed = 1) {
            if (!started || !enabled || !ensureChain()) {
                wanted = { name: 'lobby', seed };
                return;
            }
            events.stings += 1;
            const { dur, events: list } = stingEvents(kind);
            const was = current;
            seq.stop();
            if (was) { fadeOutBus(was.bus, 0.5); current = null; }
            const bus = makeBus(1);
            const t0 = ctx.currentTime + 0.35;
            const stepSec = 0.1;
            for (const e of list) voice({ ...e, dur: e.dur / stepSec }, t0 + e.t, bus, stepSec);
            const ms = (dur + 0.35) * 1000;
            stingUntil = Date.now() + ms;
            wanted = { name: 'lobby', seed };
            clearTimer(stingTimer);
            stingTimer = setTimer(() => {
                fadeOutBus(bus, 0.3);
                stingUntil = 0;
                applyWanted();
            }, ms);
        },

        /** Baja la música un momento mientras suena un efecto importante (ver DUCK). */
        duck(effect) {
            const d = duckFor(effect);
            if (!d || !chain || !started) return;
            events.ducks += 1;
            const t = ctx.currentTime;
            chain.duck.gain.cancelScheduledValues(t);
            chain.duck.gain.setTargetAtTime(d.gain, t, 0.03);
            clearTimer(duckTimer);
            duckTimer = setTimer(() => {
                if (chain) chain.duck.gain.setTargetAtTime(1, ctx.currentTime, 0.25);
            }, d.ms);
        },

        /** Pestaña oculta: se detiene el planificador y el contexto (no gasta CPU ni batería). */
        pause() {
            if (paused) return;
            paused = true;
            seq.stop();
            if (ctx && started && ctx.state === 'running') ctx.suspend().catch(() => {});
        },
        async resume() {
            if (!paused) return;
            paused = false;
            if (!ctx || !started) return;
            try { await ctx.resume(); } catch { /* sin gesto */ }
            if (enabled && current) seq.start(ctx.currentTime + 0.08, seq.position().step);
            applyWanted();
        },

        stats: () => ({
            state: ctx?.state ?? 'sin-contexto',
            enabled,
            volume,
            track: current?.name ?? null,
            seed: current?.seed ?? null,
            intensity,
            bpm: current ? bpmOf(current.name, intensity) : null,
            running: seq.isRunning(),
            paused,
            ...nodes,
            ...events,
        }),
        seedFor: (...parts) => hashSeed(...parts),
    };
}
