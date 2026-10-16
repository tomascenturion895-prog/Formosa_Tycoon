// Música procedural: la parte PURA (sin DOM ni WebAudio). Acá viven la teoría (escalas, acordes, compases de 6/8), el
// generador de melodías con semilla, la elección de pista según el estado del juego, el planificador de notas con
// "lookahead" y las preferencias. El sonido en sí lo fabrica music.js; todo esto se prueba con `npm run test:js`.
//
// Estilo: inspirado en el chamamé litoraleño (compás de 6/8, acordeón en terceras paralelas, guitarra rasgueada, bombo
// suave) pero con material propio: no copia ninguna obra. Las melodías salen de motivos rítmicos y caminatas por la
// escala que decide un generador pseudoaleatorio con semilla: misma semilla, misma música; otra semilla, otra variación.

export const STEPS_PER_BAR = 12;   // un compás de 6/8 en semicorcheas: 2 pulsos de 6 (cada uno, 3 corcheas)
export const BEAT_STEPS = 6;
export const BAR_FORM = 8;         // compases por sección (frase de 8)

import { hashSeed, mulberry32 } from './rng.js';
export { hashSeed, mulberry32 };

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// ---------------------------------------------------------------- teoría

export const SCALES = {
    mayor: [0, 2, 4, 5, 7, 9, 11],
    menor: [0, 2, 3, 5, 7, 8, 11], // menor armónica: el acorde de V queda mayor y "tira" a la tónica
};

export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Grado de la escala (puede ser negativo o mayor que 6: salta de octava) -> nota MIDI. */
export function degreeToMidi(root, scale, deg) {
    const n = scale.length;
    const oct = Math.floor(deg / n);
    return root + oct * 12 + scale[((deg % n) + n) % n];
}

/** Notas MIDI de un acorde armado sobre un grado (tríada; con `seventh` suma la séptima). */
export function chordMidi(root, scale, deg, { seventh = false, base = 0 } = {}) {
    const degs = seventh ? [0, 2, 4, 6] : [0, 2, 4];
    return degs.map((d) => degreeToMidi(root, scale, deg + d + base));
}

// ---------------------------------------------------------------- pistas

/**
 * `bpm` es de negras con puntillo (un pulso de 6/8). Capas: acordeon, guitarra ('rasgueo' | 'arpegio'), bajo, bombo,
 * escobilla (percusión de escobillas), pad, tic (reloj de tensión). `melodyBase` es el grado en que anda la melodía.
 */
export const TRACKS = {
    lobby: {
        label: 'Lobby', root: 53, scale: 'mayor', bpm: 72, melodyBase: 7, cells: ['a', 'b', 'c', 'e', 'g'],
        layers: { acordeon: 0.55, guitarra: 'arpegio', bajo: 0.6, bombo: 0, escobilla: 0, pad: 0.35 },
    },
    partida: {
        label: 'Partida', root: 55, scale: 'mayor', bpm: 92, melodyBase: 8, cells: ['b', 'c', 'd', 'f', 'h', 'e'],
        layers: { acordeon: 0.8, guitarra: 'rasgueo', bajo: 0.85, bombo: 0.7, escobilla: 0.5, pad: 0 },
    },
    tension: {
        label: 'Últimos minutos', root: 57, scale: 'menor', bpm: 100, melodyBase: 8, cells: ['c', 'd', 'h', 'd', 'f'],
        layers: { acordeon: 0.8, guitarra: 'rasgueo', bajo: 0.9, bombo: 0.85, escobilla: 0.6, pad: 0.4 },
    },
    noche: {
        label: 'Noche', root: 50, scale: 'mayor', bpm: 58, melodyBase: 7, cells: ['a', 'a', 'b', 'g'],
        layers: { acordeon: 0, caja: 0.5, guitarra: 'arpegio', bajo: 0.5, bombo: 0, escobilla: 0, pad: 0.55 },
    },
};

export const TRACK_NAMES = Object.keys(TRACKS);

/** Pulsos por minuto (negra con puntillo) de una pista; en tensión sube de 100 a 128 con la intensidad (0 a 1). */
export function bpmOf(track, intensity = 0) {
    const t = TRACKS[track];
    if (!t) return 80;
    if (track === 'tension') {
        return t.bpm + 28 * Math.min(1, Math.max(0, intensity));
    }
    return t.bpm;
}

