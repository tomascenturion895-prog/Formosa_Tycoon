// Lógica pura de la partida (sin DOM ni red): reloj, cuenta regresiva, avisos y posiciones.
// El servidor manda `started_at`, `ends_at`, `server_now` y `minutes_per_day` en milisegundos epoch. El navegador corrige
// su reloj con la diferencia contra `server_now`, así todos ven la misma cuenta regresiva aunque el dispositivo esté corrido.
// Se prueba con `npm run test:js`.

export const MINUTE = 60_000;

/** Avisos de tiempo restante, de menor a mayor urgencia (en ms). */
export const WARNINGS = [
    { key: 'cinco', ms: 5 * MINUTE },
    { key: 'uno', ms: 1 * MINUTE },
];

/** Diferencia (ms) entre el reloj del servidor y el local: `serverNow = Date.now() + offset`. */
export function serverOffset(serverNow, localNow = Date.now()) {
    return Number.isFinite(serverNow) ? serverNow - localNow : 0;
}

/** 2_345_000 -> "39:05". Nunca negativo. Con una hora o más: "1:02:03". */
export function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Texto hablado para lectores de pantalla: "39 minutos y 5 segundos". */
export function spokenCountdown(ms) {
    const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const part = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (m === 0) {
        return part(s, 'segundo', 'segundos');
    }
    return s === 0 ? part(m, 'minuto', 'minutos') : `${part(m, 'minuto', 'minutos')} y ${part(s, 'segundo', 'segundos')}`;
}

/**
 * Estado del reloj de una partida en un instante del servidor.
 * `gameDay` va de 0 a `days_total` (decimal); `day` es el número de día que se muestra (1 a days_total).
 */
export function matchClock(match, serverMs) {
    const mpd = Math.max(0.001, Number(match?.minutes_per_day) || 2);
    const total = Number(match?.days_total) || Math.max(1, Math.round((Number(match?.duration_minutes) || 40) / mpd));
    if (!match || match.started_at == null) {
        return { running: false, over: false, gameDay: 0, day: 0, daysTotal: total, dayFraction: 0, remainingMs: null, elapsedMs: 0, progress: 0 };
    }
    const endsAt = match.ends_at ?? match.started_at + total * mpd * MINUTE;
    const elapsedMs = Math.max(0, serverMs - match.started_at);
    const remainingMs = Math.max(0, endsAt - serverMs);
    const gameDay = Math.min(total, elapsedMs / (mpd * MINUTE));
    const over = remainingMs <= 0 || match.status === 'finished';
    return {
        running: !over,
        over,
        gameDay,
        day: over ? total : Math.min(total, Math.floor(gameDay) + 1),
        daysTotal: total,
        dayFraction: gameDay - Math.floor(gameDay),
        remainingMs,
        elapsedMs,
        progress: Math.min(1, gameDay / total),
    };
}

/** "Día 5/20" */
export const dayLabel = (clock) => `Día ${clock.day}/${clock.daysTotal}`;

/** Cuánto falta, en ms, para cada umbral que se cruzó entre dos lecturas (para avisar una sola vez cada uno). */
export function crossedWarnings(prevMs, nowMs) {
    if (prevMs == null || nowMs == null) {
        return [];
    }
    return WARNINGS.filter((w) => prevMs > w.ms && nowMs <= w.ms).map((w) => w.key);
}

/** Nivel visual de urgencia según lo que queda: 'normal', 'cinco' (últimos 5 min) o 'uno' (último minuto). */
export function warningLevel(remainingMs) {
    if (remainingMs == null) {
        return 'normal';
    }
    if (remainingMs <= WARNINGS[1].ms) {
        return 'uno';
    }
    return remainingMs <= WARNINGS[0].ms ? 'cinco' : 'normal';
}

/**
 * Tabla de posiciones: patrimonio de mayor a menor, luego más propiedades, luego nombre. Los empates de patrimonio
 * comparten puesto (como en el servidor: 1, 1, 3). Quienes abandonaron van al final.
 */
export function standings(players, meId = null) {
    const rows = [...(players ?? [])].map((p) => ({ ...p }));
    rows.sort((a, b) =>
        Number(Boolean(a.abandoned)) - Number(Boolean(b.abandoned))
        || (b.net_worth ?? 0) - (a.net_worth ?? 0)
        || (b.properties ?? 0) - (a.properties ?? 0)
        || String(a.name).localeCompare(String(b.name), 'es'));
    let prev = null;
    rows.forEach((r, i) => {
        const tie = prev && !r.abandoned && !prev.abandoned && prev.net_worth === r.net_worth;
        r.position = tie ? prev.position : i + 1;
        r.isMe = meId != null && r.user_id === meId;
        prev = r;
    });
    return rows;
}

/**
 * Efectivo proyectado entre dos lecturas: el servidor liquida el ingreso de forma continua (por día de juego), así que
 * el navegador lo "anima" sin pedir nada. Nunca pasa de `ends_at`.
 */
export function projectCash(cash, incomePerDay, fromServerMs, toServerMs, match) {
    const mpd = Math.max(0.001, Number(match?.minutes_per_day) || 2);
    const cap = match?.ends_at ?? Infinity;
    const to = Math.min(toServerMs, cap);
    const days = Math.max(0, to - Math.min(fromServerMs, cap)) / (mpd * MINUTE);
    return Math.floor(cash + (incomePerDay || 0) * days);
}

/** Recupero en días de juego, con un decimal ("7,5"); null si no rinde. */
export function paybackDays(price, incomePerDay) {
    if (!(incomePerDay > 0) || !(price > 0)) {
        return null;
    }
    return Math.round((price / incomePerDay) * 10) / 10;
}

export function paybackText(price, incomePerDay) {
    const d = paybackDays(price, incomePerDay);
    if (d === null) {
        return '—';
    }
    return `${String(d).replace('.', ',')} ${d === 1 ? 'día' : 'días'} de juego`;
}

/** Ordinal para el puesto: 1.º, 2.º… */
export const ordinal = (n) => `${n}.º`;

/** "Hace 3 min" / "ayer" para el historial, desde un epoch en ms. */
export function ago(ms, nowMs = Date.now()) {
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
    const d = Math.floor(s / 86_400);
    return d === 1 ? 'ayer' : `hace ${d} días`;
}

/** Mensaje de espera de la sala: cuánto falta para que venza si nadie la inicia. */
export function lobbyExpiry(match, serverMs) {
    return match?.lobby_expires_at ? Math.max(0, match.lobby_expires_at - serverMs) : null;
}
