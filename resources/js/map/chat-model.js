// Lógica pura del chat con dos canales (sin DOM ni red): qué mensajes hay en cada canal, no leídos, pestaña activa y
// si la sala se puede escribir. Se prueba con `npm run test:js`.
//
//  - "sala":   los jugadores de MI partida (con los avisos automáticos del juego, `kind: 'sistema'`).
//  - "global": todos los jugadores, charla libre.

export const TABS = ['sala', 'global'];
export const KEEP = 200; // mensajes que se mantienen en pantalla por canal

/** Lista de mensajes de UN canal: ordenada por número del servidor, sin repetidos y con tope. */
export function createFeed(keep = KEEP) {
    const byId = new Map();
    let lastId = 0;

    return {
        /** 'nuevo' (llegó al final), 'tarde' (llegó fuera de orden: hay que redibujar), 'repetido' o 'invalido'. */
        add(m) {
            if (!m || !Number.isSafeInteger(m.id) || m.id <= 0) {
                return 'invalido';
            }
            if (byId.has(m.id)) {
                return 'repetido';
            }
            byId.set(m.id, m);
            if (m.id > lastId) {
                lastId = m.id;
                return 'nuevo';
            }
            return 'tarde';
        },
        remove: (id) => byId.delete(id),
        has: (id) => byId.has(id),
        get: (id) => byId.get(id),
        get size() { return byId.size; },
        lastId: () => lastId,
        /** Mensajes en orden de número. */
        sorted: () => [...byId.values()].sort((a, b) => a.id - b.id),
        /** Saca los más viejos que pasen el tope; devuelve sus números. */
        trim() {
            const out = [];
            if (byId.size <= keep) {
                return out;
            }
            for (const id of [...byId.keys()].sort((a, b) => a - b).slice(0, byId.size - keep)) {
                byId.delete(id);
                out.push(id);
            }
            return out;
        },
        clear() {
            byId.clear();
            lastId = 0;
        },
    };
}

export const isSystem = (m) => m?.kind === 'sistema';
export const isOwn = (m, userId) => userId != null && !isSystem(m) && m?.user_id === userId;

/**
 * ¿Suma un no leído? Solo los mensajes de OTRAS PERSONAS (ni los propios ni los avisos del juego, que son informativos y
 * si no una racha de compras llenaría la insignia) y solo si no los está mirando: chat cerrado, otra pestaña, o ventana oculta.
 */
export function countsAsUnread(m, { userId = null, open = false, tabActive = false, hidden = false } = {}) {
    if (!m || isSystem(m) || isOwn(m, userId)) {
        return false;
    }
    return !open || !tabActive || hidden;
}

/** Insignia: '' sin pendientes, el número, o '99+'. */
export function badgeText(n) {
    const v = Math.max(0, Math.trunc(Number(n) || 0));
    return v === 0 ? '' : v > 99 ? '99+' : String(v);
}

/** Nombre accesible de una pestaña: "Sala, 3 mensajes sin leer". */
export function tabLabel(name, unread) {
    const base = name === 'sala' ? 'Sala' : 'Global';
    const n = Math.max(0, Math.trunc(Number(unread) || 0));
    return n === 0 ? base : `${base}, ${n} ${n === 1 ? 'mensaje sin leer' : 'mensajes sin leer'}`;
}

/** Nombre accesible del botón que abre el chat, con el total de no leídos de ambos canales. */
export function toggleLabel(counts) {
    const total = TABS.reduce((sum, t) => sum + Math.max(0, Number(counts?.[t]) || 0), 0);
    return total > 0 ? `Chat, ${total} ${total === 1 ? 'mensaje sin leer' : 'mensajes sin leer'}` : 'Chat';
}

export const totalUnread = (counts) => TABS.reduce((sum, t) => sum + Math.max(0, Number(counts?.[t]) || 0), 0);

/**
 * Pestaña que se muestra. Sin sala solo hay Global. Con sala, la que el jugador eligió la última vez; si nunca eligió,
 * la Sala (es donde pasa lo que le importa en la partida).
 */