/** Segundos que dura una semicorchea. */
export const stepSeconds = (bpm) => 60 / (bpm * BEAT_STEPS);

/** Capas que suenan según la intensidad (solo cambia en 'tension': se van sumando a medida que se acaba el tiempo). */
export function layersFor(track, intensity = 0) {
    const t = TRACKS[track];
    if (!t) return {};
    const k = Math.min(1, Math.max(0, intensity));
    const layers = { ...t.layers };
    if (track === 'tension') {
        layers.doble = k >= 0.2 ? 0.5 : 0;           // el acordeón dobla la melodía una octava arriba
        layers.semis = k >= 0.4 ? 0.55 : 0;          // guitarra y escobillas a semicorcheas
        layers.bajoCorrido = k >= 0.6 ? 1 : 0;       // el bajo camina a corcheas
        layers.tic = k >= 0.5 ? 1 : 0;               // reloj que marca los pulsos
        layers.ticDoble = k >= 0.8 ? 1 : 0;          // y después, el doble de rápido
    }
    return layers;
}

// ---------------------------------------------------------------- selección de pista según el estado del juego

export const TENSION_MS = 5 * 60_000;

/**
 * Qué debe sonar ahora. `estado`:
 *  - resultado: 'victoria' | 'derrota' | null (al terminar la partida suena un sting y luego vuelve el lobby)
 *  - enPartida: hay partida en juego; restanteMs: lo que falta
 *  - noche y es3d: la vista 3D de noche baja a la pista suave
 * Devuelve { pista, intensidad, sting }.
 */
export function selectTrack({ resultado = null, enPartida = false, restanteMs = null, noche = false, es3d = false } = {}) {
    if (resultado === 'victoria' || resultado === 'derrota') {
        return { pista: 'lobby', intensidad: 0, sting: resultado };
    }
    if (enPartida && Number.isFinite(restanteMs) && restanteMs <= TENSION_MS) {
        return { pista: 'tension', intensidad: Math.min(1, Math.max(0, 1 - restanteMs / TENSION_MS)), sting: null };
    }
    if (noche && es3d) {
        return { pista: 'noche', intensidad: 0, sting: null };
    }
    return { pista: enPartida ? 'partida' : 'lobby', intensidad: 0, sting: null };
}

// ---------------------------------------------------------------- ritmos de la melodía (en semicorcheas de un compás de 12)

/** Celdas rítmicas: [inicio, duración]. Un compás de 6/8 son 2 pulsos de 6 semicorcheas. */
export const CELLS = {
    a: [[0, 6], [6, 6]],
    b: [[0, 2], [2, 2], [4, 2], [6, 6]],
    c: [[0, 4], [4, 2], [6, 4], [10, 2]],
    d: [[0, 2], [2, 2], [4, 2], [6, 2], [8, 2], [10, 2]],
    e: [[0, 6], [6, 2], [8, 2], [10, 2]],
    f: [[0, 2], [2, 4], [6, 2], [8, 4]],
    g: [[2, 2], [4, 2], [6, 6]],
    h: [[0, 3], [3, 3], [6, 3], [9, 3]],
};

/** Progresiones de 8 compases (grados de la escala sobre los que se arma cada acorde). */
const PROGRESSIONS = {
    Ah: [[0, 0, 3, 0, 0, 3, 4, 4], [0, 4, 0, 4, 0, 3, 4, 4], [0, 0, 3, 3, 0, 4, 4, 4]],  // termina en V: pregunta
    Af: [[0, 0, 3, 0, 4, 4, 0, 0], [0, 4, 0, 4, 3, 4, 0, 0], [0, 3, 0, 4, 3, 4, 0, 0]], // termina en I: respuesta
    Bh: [[5, 5, 1, 1, 3, 3, 4, 4], [5, 1, 5, 1, 3, 3, 4, 4], [5, 3, 1, 4, 5, 3, 4, 4]],
    Bf: [[5, 1, 4, 4, 3, 4, 0, 0], [5, 5, 3, 4, 3, 4, 0, 0], [1, 4, 5, 3, 3, 4, 0, 0]],
};
export const FORM = ['Ah', 'Af', 'Bh', 'Bf']; // 32 compases antes de repetir la estructura (con otra variación cada vuelta)

