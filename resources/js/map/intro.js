// Cinemática de carga: mientras el mapa, las propiedades, las calles y tu partida se cargan de verdad, se ve una ilustración
// animada de Formosa con una barra de progreso REAL (cada paso lo avisa main.js cuando termina). Al terminar aparece
// "Tocá para jugar": ese toque es el gesto que el navegador exige para que pueda sonar la música.
//
// Es su propio punto de entrada (liviano, sale en el primer cuadro) y comparte el módulo con main.js.
// Animación solo con transform y opacity (no frena la carga). Con prefers-reduced-motion queda una imagen quieta.
import {
    LOAD_STEPS, LOAD_STEPS_GUEST, CITY_STEPS, createProgress, pickTips, tipAt, introMode, sceneVariant, enterLabel, progressText, SHORT_MAX_MS, SHORT_MIN_MS, SHORT_FADE_MS,
} from './intro-model.js';
import { introScene, logoMark, mountArt } from './art.js';

const SEEN_KEY = 'formosa.intro.visto';
const TIP_MS = 6000;
const noop = () => {};
const NOOP_API = {
    mode: 'none', step: noop, set: noop, fail: noop, note: noop, finish: noop, isOpen: () => false, whenDone: () => Promise.resolve(), progress: () => 1,
};

function createIntro() {
    if (typeof document === 'undefined') return NOOP_API;
    const root = document.getElementById('intro');
    if (!root) return NOOP_API;

    const params = new URLSearchParams(location.search);
    let seen = false;
    try { seen = sessionStorage.getItem(SEEN_KEY) === '1'; } catch { /* sin almacenamiento */ }
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const mode = introMode({
        param: params.get('intro'),
        webdriver: !!navigator.webdriver,
        seen,
        warm: nav?.type === 'reload' || nav?.type === 'back_forward',
        hasPropertyParam: params.has('p'),
    });
    if (mode === 'none') {
        root.remove();
        document.body.classList.remove('intro-activa');
        return { ...NOOP_API, mode };
    }

    const cfg = window.__MAP_CONFIG__ ?? {};
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const progress = createProgress(cfg.user ? LOAD_STEPS : LOAD_STEPS_GUEST);
    const $ = (id) => document.getElementById(id);
    const fill = $('intro-fill');
    const bar = root.querySelector('.intro-bar');
    const status = $('intro-status');
    const tipEl = $('intro-tip');
    const noteEl = $('intro-note');
    const enter = $('intro-enter');
    const skip = $('intro-skip');
    const scene = $('intro-scene');
    const mark = $('intro-mark');

    const hour = new Date().getHours();
    const variant = sceneVariant(hour);
    root.classList.add(`intro--${variant}`, mode === 'short' ? 'intro--corta' : 'intro--completa');
    if (reduce) root.classList.add('intro--quieta');
    document.body.classList.add('intro-activa');
    if (mark) mark.innerHTML = logoMark(52);
    // La ilustración se monta recién cuando el mapa terminó de inicializar WebGL (lo más pesado del arranque; en equipos sin GPU
    // dibujar el SVG al mismo tiempo lo atrasaba ~1 s). El primer cuadro ya muestra el cielo, el logo y la barra; la escena entra con un fundido.
    let art = null;
    let fitFrame = 0;
    // Pantalla ancha: se ve toda la escena (el cielo y el suelo se extienden a los lados); angosta o vertical: se recorta al centro.
    const fit = () => {
        fitFrame = 0;
        if (!art) return;
        const h = art.getBoundingClientRect().height || 1;
        art.setAttribute('preserveAspectRatio', scene.clientWidth / h >= 2.14 ? 'xMidYMax meet' : 'xMidYMax slice');
    };
    const onResize = () => { if (!fitFrame) fitFrame = requestAnimationFrame(fit); };
    window.addEventListener('resize', onResize);
    let sceneTimer = null;
    const mountScene = () => {
        clearTimeout(sceneTimer);
        if (art || state === 'cerrada' || mode === 'short') return; // la versión corta no dibuja la escena: se va antes de que se luzca
        mountArt(scene, introScene(variant));
        art = scene.querySelector('svg');
        fit();
        requestAnimationFrame(() => root.classList.add('intro--escena'));
    };

    // ---- estado
    const t0 = performance.now();
    let state = 'cargando';          // cargando | listo | error | saliendo | cerrada
    let lastLabel = '';
    let lastValue = -1;
    let tipTimer = null;
    let shortTimer = null;
    let match = null;
    let resolveDone = noop;
    const done = new Promise((r) => { resolveDone = r; });
    const opener = document.activeElement;

    // Tips: orden determinístico por semilla (usuario + día), rotan cada TIP_MS (con movimiento reducido, uno fijo).
    const seed = `${cfg.user?.id ?? 0}:${new Date().toISOString().slice(0, 10)}`;
    const tips = pickTips(seed);
    let tipN = 0;
    const showTip = (n) => { tipEl.textContent = tipAt(tips, n); };
    showTip(0);
    if (!reduce && mode === 'full') {
        tipTimer = setInterval(() => {
            tipEl.classList.add('cambia');
            setTimeout(() => { tipN += 1; showTip(tipN); tipEl.classList.remove('cambia'); }, 320);
        }, TIP_MS);
    }

    function paint() {
        const v = progress.value();
        // el progreso se pinta en la barra y en --p (el sol sube, el cielo aclara): solo transform/opacity en el CSS
        if (v !== lastValue) {
            lastValue = v;
            fill.style.transform = `scaleX(${v})`;
            root.style.setProperty('--p', String(v));
            bar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
            bar.setAttribute('aria-valuetext', progressText(progress.label(), v));
        }
        const label = state === 'error' ? status.textContent : (progress.complete() ? 'Todo listo' : progress.label());
        if (label !== lastLabel && state !== 'error') {
            lastLabel = label;
            status.textContent = label; // role=status: se anuncia solo cuando cambia el paso (no en cada porcentaje)
        }
    }

    function onReady() {
        if (state !== 'cargando') return;
        state = 'listo';
        paint();
        if (mode === 'short') {
            const wait = Math.max(0, SHORT_MIN_MS - (performance.now() - t0));
            clearTimeout(shortTimer);
            shortTimer = setTimeout(() => close('auto'), wait);
            return;
        }
        root.dataset.estado = 'listo';
        enter.textContent = enterLabel(match);
        enter.hidden = false;
        enter.disabled = false;
        skip.hidden = true;
        // El foco pasa al botón: Enter o Espacio entran enseguida, sin buscar nada con el mouse.
        enter.focus({ preventScroll: true });
    }

    function close(how) {
        if (state === 'saliendo' || state === 'cerrada') return;
        state = 'saliendo';
        clearInterval(tipTimer);
        clearTimeout(shortTimer);
        clearTimeout(sceneTimer);
        try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* sin almacenamiento */ }
        // "Tocar" o "Saltar" son gestos del jugador: destraban el audio (la música arranca en este mismo toque)
        if (how === 'toque' || how === 'saltar') window.dispatchEvent(new CustomEvent('formosa:gesto'));
        root.classList.add('is-leaving');
        const finish = () => {
            if (state === 'cerrada') return;
            state = 'cerrada';
            root.remove();
            document.body.classList.remove('intro-activa');
            document.removeEventListener('focusin', keepFocus, true);
            window.removeEventListener('resize', onResize);
            // si mientras tanto se abrió el lobby o los resultados (partida en curso), el foco va a ese diálogo
            document.querySelector('.overlay:not([hidden]) .dialog')?.focus?.({ preventScroll: true });
            if (opener && document.contains(opener) && opener !== document.body) opener.focus?.({ preventScroll: true });
            resolveDone(how);
        };
        // sin animaciones (movimiento reducido) el CSS no dispara transitionend: se cierra por tiempo
        setTimeout(finish, reduce ? 120 : (mode === 'short' ? SHORT_FADE_MS + 20 : 760));
    }

    // ---- foco y teclado: el diálogo es modal mientras está
    function keepFocus(e) {
        if (state === 'cerrada' || state === 'saliendo') return;
        if (!root.contains(e.target)) {
            e.stopPropagation();
            (enter.hidden ? skip : enter).focus({ preventScroll: true });
        }
    }
    document.addEventListener('focusin', keepFocus, true);
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(state === 'listo' ? 'toque' : 'saltar');
        } else if (e.key === 'Tab') {
            const items = [skip, enter].filter((b) => !b.hidden && !b.disabled);
            if (items.length === 0) { e.preventDefault(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    enter.addEventListener('click', () => close('toque'));
    skip.addEventListener('click', () => close('saltar'));
    root.addEventListener('click', (e) => {
        if (state === 'listo' && !e.target.closest('button')) close('toque'); // "Tocá" en cualquier parte
    });

    if (mode === 'short') {
        skip.hidden = false;
        shortTimer = setTimeout(() => close('auto'), SHORT_MAX_MS);
    } else {
        // foco inicial en el propio diálogo: el lector de pantalla lee el título y el estado
        root.focus({ preventScroll: true });
    }
    paint();
    sceneTimer = setTimeout(mountScene, 1500); // por si el mapa tarda en avisar

    return {
        mode,
        /** Un paso de la carga terminó. */
        step(id) { if (id === 'mapa') mountScene(); progress.done(id); paint(); if (progress.complete()) onReady(); },
        /** Avance parcial de un paso (0 a 1). */
        set(id, frac) { progress.set(id, frac); paint(); },
        /** La carga falló: se muestra el mensaje y se deja entrar igual. */
        fail(message) {
            if (state === 'cerrada' || state === 'saliendo') return;
            state = 'error';
            clearInterval(tipTimer);
            status.textContent = message;
            root.dataset.estado = 'error';
            enter.textContent = 'Entrar igual';
            enter.hidden = false;
            enter.disabled = false;
            skip.hidden = true;
            enter.focus({ preventScroll: true });
        },
        /** "Tu partida: 23:10 restantes" bajo el título, y el botón dice "Volver a la partida". */
        note(text, matchState = null) {
            match = matchState;
            noteEl.textContent = text;
            noteEl.hidden = !text;
            if (state === 'listo') enter.textContent = enterLabel(match);
        },
        finish: () => close('auto'),
        isOpen: () => state !== 'cerrada',
        whenDone: () => done,
        progress: () => progress.value(),
    };
}

export const intro = createIntro();

// ---------------------------------------------------------------- barra chica de la vista 3D

/** Barra de progreso compacta (abajo, al centro) para cuando se arma la ciudad en 3D: mismos pasos reales, sin tapar el mapa. */
export function createCityLoader() {
    if (typeof document === 'undefined') return { step: noop, set: noop, close: noop };
    const progress = createProgress(CITY_STEPS);
    const chip = document.createElement('div');
    chip.className = 'city-loader';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    const label = document.createElement('span');
    label.className = 'city-loader-text';
    const track = document.createElement('span');
    track.className = 'city-loader-bar';
    track.setAttribute('aria-hidden', 'true');
    const fillEl = document.createElement('span');
    track.append(fillEl);
    chip.append(label, track);
    document.body.append(chip);
    let last = '';
    const paint = () => {
        fillEl.style.transform = `scaleX(${progress.value()})`;
        const text = `Armando la ciudad en 3D: ${progress.label()}`;
        if (text !== last) { last = text; label.textContent = text; }
    };
    paint();
    return {
        step(id) { progress.done(id); paint(); },
        set(id, frac) { progress.set(id, frac); paint(); },
        close() {
            chip.classList.add('cierra');
            setTimeout(() => chip.remove(), 400);
        },
    };
}
