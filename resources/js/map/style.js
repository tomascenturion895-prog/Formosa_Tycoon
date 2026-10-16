// Estilo del mapa: sin teselas externas. Fondo + calles (GeoJSON propio) + propiedades (GeoJSON propio).

const EMPTY = { type: 'FeatureCollection', features: [] };
const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'];

/** Expresión `match` por tipo de propiedad: ['match', ['get','kind'], 'casa', v1, 'hotel', v2, ..., fallback]. */
function byKind(kinds, pick, fallback) {
    const expr = ['match', ['get', 'kind']];
    for (const [key, cfg] of Object.entries(kinds)) {
        expr.push(key, pick(cfg));
    }
    expr.push(fallback);
    return expr;
}

export function kindFilter(visibleKinds) {
    return ['in', ['get', 'kind'], ['literal', visibleKinds]];
}

// Capas de resaltado: viven en una fuente aparte ("destacadas") con solo las propiedades marcadas (unas pocas),
// así no se dibujan bordes extra sobre las ~12.500 propiedades del mapa.
const HIGHLIGHT_FLAG = { 'propiedades-mias': 'mine', 'propiedades-subasta': 'auction', 'propiedades-seleccion': 'selected' };

export const PROPERTY_LAYERS = ['propiedades-relleno', 'propiedades-borde', 'propiedades-mias', 'propiedades-subasta', 'propiedades-seleccion', 'propiedades-3d'];

/** Filtro de cada capa de propiedades según los tipos visibles (los resaltes además exigen su marca). */
export function layerFilters(visibleKinds) {
    const byKindFilter = kindFilter(visibleKinds);
    const out = {};
    for (const id of PROPERTY_LAYERS) {
        out[id] = HIGHLIGHT_FLAG[id] ? ['all', ['==', ['get', HIGHLIGHT_FLAG[id]], true], byKindFilter] : byKindFilter;
    }
    return out;
}

/** '#rrggbb' con transparencia, como 'rgba(r, g, b, a)'. */
function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function buildStyle(kinds) {
    // Lo libre va translúcido (las casas, que son miles, más todavía) y lo que tiene dueño, opaco en el color de su jugador.
    // La transparencia va dentro del color: MapLibre no aplica feature-state en fill-opacity, sí en fill-color.
    const kindColor = byKind(kinds, (c) => c.color, '#cccccc');
    const freeColor = byKind(kinds, (c) => withAlpha(c.color, c === kinds.casa ? 0.7 : 0.92), 'rgba(204, 204, 204, 0.7)');
    const owned = ['boolean', ['feature-state', 'owned'], false];
    const colorWithOwner = ['case', owned, ['coalesce', ['feature-state', 'color'], '#888888'], kindColor];
    const fillColor = ['case', owned, ['coalesce', ['feature-state', 'color'], '#888888'], freeColor];

    const road = (id, filter, casing, width) => [
        {
            id: `${id}-borde`, type: 'line', source: 'calles', filter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#d3cdbd', 'line-width': casing },
        },
        {
            id, type: 'line', source: 'calles', filter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': width },
        },
    ];
    const isMajor = ['in', ['get', 'highway'], ['literal', MAJOR]];

    return {
        version: 8,
        sources: {
            calles: { type: 'geojson', data: EMPTY },
            // promoteId: el id de cada propiedad es la clave del "estado" (dueño, selección).
            propiedades: { type: 'geojson', data: EMPTY, promoteId: 'id' },
            destacadas: { type: 'geojson', data: EMPTY },
            // Zona de un evento activo (verde/rojo) o anunciado (azul): un recuadro sobre la celda de la grilla.
            'zonas-evento': { type: 'geojson', data: EMPTY },
        },
        layers: [
            { id: 'fondo', type: 'background', paint: { 'background-color': '#ebe8e0' } },
            ...road('calles-menores', ['!', isMajor], ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 7, 19, 24], ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 5, 19, 20]),
            ...road('calles-principales', isMajor, ['interpolate', ['linear'], ['zoom'], 13, 2, 16, 11, 19, 32], ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 9, 19, 28]),
            {
                // Línea punteada amarilla al medio de las calles: solo en la vista 3D (estilo ciudad).
                id: 'calles-centro', type: 'line', source: 'calles', minzoom: 15, layout: { visibility: 'none', 'line-cap': 'butt' },
                paint: { 'line-color': '#ffd36b', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 19, 3], 'line-dasharray': [3, 3] },
            },
            {
                id: 'propiedades-relleno', type: 'fill', source: 'propiedades',
                // Sin antialias: evita un segundo pase de dibujo por cada una de las miles de propiedades.
                paint: { 'fill-color': fillColor, 'fill-antialias': false },
            },
            {
                // El borde recién se nota de cerca; de lejos son miles de líneas que no aportan nada.
                id: 'propiedades-borde', type: 'line', source: 'propiedades', minzoom: 14.5,
                paint: { 'line-color': '#6b6455', 'line-width': ['interpolate', ['linear'], ['zoom'], 14.5, 0.2, 18, 1], 'line-opacity': 0.6 },
            },
            {
                id: 'zonas-evento-relleno', type: 'fill', source: 'zonas-evento',
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 },
            },
            {
                id: 'zonas-evento-borde', type: 'line', source: 'zonas-evento',
                paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [2, 1.5] },
            },
            {
                // Las del jugador de esta sesión llevan un borde dorado, para encontrarlas de un vistazo.
                id: 'propiedades-mias', type: 'line', source: 'destacadas', filter: ['==', ['get', 'mine'], true],
                paint: { 'line-color': '#ffb703', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 4] },
            },
            {
                // Propiedades reservadas o en subasta: borde naranja (rojo si ya hay disputa).
                id: 'propiedades-subasta', type: 'line', source: 'destacadas', filter: ['==', ['get', 'auction'], true],
                paint: {
                    'line-color': ['case', ['boolean', ['get', 'contested'], false], '#e4572e', '#f59f00'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 4],
                },
            },
            {
                id: 'propiedades-seleccion', type: 'line', source: 'destacadas', filter: ['==', ['get', 'selected'], true],
                paint: { 'line-color': '#111111', 'line-width': 3 },
            },
            {
                id: 'propiedades-3d', type: 'fill-extrusion', source: 'propiedades', layout: { visibility: 'none' },
                paint: {
                    'fill-extrusion-color': colorWithOwner,
                    'fill-extrusion-height': byKind(kinds, (c) => c.height, 6),
                    'fill-extrusion-opacity': 0.92,
                },
            },
        ],
    };
}