const CYCLE_BARS = BAR_FORM * FORM.length;

/** El grado ii de la menor armónica es disminuido: en las pistas en menor se reemplaza por iv. */
const fixDeg = (scaleName, d) => (scaleName === 'menor' && d === 1 ? 3 : d);

const planCache = new Map();

/**
 * Plan de un compás: acorde y notas de la melodía. Depende SOLO de (pista, semilla, compás): reproducible.
 * { section, cycle, barInSection, deg, chord:[midi], seventh, melody:[{step, len, midi, harm}] }
 */
export function planBar(track, seed, barIndex) {
    const key = `${track}|${seed}|${barIndex}`;
    const hit = planCache.get(key);
    if (hit) return hit;
    const t = TRACKS[track];
    const scale = SCALES[t.scale];
    const cycle = Math.floor(barIndex / CYCLE_BARS);
    const inCycle = barIndex % CYCLE_BARS;
    const secIdx = Math.floor(inCycle / BAR_FORM);
    const barInSection = inCycle % BAR_FORM;
    const section = FORM[secIdx];

    // Una variación de progresión y de melodía por (vuelta, sección): la música no se repite igual cada 8 compases.
    const rngProg = mulberry32(hashSeed(seed, track, 'prog', cycle, secIdx));
    const prog = pick(rngProg, PROGRESSIONS[section]).map((d) => fixDeg(t.scale, d));
    const deg = prog[barInSection];
    const nextDeg = barInSection < BAR_FORM - 1 ? prog[barInSection + 1] : null;
    const seventh = deg === 4 && barInSection >= BAR_FORM - 2;
    const chord = chordMidi(t.root + 12, scale, deg, { seventh });

    const melody = planMelody(t, scale, section, cycle, secIdx, barInSection, seed, prog, track);
    const plan = { section, cycle, barInSection, deg, nextDeg, chord, seventh, melody };
    if (planCache.size > 400) planCache.clear();
    planCache.set(key, plan);
    return plan;
}

/** Notas de acorde (como grados módulo 7) de un acorde sobre el grado d. */
const chordDegs = (d) => [d % 7, (d + 2) % 7, (d + 4) % 7];

function planMelody(t, scale, section, cycle, secIdx, bar, seed, prog, track) {
    const sectionSeed = hashSeed(seed, track, 'mel', cycle, secIdx);
    // El motivo rítmico de los compases 0 a 3 se repite (casi) igual en 4 a 7, así la frase se siente "dicha dos veces".
    const cells = CELLS[cellForBar(t, sectionSeed, bar)];

    // La altura se camina compás a compás con un generador por (sección, compás): cada compás se puede planificar solo.
    const rng = mulberry32(hashSeed(sectionSeed, 'altura', bar));
    // Punto de partida del compás: el último grado del compás anterior (se recalcula barato recorriendo desde el inicio).
    let cur = t.melodyBase + ((hashSeed(sectionSeed, 'ini') % 3) - 1);
    for (let b = 0; b < bar; b++) {
        cur = walkBar(cur, chordDegs(prog[b]), nextOrSame(prog, b), CELLS[cellForBar(t, sectionSeed, b)], mulberry32(hashSeed(sectionSeed, 'altura', b)), b, false).last;
    }
    const lastBar = bar === BAR_FORM - 1;
    const cadenceDeg = lastBar ? (section === 'Ah' || section === 'Bh' ? 4 : 0) : null;
    const { notes } = walkBar(cur, chordDegs(prog[bar]), nextOrSame(prog, bar), cells, rng, bar, lastBar, cadenceDeg, section);
    return notes.map((n) => ({
        step: n.step,
        len: n.len,
        midi: degreeToMidi(t.root, scale, n.deg),
        harm: degreeToMidi(t.root, scale, n.deg - 2), // la tercera de abajo: sonido típico de acordeón litoraleño
    }));
}

