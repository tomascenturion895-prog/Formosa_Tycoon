// Árboles de la ciudad 3D: lapachos, chivatos, paratodos, palmeras y los árboles genéricos de los patios.
// Formas low-poly reconocibles de lejos (copa redonda del lapacho, sombrilla del chivato, penachos de las palmeras)
// y floración según el mes real: los lapachos se ponen rosas a fin de invierno, el chivato rojo en verano.
//
// speciesFor / bloomColor / bloomAmount / placeYardTrees son puras (sin three ni DOM) y se prueban en node.
// createTreeLayer recibe THREE por parámetro: arma un InstancedMesh por especie y parte (tronco, copa).
import { hash01, Grid } from './city-geometry.js';

// ------------------------------------------------------------------ especies

/**
 * height: altura típica en metros (antes de la escala por ejemplar). palm: palmera (hojas de dos caras).
 * greens: verdes de la copa fuera de la floración. trunk: color del tronco. bloom: color de la flor (o null).
 */
export const SPECIES = {
    T1: { name: 'lapacho rosado', sci: 'Handroanthus impetiginosus', height: 13, palm: false, greens: ['#4f9a45', '#5aa64c', '#468d3f'], trunk: '#6b5040', bloom: '#e86aa6' },
    T2: { name: 'lapacho negro', sci: 'Handroanthus heptaphyllus', height: 15, palm: false, greens: ['#3f8a3e', '#4a9446', '#3a7f3a'], trunk: '#4f3d33', bloom: '#c06ad0' },
    T3: { name: 'chivato', sci: 'Delonix regia', height: 10, palm: false, greens: ['#5fae4a', '#6bb851', '#56a245'], trunk: '#8a7a68', bloom: '#e8452c' },
    T4: { name: 'paratodo', sci: 'Tabebuia aurea', height: 8.5, palm: false, greens: ['#6aa94e', '#74b257', '#62a048'], trunk: '#7d6a55', bloom: '#f2c230' },
    T5: { name: 'palma blanca', sci: 'Copernicia alba', height: 13, palm: true, greens: ['#7fa266', '#88aa6c', '#76985f'], trunk: '#a39a8c', bloom: null },
    T6: { name: 'yatay', sci: 'Butia yatay', height: 9, palm: true, greens: ['#5f9a6c', '#69a474', '#578f64'], trunk: '#6e665c', bloom: null },
    T7: { name: 'pindó', sci: 'Syagrus romanzoffiana', height: 14, palm: true, greens: ['#4fb04a', '#5cbc52', '#47a343'], trunk: '#9a9488', bloom: null },
    G: { name: 'árbol de patio', sci: null, height: 6.5, palm: false, greens: ['#58b45a', '#4c9a4f', '#3f8a46', '#6cc466', '#2f7f3e'], trunk: '#86603c', bloom: null },
};

export const SPECIES_KEYS = Object.keys(SPECIES);

// Intensidad de la floración por mes (1 = copa entera en flor). Los bordes de la temporada dan floración parcial.
const BLOOM = {
    // (fracción de ejemplares en flor ese mes; fuera de temporada, copa verde sana)
    T1: { 7: 0.6, 8: 1, 9: 0.8, 10: 0.08 }, // lapacho rosado: julio–septiembre
    T2: { 6: 0.55, 7: 1, 8: 0.75, 9: 0.1 }, // lapacho negro: invierno
    T3: { 11: 0.6, 12: 1, 1: 1, 2: 0.35 }, // chivato: noviembre–febrero
    T4: { 8: 1, 9: 0.8, 10: 0.05 }, // paratodo: agosto–septiembre
};

/** 0..1: cuánto florecida está la especie ese mes (1..12). */
export function bloomAmount(speciesKey, month) {
    const m = ((Math.round(month) - 1) % 12 + 12) % 12 + 1;
    return BLOOM[speciesKey]?.[m] ?? 0;
}

