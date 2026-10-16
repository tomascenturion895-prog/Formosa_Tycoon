// Sonidos del juego, sintetizados con WebAudio: no hay archivos de audio que bajar ni licencias que cuidar.
// El navegador solo deja sonar después de un gesto del jugador (un toque o un clic): hasta entonces se queda en silencio.
// La preferencia (sí/no) se recuerda en este navegador; si no se puede guardar, se usa igual.

const KEY = 'formosa.sonido';
const MASTER = 0.45; // volumen general: se escucha bien en parlantes de notebook sin asustar con auriculares

// Cada sonido es una lista de notas: f = frecuencia (Hz), t = cuándo empieza (s), d = cuánto dura (s), type = timbre, g = volumen relativo.
const RECIPES = {
    compra: [{ f: 523.25, t: 0, d: 0.1, type: 'triangle' }, { f: 659.25, t: 0.09, d: 0.1, type: 'triangle' }, { f: 783.99, t: 0.18, d: 0.1, type: 'triangle' }, { f: 1046.5, t: 0.27, d: 0.3, type: 'triangle' }],
    cobro: [{ f: 987.77, t: 0, d: 0.08, type: 'square', g: 0.35 }, { f: 1318.5, t: 0.07, d: 0.28, type: 'square', g: 0.35 }],
    puja: [{ f: 660, t: 0, d: 0.07, type: 'sine' }, { f: 880, t: 0.07, d: 0.12, type: 'sine' }],
    superado: [{ f: 392, t: 0, d: 0.14, type: 'sawtooth', g: 0.3 }, { f: 293.66, t: 0.14, d: 0.26, type: 'sawtooth', g: 0.3 }],
    ganaste: [{ f: 523.25, t: 0, d: 0.12, type: 'triangle' }, { f: 659.25, t: 0.12, d: 0.12, type: 'triangle' }, { f: 783.99, t: 0.24, d: 0.12, type: 'triangle' }, { f: 1046.5, t: 0.36, d: 0.12, type: 'triangle' }, { f: 1318.5, t: 0.5, d: 0.5, type: 'triangle' }],
    perdiste: [{ f: 220, t: 0, d: 0.2, type: 'sine' }, { f: 174.61, t: 0.2, d: 0.4, type: 'sine' }],
    chat: [{ f: 520, t: 0, d: 0.06, type: 'sine', g: 0.5 }],
    aviso: [{ f: 880, t: 0, d: 0.1, type: 'sine', g: 0.6 }, { f: 880, t: 0.18, d: 0.1, type: 'sine', g: 0.6 }],
    fin: [{ f: 523.25, t: 0, d: 0.15, type: 'triangle' }, { f: 392, t: 0.15, d: 0.15, type: 'triangle' }, { f: 329.63, t: 0.3, d: 0.15, type: 'triangle' }, { f: 261.63, t: 0.45, d: 0.4, type: 'triangle' }],
    error: [{ f: 160, t: 0, d: 0.14, type: 'square', g: 0.25 }],
};

// Separación mínima entre repeticiones del mismo sonido (ms): un chat movido no debe sonar como una ametralladora.
const MIN_GAP = { aviso: 2000, chat: 1500, error: 400, puja: 150 };

function readPreference() {
    try {
        return window.localStorage.getItem(KEY) !== 'no';
    } catch {
        return true;
    }
}

function writePreference(on) {
    try {
        window.localStorage.setItem(KEY, on ? 'si' : 'no');
    } catch {
        // sin almacenamiento (ventana privada, bloqueado): la elección vale solo para esta visita
    }
}

/**
 * `onPlay(nombre)` avisa cada vez que suena un efecto (la música baja un poco para que se escuche: ver music-model DUCK).
 * El AudioContext es uno solo y lo comparte la música (music.js), así el navegador lo destraba con un único gesto.
 */
export function createSound({ onPlay = null } = {}) {
    let on = readPreference();
    let ctx = null;
    const last = {};

    function context() {
        if (!ctx) {
            const Ctor = window.AudioContext ?? window.webkitAudioContext;
            if (!Ctor) {
                return null;
            }
            ctx = new Ctor();
        }
        return ctx;
    }

    /** Se llama en el primer gesto del jugador: recién ahí el navegador permite el audio. */
    function unlock() {
        const c = context();
        if (c && c.state === 'suspended') {
            c.resume().catch(() => {});
        }
    }
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(type, unlock, { once: true, passive: true });
    }

    function note(c, out, { f, t = 0, d = 0.12, type = 'sine', g = 1 }) {
        const start = c.currentTime + t;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f, start);
        // Entra y sale suave: sin "clics" al empezar o terminar la nota.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + d);
        osc.connect(gain).connect(out);
        osc.start(start);
        osc.stop(start + d + 0.02);
    }

    function play(name, { wait = false } = {}) {
        const recipe = RECIPES[name];
        if (!on || !recipe) {
            return;
        }
        // Con `wait` (la muestra al activar el botón) se espera a que el navegador destrabe el audio en vez de descartarla.
        if (wait) {
            const c0 = context();
            if (c0 && c0.state !== 'running') {
                c0.resume().then(() => play(name), () => {});
                return;
            }
        }
        const now = performance.now();
        if (now - (last[name] ?? -Infinity) < (MIN_GAP[name] ?? 0)) {
            return;
        }
        const c = context();
        // Suspendido = el jugador todavía no tocó nada: se descarta en vez de acumular sonidos que explotarían juntos después.
        if (!c || c.state !== 'running') {
            return;
        }
        last[name] = now;
        const master = c.createGain();
        master.gain.value = MASTER;
        master.connect(c.destination);
        for (const n of recipe) {
            note(c, master, n);
        }
        onPlay?.(name);
    }

    return {
        play,
        context,
        unlock,
        isOn: () => on,
        state: () => ctx?.state ?? 'sin-contexto',
        toggle() {
            on = !on;
            writePreference(on);
            if (on) {
                unlock();
                play('compra', { wait: true }); // una muestra al activarlo
            }
            return on;
        },
    };
}