function cellForBar(t, sectionSeed, bar) {
    const half = bar % 4;
    const base = pick(mulberry32(hashSeed(sectionSeed, 'ritmo', half)), t.cells);
    if (bar >= 4 && mulberry32(hashSeed(sectionSeed, 'rep', bar))() >= 0.75) {
        return pick(mulberry32(hashSeed(sectionSeed, 'rep', bar) + 1), t.cells);
    }
    return base;
}

function nextOrSame(prog, b) {
    return prog[Math.min(prog.length - 1, b + 1)];
}

/**
 * Camina la melodía de un compás. Los tiempos fuertes (pasos 0 y 6) caen en notas del acorde; el resto avanza por
 * grados vecinos; el último compás de la sección termina apoyando en la tónica (cierre) o en la dominante (pregunta).
 */
function walkBar(start, chordNow, _next, cells, rng, bar, lastBar, cadenceDeg = null, section = '') {
    const LOW = 5;
    const HIGH = 13;
    let cur = start;
    const notes = [];
    cells.forEach(([step, len], i) => {
        const isLast = i === cells.length - 1;
        if (lastBar && isLast && cadenceDeg != null) {
            cur = nearestDegree(cur, chordDegs(cadenceDeg)[0], LOW, HIGH);
        } else if (step % BEAT_STEPS === 0) {
            cur = nearestChordTone(cur, chordNow, rng, LOW, HIGH);
        } else {
            const dir = cur >= HIGH - 1 ? -1 : cur <= LOW + 1 ? 1 : (rng() < 0.5 ? -1 : 1);
            cur += dir * (rng() < 0.7 ? 1 : 2);
            cur = Math.min(HIGH, Math.max(LOW, cur));
        }
        // Algún silencio breve para respirar (no en los apoyos fuertes ni en el cierre).
        const rest = step % BEAT_STEPS !== 0 && !isLast && rng() < 0.08;
        if (!rest) notes.push({ step, len, deg: cur });
    });
    return { notes, last: cur };
}

function nearestDegree(cur, degMod, low, high) {
    let best = null;
    for (let d = low; d <= high; d++) {
        if (((d % 7) + 7) % 7 === degMod) {
            if (best === null || Math.abs(d - cur) < Math.abs(best - cur)) best = d;
        }
    }
    return best ?? cur;
}

function nearestChordTone(cur, chordDegsNow, rng, low, high) {
    const cands = [];
    for (let d = Math.max(low, cur - 3); d <= Math.min(high, cur + 3); d++) {
        if (chordDegsNow.includes(((d % 7) + 7) % 7)) cands.push(d);
    }
    if (cands.length === 0) return cur;
    cands.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
    // casi siempre la más cercana; a veces la segunda, para que no sea monótono
    return rng() < 0.7 || cands.length === 1 ? cands[0] : cands[1];
}

// ---------------------------------------------------------------- eventos por paso

/**
 * Todo lo que arranca en un paso (semicorchea) de la pista. Cada evento: { voice, midi, dur (en pasos), vel, ... }.
 * Voces: acordeon, doble, caja, guitarra (rasgueo = acorde, arpegio = nota), bajo, bombo, escobilla, pad, tic.
 */