export function pickTab({ saved = null, hasRoom = false } = {}) {
    if (!hasRoom) {
        return 'global';
    }
    return saved === 'global' || saved === 'sala' ? saved : 'sala';
}

/** Siguiente pestaña con las flechas (circular, solo entre las disponibles). */
export function stepTab(current, dir, available) {
    const list = TABS.filter((t) => available.includes(t));
    if (list.length === 0) {
        return current;
    }
    const i = list.indexOf(current);
    return list[(i + dir + list.length) % list.length];
}

/**
 * Qué hacer con la sala del chat según lo que dice el servidor de MI partida.
 *  - `match` en sala de espera o en juego: sala abierta (se puede escribir).
 *  - sin partida, pero venía de una EN JUEGO (terminó o abandoné): la sala queda en SOLO LECTURA con su historial.
 *  - sin partida, pero venía de la sala de espera (salí o venció): ya no soy de ese chat, se cierra.
 *  - terminada / vencida con el objeto todavía presente: solo lectura / cierre, igual que arriba.
 *
 * @param {{id:number,status:string}|null} match  la partida actual del jugador (o null)
 * @param {{id:number,status:string}|null} prev   la sala que el chat tenía hasta ahora (`id` y último `status` conocido)
 * @returns {{action:'abrir'|'cambiar'|'solo-lectura'|'cerrar'|'nada', id:number|null, status:string|null}}
 */
export function roomTransition(match, prev) {
    const live = match && (match.status === 'lobby' || match.status === 'running');
    if (live) {
        if (!prev) {
            return { action: 'abrir', id: match.id, status: match.status };
        }
        if (prev.id !== match.id) {
            return { action: 'cambiar', id: match.id, status: match.status };
        }
        return { action: 'nada', id: match.id, status: match.status }; // lobby -> running de la misma partida: sigue la misma sala
    }
    if (!prev) {
        return { action: 'nada', id: null, status: null };
    }
    if (prev.readonly) {
        return { action: 'nada', id: prev.id, status: prev.status }; // ya está en solo lectura: así sigue hasta que empiece otra partida
    }
    if (match && match.id === prev.id && match.status === 'expired') {
        return { action: 'cerrar', id: null, status: null };
    }
    if (prev.status === 'running' || (match && match.id === prev.id && match.status === 'finished')) {
        return { action: 'solo-lectura', id: prev.id, status: 'finished' };
    }
    return { action: 'cerrar', id: null, status: null };
}

/** Texto para el campo de escribir según el canal y si se puede. */
export function composerText(tab, { writable = true, loggedIn = true } = {}) {
    if (!loggedIn) {
        return { placeholder: '', label: '', disabled: true };
    }
    if (tab === 'sala') {
        return writable
            ? { placeholder: 'Escribí a tu sala…', label: 'Mensaje para tu sala', disabled: false }
            : { placeholder: 'Sala en solo lectura', label: 'Mensaje para tu sala (solo lectura)', disabled: true };
    }
    return { placeholder: 'Escribí a todos (global)…', label: 'Mensaje para el chat global', disabled: false };
}

/** Mensaje de error en castellano según lo que contestó el servidor (`{status, data}`) o un fallo de red (null). */
export function chatErrorText(err, hhmm = (ms) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })) {
    if (!err || err.status == null) {
        return 'No se pudo enviar. Revisá tu conexión y probá de nuevo.';
    }
    const { status, data = {} } = err;
    if (data.error === 'silenciado' && Number.isFinite(data.hasta)) {
        return `Un moderador te silenció en el chat (sala y global). Podés volver a escribir a las ${hhmm(data.hasta)}`;
    }
    if (data.error === 'sala_solo_lectura') {
        return 'Esa sala ya no está en juego: quedó solo para leer.';
    }
    if (data.error === 'no_estas_en_partida') {
        return 'Ya no sos parte de esa sala.';
    }
    if (status === 403 && !data.error) {
        return 'No tenés permiso para hacer eso.';
    }
    if (status === 429 && !data.error) {
        return 'Vas muy rápido. Esperá unos segundos.';
    }
    return data.errors?.mensaje?.[0] ?? data.message ?? `Error ${status}`;
}