/** '#hex' de la flor si la especie está florecida ese mes (aunque sea en parte), si no null. */
export function bloomColor(speciesKey, month) {
    return bloomAmount(speciesKey, month) > 0 ? SPECIES[speciesKey].bloom : null;
}

// ------------------------------------------------------------------ qué especie va en cada lugar

/** Entero estable a partir de una posición redondeada a `step` metros. */
function posKey(x, y, step = 0.5) {
    const ix = Math.round(x / step) | 0, iy = Math.round(y / step) | 0;
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) | 0;
}

/** Elige de una tabla [[clave, peso], …] con un número 0..1. */
function weighted(table, r) {
    let total = 0;
    for (const [, w] of table) total += w;
    let acc = 0;
    for (const [k, w] of table) {
        acc += w / total;
        if (r < acc) return k;
    }
    return table[table.length - 1][0];
}

const MIX = {
    vereda: [['T1', 30], ['T2', 15], ['T3', 18], ['T4', 15], ['G', 22]],
    plaza: [['T1', 13], ['T2', 10], ['T3', 11], ['T4', 8], ['T5', 14], ['T6', 14], ['T7', 20], ['G', 10]],
    costanera: [['T5', 38], ['T6', 30], ['T3', 32]],
    patio: [['G', 90], ['T7', 5], ['T5', 3], ['T6', 2]],
    peatonal: [['T4', 60], ['T1', 40]],
};
MIX.campo = MIX.patio;

/**
 * Especie para un árbol según dónde está. Determinista por posición.
 * En los canteros centrales las palmeras van en hileras: cada tramo de ~60 m es casi todo de una misma especie.
 */
export function speciesFor(context, x, y) {
    const n = posKey(x, y);
    if (context === 'cantero') {
        const stretch = posKey(x, y, 60);
        const main = hash01(stretch, 501) < 0.7 ? 'T7' : 'T5';
        if (hash01(n, 502) < 0.88) return main;
        return main === 'T7' ? 'T5' : 'T7';
    }
    return weighted(MIX[context] ?? MIX.vereda, hash01(n, 503));
}

// ------------------------------------------------------------------ árboles en los fondos de las casas

/**
 * Árboles en los patios del fondo: detrás de cada edificio (del lado opuesto a la calle más cercana),
 * nunca dentro de un edificio (+1 m) ni sobre una calle o vereda (+2 m), separados al menos 6 m entre sí.
 * Puro y determinista. Si sobran candidatos se eligen salteados por hash, repartidos por toda la ciudad.
 *
 * @param buildingBoxes [[minX, minY, maxX, maxY], …]
 * @param query         { onRoad(x,y,margin), nearest(x,y) } de city-roads (o null)
 * @returns [{ x, y, context: 'patio' }]
 */
