// Datos derivados para los paneles del mapa (HUD de la partida y detalle de la propiedad). Puro: sin DOM ni red,
// así se prueba con node --test. main.js los calcula y los escribe en pantalla.

const MINUTE = 60_000;

/** Cuánto falta, en ms, para que termine el día de juego en curso (0 si la partida no corre). */
export function dayRemainingMs(clock, minutesPerDay) {
    const mpd = Number(minutesPerDay);
    if (!clock?.running || !(mpd > 0)) {
        return 0;
    }
    const fraction = Math.min(1, Math.max(0, Number(clock.dayFraction) || 0));
    return Math.max(0, Math.round((1 - fraction) * mpd * MINUTE));
}

/** Ingreso por minuto real, para dar una idea de cuánto entra mientras se mira el mapa. */
export function incomePerMinute(incomePerDay, minutesPerDay) {
    const mpd = Number(minutesPerDay);
    if (!(mpd > 0) || !(incomePerDay > 0)) {
        return 0;
    }
    return Math.round(incomePerDay / mpd);
}

/**
 * Distancia al líder (o ventaja sobre el segundo) a partir de la tabla de `standings()`.
 * Devuelve null si no hay con quién compararse (solo, o el jugador abandonó).
 *
 * @returns {{kind: 'lead'|'behind', amount: number, name: string}|null}
 */
export function leaderGap(rows) {
    const active = (rows ?? []).filter((r) => !r.abandoned);
    const mine = active.find((r) => r.isMe);
    if (!mine || active.length < 2) {
        return null;
    }
    if (mine.position === 1) {
        const second = active.filter((r) => !r.isMe).sort((a, b) => (b.net_worth ?? 0) - (a.net_worth ?? 0))[0];
        return { kind: 'lead', amount: Math.max(0, (mine.net_worth ?? 0) - (second.net_worth ?? 0)), name: second.name };
    }
    const leader = active.find((r) => r.position === 1) ?? active[0];
    return { kind: 'behind', amount: Math.max(0, (leader.net_worth ?? 0) - (mine.net_worth ?? 0)), name: leader.name };
}

/** Texto corto para el HUD. `money` es el formateador de plata de la pantalla. */
export function gapText(gap, money) {
    if (!gap) {
        return '';
    }
    return gap.kind === 'lead'
        ? `Vas 1.º con ${money(gap.amount)} sobre ${gap.name}`
        : `A ${money(gap.amount)} del 1.º (${gap.name})`;
}

/**
 * Qué pasa con el efectivo si se compra una propiedad: cuánto queda y si alcanza.
 * `available` es el efectivo libre (sin lo reservado en subastas).
 */
export function afterBuy(available, price) {
    const a = Number(available) || 0;
    const p = Number(price) || 0;
    return { ok: a >= p, left: a - p, missing: Math.max(0, p - a) };
}

/**
 * Qué parte de la partida tarda en recuperarse la inversión (0 a 1) y en cuántos días de juego.
 * Sirve para dibujar la barra de recupero: corta es buena, llena es "no llegás a recuperarla".
 *
 * @returns {{days: number, share: number, late: boolean}|null}
 */
export function paybackShare(price, incomePerDay, daysTotal, daysLeft = daysTotal) {
    if (!(incomePerDay > 0) || !(price > 0) || !(daysTotal > 0)) {
        return null;
    }
    const days = price / incomePerDay;
    return {
        days: Math.round(days * 10) / 10,
        share: Math.min(1, days / daysTotal),
        late: days > daysLeft,
    };
}