export function eventsForStep(track, seed, stepIndex, intensity = 0) {
    const t = TRACKS[track];
    if (!t) return [];
    const layers = layersFor(track, intensity);
    const bar = Math.floor(stepIndex / STEPS_PER_BAR);
    const s = stepIndex % STEPS_PER_BAR;
    const plan = planBar(track, seed, bar);
    const out = [];
    const root = plan.chord[0] - 12; // la raíz grave del acorde

    // Melodía (acordeón en terceras, o caja de música suave a la noche)
    for (const n of plan.melody) {
        if (n.step !== s) continue;
        if (layers.acordeon) {
            out.push({ voice: 'acordeon', midi: n.midi, harm: n.harm, dur: n.len, vel: layers.acordeon });
            if (layers.doble) out.push({ voice: 'acordeon', midi: n.midi + 12, harm: null, dur: n.len, vel: layers.doble * 0.7 });
        }
        if (layers.caja) out.push({ voice: 'caja', midi: n.midi + 12, dur: n.len * 1.5, vel: layers.caja });
    }

    // Guitarra
    if (layers.guitarra === 'rasgueo') {
        const strums = { 2: 0.8, 4: 0.6, 8: 0.7, 10: 0.5 };
        if (strums[s] != null) out.push({ voice: 'guitarra', chord: plan.chord, dur: 3, vel: strums[s] * (layers.semis ? 1 : 0.9), up: s === 10 });
        if (layers.semis && [1, 3, 7, 9, 11].includes(s)) out.push({ voice: 'guitarra', chord: plan.chord.slice(1), dur: 1.5, vel: 0.28, up: s % 4 === 3 });
    } else if (layers.guitarra === 'arpegio') {
        const seq = [0, 1, 2, 1, 2, 1];
        if (s % 2 === 0) {
            const i = seq[s / 2];
            out.push({ voice: 'guitarra', midi: plan.chord[i] - (i === 0 ? 0 : 0), dur: 4, vel: i === 0 ? 0.75 : 0.5 });
        }
    }

    // Bajo: raíz en el primer pulso, quinta en el segundo (o camina a corcheas con la tensión alta)
    if (layers.bajo) {
        if (layers.bajoCorrido) {
            if (s % 2 === 0) out.push({ voice: 'bajo', midi: s % 4 === 0 ? root : root + (s % 6 === 0 ? 7 : 12), dur: 2, vel: layers.bajo * 0.9 });
        } else if (s === 0) {
            out.push({ voice: 'bajo', midi: root, dur: 5, vel: layers.bajo });
        } else if (s === 6) {
            out.push({ voice: 'bajo', midi: root + 7, dur: 5, vel: layers.bajo * 0.8 });
        }
    }

    // Bombo (pulsos 1 y 2 del compás) y escobillas a contratiempo
    if (layers.bombo && (s === 0 || s === 6)) out.push({ voice: 'bombo', dur: 3, vel: layers.bombo * (s === 0 ? 1 : 0.7) });
    if (layers.escobilla) {
        const hits = layers.semis ? [1, 2, 3, 4, 5, 7, 8, 9, 10, 11] : [2, 4, 8, 10];
        if (hits.includes(s)) out.push({ voice: 'escobilla', dur: 1, vel: layers.escobilla * (s % 2 === 0 ? 1 : 0.5) });
    }

    // Colchón (un acorde largo por compás)
    if (layers.pad && s === 0) out.push({ voice: 'pad', chord: plan.chord, dur: STEPS_PER_BAR, vel: layers.pad });

    // Reloj de tensión
    if (layers.tic && (s === 0 || s === 6 || (layers.ticDoble && (s === 3 || s === 9)))) out.push({ voice: 'tic', dur: 1, vel: s === 0 ? 1 : 0.7 });

    return out;
}

// ---------------------------------------------------------------- stings de resultados

/** Fanfarria de victoria o cierre de derrota: lista de notas con tiempo absoluto en segundos. Duración total en `dur`. */
export function stingEvents(kind) {
    if (kind === 'victoria') {
        // Do mayor ascendente con acordeón en terceras y bombo: dos pulsos de anticipación y un acorde final largo.
        const ev = [];
        const m = [60, 64, 67, 72, 76];
        m.forEach((midi, i) => ev.push({ t: i * 0.17, voice: 'acordeon', midi, harm: midi - 4, dur: 0.2, vel: 0.9 }));
        ev.push({ t: 0, voice: 'bombo', dur: 0.3, vel: 0.9 }, { t: 0.51, voice: 'bombo', dur: 0.3, vel: 0.8 });
        ev.push({ t: 0.9, voice: 'acordeon', midi: 79, harm: 72, dur: 1.5, vel: 1 });
        ev.push({ t: 0.9, voice: 'guitarra', chord: [60, 64, 67, 72], dur: 3, vel: 0.9 });
        ev.push({ t: 0.9, voice: 'bajo', midi: 48, dur: 3, vel: 0.9 }, { t: 0.9, voice: 'bombo', dur: 0.4, vel: 1 });
        return { dur: 3.2, events: ev };
    }
    // derrota: línea descendente en menor, sin dramatismo, y un acorde final que se apaga
    const m = [72, 70, 67, 63];
    const ev = m.map((midi, i) => ({ t: i * 0.3, voice: 'acordeon', midi, harm: midi - 3, dur: 0.34, vel: 0.7 }));
    ev.push({ t: 1.25, voice: 'acordeon', midi: 60, harm: 55, dur: 1.8, vel: 0.7 });
    ev.push({ t: 1.25, voice: 'guitarra', chord: [48, 55, 60, 63], dur: 3, vel: 0.6 });
    ev.push({ t: 1.25, voice: 'bajo', midi: 36, dur: 3, vel: 0.7 });
    return { dur: 3.4, events: ev };
}