export function placeYardTrees(buildingBoxes, query, { max = 4000, spacing = 6 } = {}) {
    const blocked = new Grid(10);
    buildingBoxes.forEach((b, i) => blocked.addBox(b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1, i));
    const insideBuilding = (x, y) => {
        for (const i of blocked.near(x, y)) {
            const b = buildingBoxes[i];
            if (x >= b[0] - 1 && x <= b[2] + 1 && y >= b[1] - 1 && y <= b[3] + 1) return true;
        }
        return false;
    };
    const onRoad = (x, y) => (query?.onRoad ? query.onRoad(x, y, 2) : false);

    // candidatos: 2 por edificio, detrás (y algo al costado), con prioridad por hash
    const cands = [];
    for (let i = 0; i < buildingBoxes.length; i++) {
        const [a, b, c, d] = buildingBoxes[i];
        const cx = (a + c) / 2, cy = (b + d) / 2;
        const hx = (c - a) / 2, hy = (d - b) / 2;
        const k = posKey(cx, cy, 1);
        let dx, dy;
        const near = query?.nearest ? query.nearest(cx, cy) : null;
        if (near && (near.dirX || near.dirY)) {
            dx = -near.dirX; dy = -near.dirY; // hacia el fondo: lejos de la calle
        } else {
            const ang = hash01(k, 601) * Math.PI * 2;
            dx = Math.cos(ang); dy = Math.sin(ang);
        }
        const reach = Math.abs(dx) * hx + Math.abs(dy) * hy; // del centro al borde en esa dirección
        for (let j = 0; j < 2; j++) {
            const back = reach + 3 + hash01(k, 610 + j) * 5;
            const side = (hash01(k, 620 + j) - 0.5) * 2 * Math.max(hx, hy, 3);
            cands.push({ x: cx + dx * back - dy * side, y: cy + dy * back + dx * side, p: hash01(k, 630 + j) });
        }
    }
    cands.sort((u, v) => u.p - v.p);

    const placed = new Grid(spacing);
    const out = [];
    const tooClose = (x, y) => {
        for (let gx = -1; gx <= 1; gx++) {
            for (let gy = -1; gy <= 1; gy++) {
                for (const t of placed.near(x + gx * spacing, y + gy * spacing)) {
                    if ((t.x - x) ** 2 + (t.y - y) ** 2 < spacing * spacing) return true;
                }
            }
        }
        return false;
    };
    for (const c of cands) {
        if (out.length >= max) break;
        if (insideBuilding(c.x, c.y) || tooClose(c.x, c.y) || onRoad(c.x, c.y)) continue;
        const t = { x: c.x, y: c.y, context: 'patio' };
        placed.addBox(c.x, c.y, c.x, c.y, t);
        out.push(t);
    }
    return out;
}

// ------------------------------------------------------------------ geometría low-poly (arrays planos, sin three)

const ICO = (() => {
    const t = (1 + Math.sqrt(5)) / 2;
    const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
        .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, z / l, y / l]; }); // eje y↔z: vértice arriba
    const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    return { v, f: f.map(([a, b, c]) => [a, c, b]) }; // el cambio de ejes invierte el sentido: se corrige
})();

class Geo {
    constructor() {
        this.pos = [];
        this.col = [];
    }

    get tris() {
        return this.pos.length / 9;
    }

    tri(a, b, c, shade = [1, 1, 1]) {
        this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        for (let i = 0; i < 3; i++) this.col.push(shade[i], shade[i], shade[i]);
    }

    /** Tronco: prisma de n lados de (x0,y0,z0) radio r0 a (x1,y1,z1) radio r1, sin tapas. */
    prism(n, x0, y0, z0, r0, x1, y1, z1, r1, rot = 0, shade = 1) {
        for (let i = 0; i < n; i++) {
            const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2;
            const p = (x, y, z, r, a) => [x + Math.cos(a) * r, y + Math.sin(a) * r, z];
            const A = p(x0, y0, z0, r0, a0), B = p(x0, y0, z0, r0, a1), C = p(x1, y1, z1, r1, a1), D = p(x1, y1, z1, r1, a0);
            this.tri(A, B, C, [shade, shade, shade]);
            this.tri(A, C, D, [shade, shade, shade]);
        }
    }

    /** Copa: icosaedro deformado (20 triángulos), más oscuro abajo. jit: cuánto se mueven los vértices. */
    blob(cx, cy, cz, rx, ry, rz, seed, jit = 0.12, dark = 0.72) {
        const vs = ICO.v.map(([x, y, z], i) => {
            const j = 1 + (hash01(seed * 31 + i, 701) - 0.5) * 2 * jit;
            return [cx + x * rx * j, cy + y * ry * j, cz + z * rz * j];
        });
        for (const [a, b, c] of ICO.f) {
            const zc = (ICO.v[a][2] + ICO.v[b][2] + ICO.v[c][2]) / 3; // -1..1
            const s = dark + (1 - dark) * (zc * 0.5 + 0.5);
            this.tri(vs[a], vs[b], vs[c], [s, s, s]);
        }
    }

