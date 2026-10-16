// Estado "visto" de las guías: qué versión de cada una vio esta persona en este navegador.
// Se guarda en localStorage como JSON { [id]: versión }. Todo acceso va dentro de try/catch (modo privado, almacenamiento
// bloqueado o lleno): si no se puede guardar, la guía queda vista solo durante la sesión y nada se rompe.

import { GUIDES } from './guides-model.js';

export const STORAGE_KEY = 'formosa.guias.v1';

/** Solo se aceptan versiones enteras positivas; cualquier otra cosa (contenido corrupto) se descarta. */
function parse(raw) {
    try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return {};
        }
        const clean = {};
        for (const [id, v] of Object.entries(data)) {
            if (Number.isInteger(v) && v >= 1) {
                clean[id] = v;
            }
        }
        return clean;
    } catch {
        return {};
    }
}

export function createGuideState(storage) {
    let seen = {};
    try {
        seen = parse(storage?.getItem(STORAGE_KEY));
    } catch {
        seen = {};
    }

    const status = (guide) => {
        const v = seen[guide.id];
        if (v === undefined) {
            return 'new';
        }
        return v >= guide.version ? 'seen' : 'updated';
    };

    return {
        status,
        mark(guide) {
            seen = { ...seen, [guide.id]: guide.version };
            try {
                storage?.setItem(STORAGE_KEY, JSON.stringify(seen));
            } catch {
                // sin almacenamiento: queda vista en esta sesión
            }
        },
        /** Guías automáticas del lugar que todavía no se vieron (o cambiaron de versión), en el orden del catálogo. */
        pendingAuto(place, ctx = {}) {
            return (ctx.catalog ?? GUIDES).filter((g) => g.place === place && g.auto && status(g) !== 'seen' && (!g.available || g.available(ctx)));
        },
    };
}
