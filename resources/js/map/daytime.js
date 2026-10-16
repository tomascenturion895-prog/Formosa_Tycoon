// Hora interna de la ciudad. Dos relojes, los dos con la HORA DEL SERVIDOR (todos ven la misma hora y la misma luz):
//  - Dentro de una partida (`matchHours`): sale del inicio de ESA partida (`started_at`) y un día de juego dura
//    `minutes_per_day` minutos reales (2): la partida arranca al amanecer y da una vuelta completa por día de juego.
//  - Sin partida, modo exploración (`gameHours`): ciclo lento de 24 minutos por día (1 hora de juego = 1 minuto real).
// Es solo presentación: no cambia precios, ingresos ni subastas.
//
// Funciones puras (sin DOM ni mapa): se prueban con `npm run test:js`.

export const PHASES = [
    { key: 'madrugada', label: 'Madrugada', from: 0, icon: '🌌' },
    { key: 'dia', label: 'Día', from: 6, icon: '☀️' },
    { key: 'tarde', label: 'Tarde', from: 13, icon: '🌇' },
    { key: 'noche', label: 'Noche', from: 20, icon: '🌙' },
];

/** Hora de juego (0 a 24, con decimales) para un instante dado en ms del servidor. */
export function gameHours(serverMs, minutesPerDay = 24) {
    const dayMs = Math.max(1, minutesPerDay) * 60_000;
    const into = ((serverMs % dayMs) + dayMs) % dayMs;
    return (into / dayMs) * 24;
}

/** Minutos reales por día en el ciclo lento de exploración (sin partida). El servidor manda 2 en `clock.minutes_per_day` (el de la partida): no sirve para explorar. */
export const EXPLORE_MINUTES_PER_DAY = 24;

/** Hora del día de juego a la que arranca una partida (amanecer). */
export const START_HOUR = 6;

/**
 * Hora de juego (0 a 24) dentro de una partida: arranca en `startHour` al iniciar y da una vuelta por cada
 * `minutesPerDay` minutos reales. Antes de empezar (o con un reloj adelantado) queda en la hora de arranque.
 */
export function matchHours(serverMs, startedAt, minutesPerDay = 2, startHour = START_HOUR) {
    const dayMs = Math.max(0.001, minutesPerDay) * 60_000;
    const into = Math.max(0, serverMs - startedAt);
    return (startHour + ((into % dayMs) / dayMs) * 24) % 24;
}

/**
 * La hora que corresponde mostrar: la de la partida en curso (si hay una iniciada) o la del ciclo lento de exploración.
 * `match` = { started_at, minutes_per_day } o null.
 */
export function cityHours(serverMs, match, exploreMinutesPerDay = EXPLORE_MINUTES_PER_DAY) {
    if (match && Number.isFinite(match.started_at)) {
        return matchHours(serverMs, match.started_at, match.minutes_per_day || 2);
    }
    return gameHours(serverMs, exploreMinutesPerDay);
}

export function phaseAt(hours) {
    let phase = PHASES[0];
    for (const p of PHASES) {
        if (hours >= p.from) {
            phase = p;
        }
    }
    return phase;
}

/** "07:05" */
export function hhmm(hours) {
    const total = Math.floor(hours * 60) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// Multiplicadores de color de cada momento (como el ciclo de la ciudad pixel: día, atardecer, noche azulada).
const TINT_DAY = [1, 1, 1];
const TINT_DUSK = [0.98, 0.8, 0.74];
const TINT_NIGHT = [0.36, 0.43, 0.72];

const SUNRISE = 6.5;
const SUNSET = 19.5;

/**
 * Todo lo que la pantalla necesita para pintar la luz de una hora:
 *  - sun: elevación (-1 a 1, negativa de noche) y azimut en radianes (sale por el este, se pone por el oeste).
 *  - night: 0 de día a 1 de noche cerrada. warm: cuánto "atardecer" hay (amanecer y atardecer).
 *  - tint: multiplicador RGB para el suelo, las calles y el mapa 2D.
 *  - lights: encendido de ventanas y faroles (0 a 1).
 *  - sky / horizon: colores del cielo en la vista inclinada.
 */
export function lightAt(hours) {
    const dayLength = SUNSET - SUNRISE;
    const t = (hours - SUNRISE) / dayLength; // 0 al salir el sol, 1 al ponerse
    let elevation;
    if (t >= 0 && t <= 1) {
        elevation = Math.sin(Math.PI * t);
    } else {
        const sinceSunset = (hours - SUNSET + 24) % 24; // horas de noche transcurridas
        elevation = -Math.sin((Math.PI * sinceSunset) / (24 - dayLength));
    }
    const azimuth = Math.PI / 2 + Math.PI * clamp(t); // 90° (este) a 270° (oeste)

    const night = 1 - smooth(-0.18, 0.12, elevation);
    const warm = clamp(1 - Math.abs(elevation) / 0.35) * (1 - night * 0.6);
    let tint = mix3(TINT_DAY, TINT_DUSK, warm);
    tint = mix3(tint, TINT_NIGHT, night);

    const lights = clamp(smooth(0.25, -0.05, elevation));
    const skyDay = [0.53, 0.78, 0.96];
    const skyDusk = [0.98, 0.62, 0.45];
    const skyNight = [0.05, 0.08, 0.2];
    let sky = mix3(skyDay, skyDusk, warm);
    sky = mix3(sky, skyNight, night);
    let horizon = mix3([0.85, 0.92, 0.98], [1, 0.78, 0.55], warm);
    horizon = mix3(horizon, [0.16, 0.2, 0.38], night);

    return {
        hours,
        phase: phaseAt(hours).key,
        sun: { elevation, azimuth },
        night,
        warm,
        tint,
        lights,
        sky,
        horizon,
        sunIntensity: clamp(elevation * 1.6) * (1 - night),
        sunColor: mix3([1, 0.97, 0.9], [1, 0.62, 0.38], warm),
        ambient: mix(0.85, 0.32, night),
        ambientColor: mix3([1, 1, 1], [0.55, 0.62, 1], night),
    };
}

/** Color '#rrggbb' multiplicado por un tinte RGB (0 a 1). */
export function tintHex(hex, tint) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v, k) => Math.round(clamp(((n >> v) & 255) * k / 255) * 255).toString(16).padStart(2, '0');
    return `#${ch(16, tint[0])}${ch(8, tint[1])}${ch(0, tint[2])}`;
}

export function rgbCss([r, g, b]) {
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