    /** Copa barata: bipirámide hexagonal (12 triángulos). */
    bipyr(cx, cy, cz, rx, ry, rz, seed, n = 6) {
        const ring = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + hash01(seed, 711) * 0.5;
            const j = 1 + (hash01(seed * 7 + i, 712) - 0.5) * 0.2;
            ring.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j, cz + (hash01(seed + i, 713) - 0.5) * rz * 0.3]);
        }
        const top = [cx, cy, cz + rz * 0.75], bot = [cx, cy, cz - rz * 0.7];
        for (let i = 0; i < n; i++) {
            const a = ring[i], b = ring[(i + 1) % n];
            this.tri(a, b, top, [1, 1, 1]);
            this.tri(b, a, bot, [0.72, 0.72, 0.72]);
        }
    }

    /** Sombrilla del chivato: disco ancho y chato, irregular. 4n triángulos. */
    umbrella(cx, cy, z, R, hTop, hBot, seed, n = 6) {
        const top = [], bot = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + 0.3;
            const j = 1 + (hash01(seed * 5 + i, 721) - 0.5) * 0.3;
            top.push([cx + Math.cos(a) * R * j, cy + Math.sin(a) * R * j, z + (hash01(seed * 5 + i, 722) - 0.5) * 0.6]);
            bot.push([cx + Math.cos(a + Math.PI / n) * R * 0.62, cy + Math.sin(a + Math.PI / n) * R * 0.62, z - hBot]);
        }
        const peak = [cx, cy, z + hTop], under = [cx, cy, z - hBot * 1.1];
        for (let i = 0; i < n; i++) {
            const i1 = (i + 1) % n;
            this.tri(top[i], top[i1], peak, [1, 1, 1]);
            this.tri(top[i], bot[i], top[i1], [0.84, 0.84, 0.84]);
            this.tri(top[i1], bot[i], bot[i1], [0.78, 0.78, 0.78]);
            this.tri(bot[i1], bot[i], under, [0.62, 0.62, 0.62]);
        }
    }

    /**
     * Hoja de palmera: tira con quilla que sale de (x,y,z) hacia `ang`; pasa a `midH` metros de altura (relativa)
     * al 55 % del largo y termina a `tipH`. segs = 1: un tramo de 4 triángulos + punta de 2; segs = 0: solo la punta.
     */
    frond(x, y, z, ang, len, midH, tipH, width, segs = 1, keel = 0.35) {
        const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
        const pts = segs ? [[0, 0], [0.55, midH], [1, tipH]] : [[0, 0], [1, tipH]];
        let prev = null;
        pts.forEach(([t, h], i) => {
            const c = [x + dx * len * t, y + dy * len * t, z + h];
            if (i === pts.length - 1) {
                this.tri(prev.c, prev.l, c, [0.95, 0.95, 0.95]);
                this.tri(prev.c, c, prev.r, [0.95, 0.95, 0.95]);
                return;
            }
            const w = width * (i === 0 ? (segs ? 0.3 : 0.7) : 1);
            const k = keel * w;
            const cur = { c, l: [c[0] + px * w, c[1] + py * w, c[2] - k], r: [c[0] - px * w, c[1] - py * w, c[2] - k] };
            if (prev) {
                this.tri(prev.c, prev.l, cur.l, [1, 1, 1]);
                this.tri(prev.c, cur.l, cur.c, [1, 1, 1]);
                this.tri(prev.c, cur.c, cur.r, [0.88, 0.88, 0.88]);
                this.tri(prev.c, cur.r, prev.r, [0.88, 0.88, 0.88]);
            }
            prev = cur;
        });
    }
}

