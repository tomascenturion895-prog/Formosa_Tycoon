// Cinemática de carga: la parte PURA (sin DOM). Progreso ponderado de la carga real, elección de tips con semilla,
// decisión de qué versión mostrar (completa, corta o ninguna) y textos. Se prueba con `npm run test:js`.
import { hashSeed, mulberry32 } from './rng.js';

// ---------------------------------------------------------------- pasos de la carga y su peso

/** Cada paso es algo que de verdad se espera: el peso es cuánto del tiempo total suele llevar. */
export const STEP_DEFS = {
    mapa: { w: 15, label: 'Armando el mapa' },
    propiedades: { w: 25, label: 'Leyendo las propiedades' },
    calles: { w: 10, label: 'Trazando las calles' },
    partida: { w: 15, label: 'Buscando tu partida' },
    duenos: { w: 15, label: 'Sincronizando los dueños' },
    dibujo: { w: 20, label: 'Dibujando la ciudad' },
    // vista 3D (barra chica al activarla)
    entorno: { w: 15, label: 'Bajando el entorno (agua y parques)' },
    modulo: { w: 10, label: 'Preparando el motor 3D' },
    armado: { w: 55, label: 'Levantando los edificios' },
    luces: { w: 20, label: 'Preparando luces y texturas' },
};

export const LOAD_STEPS = ['mapa', 'propiedades', 'calles', 'partida', 'duenos', 'dibujo'];
export const LOAD_STEPS_GUEST = ['mapa', 'propiedades', 'calles', 'dibujo'];
export const CITY_STEPS = ['entorno', 'modulo', 'armado', 'luces'];

/**
 * Progreso ponderado. `ids` son los pasos que esta carga espera (un visitante sin cuenta no espera la partida).
 * set(id, 0..1) permite avanzar a medias un paso; done(id) lo completa. Nunca retrocede.
 */
export function createProgress(ids) {
    const steps = ids.map((id) => ({ id, w: STEP_DEFS[id]?.w ?? 10, frac: 0 }));
    const total = steps.reduce((s, x) => s + x.w, 0) || 1;
    const find = (id) => steps.find((s) => s.id === id);
    return {
        set(id, frac) {
            const s = find(id);
            if (s) s.frac = Math.max(s.frac, Math.min(1, Math.max(0, Number(frac) || 0)));
        },
        done(id) { this.set(id, 1); },
        /** 0 a 1 */
        value: () => steps.reduce((s, x) => s + x.w * x.frac, 0) / total,
        complete: () => steps.every((s) => s.frac >= 1),
        /** Etiqueta del primer paso pendiente (el que se está esperando ahora). */
        label() {
            const next = steps.find((s) => s.frac < 1);
            return next ? `${STEP_DEFS[next.id]?.label ?? 'Cargando'}…` : 'Todo listo';
        },
        pending: () => steps.filter((s) => s.frac < 1).map((s) => s.id),
        ids: () => steps.map((s) => s.id),
    };
}

// ---------------------------------------------------------------- tips de estrategia

export const TIPS = [
    'Cada propiedad rinde por día de juego, y un día dura 2 minutos reales. Comprá temprano: la plata trabaja mientras mirás el mapa.',
    'Gana quien termina con más patrimonio: efectivo más el valor de todas tus propiedades. Gastar bien importa más que guardar.',
    'Mirá "Se recupera en": cuanto menos tarda un edificio en devolverte lo que costó, mejor negocio es al principio de la partida.',
    'Si nadie disputa tu reclamo en 5 segundos, la propiedad es tuya al precio de lista.',
    'Una puja en los últimos 5 segundos de una subasta la extiende. Guardate plata para el final.',
    'Una puja que va ganando reserva efectivo: no te quedes sin plata para otras jugadas.',
    'Los supermercados y los hoteles son pocos y rinden más por peso: conviene pelearlos en subasta.',
    'En los últimos 5 minutos la música se acelera. Es la hora de cerrar la jugada: lo que no rinde antes del final no suma.',
    'Con H ocultás los paneles y ves solo el mapa. Con M silenciás la música.',
    'En la vista 3D tus edificios tienen el techo dorado y los de otros, el color de su dueño.',
    'Tocá el reloj de la ciudad para dejar la luz de día fija, o dejá que corra: un día de juego es un día de la ciudad.',
    'El ranking suma puntos por partida: cada puesto cuenta, no solo el primero.',
];

/** Lista de tips en un orden que depende de la semilla (misma semilla, mismo orden). Mezcla de Fisher-Yates con mulberry32. */
export function pickTips(seed, count = TIPS.length, tips = TIPS) {
    const rng = mulberry32(hashSeed('tips', seed));
    const list = tips.slice();
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, Math.max(1, Math.min(count, list.length)));
}

/** Tip que corresponde al número de rotación n (da la vuelta). */
export const tipAt = (list, n) => list[((n % list.length) + list.length) % list.length];

// ---------------------------------------------------------------- qué versión mostrar

export const SHORT_MAX_MS = 750;    // la versión corta empieza a irse como mucho a los 750 ms...
export const SHORT_FADE_MS = 450;   // ...y se desvanece en 450: en total ≤ 1,2 s
export const SHORT_MIN_MS = 400;    // pero se deja ver un instante para que no parpadee

/**
 * 'none' (sin cinemática), 'short' (≤ 1,2 s, se cierra sola) o 'full' (con "Tocá para jugar").
 *  - ?intro=0 la apaga; ?intro=1 fuerza la completa y ?intro=corta la corta (también bajo automatización)
 *  - navegador automatizado o /mapa?p=ID (moderación): ninguna
 *  - ya se vio en esta pestaña, o es una recarga / volver atrás (caché caliente): corta
 */
export function introMode({ param = null, webdriver = false, seen = false, warm = false, hasPropertyParam = false } = {}) {
    if (param === '0') return 'none';
    if (param === '1') return 'full';
    if (param === 'corta') return 'short';
    if (webdriver || hasPropertyParam) return 'none';
    return seen || warm ? 'short' : 'full';
}

/** Momento del día para elegir la ilustración: sol saliendo (por defecto) o atardecer entre las 16 y las 20. */
export function sceneVariant(hour) {
    const h = Number.isFinite(hour) ? hour : 9;
    return h >= 16 && h < 20 ? 'atardecer' : 'amanecer';
}

// ---------------------------------------------------------------- textos

/** Línea de la partida en curso: "Tu partida: 23:10 restantes" o la sala que te espera. Vacío si no hay nada. */
export function matchNote(match, remainingText) {
    if (!match) return '';
    if (match.status === 'running') return `Tu partida: ${remainingText} restantes`;
    if (match.status === 'lobby') return match.name ? `Tu sala te espera: ${match.name}` : 'Tu sala te espera';
    return '';
}

export const enterLabel = (match) => (match?.status === 'running' ? 'Volver a la partida' : match?.status === 'lobby' ? 'Volver a la sala' : 'Tocá para jugar');

/** Texto accesible para la barra: "Armando el mapa… 42 %" */
export const progressText = (label, value) => `${label} ${Math.round(Math.min(1, Math.max(0, value)) * 100)} %`;