// ---------------------------------------------------------------- ducking

/** Cuánto baja la música (factor de volumen) y por cuánto tiempo (ms) cuando suena un efecto importante. */
export const DUCK = {
    ganaste: { gain: 0.35, ms: 1500 },
    perdiste: { gain: 0.35, ms: 1200 },
    fin: { gain: 0.35, ms: 1400 },
    compra: { gain: 0.6, ms: 700 },
    superado: { gain: 0.55, ms: 700 },
    aviso: { gain: 0.5, ms: 700 },
    error: { gain: 0.7, ms: 400 },
};

export const duckFor = (effect) => DUCK[effect] ?? null;

// ---------------------------------------------------------------- planificador con "lookahead"

/**
 * Planificador de notas. Un temporizador de JavaScript es impreciso (se atrasa si el hilo está ocupado), así que NO toca
 * el sonido: solo se despierta seguido y agenda en el reloj de audio (preciso) todo lo que cae dentro de los próximos
 * `lookahead` segundos. Si el hilo se demora, las notas ya estaban agendadas.
 *
 * Todo se inyecta (reloj, temporizadores, qué hacer con cada paso) para poder probarlo sin navegador.
 */
export function createSequencer({ now, emit, bpm, setTimer, clearTimer, lookahead = 0.3, tickMs = 40, maxCatchUp = 64 }) {
    let timer = null;
    let running = false;
    let step = 0;
    let nextTime = 0;

    function pump() {
        if (!running) return;
        const horizon = now() + lookahead;
        // Si el hilo estuvo congelado mucho tiempo (pestaña en segundo plano), no se dispara una ráfaga: se salta lo perdido.
        if (nextTime < now() - 0.5) {
            nextTime = now() + 0.05;
        }
        let guard = 0;
        while (nextTime < horizon && guard++ < maxCatchUp) {
            emit(step, nextTime);
            nextTime += stepSeconds(bpm());
            step += 1;
        }
        timer = setTimer(pump, tickMs);
    }

    return {
        /** Arranca en el paso `fromStep` (por defecto el inicio) al tiempo de audio `at`. */
        start(at, fromStep = 0) {
            this.stop();
            running = true;
            step = fromStep;
            nextTime = at;
            pump();
        },
        stop() {
            running = false;
            if (timer != null) clearTimer(timer);
            timer = null;
        },
        isRunning: () => running,
        position: () => ({ step, nextTime }),
    };
}

// ---------------------------------------------------------------- preferencias

export const KEY_MUSIC = 'formosa.musica';
export const KEY_VOLUME = 'formosa.volumen';
export const DEFAULT_VOLUME = 0.6;

/** La música está activa salvo que el jugador la haya apagado ('no'). */
/** Sin preferencia guardada la música está activa, salvo en un navegador automatizado (los e2e no deben cargar la CPU con audio). */
export const parseMusicPref = (v, automated = false) => (v == null ? !automated : v !== 'no');

export function parseVolume(v, fallback = DEFAULT_VOLUME) {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
}

/** Ganancia final del bus de música: tope bajo y curva cuadrática para que el control sea parejo al oído. */
export const MUSIC_CAP = 0.55;
export const volumeToGain = (v) => MUSIC_CAP * Math.min(1, Math.max(0, v)) ** 2;

/** Semilla de la sesión: estable dentro de una partida (todos los de la sala escuchan la misma variación) y distinta entre partidas. */
export function sessionSeed(matchId, userId = 0) {
    return hashSeed('formosa', matchId ?? 'lobby', matchId == null ? userId : 0);
}
