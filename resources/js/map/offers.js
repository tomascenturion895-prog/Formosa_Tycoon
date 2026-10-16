import { getJson, postJson } from './api.js';
import { isActive } from './offers-model.js';

/**
 * Ofertas entre jugadores abiertas en la partida. El servidor manda la verdad: acá se guarda lo último que dijo y las cuentas
 * regresivas usan la HORA DEL SERVIDOR (`offset`), no la del dispositivo.
 */
export function createOffers() {
    const byId = new Map();
    let offset = 0; // hora del servidor - hora local, en ms
    let matchId = null;
    let feePct = 5;
    let floor = 100;

    const now = () => Date.now() + offset;
    const sync = (serverNow) => {
        if (Number.isFinite(serverNow)) {
            offset = serverNow - Date.now();
        }
    };
    const url = (path = '') => `/api/partidas/${matchId}/ofertas${path}`;

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
        const d = await getJson(url());
        if (id !== matchId) {
            return;
        }
        sync(d.server_now);
        feePct = d.fee_pct ?? feePct;
        floor = d.min_price ?? floor;
        byId.clear();
        for (const o of d.offers) {
            byId.set(o.id, o);
        }
    }

    /** Aplica una oferta (aviso en vivo o respuesta). Devuelve la versión anterior, si había. */
    function apply(o) {
        if (o.match_id != null && o.match_id !== matchId) {
            return null;
        }
        sync(o.server_now);
        const prev = byId.get(o.id) ?? null;
        if (isActive(o)) {
            byId.set(o.id, o);
        } else {
            byId.delete(o.id);
        }
        return prev;
    }

    return {
        setMatch,
        load,
        apply,
        now,
        get feePct() { return feePct; },
        get floor() { return floor; },
        get matchId() { return matchId; },
        get: (id) => byId.get(id),
        forProperty: (propertyId) => [...byId.values()].find((o) => o.property_id === propertyId) ?? null,
        list: () => [...byId.values()],
        open: (propertyId, minimo, comprarYa) => postJson(`/api/partidas/${matchId}/propiedades/${propertyId}/ofertar`, {}, { minimo, comprar_ya: comprarYa }),
        bid: (id, monto) => postJson(url(`/${id}/ofrecer`), {}, { monto }),
        accept: (id) => postJson(url(`/${id}/aceptar`)),
        cancel: (id) => postJson(url(`/${id}/retirar`)),
        close: (id) => postJson(url(`/${id}/cerrar`)),
    };
}
