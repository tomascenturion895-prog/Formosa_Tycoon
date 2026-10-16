// Resaltes (mis propiedades, subastas, selección) en una fuente chica aparte: solo las propiedades marcadas.
// Así el mapa no dibuja bordes extra sobre las miles de propiedades que no tienen nada que destacar.

const NONE = { mine: false, auction: false, contested: false, selected: false };

export function createHighlights({ map, properties, geometries }) {
    const marks = new Map(); // id de propiedad -> { mine, auction, contested, selected }
    let timer = null;

    function flush() {
        timer = null;
        const features = [];
        for (const [id, flags] of marks) {
            const geometry = geometries.get(id);
            if (geometry) {
                features.push({ type: 'Feature', geometry, properties: { id, kind: properties.get(id)?.kind ?? null, ...flags } });
            }
        }
        map.getSource('destacadas')?.setData({ type: 'FeatureCollection', features });
    }

    function schedule() {
        if (timer === null) {
            timer = setTimeout(flush, 16); // junta varios cambios seguidos en un solo redibujado
        }
    }

    return {
        /** Cambia marcas de una propiedad (solo las que se pasan). */
        set(id, patch) {
            const next = { ...(marks.get(id) ?? NONE), ...patch };
            if (next.mine || next.auction || next.contested || next.selected) {
                marks.set(id, next);
            } else {
                marks.delete(id);
            }
            schedule();
        },
        /** Marcas actuales de una propiedad (para pruebas). */
        get: (id) => ({ ...(marks.get(id) ?? NONE) }),
        flush,
        size: () => marks.size,
    };
}
