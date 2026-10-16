// Controles de la música: botón "Música" (activar o silenciar), panel con el volumen, tecla M y pausa con la pestaña oculta.
// El motor (music.js, con todo el sintetizador) se baja recién cuando hace falta: no pesa en la primera carga.
//
// Regla del navegador: no deja sonar hasta que el jugador hace algo (un toque, un clic, una tecla). Por eso no hay música
// al abrir; arranca en el primer gesto (el "Tocá para jugar" de la cinemática de carga lo es) si la música está activa.
import { KEY_MUSIC, KEY_VOLUME, DEFAULT_VOLUME, parseMusicPref, parseVolume, selectTrack, duckFor } from './music-model.js';

const read = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* sin almacenamiento: vale solo para esta visita */ } };
const typing = (t) => /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '') && t.type !== 'range';

export function createAudioControls({ $, sound, doc = document, loadEngine = () => import('./music.js') }) {
    const btn = $('btn-music');
    const volBtn = $('btn-music-vol');
    const panel = $('music-panel');
    const slider = $('music-volume');
    const out = $('music-volume-out');
    let on = parseMusicPref(read(KEY_MUSIC), !!doc.defaultView?.navigator?.webdriver);
    let volume = parseVolume(read(KEY_VOLUME), DEFAULT_VOLUME);
    let engine = null;
    let loading = null;
    let gestured = false;
    let lastKey = '';
    let pending = null;      // último estado del juego pedido antes de que el motor estuviera listo
    let pendingSting = null;
    const resultsSeen = new Set();

    async function ensureEngine() {
        if (engine) return engine;
        if (!loading) {
            loading = loadEngine().then(({ createMusic }) => {
                engine = createMusic({ getContext: () => sound.context() });
                engine.setVolume(volume);
                engine.setEnabled(on);
                return engine;
            }).catch((e) => { loading = null; console.info('Música no disponible', e?.message ?? e); return null; });
        }
        return loading;
    }

    function paint() {
        if (btn) {
            btn.setAttribute('aria-pressed', String(on));
            btn.title = on ? 'Música activada (tecla M para silenciar)' : 'Música silenciada (tecla M para activar)';
        }
        if (slider) {
            slider.value = String(Math.round(volume * 100));
            slider.setAttribute('aria-valuetext', `${Math.round(volume * 100)} %`);
        }
        if (out) out.textContent = `${Math.round(volume * 100)} %`;
    }

    /** Primer gesto del jugador: destraba el audio y, si la música está activa, empieza. */
    async function unlock() {
        gestured = true;
        sound.unlock();
        if (!on) return;
        const e = await ensureEngine();
        if (!e) return;
        e.setEnabled(on); // por si se apagó y se volvió a prender (tecla M o botón)
        if (pending) e.apply(pending.state, pending.seed);
        await e.start();
        if (pendingSting) {
            const s = pendingSting;
            pendingSting = null;
            e.sting(s.kind, s.seed);
        }
    }
    const onGesture = () => {
        unlock().then(() => {
            if (engine?.stats().state === 'running') {
                for (const t of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(t, onGesture, true);
            }
        });
    };
    for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, onGesture, { capture: true, passive: true });
    window.addEventListener('formosa:gesto', onGesture); // la cinemática de carga avisa cuando el toque cierra

    function setOn(next, { quiet = false } = {}) {
        on = next;
        write(KEY_MUSIC, on ? 'si' : 'no');
        paint();
        if (on) {
            unlock();
        } else {
            engine?.setEnabled(false);
        }
        if (!quiet) doc.dispatchEvent(new CustomEvent('formosa:musica', { detail: { on } }));
    }

    function setVolume(v) {
        volume = parseVolume(v);
        write(KEY_VOLUME, String(Math.round(volume * 100)));
        paint();
        engine?.setVolume(volume);
    }

    // ---- panel de volumen (accesible por teclado: el control es un <input type=range> nativo)
    function openPanel(open) {
        if (!panel || !volBtn) return;
        panel.hidden = !open;
        volBtn.setAttribute('aria-expanded', String(open));
        if (open) slider?.focus({ preventScroll: true });
    }
    btn?.addEventListener('click', () => setOn(!on));
    volBtn?.addEventListener('click', () => openPanel(panel.hidden));
    slider?.addEventListener('input', () => setVolume(Number(slider.value) / 100));
    panel?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            openPanel(false);
            volBtn.focus({ preventScroll: true });
        }
    });
    doc.addEventListener('pointerdown', (e) => {
        if (panel && !panel.hidden && !e.target.closest?.('#music-ctl')) openPanel(false);
    });
    doc.addEventListener('keydown', (e) => {
        if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
            setOn(!on);
        }
    });

    // ---- pestaña oculta: se detiene todo y se retoma al volver
    doc.addEventListener('visibilitychange', () => {
        if (!engine) return;
        if (doc.hidden) engine.pause();
        else engine.resume();
    });

    paint();

    return {
        isOn: () => on,
        volume: () => volume,
        engine: () => engine,
        gestured: () => gestured,
        stats: () => engine?.stats() ?? { state: 'sin-motor', enabled: on, volume },

        /** Mismo gesto que el primer toque: lo usa la cinemática ("Tocá para jugar"). */
        unlock,

        /** Estado del juego -> qué pista suena. Barato: solo avisa al motor si cambió algo (la intensidad sí se actualiza siempre). */
        update(state, seed) {
            const s = selectTrack(state);
            const key = `${s.pista}:${seed}`;
            pending = { state, seed };
            if (!engine || !gestured) return;
            if (key !== lastKey || s.pista === 'tension') {
                lastKey = key;
                engine.apply({ ...state, resultado: null }, seed);
            }
        },

        /** Terminó una partida: suena el sting de victoria o de derrota (una sola vez por partida). */
        result(kind, matchId, seed) {
            if (!kind || resultsSeen.has(matchId)) return;
            resultsSeen.add(matchId);
            if (engine && gestured) engine.sting(kind, seed);
            else pendingSting = { kind, seed };
        },

        /** Un efecto importante suena: baja la música un momento. */
        duck(effect) {
            if (duckFor(effect)) engine?.duck(effect);
        },
    };
}