/** Arma tronco y copa de cada especie. lod: 'baja' (barato) o 'media' (también 'alta'). */
function speciesGeometry(key, lod) {
    const lo = lod === 'baja';
    const trunk = new Geo(), crown = new Geo();
    const s = key.charCodeAt(1) || 71;
    switch (key) {
        case 'T1': // lapacho rosado: copa ancha y redondeada, tronco hasta la mitad
            trunk.prism(lo ? 3 : 5, 0, 0, 0, 0.42, 0.3, 0, 7, 0.22);
            if (lo) crown.bipyr(0.3, 0, 9.6, 5.6, 5.6, 3.6, s);
            else {
                crown.blob(0.2, 0, 9.3, 5.4, 5.4, 3.3, s);
                crown.blob(1.4, 0.9, 11, 3.6, 3.4, 2.3, s + 1);
            }
            break;
        case 'T2': // lapacho negro: más alto, copa ovalada y cerrada
            trunk.prism(lo ? 3 : 5, 0, 0, 0, 0.45, 0, 0.2, 8.5, 0.24);
            if (lo) crown.bipyr(0, 0.2, 11.4, 3.8, 3.8, 3.8, s);
            else {
                crown.blob(0, 0.2, 10.6, 3.7, 3.7, 3.6, s, 0.1);
                crown.blob(0.2, 0, 13.2, 2.6, 2.6, 2.1, s + 1, 0.1);
            }
            break;
        case 'T3': // chivato: tronco corto, ramas abiertas y copa en sombrilla ancha y chata
            trunk.prism(lo ? 3 : 4, 0, 0, 0, 0.5, 0, 0, 3, 0.38);
            if (!lo) {
                for (let i = 0; i < 3; i++) {
                    const a = (i / 3) * Math.PI * 2 + 0.4;
                    trunk.prism(3, 0, 0, 2.6, 0.26, Math.cos(a) * 3.2, Math.sin(a) * 3.2, 7, 0.12, a);
                }
            }
            crown.umbrella(0, 0, 7.6, 7.2, 2.1, 1.1, s, lo ? 5 : 7);
            break;
        case 'T4': // paratodo: chico, tronco torcido y copa irregular de 2–3 lóbulos
            if (lo) trunk.prism(3, 0, 0, 0, 0.32, 0.8, 0.3, 4.6, 0.18);
            else {
                trunk.prism(3, 0, 0, 0, 0.32, 0.9, 0.2, 2.6, 0.24);
                trunk.prism(3, 0.9, 0.2, 2.6, 0.24, 0.1, 0.8, 5.2, 0.15, 0.5);
            }
            if (lo) crown.bipyr(0.3, 0.6, 6.6, 3.2, 2.6, 1.9, s);
            else {
                crown.blob(-0.6, 0.7, 6.4, 2.7, 2.4, 1.7, s, 0.2);
                crown.blob(1.6, -0.3, 7.2, 2.1, 2, 1.4, s + 1, 0.2);
            }
            break;
        case 'T5': { // palma blanca: tronco fino y alto, copa redonda y chica de abanicos; pollera de hojas secas
            trunk.prism(lo ? 3 : 4, 0, 0, 0, 0.3, 0, 0, 11.6, 0.22);
            if (!lo) trunk.prism(4, 0, 0, 10.6, 0.3, 0, 0, 12.2, 1.1, 0.3); // pollera de hojas secas
            if (lo) crown.bipyr(0, 0, 12.6, 1.8, 1.8, 1.4, s);
            else {
                crown.blob(0, 0, 12.9, 2, 2, 1.6, s, 0.22, 0.78);
                const n = 3;
                for (let i = 0; i < n; i++) {
                    const a = (i / n) * Math.PI * 2 + 0.6;
                    crown.frond(0, 0, 13, a, 3, 0.9, 1.3 - i * 0.6, 1.2, 1, 0.1); // abanicos duros
                }
            }
            break;
        }
        case 'T6': { // yatay: tronco grueso, hojas arqueadas azuladas
            trunk.prism(lo ? 3 : 5, 0, 0, 0, 0.55, 0, 0, 7.2, 0.48);
            const n = lo ? 5 : 6;
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + hash01(i, 731) * 0.4;
                const up = i % 2 === 0;
                crown.frond(0, 0, 7.1, a, up ? 3.6 : 4.6, up ? 2.6 : 1.9, up ? 1.6 : -1.6, 0.75, lo ? 0 : 1, 0.45);
            }
            if (!lo) crown.prism(3, 0, 0, 6.3, 0.75, 0, 0, 8.2, 0.2); // la base de las hojas
            break;
        }
        case 'T7': { // pindó: alto y fino, hojas largas que cuelgan
            trunk.prism(lo ? 3 : 5, 0, 0, 0, 0.3, 0, 0, 12.4, 0.26);
            const n = lo ? 5 : 7;
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + hash01(i, 741) * 0.35;
                const up = i % 3 === 0;
                crown.frond(0, 0, 12.3, a, up ? 4.6 : 5.6, up ? 2.2 : 0.9, up ? 0.6 : -3.4, 0.85, lo ? 0 : 1, 0.4);
            }
            break;
        }
        default: // G: árbol de patio redondo y más bajo
            trunk.prism(lo ? 3 : 4, 0, 0, 0, 0.26, 0, 0, 3.2, 0.18);
            if (lo) crown.bipyr(0, 0, 4.4, 2.6, 2.6, 2.1, s);
            else crown.blob(0, 0, 4.5, 2.7, 2.7, 2.3, s, 0.15);
    }
    return { trunk, crown };
}

