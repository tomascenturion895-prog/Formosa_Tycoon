import { getJson, postJson } from './api.js';

const ACTIVE = new Set(['disputa', 'abierta']);
export const isActive = (a) => ACTIVE.has(a.status);

/**
 * Subastas activas en el navegador. El servidor manda la verdad: acá se guarda lo último que dijo y se calcula
 * la cuenta regresiva con la HORA DEL SERVIDOR (`offset`), no con la del reloj del dispositivo, que puede estar corrido.
 */
export function createAuctions() {
    const byId = new Map();
    let offset = 0; // hora del servidor - hora local, en ms
    let disputeSeconds = 5;
    let matchId = null; // las subastas son de UNA partida: sin partida no hay ninguna

    const now = () => Date.now() + offset;

    function sync(serverNow) {
        if (Number.isFinite(serverNow)) {
            offset = serverNow - Date.now();
        }
    }

    /** Cambia de partida (o la deja en null): se olvidan las subastas de la anterior. */
    function setMatch(id) {
        if (id !== matchId) {
            matchId = id;
            byId.clear();
        }
    }

    async function load() {
        if (matchId === null) {
            byId.clear();
            return;
        }
        const id = matchId;
        const d = await getJson(`/api/partidas/${id}/subastas`);
        if (id !== matchId) {
            return; // mientras tanto se cambió de partida
        }
        sync(d.server_now);
        disputeSeconds = d.dispute_seconds;
        byId.clear();
        for (const a of d.auctions) {
            byId.set(a.id, a);
        }
    }

    /** Aplica una subasta (de un aviso en vivo o de una respuesta). Devuelve la versión anterior, si había. */
    function apply(a) {
        if (a.match_id != null && a.match_id !== matchId) {
            return null; // aviso de otra partida
        }
        sync(a.server_now);
        const prev = byId.get(a.id) ?? null;
        if (isActive(a)) {
            byId.set(a.id, a);
        } else {
            byId.delete(a.id);
        }
        return prev;
    }

    return {
        setMatch,
        load,
        apply,
        now,
        get disputeSeconds() { return disputeSeconds; },
        get: (id) => byId.get(id),
        forProperty: (propertyId) => [...byId.values()].find((a) => a.property_id === propertyId) ?? null,
        list: () => [...byId.values()].sort((x, y) => x.ends_at - y.ends_at),
        remainingMs: (a) => a.ends_at - now(),
        bid: (id, amount) => postJson(`/api/partidas/${matchId}/subastas/${id}/pujar`, {}, { monto: amount }),
        close: (id) => postJson(`/api/partidas/${matchId}/subastas/${id}/cerrar`),
        get matchId() { return matchId; },
    };
}

/** 83000 ms -> "1:23". Nunca negativo. */
export function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
