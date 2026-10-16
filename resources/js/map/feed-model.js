// Feed de actividad: las tarjetas que muestran lo que hacen los demás jugadores (compras, subastas, ventas).
// Puro, sin DOM ni red: feed.js dibuja y main.js conecta. Los avisos vienen del servidor (ActivityFeed) con datos ya públicos.

/** Cuánto dura una tarjeta en pantalla y cuántas se ven a la vez. */
export const SHOW_MS = 6500;
export const MAX_VISIBLE = 3;

/** Tipos que el mapa entiende (los mismos que ActivityFeed::TYPES). Uno desconocido se ignora sin romper nada. */
const TYPES = {
    compra: { tag: 'Compra', tone: 'gold' },
    subasta_ganada: { tag: 'Subasta', tone: 'gold' },
    venta: { tag: 'Venta', tone: 'grey' },
    reclamo: { tag: 'Reserva', tone: 'blue' },
    disputa: { tag: 'Disputa', tone: 'red' },
    oferta_abierta: { tag: 'Oferta', tone: 'blue' },
    oferta_vendida: { tag: 'Trato', tone: 'gold' },
};

export const isKnownType = (type) => Object.hasOwn(TYPES, type);

/** Etiqueta corta y tono de color de la tarjeta ('gold', 'grey', 'blue' o 'red'). */
export function cardStyle(type) {
    return TYPES[type] ?? { tag: '', tone: 'grey' };
}

/** Texto de la tarjeta. `money` es el formateador de plata de la pantalla. */
export function feedText(item, money) {
    const who = item.actor ?? 'Alguien';
    const what = item.label || 'una propiedad';
    const amount = money(Number(item.amount) || 0);
    switch (item.type) {
        case 'compra': return `${who} compró ${what} por ${amount}`;
        case 'subasta_ganada': return `${who} ganó la subasta de ${what} por ${amount}`;
        case 'venta': return `${who} vendió ${what} al banco por ${amount}`;
        case 'reclamo': return `${who} reservó ${what} por ${amount}`;
        case 'disputa': return `${who} disputa ${what} y puja ${amount}`;
        case 'oferta_abierta': return `${who} ofrece ${what} desde ${amount}`;
        case 'oferta_vendida': return `${who} le vendió ${what} a ${item.other ?? 'otro jugador'} por ${amount}`;
        default: return '';
    }
}

/**
 * ¿Se muestra esta tarjeta? No si el tipo es desconocido, si falta lo básico, si la hizo el propio jugador (ya lo ve en
 * pantalla) o si ya se mostró (Reverb puede repetir un aviso al reconectar).
 */
export function shouldShow(item, meId, seen) {
    if (!item || !isKnownType(item.type) || !Number.isInteger(item.property_id) || !item.key) {
        return false;
    }
    if (meId != null && item.actor_id === meId) {
        return false;
    }
    return !seen.has(item.key);
}

/** Agrega una tarjeta a las visibles (la más nueva al final) y devuelve { visible, dropped }: las que sobran salen por las más viejas. */
export function pushVisible(visible, item, max = MAX_VISIBLE) {
    const next = [...visible, item];
    const cut = Math.max(0, next.length - max);
    return { visible: next.slice(cut), dropped: next.slice(0, cut) };
}

/** Recuerda las últimas `limit` claves vistas (para no repetir) sin crecer sin fin en una partida larga. */
export function rememberKey(seen, key, limit = 60) {
    seen.add(key);
    while (seen.size > limit) {
        seen.delete(seen.values().next().value);
    }
}