/** Triángulos de cada especie (tronco + copa) para un nivel de calidad. */
export function speciesTriangles(lod = 'media') {
    const out = {};
    for (const k of SPECIES_KEYS) {
        const { trunk, crown } = speciesGeometry(k, lod);
        out[k] = { trunk: trunk.tris, crown: crown.tris, total: trunk.tris + crown.tris };
    }
    return out;
}

export const QUALITY_CAP = { baja: 3000, media: 7000, alta: 12000 };

/**
 * Elige `cap` árboles repartidos por todo el espacio (no los primeros N): se queda con los de menor hash de
 * posición, que es un muestreo uniforme y determinista.
 */
export function sampleTrees(trees, cap) {
    if (trees.length <= cap) return trees;
    const scored = trees.map((t, i) => ({ t, p: hash01(posKey(t.x, t.y), 801) + i * 1e-12 }));
    scored.sort((a, b) => a.p - b.p);
    return scored.slice(0, cap).map((s) => s.t);
}

// ------------------------------------------------------------------ capa three

/**
 * @param THREE  el módulo three (se pasa para que este archivo no dependa de WebGL)
 * @param trees  [{ x, y, context, species? }]
 * @returns { group, setLight(light), count, species: {T1:n,…}, triangles, dispose() }
 */
export function createTreeLayer(THREE, trees, { month = 8, quality = 'media' } = {}) {
    const lod = quality === 'baja' ? 'baja' : 'media';
    const cap = QUALITY_CAP[quality] ?? QUALITY_CAP.media;
    const list = sampleTrees(trees, cap);

    const bySpecies = Object.fromEntries(SPECIES_KEYS.map((k) => [k, []]));
    for (const t of list) {
        const k = t.species && SPECIES[t.species] ? t.species : speciesFor(t.context ?? 'vereda', t.x, t.y);
        bySpecies[k].push(t);
    }

    const group = new THREE.Group();
    group.name = 'arboles';
    const geos = [], mats = [], crownMats = [], trunkMats = [];
    const counts = {};
    let triangles = 0;

    const toGeometry = (g) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
        geo.computeVertexNormals();
        geos.push(geo);
        return geo;
    };

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qt = new THREE.Quaternion();
    const v = new THREE.Vector3(), sc = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1), tiltAxis = new THREE.Vector3();
    const green = new THREE.Color(), flower = new THREE.Color(), c = new THREE.Color();

    for (const key of SPECIES_KEYS) {
        const items = bySpecies[key];
        counts[key] = items.length;
        if (!items.length) continue;
        const sp = SPECIES[key];
        const { trunk, crown } = speciesGeometry(key, lod);
        triangles += (trunk.tris + crown.tris) * items.length;

        const trunkMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
        trunkMat.userData.base = new THREE.Color(sp.trunk);
        trunkMat.color.copy(trunkMat.userData.base);
        const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, side: sp.palm ? THREE.DoubleSide : THREE.FrontSide });
        crownMat.userData.base = new THREE.Color(0xffffff);
        mats.push(trunkMat, crownMat);
        trunkMats.push(trunkMat);
        crownMats.push(crownMat);

        const trunks = new THREE.InstancedMesh(toGeometry(trunk), trunkMat, items.length);
        const crowns = new THREE.InstancedMesh(toGeometry(crown), crownMat, items.length);
        trunks.name = `${key}-tronco`;
        crowns.name = `${key}-copa`;

        const amount = bloomAmount(key, month);
        if (sp.bloom) flower.set(sp.bloom);
        items.forEach((t, i) => {
            const n = posKey(t.x, t.y);
            let s = 0.8 + hash01(n, 811) * 0.4;
            if (t.context === 'peatonal') s *= 0.72;
            const w = s * (0.92 + hash01(n, 812) * 0.16); // un poco más ancho o más angosto
            q.setFromAxisAngle(zAxis, hash01(n, 813) * Math.PI * 2);
            const tilt = (hash01(n, 814) * (sp.palm ? 0.09 : 0.04));
            const ta = hash01(n, 815) * Math.PI * 2;
            tiltAxis.set(Math.cos(ta), Math.sin(ta), 0);
            qt.setFromAxisAngle(tiltAxis, tilt);
            q.premultiply(qt);
            m4.compose(v.set(t.x, t.y, 0), q, sc.set(w, w, s));
            trunks.setMatrixAt(i, m4);
            crowns.setMatrixAt(i, m4);

            green.set(sp.greens[Math.floor(hash01(n, 816) * sp.greens.length) % sp.greens.length]);
            const k = 0.9 + hash01(n, 817) * 0.2;
            c.setRGB(green.r * k, green.g * k, green.b * k);
            // cada ejemplar está en flor o no (sin mezclas verde-rosa, que de lejos parecen copas secas):
            // `amount` es la fracción de ejemplares florecidos ese mes
            if (amount > 0 && hash01(n, 818) < amount) {
                c.copy(flower).multiplyScalar(0.94 + hash01(n, 819) * 0.12);
            }
            crowns.setColorAt(i, c);
        });
        for (const m of [trunks, crowns]) {
            m.frustumCulled = false; // la cámara la arma MapLibre: three no sabe dónde está
            m.instanceMatrix.needsUpdate = true;
            group.add(m);
        }
        if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    }

    const tmp = new THREE.Color();
    /** Oscurece las copas de noche (tinte de la hora) y las entibia un poco con las luces encendidas. Sin recorrer instancias. */
    function setLight(light) {
        const tint = light?.tint ?? [1, 1, 1];
        const night = light?.night ?? 0;
        const lights = light?.lights ?? 0;
        const r = (0.55 + 0.45 * tint[0]) + 0.07 * lights * night;
        const g = (0.55 + 0.45 * tint[1]) + 0.025 * lights * night;
        const b = (0.55 + 0.45 * tint[2]) - 0.04 * lights * night;
        for (const m of crownMats) {
            // las hojas de palmera miran al cielo y de noche quedarían demasiado claras
            const k = m.side === THREE.DoubleSide ? 1 - 0.3 * night : 1;
            m.color.setRGB(r * k, g * k, b * k, THREE.SRGBColorSpace);
        }
        for (const m of trunkMats) {
            tmp.setRGB(r, g, b, THREE.SRGBColorSpace);
            m.color.copy(m.userData.base).multiply(tmp);
        }
    }

    function dispose() {
        for (const g of geos) g.dispose();
        for (const m of mats) m.dispose();
        group.clear();
    }

    return { group, setLight, count: list.length, species: counts, triangles, dispose };
}
