// Ofertas entre jugadores (lado del navegador): lógica pura, sin DOM ni red. offers.js guarda el estado y offers-ui.js dibuja.
// El servidor manda la verdad; acá solo se decide qué mostrar y se calculan los textos con la hora DEL SERVIDOR.

export const isActive = (o) => o?.status === 'abierta';

/** Lo que se queda el banco de una venta y lo que cobra el dueño (mismo redondeo que el servidor: hacia abajo). */
export function sellerNet(price, feePct) {
    const fee = Math.floor((price * Math.max(0, feePct)) / 100);
    return { fee, net: price - fee };
}

/** Precios sugeridos al ofrecer: el mínimo en el precio de lista y el "comprá ya" un 50 % arriba, redondeados a cientos. */
export function suggestPrices(listPrice, floor = 100) {
    const round = (n) => Math.max(floor, Math.round(n / 100) * 100);
    const min = round(listPrice);
    const max = round(listPrice * 1.5);
    return { min, max: max > min ? max : min + 100 };
}

/** '' si los dos precios sirven; si no, el motivo en castellano. */
export function validatePrices(min, max, floor = 100) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min <= 0 || max <= 0) {
        return 'Poné los dos montos en pesos, sin decimales.';
    }
    if (min < floor) {
        return `El mínimo tiene que ser de al menos ${floor}.`;
    }
    if (max <= min) {
        return 'El "comprá ya" tiene que ser mayor que el mínimo.';
    }
    return '';
}

/** 'ofertando' (se puede ofertar), 'decidiendo' (el dueño elige), 'vencida' (por cerrarse) o 'cerrada'. */
export function phase(o, now) {
    if (!isActive(o)) {
        return 'cerrada';
    }
    if (now < o.ends_at) {
        return 'ofertando';
    }
    return o.leader_id != null && now < o.decide_until ? 'decidiendo' : 'vencida';
}

/** ¿Ya corresponde pedirle al servidor que la cierre? Sin ofertas, al vencer el plazo de ofertar; con ofertas, al vencer el del dueño. */
export function isDue(o, now) {
    return isActive(o) && (o.leader_id == null ? now >= o.ends_at : now >= o.decide_until);
}

/** 'owner' (es mía), 'leader' (voy ganando), 'visitor' (otro jugador) o 'guest' (sin sesión). */
export function roleOf(o, meId) {
    if (meId == null) {
        return 'guest';
    }
    if (o.seller_id === meId) {
        return 'owner';
    }
    return o.leader_id === meId ? 'leader' : 'visitor';
}

/** ¿Puede ofertar `meId`? `available` = efectivo disponible (sin lo reservado). Devuelve { can, missing } (missing = lo que le falta). */
export function bidCheck(o, { meId, available, now }) {
    const role = roleOf(o, meId);
    if (role !== 'visitor' && role !== 'leader') {
        return { can: false, missing: 0 };
    }
    if (phase(o, now) !== 'ofertando') {
        return { can: false, missing: 0 };
    }
    const own = role === 'leader' ? o.current_bid ?? 0 : 0; // su propia reserva se libera al mejorar
    const missing = Math.max(0, o.min_next - (available + own));
    return { can: missing === 0, missing };
}

/** Cuenta regresiva según la fase. `clock` formatea milisegundos como m:ss. */
export function timerText(o, now, clock) {
    switch (phase(o, now)) {
        case 'ofertando': return `Se ofrece por ${clock(o.ends_at - now)} más`;
        case 'decidiendo': return o.seller_id == null ? '' : `${o.seller} decide en ${clock(o.decide_until - now)}`;
        case 'vencida': return 'Cerrando…';
        default: return '';
    }
}

/** Frase de estado de la oferta para quien la mira. */
export function statusText(o, meId, now, money) {
    const role = roleOf(o, meId);
    const ph = phase(o, now);
    if (role === 'owner') {
        if (o.leader_id == null) {
            return ph === 'ofertando' ? 'Tu propiedad está en oferta. Todavía nadie ofertó.' : 'Nadie ofertó.';
        }
        return ph === 'ofertando'
            ? `${o.leader} ofreció ${money(o.current_bid)}. Podés aceptar ya o esperar mejores ofertas.`
            : `Elegí: aceptás los ${money(o.current_bid)} de ${o.leader} o dejás pasar.`;
    }
    if (role === 'leader') {
        return ph === 'ofertando' ? 'Vas ganando. Si te superan, te aviso.' : `Esperando que ${o.seller} decida.`;
    }
    return ph === 'ofertando'
        ? `${o.seller} la ofrece. Ofertá entre ${money(o.min_price)} y ${money(o.buy_now_price)}.`
        : `${o.seller} está decidiendo.`;
}

/**
 * Aviso para el jugador cuando una oferta cambia (`prev` = lo último que se sabía, puede ser null). Devuelve { text, warn } o null.
 * `label` = nombre de la propiedad; `feePct` = comisión del banco.
 */
export function outcomeNotice(prev, o, meId, { money, label, feePct }) {
    if (meId == null) {
        return null;
    }
    if (isActive(o)) {
        if (prev?.leader_id === meId && o.leader_id !== meId) {
            return { text: `Te superaron en ${label}: ${money(o.current_bid)} de ${o.leader}.`, warn: true };
        }
        if (o.seller_id === meId && o.leader_id != null && prev?.leader_id !== o.leader_id) {
            return { text: `${o.leader} ofertó ${money(o.current_bid)} por ${label}.`, warn: false };
        }
        return null;
    }
    if (o.status === 'vendida') {
        if (o.seller_id === meId) {
            return { text: `Vendiste ${label} por ${money(o.sold_price)} (cobrás ${money(sellerNet(o.sold_price, feePct).net)}).`, warn: false };
        }
        if (o.leader_id === meId) {
            return { text: `¡Es tuya! Compraste ${label} por ${money(o.sold_price)}.`, warn: false };
        }
        return null;
    }
    if (prev?.leader_id === meId) {
        return {
            text: o.status === 'cancelada' ? `Retiraron la oferta por ${label}: se liberó tu plata.` : `La oferta por ${label} terminó sin venta: se liberó tu plata.`,
            warn: true,
        };
    }
    if (o.seller_id === meId && o.status === 'cerrada') {
        return { text: `Tu oferta por ${label} terminó sin venta.`, warn: true };
    }
    return null;
}
