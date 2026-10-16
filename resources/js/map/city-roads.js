// Calles de la ciudad 3D: perfiles (calle común, avenida, tierra, peatonal), cruces recortados con ochavas,
// demarcación, grafo de carriles para el tránsito, mobiliario urbano y consultas rápidas ("¿esto está sobre la calle?").
// Puro (sin DOM ni WebGL): corre en node y en un Web Worker. Determinista: mismas calles, misma ciudad.
//
// Metros locales: x = este, y = norte, z = arriba. Capas: tierra/verde 0.02, asfalto 0.03, marcas 0.05, vereda 0.15.
import { MeshBuilder, hash01, hexToRgb } from './city-geometry.js';
import { buildLots, nearLot } from './city-lots.js';

const DEG = Math.PI / 180;
const Z_VERDE = 0.02;
const Z_ASFALTO = 0.03;
const Z_MARCA = 0.05;
const Z_VEREDA = 0.15;

const HEX = {
    asfalto: '#3a3f4e',
    asfaltoCentro: '#41465a', // asfalto más viejo y gastado en el microcentro
    avenida: '#33384a',
    hormigon: '#8b8f96',
    adoquin: '#6b6258',
    tierra: '#b5653d',
    vereda: '#d9d4c7',
    cordon: '#cfd3d8',
    cantero: '#6aa152',
    verde: '#7fae5c',
    peatonal: '#e6dccb',
    maceta: '#b3aba0',
    blanco: '#f2f2ee',
    amarillo: '#f2c230',
    playa: '#4a4d56', // asfalto de playa de estacionamiento: un poco más claro y liso que el de calle
    cajon: '#e8e8e2',
};
const COL = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, hexToRgb(v)]));

const MAJOR = new Set(['primary', 'secondary', 'trunk', 'motorway']);
const PEATONAL = new Set(['pedestrian', 'living_street', 'footway', 'path', 'steps', 'cycleway', 'bridleway']);
const SIN_PAVIMENTO = new Set(['unpaved', 'dirt', 'ground', 'gravel', 'fine_gravel', 'earth', 'mud', 'sand', 'grass', 'compacted', 'dirt/sand']);

const QUALITY = {
    baja: { cornerSegs: 0, zebras: false, arrows: false, outerFaces: false },
    media: { cornerSegs: 4, zebras: true, arrows: true, outerFaces: false },
    alta: { cornerSegs: 7, zebras: true, arrows: true, outerFaces: true },
};

// ------------------------------------------------------------------ normalización y perfiles

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};

function parseOneway(v, junction) {
    if (v === 1 || v === '1' || v === 'yes' || v === true) return 1;
    if (v === -1 || v === '-1' || v === 'reverse') return -1;
    if (v === 0 || v === '0' || v === 'no' || v === false) return 0;
    return junction === 'roundabout' ? 1 : 0;
}

/** Calles GeoJSON (lng/lat) → Road[] en metros locales. Los campos nuevos (oneway, lanes, width…) son opcionales. */
export function normalizeRoads(features, toLocal) {
    const list = Array.isArray(features) ? features : (features?.features ?? []);
    const out = [];
    list.forEach((f, i) => {
        const g = f?.geometry;
        if (!g) return;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        const p = f.properties ?? {};
        lines.forEach((line, part) => {
            const coords = [];
            for (const c of line ?? []) {
                const q = toLocal(c);
                const x = q[0], y = q[1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                const last = coords.at(-1);
                if (last && Math.hypot(last[0] - x, last[1] - y) < 0.05) continue;
                coords.push([x, y]);
            }
            if (coords.length < 2) return;
            const osm = Number.isFinite(+p.osm_id) && p.osm_id !== null ? +p.osm_id : null;
            out.push(makeRoad(p, coords, osm !== null ? (part ? osm * 16 + part : osm) : i + 1));
        });
    });
    return out;
}

function makeRoad(p, coords, id) {
    const highway = String(p.highway ?? 'residential');
    const surface = p.surface ?? null;
    const base = highway.replace(/_link$/, '');
    const lanes = num(p.lanes);
    return {
        id,
        coords,
        highway,
        name: p.name ?? null,
        oneway: parseOneway(p.oneway, p.junction),
        lanes: lanes === null ? null : Math.round(lanes),
        width: num(p.width),
        surface,
        major: MAJOR.has(base),
        pedestrian: PEATONAL.has(highway),
        service: highway === 'service',
        // pasillo de playa de estacionamiento: servicio SIN nombre (los pasajes con nombre sí son calles)
        lot: highway === 'service' && !String(p.name ?? '').trim(),
        unpaved: highway === 'track' || SIN_PAVIMENTO.has(surface),
        maxspeed: num(p.maxspeed),
        junction: p.junction ?? null,
        bridge: !!p.bridge,
    };
}

function surfaceKind(road) {
    if (road.pedestrian) return 'paving';
    if (road.unpaved) return 'dirt';
    if (road.surface === 'concrete') return 'concrete';
    if (road.surface === 'sett' || road.surface === 'paving_stones' || road.surface === 'cobblestone') return 'cobble';
    return 'asphalt';
}

/**
 * Perfil transversal de una calle (metros).
 *  K1 calle común, K2 avenida (sola de doble mano o par de manos únicas con cantero), K3 tierra, K4 peatonal, pasaje de servicio.
 * `road.dual` (lo pone buildRoadNetwork al detectar el par de una avenida) cambia la avenida a una mano con cantero.
 */
export function roadProfile(road) {
    const surface = surfaceKind(road);
    const hw = road.highway ?? 'residential';
    const ow = road.oneway ?? 0;
    if (road.pedestrian) {
        const def = hw === 'living_street' ? 9 : hw === 'pedestrian' ? 10 : 3;
        return { carriageway: road.width ?? def, sidewalk: 0, median: 0, curb: 0, surface, kerb: false, centerLine: 'none', lanesPerDir: 0 };
    }
    if (road.lot) {
        // pasillo de playa: asfalto angosto sin vereda ni cordón; no es una calle (el tránsito no circula)
        return { carriageway: road.width ?? 5, sidewalk: 0, median: 0, curb: 0, surface, kerb: false, centerLine: 'none', lanesPerDir: 1, lot: true };
    }
    if (road.unpaved) {
        const lanesPerDir = ow ? (road.lanes ?? 1) : Math.max(1, Math.floor((road.lanes ?? 2) / 2));
        return { carriageway: road.width ?? (road.major ? 9 : 7), sidewalk: 2.5, median: 0, curb: 0, surface, kerb: false, centerLine: 'none', lanesPerDir };
    }
    if (road.service) {
        return { carriageway: road.width ?? 4.5, sidewalk: 1, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'none', lanesPerDir: 1 };
    }
    if (road.major) {
        const link = hw.endsWith('_link');
        if (road.dual) {
            const lanesPerDir = road.lanes ?? 2;
            let carriageway = road.width ?? lanesPerDir * 3.5;
            if (road.dual.maxCarriageway) carriageway = Math.min(carriageway, road.dual.maxCarriageway);
            return { carriageway, sidewalk: 3.5, median: Math.max(0, road.dual.gap - carriageway), curb: 0.15, surface, kerb: true, centerLine: 'none', lanesPerDir };
        }
        if (ow) {
            const lanesPerDir = road.lanes ?? (link ? 1 : 2);
            return { carriageway: road.width ?? Math.max(4.5, lanesPerDir * 3.5), sidewalk: link ? 3 : 3.5, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'none', lanesPerDir };
        }
        if (link) {
            return { carriageway: road.width ?? 8, sidewalk: 3, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'single', lanesPerDir: 1 };
        }
        // avenida de doble mano: 7 m por mano (un carril y estacionamiento, o dos carriles)
        const lanesPerDir = road.lanes ? Math.max(1, Math.ceil(road.lanes / 2)) : 2;
        return { carriageway: road.width ?? Math.max(14, lanesPerDir * 2 * 3.5), sidewalk: 3.5, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'double', lanesPerDir };
    }
    const def = hw === 'tertiary' ? 9 : 8.5;
    if (ow) {
        return { carriageway: road.width ?? def, sidewalk: 3, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'none', lanesPerDir: road.lanes ?? 2 };
    }
    const lanesPerDir = road.lanes ? Math.max(1, Math.floor(road.lanes / 2)) : 1;
    return { carriageway: road.width ?? def, sidewalk: 3, median: 0, curb: 0.15, surface, kerb: true, centerLine: 'single', lanesPerDir };
}

function defaultSpeed(road) {
    if (road.maxspeed) return road.maxspeed / 3.6;
    if (road.unpaved) return 25 / 3.6;
    if (road.service) return 15 / 3.6;
    if (road.major) return 50 / 3.6;
    return 30 / 3.6;
}

// ------------------------------------------------------------------ geometría 2D

const left = (dx, dy) => [-dy, dx];

function intersect(p, d, q, e) {
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-6) return null;
    const wx = q[0] - p[0], wy = q[1] - p[1];
    const t = (wx * e[1] - wy * e[0]) / den;
    return [p[0] + d[0] * t, p[1] + d[1] * t];
}

function cumLengths(pts) {
    const c = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return c;
}

/** Tramo [s0, s1] de una polilínea, con los anchos laterales interpolados. */
function cutPolyline(pts, wl, wr, cum, s0, s1) {
    const out = [], ol = [], or = [];
    const at = (s) => {
        let i = 0;
        while (i < pts.length - 2 && cum[i + 1] < s) i++;
        const L = cum[i + 1] - cum[i];
        const t = L > 1e-9 ? Math.min(1, Math.max(0, (s - cum[i]) / L)) : 0;
        out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
        ol.push(wl[i] + (wl[i + 1] - wl[i]) * t);
        or.push(wr[i] + (wr[i + 1] - wr[i]) * t);
    };
    at(s0);
    for (let i = 1; i < pts.length - 1; i++) {
        if (cum[i] > s0 + 1e-3 && cum[i] < s1 - 1e-3) {
            out.push(pts[i]);
            ol.push(wl[i]);
            or.push(wr[i]);
        }
    }
    at(s1);
    return { pts: out, wl: ol, wr: or, cum: cumLengths(out) };
}

/** Normal izquierda con inglete (limitado) en cada vértice. */
function miters(pts) {
    const n = pts.length;
    const m = new Array(n);
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
        let nx, ny;
        if (i < n - 1) {
            const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
            const l = Math.hypot(dx, dy) || 1;
            nx = -dy / l; ny = dx / l;
        } else {
            nx = px; ny = py;
        }
        if (i === 0) {
            m[i] = [nx, ny];
        } else {
            let ax = px + nx, ay = py + ny;
            const al = Math.hypot(ax, ay);
            if (al < 1e-6) {
                m[i] = [nx, ny];
            } else {
                ax /= al; ay /= al;
                const k = 1 / Math.max(0.5, ax * nx + ay * ny);
                m[i] = [ax * k, ay * k];
            }
        }
        px = nx; py = ny;
    }
    return m;
}

function offsetPts(pts, off, mit = miters(pts)) {
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
        const o = typeof off === 'number' ? off : off[i];
        out[i] = [pts[i][0] + mit[i][0] * o, pts[i][1] + mit[i][1] * o];
    }
    return out;
}

function pointAt(pts, cum, s) {
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const L = cum[i + 1] - cum[i] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[i]) / L));
    const dx = (pts[i + 1][0] - pts[i][0]) / L, dy = (pts[i + 1][1] - pts[i][1]) / L;
    return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, tx: dx, ty: dy, i, t };
}

function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const fx = ax + dx * t - px, fy = ay + dy * t - py;
    return fx * fx + fy * fy;
}

/** Grilla numérica (más rápida que la de strings para las consultas que se hacen miles de veces por cuadro). */
class NumGrid {
    constructor(cell) {
        this.cell = cell;
        this.map = new Map();
    }

    k(ix, iy) {
        // clave entera chica (rápida en Map); si dos celdas chocan solo se suman candidatos, que igual se verifican
        return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) & 0x3fffffff;
    }

    add(minX, minY, maxX, maxY, v) {
        const c = this.cell;
        for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++) {
            for (let iy = Math.floor(minY / c); iy <= Math.floor(maxY / c); iy++) {
                const key = this.k(ix, iy);
                let l = this.map.get(key);
                if (!l) this.map.set(key, (l = []));
                l.push(v);
            }
        }
    }

    cellList(ix, iy) {
        return this.map.get(this.k(ix, iy));
    }

    /**
     * Segmento a–b con un margen `pad`: se anota en las celdas que recorre (no en toda su caja, que para un segmento
     * largo en diagonal son cientos de celdas vacías). Toda celda con un punto a ≤ pad del segmento queda anotada.
     */
    addSeg(ax, ay, bx, by, pad, v) {
        const c = this.cell;
        const L = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(L / (c * 0.5)));
        const r = pad + c * 0.25 + 1e-6;
        for (let i = 0; i <= n; i++) {
            const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
            for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) {
                for (let iy = Math.floor((y - r) / c); iy <= Math.floor((y + r) / c); iy++) {
                    const key = this.k(ix, iy);
                    const l = this.map.get(key);
                    // dentro de una misma llamada solo se agrega `v`: si ya es el último de la celda, ya estaba
                    if (!l) this.map.set(key, [v]);
                    else if (l[l.length - 1] !== v) l.push(v);
                }
            }
        }
    }
}

// ------------------------------------------------------------------ armado de triángulos

/**
 * MeshBuilder que junta los triángulos en arreglos tipados (la red real tiene ~100 mil triángulos y los `push`
 * sobre arreglos comunes eran la mitad del tiempo de armado). Al terminar, `pos`, `nor`, `col`, `uv` y `owner` quedan
 * como arreglos tipados del largo justo: sirven igual para `Float32Array.from(b.pos)`, `b.col[i] = …` y `b.vertexCount`.
 * Si después alguien llama a `tri/quad/wall/box`, primero se pasan a arreglos comunes y sigue como un MeshBuilder normal.
 */
class RoadMesh extends MeshBuilder {
    constructor(cap = 4096) {
        super();
        this.n = 0;
        this.cap = Math.max(256, Math.ceil(cap));
        this.bp = new Float64Array(this.cap * 9);
        this.bn = new Float32Array(this.cap * 9);
        this.bc = new Float32Array(this.cap * 9);
    }

    grow() {
        this.cap *= 2;
        const g = (a) => {
            const b = new a.constructor(this.cap * 9);
            b.set(a);
            return b;
        };
        this.bp = g(this.bp);
        this.bn = g(this.bn);
        this.bc = g(this.bc);
    }

    /** Cierra el armado: deja los arreglos tipados del largo justo en los campos de MeshBuilder. */
    seal() {
        const n = this.n;
        this.pos = this.bp.slice(0, n * 9);
        this.nor = this.bn.slice(0, n * 9);
        this.col = this.bc.slice(0, n * 9);
        this.uv = new Float32Array(n * 6).fill(0.02);
        this.owner = new Uint32Array(n);
        this.bp = this.bn = this.bc = null;
        return this;
    }

    tri(...args) {
        if (!Array.isArray(this.pos)) {
            for (const k of ['pos', 'nor', 'uv', 'col', 'owner']) this[k] = Array.from(this[k]);
        }
        return super.tri(...args);
    }
}

/** Escribe un triángulo directo en los arreglos tipados del RoadMesh (mismo formato que MeshBuilder.tri, sin crear objetos). */
function pushTri(b, ax, ay, az, bx, by, bz, cx, cy, cz, col, nx, ny, nz) {
    if (b.n === b.cap) b.grow();
    const o = b.n++ * 9;
    const p = b.bp, q = b.bn, c = b.bc;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az;
    p[o + 3] = bx; p[o + 4] = by; p[o + 5] = bz;
    p[o + 6] = cx; p[o + 7] = cy; p[o + 8] = cz;
    const r = col[0], g = col[1], bl = col[2];
    for (let k = o; k < o + 9; k += 3) {
        q[k] = nx; q[k + 1] = ny; q[k + 2] = nz;
        c[k] = r; c[k + 1] = g; c[k + 2] = bl;
    }
}

/** Caja chica (maceta) sin base, con caras verticales hacia afuera. */
function boxTop(b, x, y, u, v, hu, hv, z0, z1, col) {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => [x + u[0] * su * hu + v[0] * sv * hv, y + u[1] * su * hu + v[1] * sv * hv]);
    // c queda antihorario si (u, v) es una base derecha; si no, se da vuelta
    if (u[0] * v[1] - u[1] * v[0] < 0) c.reverse();
    for (let i = 0; i < 4; i++) face(b, c[i], c[(i + 1) % 4], z0, z1, col);
    fquad(b, c[0], c[1], c[2], c[3], z1, col);
}

/** Triángulo horizontal mirando hacia arriba (ordena los vértices si hace falta). */
function ftri(b, p, q, r, z, col) {
    const cr = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (Math.abs(cr) < 1e-7) return;
    if (cr > 0) pushTri(b, p[0], p[1], z, q[0], q[1], z, r[0], r[1], z, col, 0, 0, 1);
    else pushTri(b, p[0], p[1], z, r[0], r[1], z, q[0], q[1], z, col, 0, 0, 1);
}

function fquad(b, p, q, r, s, z, col) {
    ftri(b, p, q, r, z, col);
    ftri(b, p, r, s, z, col);
}

/** Franja entre dos bordes paralelos A (derecho) y B (izquierdo) con la misma cantidad de puntos. */
function strip(b, A, B, z, col) {
    for (let i = 0; i + 1 < A.length; i++) fquad(b, A[i], A[i + 1], B[i + 1], B[i], z, col);
}

/** Cara vertical que mira a la derecha de p→q. */
function face(b, p, q, z0, z1, col) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-3) return;
    const nx = dy / l, ny = -dx / l;
    pushTri(b, p[0], p[1], z0, q[0], q[1], z0, q[0], q[1], z1, col, nx, ny, 0);
    pushTri(b, p[0], p[1], z0, q[0], q[1], z1, p[0], p[1], z1, col, nx, ny, 0);
}

function shade(col, f) {
    return [Math.min(1, col[0] * f), Math.min(1, col[1] * f), Math.min(1, col[2] * f)];
}

// ------------------------------------------------------------------ preparación de la red

function normName(n) {
    if (!n) return '';
    return String(n).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/^(avenida|avda\.?|av\.?)\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Copia interna (nunca se modifica lo que entra: dos corridas dan exactamente lo mismo). */
function prepare(roads) {
    const rs = [];
    roads.forEach((r, i) => {
        if (!r?.coords || r.coords.length < 2) return;
        const coords = [];
        for (const c of r.coords) {
            const last = coords.at(-1);
            if (last && Math.hypot(last[0] - c[0], last[1] - c[1]) < 0.05) continue;
            coords.push([+c[0], +c[1]]);
        }
        if (coords.length < 2) return;
        const road = { ...r, highway: r.highway ?? 'residential', oneway: r.oneway ?? 0, coords, src: r, idx: rs.length, hid: (r.id ?? i + 1) | 0 };
        if (road.major === undefined) road.major = MAJOR.has(road.highway.replace(/_link$/, ''));
        if (road.pedestrian === undefined) road.pedestrian = PEATONAL.has(road.highway);
        if (road.service === undefined) road.service = road.highway === 'service';
        if (road.lot === undefined) road.lot = road.service && !normName(road.name);
        if (road.unpaved === undefined) road.unpaved = road.highway === 'track' || SIN_PAVIMENTO.has(road.surface);
        delete road.dual;
        rs.push(road);
    });
    return rs;
}

function snapNodes(rs) {
    const cell = 0.5;
    const map = new Map();
    const nodes = [];
    const key = (ix, iy) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) & 0x3fffffff;
    for (const r of rs) {
        r.nid = new Int32Array(r.coords.length);
        for (let i = 0; i < r.coords.length; i++) {
            const [x, y] = r.coords[i];
            const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
            let best = -1, bd = cell * cell;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const l = map.get(key(ix + dx, iy + dy));
                    if (!l) continue;
                    for (const id of l) {
                        const d = (nodes[id][0] - x) ** 2 + (nodes[id][1] - y) ** 2;
                        if (d <= bd) { bd = d; best = id; }
                    }
                }
            }
            if (best < 0) {
                best = nodes.length;
                nodes.push([x, y]);
                const k = key(ix, iy);
                if (!map.has(k)) map.set(k, []);
                map.get(k).push(best);
            }
            r.nid[i] = best;
            r.coords[i] = [nodes[best][0], nodes[best][1]];
        }
    }
    const occ = new Int32Array(nodes.length);
    for (const r of rs) {
        for (let i = 0; i < r.nid.length; i++) {
            if (i > 0 && r.nid[i] === r.nid[i - 1]) continue;
            occ[r.nid[i]]++;
        }
    }
    return { nodes, occ };
}

/** Uniones en T: una punta que cae a menos de 1 m de otra calle se engancha (se agrega el vértice a esa calle). */
function insertTJunctions(rs) {
    const { occ } = snapNodes(rs);
    const grid = new NumGrid(10);
    rs.forEach((r, ri) => {
        for (let j = 0; j + 1 < r.coords.length; j++) {
            const a = r.coords[j], b = r.coords[j + 1];
            grid.addSeg(a[0], a[1], b[0], b[1], 1, ri * 65536 + j);
        }
    });
    const inserts = new Map(); // ri -> [{j, t, p}]
    rs.forEach((r, ri) => {
        for (const end of [0, r.coords.length - 1]) {
            if (occ[r.nid[end]] !== 1) continue;
            const p = r.coords[end];
            const l = grid.cellList(Math.floor(p[0] / 10), Math.floor(p[1] / 10)) ?? [];
            let best = null, bd = 1;
            for (const v of l) {
                const rj = Math.floor(v / 65536), j = v % 65536;
                if (rj === ri && (j === end || j === end - 1)) continue;
                const a = rs[rj].coords[j], b = rs[rj].coords[j + 1];
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const L2 = dx * dx + dy * dy;
                if (L2 < 1e-9) continue;
                const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
                const f = [a[0] + dx * t, a[1] + dy * t];
                const d = Math.hypot(f[0] - p[0], f[1] - p[1]);
                if (d < bd) { bd = d; best = { rj, j, t, f, L: Math.sqrt(L2) }; }
            }
            if (!best) continue;
            const { rj, j, t, f, L } = best;
            const ta = t * L, tb = (1 - t) * L;
            if (ta < 0.5) { r.coords[end] = rs[rj].coords[j].slice(); continue; }
            if (tb < 0.5) { r.coords[end] = rs[rj].coords[j + 1].slice(); continue; }
            r.coords[end] = f.slice();
            if (!inserts.has(rj)) inserts.set(rj, []);
            inserts.get(rj).push({ j, t, p: f });
        }
    });
    for (const [rj, list] of inserts) {
        list.sort((a, b) => b.j - a.j || b.t - a.t);
        for (const it of list) rs[rj].coords.splice(it.j + 1, 0, it.p.slice());
    }
}

/**
 * Cruces en X sin nodo compartido (los datos de demo y algunas vías de OSM se cruzan a mitad de segmento):
 * se agrega el punto de cruce a las dos calles. Los puentes no se cruzan con lo que pasa por debajo.
 */
function insertCrossings(rs) {
    const CELL = 40;
    const grid = new NumGrid(CELL);
    rs.forEach((r, ri) => {
        if (r.bridge) return;
        for (let j = 0; j + 1 < r.coords.length; j++) {
            const a = r.coords[j], b = r.coords[j + 1];
            grid.addSeg(a[0], a[1], b[0], b[1], 0, ri * 65536 + j);
        }
    });
    const inserts = new Map(); // ri -> [{j, t, p}]
    const push = (ri, j, t, p) => {
        if (!inserts.has(ri)) inserts.set(ri, []);
        inserts.get(ri).push({ j, t, p });
    };
    const done = new Set();
    for (const list of grid.map.values()) {
        for (let m = 0; m < list.length; m++) {
            const v1 = list[m], r1 = Math.floor(v1 / 65536), j1 = v1 % 65536;
            const a = rs[r1].coords[j1], b = rs[r1].coords[j1 + 1];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L1 = Math.hypot(dx, dy);
            if (L1 < 1e-6) continue;
            for (let n = m + 1; n < list.length; n++) {
                const v2 = list[n], r2 = Math.floor(v2 / 65536), j2 = v2 % 65536;
                if (r1 === r2 && Math.abs(j1 - j2) <= 1) continue;
                const c = rs[r2].coords[j2], d = rs[r2].coords[j2 + 1];
                const ex = d[0] - c[0], ey = d[1] - c[1];
                const den = dx * ey - dy * ex;
                const L2 = Math.hypot(ex, ey);
                if (L2 < 1e-6 || Math.abs(den) < 1e-6 * L1 * L2) continue;
                const wx = c[0] - a[0], wy = c[1] - a[1];
                const t = (wx * ey - wy * ex) / den;
                const u = (wx * dy - wy * dx) / den;
                if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
                const pk = v1 < v2 ? v1 + ':' + v2 : v2 + ':' + v1;
                if (done.has(pk)) continue; // el mismo par aparece en varias celdas
                done.add(pk);
                // si el cruce cae a menos de 0,5 m de un vértice existente, ese vértice es el cruce (lo une el ajuste de nodos)
                const near1 = t * L1 < 0.5 ? a : (1 - t) * L1 < 0.5 ? b : null;
                const near2 = u * L2 < 0.5 ? c : (1 - u) * L2 < 0.5 ? d : null;
                const p = near1 ?? near2 ?? [a[0] + dx * t, a[1] + dy * t];
                if (!near1) push(r1, j1, t, p);
                if (!near2) push(r2, j2, u, p);
            }
        }
    }
    for (const [ri, list] of inserts) {
        list.sort((p, q) => q.j - p.j || q.t - p.t);
        for (const it of list) rs[ri].coords.splice(it.j + 1, 0, it.p.slice());
    }
}

/**
 * Pares de avenidas: dos vías de mano única con el mismo nombre, casi paralelas y a 6–30 m entre ejes.
 * El hueco entre las dos se llena con un cantero (cada una pone su mitad). Si no se sabe la mano,
 * se deduce: se maneja por la derecha, así que la otra mano queda a la izquierda.
 */
function detectPairs(rs) {
    const cand = rs.filter((r) => r.major && !r.pedestrian && !r.unpaved && !r.highway.endsWith('_link'));
    const grid = new NumGrid(32);
    for (const r of cand) {
        for (let j = 0; j + 1 < r.coords.length; j++) {
            const a = r.coords[j], b = r.coords[j + 1];
            grid.addSeg(a[0], a[1], b[0], b[1], 0, r.idx * 65536 + j);
        }
    }
    const names = rs.map((r) => normName(r.name));
    const pairs = new Set();
    for (const r of cand) {
        const n = r.coords.length;
        const pd = new Float64Array(n), ps = new Int8Array(n), pp = new Int32Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            const p = r.coords[i];
            const a = r.coords[Math.max(0, i - 1)], b = r.coords[Math.min(n - 1, i + 1)];
            let tx = b[0] - a[0], ty = b[1] - a[1];
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl; ty /= tl;
            const cx = Math.floor(p[0] / 32), cy = Math.floor(p[1] / 32);
            let bd = Infinity;
            const seen = new Set();
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (const v of grid.cellList(cx + dx, cy + dy) ?? []) {
                        if (seen.has(v)) continue;
                        seen.add(v);
                        const ri = Math.floor(v / 65536), j = v % 65536;
                        if (ri === r.idx) continue;
                        if (names[ri] && names[r.idx] && names[ri] !== names[r.idx]) continue;
                        const s0 = rs[ri].coords[j], s1 = rs[ri].coords[j + 1];
                        let sx = s1[0] - s0[0], sy = s1[1] - s0[1];
                        const L = Math.hypot(sx, sy);
                        if (L < 1e-6) continue;
                        sx /= L; sy /= L;
                        if (Math.abs(sx * tx + sy * ty) < 0.92) continue;
                        const t = Math.max(0, Math.min(L, (p[0] - s0[0]) * sx + (p[1] - s0[1]) * sy));
                        const fx = s0[0] + sx * t - p[0], fy = s0[1] + sy * t - p[1];
                        const d = Math.hypot(fx, fy);
                        if (d < 5.5 || d > 30 || d >= bd) continue;
                        if (Math.abs(fx * tx + fy * ty) > 0.35 * d) continue;
                        bd = d;
                        pd[i] = d;
                        ps[i] = tx * fy - ty * fx > 0 ? 1 : -1;
                        pp[i] = ri;
                    }
                }
            }
        }
        let k = 0, kl = 0;
        for (let i = 0; i < n; i++) if (pp[i] >= 0) { k++; if (ps[i] > 0) kl++; }
        if (k < Math.max(2, Math.ceil(n * 0.5))) continue;
        const side = kl * 2 >= k ? 1 : -1;
        if (Math.max(kl, k - kl) < 0.75 * k) continue;
        // hueco por vértice (los que no tienen pareja toman el del vecino más cercano que sí tiene)
        const gap = new Float64Array(n), partner = new Int32Array(n).fill(-1);
        const ok = [];
        for (let i = 0; i < n; i++) if (pp[i] >= 0 && ps[i] === side) ok.push(i);
        for (let i = 0; i < n; i++) {
            let bi = ok[0], bdi = Infinity;
            for (const o of ok) if (Math.abs(o - i) < bdi) { bdi = Math.abs(o - i); bi = o; }
            gap[i] = pd[bi];
            partner[i] = pp[bi];
        }
        const sorted = ok.map((i) => pd[i]).sort((a, b) => a - b);
        const gapMedian = sorted[Math.floor(sorted.length / 2)];
        r.dual = { side, gap: gapMedian, gaps: gap, partner, maxCarriageway: Math.max(3.5, gapMedian - 1) };
        if (!r.oneway) r.oneway = side;
        for (const o of ok) pairs.add(Math.min(r.idx, pp[o]) + ':' + Math.max(r.idx, pp[o]));
    }
    // solo cuentan los pares donde las dos vías quedaron como mano única con cantero
    return [...pairs].map((s) => s.split(':').map(Number)).filter(([a, b]) => rs[a].dual && rs[b].dual)
        .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

function sideInfo(r, prof, sideSign) {
    if (r.dual && r.dual.side === sideSign) return { type: 'cantero' };
    if (r.pedestrian || prof.sidewalk <= 0) return { type: 'none', w: 0 };
    return { type: r.unpaved ? 'verde' : 'vereda', w: prof.sidewalk };
}

/** Saca vértices casi alineados o demasiado juntos (menos triángulos, ingletes más prolijos). */
function simplify(idx, coords) {
    if (idx.length <= 2) return idx;
    const keep = [idx[0]];
    for (let k = 1; k < idx.length - 1; k++) {
        const p = coords[keep.at(-1)], q = coords[idx[k]], r = coords[idx[k + 1]];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1) continue;
        const dx = r[0] - p[0], dy = r[1] - p[1];
        const L = Math.hypot(dx, dy);
        if (L > 1e-6 && Math.abs((q[0] - p[0]) * dy - (q[1] - p[1]) * dx) / L < 0.15) continue;
        keep.push(idx[k]);
    }
    const last = idx.at(-1);
    if (keep.length > 1 && Math.hypot(coords[last][0] - coords[keep.at(-1)][0], coords[last][1] - coords[keep.at(-1)][1]) < 0.5) keep.pop();
    keep.push(last);
    return keep;
}

function buildGraph(rs) {
    const { nodes, occ } = snapNodes(rs);
    const gid = new Map();
    const gnodes = [];
    const gnode = (nid) => {
        if (!gid.has(nid)) {
            gid.set(nid, gnodes.length);
            gnodes.push({ x: nodes[nid][0], y: nodes[nid][1], arms: [], signal: false });
        }
        return gid.get(nid);
    };
    const edges = [];
    for (const r of rs) {
        const prof = r.prof;
        const idxs = [];
        for (let i = 0; i < r.coords.length; i++) if (i === 0 || r.nid[i] !== r.nid[i - 1]) idxs.push(i);
        if (idxs.length < 2) continue;
        const L = sideInfo(r, prof, 1), R = sideInfo(r, prof, -1);
        const cw = prof.carriageway / 2;
        const sideW = (info, i) => (info.type === 'cantero' ? Math.max(0.3, r.dual.gaps[i] / 2 - cw) : info.w);
        let start = 0;
        for (let k = 1; k < idxs.length; k++) {
            const v = idxs[k];
            if (!(k === idxs.length - 1 || occ[r.nid[v]] >= 2)) continue;
            const vi = simplify(idxs.slice(start, k + 1), r.coords);
            start = k;
            const pts = vi.map((i) => r.coords[i]);
            const cum = cumLengths(pts);
            const len = cum[cum.length - 1];
            if (len < 0.3) continue;
            const a = gnode(r.nid[vi[0]]), b = gnode(r.nid[vi.at(-1)]);
            edges.push({
                idx: edges.length, r, prof, pts, cum, len, a, b, w: cw,
                tl: L.type, tr: R.type,
                wl: vi.map((i) => sideW(L, i)), wr: vi.map((i) => sideW(R, i)),
                partner: r.dual ? vi.map((i) => r.dual.partner[i]) : null,
                ow: r.oneway || 0, // mano relativa al sentido del tramo (cambia si el tramo se da vuelta al unirlo)
                trim: [0, 0],
            });
        }
    }
    const merged = mergeJoints(edges, gnodes);
    for (const e of merged.edges) {
        for (const end of [0, 1]) {
            const g = merged.gnodes[end ? e.b : e.a];
            const s = Math.min(6, e.len * 0.45);
            const p = pointAt(e.pts, e.cum, end ? e.len - s : s);
            let dx = p.x - g.x, dy = p.y - g.y;
            const l = Math.hypot(dx, dy) || 1;
            dx /= l; dy /= l;
            g.arms.push({ e, end, d: [dx, dy], ang: Math.atan2(dy, dx) });
        }
    }
    for (const g of merged.gnodes) g.arms.sort((p, q) => p.ang - q.ang || p.e.idx - q.e.idx);
    return merged;
}

function reverseEdge(e) {
    e.pts = e.pts.slice().reverse();
    [e.wl, e.wr] = [e.wr.slice().reverse(), e.wl.slice().reverse()];
    [e.tl, e.tr] = [e.tr, e.tl];
    if (e.partner) e.partner = e.partner.slice().reverse();
    e.ow = -e.ow;
    [e.a, e.b] = [e.b, e.a];
}

/**
 * Une los tramos que siguen de largo por un nodo de grado 2 (la misma calle partida en dos vías de OSM):
 * así los cruces, cebras y recortes quedan donde corresponde y no en cada empalme.
 */
function mergeJoints(edges, gnodes) {
    const key = (e) => [e.r.highway, normName(e.r.name), e.prof.carriageway, e.prof.sidewalk, e.r.pedestrian, e.r.unpaved, e.prof.lanesPerDir].join('|');
    const inc = gnodes.map(() => []);
    for (const e of edges) { inc[e.a].push(e); inc[e.b].push(e); }
    const alive = new Set(edges);
    for (let gi = 0; gi < gnodes.length; gi++) {
        const l = inc[gi];
        if (l.length !== 2 || l[0] === l[1]) continue;
        let [e1, e2] = l;
        if (!alive.has(e1) || !alive.has(e2) || key(e1) !== key(e2)) continue;
        // e1 tiene que terminar en gi y e2 empezar en gi
        if (e1.b !== gi) reverseEdge(e1);
        if (e2.a !== gi) reverseEdge(e2);
        if (e1.b !== gi || e2.a !== gi || e1.a === gi || e2.b === gi) continue;
        if (e1.tl !== e2.tl || e1.tr !== e2.tr || e1.ow !== e2.ow) continue;
        e1.pts = e1.pts.concat(e2.pts.slice(1));
        e1.wl = e1.wl.concat(e2.wl.slice(1));
        e1.wr = e1.wr.concat(e2.wr.slice(1));
        e1.partner = e1.partner && e2.partner ? e1.partner.concat(e2.partner.slice(1)) : null;
        e1.b = e2.b;
        const lb = inc[e2.b];
        lb[lb.indexOf(e2)] = e1;
        inc[gi] = [];
        alive.delete(e2);
    }
    const remap = new Int32Array(gnodes.length).fill(-1);
    const outNodes = [];
    for (let gi = 0; gi < gnodes.length; gi++) {
        if (!inc[gi].length) continue;
        remap[gi] = outNodes.length;
        outNodes.push(gnodes[gi]);
    }
    const outEdges = [];
    for (const e of edges) {
        if (!alive.has(e)) continue;
        e.idx = outEdges.length;
        e.a = remap[e.a];
        e.b = remap[e.b];
        e.cum = cumLengths(e.pts);
        e.len = e.cum[e.cum.length - 1];
        outEdges.push(e);
    }
    return { gnodes: outNodes, edges: outEdges };
}

/** Datos del brazo mirando desde el cruce hacia afuera (izquierda/derecha del brazo, no de la calle). */
function armSides(arm) {
    const e = arm.e;
    return arm.end === 0
        ? { tl: e.tl, tr: e.tr, sl: e.wl[0], sr: e.wr[0] }
        : { tl: e.tr, tr: e.tl, sl: e.wr.at(-1), sr: e.wl.at(-1) };
}

function ccwAngle(d1, d2) {
    let a = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]);
    while (a <= 1e-9) a += 2 * Math.PI;
    while (a > 2 * Math.PI) a -= 2 * Math.PI;
    return a;
}

const cornerRadius = (A, B) => (A.e.r.service || B.e.r.service ? 1.5 : 3);

function computeTrims(gnodes) {
    for (const g of gnodes) {
        const n = g.arms.length;
        if (n < 2) continue;
        const need = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const A = g.arms[k], B = g.arms[(k + 1) % n];
            const phi = ccwAngle(A.d, B.d);
            if (phi >= 160 * DEG) continue;
            const sa = armSides(A), sb = armSides(B);
            const na = left(...A.d), nb = left(...B.d);
            const o = [g.x, g.y];
            const wa = A.e.w, wb = B.e.w;
            const P = intersect([o[0] + na[0] * wa, o[1] + na[1] * wa], A.d, [o[0] - nb[0] * wb, o[1] - nb[1] * wb], B.d);
            const Q = intersect([o[0] + na[0] * (wa + sa.sl), o[1] + na[1] * (wa + sa.sl)], A.d,
                [o[0] - nb[0] * (wb + sb.sr), o[1] - nb[1] * (wb + sb.sr)], B.d);
            const R = cornerRadius(A, B);
            const proj = (p, d) => (p ? (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] : 0);
            need[k] = Math.max(need[k], proj(P, A.d) + R, proj(Q, A.d));
            const kb = (k + 1) % n;
            need[kb] = Math.max(need[kb], proj(P, B.d) + R, proj(Q, B.d));
        }
        for (let k = 0; k < n; k++) {
            const A = g.arms[k];
            A.e.trim[A.end] = Math.min(30, Math.max(0, need[k]));
        }
    }
}

/** Componentes fuertemente conexas del grafo de carriles (Tarjan sin recursión). Devuelve el número de componente por nodo. */
function sccOf(n, lanes, out) {
    const index = new Int32Array(n).fill(-1), low = new Int32Array(n), comp = new Int32Array(n).fill(-1);
    const onStack = new Uint8Array(n), stack = [], call = [];
    let idx = 0, nc = 0;
    for (let s = 0; s < n; s++) {
        if (index[s] >= 0) continue;
        call.push(s, 0);
        while (call.length) {
            const v = call[call.length - 2], k = call[call.length - 1];
            if (k === 0) {
                index[v] = low[v] = idx++;
                stack.push(v);
                onStack[v] = 1;
            }
            const o = out[v];
            if (k < o.length) {
                call[call.length - 1] = k + 1;
                const w = lanes[o[k]].to;
                if (index[w] < 0) call.push(w, 0);
                else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
                continue;
            }
            call.length -= 2;
            if (call.length) {
                const u = call[call.length - 2];
                low[u] = Math.min(low[u], low[v]);
            }
            if (low[v] === index[v]) {
                let w;
                do {
                    w = stack.pop();
                    onStack[w] = 0;
                    comp[w] = nc;
                } while (w !== v);
                nc++;
            }
        }
    }
    return comp;
}

// ------------------------------------------------------------------ red completa

/**
 * Arma la red de calles: pisos (asfalto, veredas, cordones, canteros, tierra, peatonal), demarcación,
 * cruces, grafo de carriles, mobiliario y consultas espaciales. Ver CONTRACT.md.
 */
/**
 * opciones: signals/busStops (puntos), quality, center/centerRadius (microcentro),
 *   lotBlocked(x, y) → true donde no se puede pavimentar una playa (edificios reales): las islas entre pasillos de playa se pavimentan,
 *   con cajones y autos estacionados (ver city-lots.js).
 */
export function buildRoadNetwork(roads, { signals = [], busStops = [], quality = 'media', center = [0, 0], centerRadius = 800, lotBlocked = null } = {}) {
    const Q = QUALITY[quality] ?? QUALITY.media;
    const rs = prepare(roads ?? []);
    insertCrossings(rs);
    insertTJunctions(rs);
    snapNodes(rs); // coordenadas definitivas antes de buscar pares
    const pairs = detectPairs(rs);
    for (const r of rs) r.prof = roadProfile(r);
    const { gnodes, edges } = buildGraph(rs);
    computeTrims(gnodes);

    // capacidad inicial según el largo total (≈0,4 triángulos de piso y ≈0,3 de marcas por metro de calle)
    let totalLen = 0;
    for (const e of edges) totalLen += e.len;
    const ground = new RoadMesh(totalLen * 0.45 + 1024);
    const markings = new RoadMesh(totalLen * 0.35 + 1024);
    const cx0 = Array.isArray(center) ? center[0] : center.x, cy0 = Array.isArray(center) ? center[1] : center.y;
    const inCentre = (x, y) => Math.hypot(x - cx0, y - cy0) < centerRadius;

    // --- recorte de cada tramo
    for (const e of edges) {
        let [t0, t1] = e.trim;
        if (gnodes[e.a].arms.length < 2) t0 = 0;
        if (gnodes[e.b].arms.length < 2) t1 = 0;
        const room = e.len - 0.5;
        if (t0 + t1 > room) {
            const f = room > 0 ? room / (t0 + t1) : 0;
            t0 *= f; t1 *= f;
            if (room <= 0) { t0 = e.len * 0.25; t1 = e.len * 0.25; }
            e.consumed = true; // tramo cortito entre dos cruces (p. ej. el cruce del cantero de un bulevar)
            // entre las dos manos de un bulevar, los costados de ese pedacito son cantero, no vereda
            const nearCantero = [e.a, e.b].some((n) => gnodes[n].arms.some((a) => a.e !== e && (a.e.tl === 'cantero' || a.e.tr === 'cantero')));
            if (nearCantero) {
                if (e.tl === 'vereda' || e.tl === 'verde') e.tl = 'cantero';
                if (e.tr === 'vereda' || e.tr === 'verde') e.tr = 'cantero';
            }
        }
        e.trim = [t0, t1];
        e.cut = cutPolyline(e.pts, e.wl, e.wr, e.cum, t0, e.len - t1);
        e.cutLen = e.cut.cum[e.cut.cum.length - 1];
        const mid = pointAt(e.pts, e.cum, e.len / 2);
        e.centre = inCentre(mid.x, mid.y);
        e.colC = e.r.pedestrian ? COL.peatonal
            : e.r.lot && !e.r.unpaved ? COL.playa
            : e.r.unpaved ? COL.tierra
                : e.prof.surface === 'concrete' ? COL.hormigon
                    : e.prof.surface === 'cobble' ? COL.adoquin
                        : e.r.major ? COL.avenida
                            : e.centre ? COL.asfaltoCentro : COL.asfalto;
        // el pedacito que queda entre dos cruces de avenida se pinta como el cruce
        if (e.consumed && !e.r.pedestrian && [e.a, e.b].some((n) => gnodes[n].arms.some((a) => a.e.r.major))) e.colC = COL.avenida;
        e.zC =e.r.pedestrian ? Z_VEREDA : Z_ASFALTO;
    }

    // --- marco de cada brazo en su punto de corte (de acá salen las esquinas: coinciden exacto con las franjas)
    const frame = (arm) => {
        const e = arm.e, c = e.cut.pts;
        const E = arm.end ? c[c.length - 1] : c[0];
        const F = arm.end ? c[c.length - 2] : c[1];
        let dx = F[0] - E[0], dy = F[1] - E[1];
        const l = Math.hypot(dx, dy) || 1;
        dx /= l; dy /= l;
        const n = left(dx, dy);
        const s = arm.end === 0 ? { tl: e.tl, tr: e.tr, sl: e.cut.wl[0], sr: e.cut.wr[0] }
            : { tl: e.tr, tr: e.tl, sl: e.cut.wr.at(-1), sr: e.cut.wl.at(-1) };
        const w = e.w;
        return {
            arm, e, E, d: [dx, dy], n, w, ...s,
            L: [E[0] + n[0] * w, E[1] + n[1] * w], R: [E[0] - n[0] * w, E[1] - n[1] * w],
            Lo: [E[0] + n[0] * (w + s.sl), E[1] + n[1] * (w + s.sl)], Ro: [E[0] - n[0] * (w + s.sr), E[1] - n[1] * (w + s.sr)],
            trim: e.trim[arm.end],
        };
    };

    const sideColor = (type, e, sideKey) => {
        if (type === 'cantero') return COL.cantero;
        if (type === 'verde') return COL.verde;
        return shade(COL.vereda, 0.96 + 0.07 * hash01(e.idx * 2 + sideKey, 17));
    };
    const raised = (type) => type === 'vereda' || type === 'cantero';

    // --- franjas de cada tramo: calzada, veredas/canteros/banquinas y cordones
    for (const e of edges) {
        const c = e.cut;
        if (c.pts.length < 2 || e.cutLen < 1e-3) continue;
        const mit = miters(c.pts);
        const A = offsetPts(c.pts, -e.w, mit), B = offsetPts(c.pts, e.w, mit);
        strip(ground, A, B, e.zC, e.colC);
        if (e.tl !== 'none') {
            const BL = offsetPts(c.pts, c.wl.map((v) => e.w + v), mit);
            const up = raised(e.tl);
            strip(ground, B, BL, up ? Z_VEREDA : Z_VERDE, sideColor(e.tl, e, 0));
            if (up) for (let i = 0; i + 1 < B.length; i++) face(ground, B[i], B[i + 1], Z_ASFALTO, Z_VEREDA, COL.cordon);
            if (up && Q.outerFaces && e.tl === 'vereda') for (let i = 0; i + 1 < BL.length; i++) face(ground, BL[i + 1], BL[i], 0, Z_VEREDA, COL.cordon);
        }
        if (e.tr !== 'none') {
            const AR = offsetPts(c.pts, c.wr.map((v) => -e.w - v), mit);
            const up = raised(e.tr);
            strip(ground, AR, A, up ? Z_VEREDA : Z_VERDE, sideColor(e.tr, e, 1));
            if (up) for (let i = 0; i + 1 < A.length; i++) face(ground, A[i + 1], A[i], Z_ASFALTO, Z_VEREDA, COL.cordon);
            if (up && Q.outerFaces && e.tr === 'vereda') for (let i = 0; i + 1 < AR.length; i++) face(ground, AR[i], AR[i + 1], 0, Z_VEREDA, COL.cordon);
        }
    }

    // --- cruces: asfalto del cruce + ochavas de vereda
    const junctionPolys = [];
    const intersections = [];
    for (const g of gnodes) {
        const F = g.arms.map(frame);
        g.frames = F;
        if (F.length === 1) {
            const f = F[0];
            if (raised(f.tl)) face(ground, f.L, f.Lo, 0, Z_VEREDA, COL.cordon);
            if (raised(f.tr)) face(ground, f.Ro, f.R, 0, Z_VEREDA, COL.cordon);
            if (f.e.r.pedestrian) face(ground, f.R, f.L, 0, Z_VEREDA, COL.peatonal);
            continue;
        }
        if (F.length < 2) continue;
        F.sort((p, q) => Math.atan2(p.d[1], p.d[0]) - Math.atan2(q.d[1], q.d[0]) || p.e.idx - q.e.idx);
        const allPed = F.every((f) => f.e.r.pedestrian);
        const veh = F.filter((f) => !f.e.r.pedestrian);
        const zJ = allPed ? Z_VEREDA : Z_ASFALTO;
        const colJ = allPed ? COL.peatonal
            : veh.every((f) => f.e.r.lot) && !veh.every((f) => f.e.r.unpaved) ? COL.playa
            : veh.some((f) => f.e.r.major) ? COL.avenida
                : veh.every((f) => f.e.r.unpaved) ? COL.tierra
                    : veh.some((f) => f.e.centre) ? COL.asfaltoCentro : COL.asfalto;
        const poly = [];
        for (let k = 0; k < F.length; k++) {
            const A = F[k], B = F[(k + 1) % F.length];
            poly.push(A.R, A.L);
            if (!allPed && A.e.r.pedestrian) face(ground, A.L, A.R, Z_ASFALTO, Z_VEREDA, COL.peatonal);
            const phi = ccwAngle(A.d, B.d);
            const P = intersect(A.L, A.d, B.R, B.d);
            const okP = P && (P[0] - A.E[0]) * A.d[0] + (P[1] - A.E[1]) * A.d[1] <= 0.05
                && (P[0] - B.E[0]) * B.d[0] + (P[1] - B.E[1]) * B.d[1] <= 0.05
                && Math.hypot(P[0] - g.x, P[1] - g.y) < 40;
            let kind = 'recta';
            const inner = [];
            if (phi < 160 * DEG && okP) {
                kind = 'curva';
                const segs = Q.cornerSegs;
                for (let s = 1; s < segs; s++) {
                    const t = s / segs, u = 1 - t;
                    inner.push([u * u * A.L[0] + 2 * u * t * P[0] + t * t * B.R[0], u * u * A.L[1] + 2 * u * t * P[1] + t * t * B.R[1]]);
                }
            } else if (phi > 200 * DEG && okP) {
                kind = 'punta';
                inner.push(P);
            }
            poly.push(...inner);
            // ochava (vereda de la esquina entre el lado izquierdo de A y el derecho de B)
            const type = [A.tl, B.tr].includes('vereda') ? 'vereda' : [A.tl, B.tr].includes('cantero') ? 'cantero'
                : [A.tl, B.tr].includes('verde') ? 'verde' : 'none';
            if (type === 'none' || (A.sl < 0.05 && B.sr < 0.05)) continue;
            const z = raised(type) ? Z_VEREDA : Z_VERDE;
            const col = sideColor(type, A.e, 0);
            const Qo = intersect(A.Lo, A.d, B.Ro, B.d);
            const okQ = Qo && (Qo[0] - A.E[0]) * A.d[0] + (Qo[1] - A.E[1]) * A.d[1] <= 0.05
                && (Qo[0] - B.E[0]) * B.d[0] + (Qo[1] - B.E[1]) * B.d[1] <= 0.05
                && Math.hypot(Qo[0] - g.x, Qo[1] - g.y) < 50;
            const chain = [A.L, ...inner, B.R];
            if (kind === 'punta' && okQ) {
                fquad(ground, A.L, P, Qo, A.Lo, z, col);
                fquad(ground, P, B.R, B.Ro, Qo, z, col);
            } else if (phi < 160 * DEG && okQ) {
                const ring = [A.Lo, ...chain, B.Ro];
                for (let i = 0; i + 1 < ring.length; i++) ftri(ground, Qo, ring[i], ring[i + 1], z, col);
            } else {
                fquad(ground, A.L, B.R, B.Ro, A.Lo, z, col);
                if (kind !== 'recta') {
                    // curva sin esquina exterior utilizable: se rellena entre la cuerda y la curva
                    for (let i = 1; i + 1 < chain.length; i++) ftri(ground, chain[0], chain[i], chain[i + 1], z, col);
                }
            }
            if (raised(type)) for (let i = 0; i + 1 < chain.length; i++) face(ground, chain[i + 1], chain[i], zJ, Z_VEREDA, COL.cordon);
        }
        // asfalto del cruce (abanico desde el nodo)
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i], q = poly[(i + 1) % poly.length];
            area += p[0] * q[1] - q[0] * p[1];
        }
        if (Math.abs(area) > 0.02) {
            const o = [g.x, g.y];
            for (let i = 0; i < poly.length; i++) ftri(ground, o, poly[i], poly[(i + 1) % poly.length], zJ, colJ);
            junctionPolys.push(poly);
        } else {
            junctionPolys.push(null);
        }
        g.poly = Math.abs(area) > 0.02 ? poly : null;
    }

    // --- semáforos: los pedidos (a menos de 15 m) y los cruces de dos avenidas
    const sigPts = (signals ?? []).map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
    for (const g of gnodes) {
        const deg = g.arms.filter((a) => !a.e.r.lot).length; // los pasillos de playa no hacen cruce (ni cebras ni semáforo)
        g.major = g.arms.some((a) => a.e.r.major);
        g.degree = deg;
        if (deg >= 2 && sigPts.some(([x, y]) => Math.hypot(x - g.x, y - g.y) <= 15)) g.signal = true;
        if (deg >= 3) {
            const maj = g.arms.filter((a) => a.e.r.major);
            for (let i = 0; i < maj.length && !g.signal; i++) {
                for (let j = i + 1; j < maj.length; j++) {
                    if (Math.abs(maj[i].d[0] * maj[j].d[1] - maj[i].d[1] * maj[j].d[0]) > 0.5) { g.signal = true; break; }
                }
            }
            intersections.push({ x: g.x, y: g.y, degree: deg, signal: g.signal });
        }
        // cebras: cruces del centro con 3+ brazos, o cualquier cruce con avenida
        g.zebra = Q.zebras && deg >= 3 && (g.major || inCentre(g.x, g.y));
    }

    // --- demarcación
    const WHITE = COL.blanco, YELLOW = COL.amarillo;
    // franja pintada entre s0 y s1 (a lo largo) y o0..o1 (de costado); un cuadrilátero por segmento, sin crear objetos
    const band = (c, s0, s1, o0, o1, col) => {
        if (s1 - s0 < 0.05) return;
        const pts = c.pts, cum = c.cum;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = Math.max(s0, cum[i]), b = Math.min(s1, cum[i + 1]);
            if (b - a < 0.02) continue;
            const L = cum[i + 1] - cum[i];
            const tx = (pts[i + 1][0] - pts[i][0]) / L, ty = (pts[i + 1][1] - pts[i][1]) / L;
            const ax = pts[i][0] + tx * (a - cum[i]), ay = pts[i][1] + ty * (a - cum[i]);
            const bx = pts[i][0] + tx * (b - cum[i]), by = pts[i][1] + ty * (b - cum[i]);
            const nx = -ty, ny = tx;
            const z = Z_MARCA;
            pushTri(markings, ax + nx * o0, ay + ny * o0, z, bx + nx * o0, by + ny * o0, z, bx + nx * o1, by + ny * o1, z, col, 0, 0, 1);
            pushTri(markings, ax + nx * o0, ay + ny * o0, z, bx + nx * o1, by + ny * o1, z, ax + nx * o1, ay + ny * o1, z, col, 0, 0, 1);
        }
    };
    const dashed = (c, s0, s1, o, w, dash, gap, col) => {
        for (let s = s0; s < s1 - 0.5; s += dash + gap) band(c, s, Math.min(s + dash, s1), o - w / 2, o + w / 2, col);
    };
    for (const e of edges) {
        const r = e.r;
        if (r.pedestrian || r.unpaved || r.lot || e.cutLen < 2) continue;
        const c = e.cut, w = e.w, prof = e.prof, L = e.cutLen;
        const za = gnodes[e.a].zebra, zb = gnodes[e.b].zebra;
        const da = gnodes[e.a].arms.length, db = gnodes[e.b].arms.length;
        const s0 = da >= 3 ? (za ? 4.6 : 1.2) : 0.3, s1 = L - (db >= 3 ? (zb ? 4.6 : 1.2) : 0.3);
        // cebras
        for (const [on, a0] of [[za, 0.6], [zb, L - 3.6]]) {
            if (!on || L < 8) continue;
            const n = Math.max(2, Math.floor((2 * w - 0.6) / 1.2));
            const span = n * 1.2 - 0.6;
            for (let k = 0; k < n; k++) {
                const o = -span / 2 + k * 1.2;
                band(c, a0, a0 + 3, o, o + 0.6, WHITE);
            }
        }
        // línea de detención en la calle menor que llega a una avenida
        for (const end of [0, 1]) {
            const g = gnodes[end ? e.b : e.a];
            if (r.major || !g.major || g.arms.length < 3 || L < 10) continue;
            const incoming = end === 0 ? e.ow !== 1 : e.ow !== -1;
            if (!incoming) continue;
            const st = g.zebra ? 4.0 : 0.8;
            const [o0, o1] = e.ow ? [-w + 0.3, w - 0.3] : end === 0 ? [0.15, w - 0.3] : [-w + 0.3, -0.15];
            const sa = end === 0 ? st : L - st - 0.45;
            band(c, sa, sa + 0.45, o0, o1, WHITE);
        }
        if (s1 - s0 < 1) continue;
        // eje amarillo
        if (prof.centerLine === 'single' && !e.ow) dashed(c, s0, s1, 0, 0.14, 3, 5, YELLOW);
        if (prof.centerLine === 'double' && !e.ow) {
            band(c, s0, s1, -0.24, -0.1, YELLOW);
            band(c, s0, s1, 0.1, 0.24, YELLOW);
        }
        // divisiones de carril (blancas, discontinuas)
        const lpd = Math.max(1, prof.lanesPerDir);
        if (e.ow) {
            const lw = (2 * w) / lpd;
            for (let k = 1; k < lpd; k++) dashed(c, s0, s1, -w + k * lw, 0.12, 3, 6, WHITE);
        } else if (lpd > 1) {
            const lw = w / lpd;
            for (let k = 1; k < lpd; k++) {
                dashed(c, s0, s1, k * lw, 0.12, 3, 6, WHITE);
                dashed(c, s0, s1, -k * lw, 0.12, 3, 6, WHITE);
            }
        }
        // flechas en las calles de mano única
        if (Q.arrows && e.ow && s1 - s0 > 20) {
            const lw = (2 * w) / lpd;
            for (let s = s0 + 10; s < s1 - 6; s += 60) {
                const p = pointAt(c.pts, c.cum, s);
                const tx = p.tx * e.ow, ty = p.ty * e.ow;
                const [nx, ny] = left(tx, ty);
                for (let k = 0; k < lpd; k++) {
                    const o = (-w + (k + 0.5) * lw) * e.ow; // desplazamiento sobre la normal de la calle → sobre la de la marcha
                    const bx = p.x - p.ty * o, by = p.y + p.tx * o;
                    const at = (u, v) => [bx + tx * u + nx * v, by + ty * u + ny * v];
                    fquad(markings, at(-1.6, -0.13), at(0.4, -0.13), at(0.4, 0.13), at(-1.6, 0.13), Z_MARCA, WHITE);
                    ftri(markings, at(0.4, -0.55), at(1.6, 0), at(0.4, 0.55), Z_MARCA, WHITE);
                }
            }
        }
    }

    // --- pasillos de playa: no son calles (el tránsito no entra) salvo que sean el único acceso que une dos
    // conjuntos de calles que de otro modo quedarían separados (largo propio ≥ 25 m cada uno)
    {
        const par = gnodes.map((_, i) => i);
        const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
        const clen = new Float64Array(gnodes.length);
        for (const e of edges) {
            if (e.r.lot || e.r.pedestrian) continue;
            const ra = find(e.a), rb = find(e.b);
            if (ra !== rb) { par[rb] = ra; clen[ra] += clen[rb]; }
            clen[find(e.a)] += e.len;
        }
        for (const e of edges) {
            if (!e.r.lot) continue;
            const ra = find(e.a), rb = find(e.b);
            if (ra === rb || Math.min(clen[ra], clen[rb]) < 25) continue;
            e.access = true;
            par[rb] = ra;
            clen[ra] += clen[rb];
        }
    }

    // --- grafo de carriles
    const laneNodes = gnodes.map((g) => ({ x: g.x, y: g.y, signal: !!g.signal }));
    const lanes = [];
    const laneMeta = [];
    const polyLen = (pts) => {
        let s = 0;
        for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        return s;
    };
    const addLane = (from, to, pts, e, speed, width, meta) => {
        // park = distancia del carril al cordón derecho si ahí se puede estacionar en paralelo (calle con cordón de ≥ 8 m, un carril
        // por mano), 0 si no; t0/t1 = largo recortado por el cruce al principio/final del carril (en el sentido de la marcha)
        lanes.push({ from, to, pts, len: polyLen(pts), speed, major: !!e?.r.major, bus: !!e && (e.r.highway === 'primary' || e.r.highway === 'secondary'), width,
            park: meta?.park ?? 0, t0: meta?.t0 ?? 0, t1: meta?.t1 ?? 0, stop: meta?.stop ?? 0 });
        laneMeta.push({ e, ...meta });
    };
    for (const e of edges) {
        const r = e.r;
        if (r.pedestrian || (r.lot && !e.access)) continue;
        const lpd = Math.max(1, e.prof.lanesPerDir);
        const cw = 2 * e.w;
        const speed = defaultSpeed(r);
        const mit = miters(e.pts);
        // con estacionamiento junto al cordón (calle de cordón, ≥ 8 m, un carril por mano) los autos en marcha van más
        // cerca del eje: así no atraviesan a los estacionados (franja de 2,05 m desde el cordón)
        const parkable = e.prof.kerb && !r.major && !r.lot && !r.service && cw >= 8 && lpd === 1;
        const [tA, tB] = e.trim;
        // línea de detención: antes de la senda (si el cruce de ese extremo tiene cebra) o del borde del asfalto del cruce;
        // distancia desde el nodo hasta el paragolpes delantero del primero de la fila
        const stopA = tA + (gnodes[e.a].zebra ? 4.8 : 1.2), stopB = tB + (gnodes[e.b].zebra ? 4.8 : 1.2);
        if (!e.ow) {
            const lw = cw / (2 * lpd);
            for (let k = 0; k < lpd; k++) {
                const o = parkable ? Math.max(1, e.w - 3.1) : (k + 0.5) * lw;
                const park = parkable ? e.w - o : 0;
                addLane(e.a, e.b, offsetPts(e.pts, -o, mit), e, speed, lw, { sign: 1, o: -o, k, park, t0: tA, t1: tB, stop: stopB });
                addLane(e.b, e.a, offsetPts(e.pts, o, mit).reverse(), e, speed, lw, { sign: -1, o, k, park, t0: tB, t1: tA, stop: stopA });
            }
        } else {
            const lw = cw / lpd;
            for (let k = 0; k < lpd; k++) {
                // k = 0 es el carril de la derecha según la marcha
                const o = (-e.w + (k + 0.5) * lw) * e.ow;
                const pts = offsetPts(e.pts, o, mit);
                const park = parkable && k === 0 ? e.w - Math.abs(o) : 0;
                if (e.ow === 1) addLane(e.a, e.b, pts, e, speed, lw, { sign: 1, o, k, park, t0: tA, t1: tB, stop: stopB });
                else addLane(e.b, e.a, pts.reverse(), e, speed, lw, { sign: -1, o, k, park, t0: tB, t1: tA, stop: stopA });
            }
        }
    }
    const buildOut = () => {
        const out = laneNodes.map(() => []);
        lanes.forEach((l, i) => out[l.from].push(i));
        return out;
    };
    let out = buildOut();
    const incoming = laneNodes.map(() => []);
    lanes.forEach((l, i) => incoming[l.to].push(i));
    // callejones sin salida: vuelta en U alrededor de la punta
    for (let gi = 0; gi < gnodes.length; gi++) {
        const g = gnodes[gi];
        if (g.arms.filter((a) => !a.e.r.lot || a.e.access).length !== 1) continue; // punta suelta (sin contar pasillos de playa)
        const inc = incoming[gi].filter((i) => laneMeta[i].e);
        const og = out[gi].filter((i) => laneMeta[i].e);
        if (!inc.length || !og.length) continue;
        const li = inc.reduce((a, b) => (laneMeta[b].k > laneMeta[a].k ? b : a)); // el más cercano al eje
        const lo = og.reduce((a, b) => (laneMeta[b].k > laneMeta[a].k ? b : a));
        const p0 = lanes[li].pts.at(-1), p1 = lanes[lo].pts[0];
        const d = g.arms[0].d; // hacia adentro del tramo: la vuelta sobresale para el otro lado
        const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
        const rad = Math.max(1, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2);
        const ux = (p0[0] - mx) / rad, uy = (p0[1] - my) / rad;
        const pts = [];
        for (let s = 0; s <= 6; s++) {
            const a = (Math.PI * s) / 6;
            pts.push([mx + (ux * Math.cos(a) - d[0] * Math.sin(a)) * rad, my + (uy * Math.cos(a) - d[1] * Math.sin(a)) * rad]);
        }
        pts[0] = p0.slice();
        pts[6] = p1.slice();
        addLane(gi, gi, pts, null, 3, lanes[li].width, { uturn: true });
        out[gi].push(lanes.length - 1);
    }
    // carril de escape: la vuelta a contramano de un carril de mano única (solo donde hace falta para no quedar encerrado)
    const escaped = new Set();
    const addEscape = (li) => {
        const m = laneMeta[li];
        if (escaped.has(m.e)) return false;
        escaped.add(m.e);
        const from = lanes[li].to, to = lanes[li].from;
        const oe = m.sign * Math.max(Math.abs(m.o), lanes[li].width / 2); // a la derecha de la marcha de vuelta
        const pts = offsetPts(m.e.pts, oe);
        if (m.sign === 1) pts.reverse();
        addLane(from, to, pts, m.e, 4, lanes[li].width, { sign: -m.sign, o: oe, k: 0, escape: true });
        out[from].push(lanes.length - 1);
        incoming[to].push(lanes.length - 1);
        return true;
    };
    // nodos trampa (solo entran manos únicas): un carril de escape a contramano por el primer tramo que llega
    for (let gi = 0; gi < gnodes.length; gi++) {
        const inc = incoming[gi].filter((i) => lanes[i].from !== gi);
        if (!inc.length || out[gi].some((i) => lanes[i].to !== gi)) continue;
        addEscape(inc[0]);
    }
    // zonas encerradas (p. ej. una mano de bulevar que se corta en el borde del mapa): se abre a contramano
    // cada tramo de mano única que toca un nodo fuera de la componente fuertemente conexa más grande
    for (let iter = 0; iter < 6; iter++) {
        const comp = sccOf(laneNodes.length, lanes, out);
        const size = new Int32Array(laneNodes.length);
        for (let i = 0; i < comp.length; i++) size[comp[i]]++;
        let main = 0;
        for (let c = 1; c < size.length; c++) if (size[c] > size[main]) main = c;
        let added = 0;
        const n0 = lanes.length;
        for (let li = 0; li < n0; li++) {
            const m = laneMeta[li];
            if (!m.e || m.escape || !m.e.ow) continue;
            const l = lanes[li];
            if (comp[l.from] !== main || comp[l.to] !== main) added += addEscape(li) ? 1 : 0;
        }
        if (!added) break;
    }
    out = buildOut();
    // nodos sin ningún carril (extremos de pasillos de playa, peatonales): afuera del grafo; los índices se reasignan
    let laneGraph;
    {
        const remap = new Int32Array(laneNodes.length).fill(-1);
        for (const l of lanes) { remap[l.from] = 0; remap[l.to] = 0; }
        const nodes2 = [];
        laneNodes.forEach((nd, i) => { if (remap[i] === 0) { remap[i] = nodes2.length; nodes2.push(nd); } });
        if (nodes2.length !== laneNodes.length) {
            for (const l of lanes) { l.from = remap[l.from]; l.to = remap[l.to]; }
            const out2 = nodes2.map(() => []);
            lanes.forEach((l, i) => out2[l.from].push(i));
            laneGraph = { nodes: nodes2, lanes, out: out2 };
        } else laneGraph = { nodes: laneNodes, lanes, out };
    }

    // --- consultas espaciales (grilla de segmentos de 20 m)
    const CELL = 20;
    const segs = []; // [ax, ay, bx, by, cwHalf, leftTotal, rightTotal, edgeIdx]
    for (const e of edges) {
        for (let i = 0; i + 1 < e.pts.length; i++) {
            const lt = e.w + (e.tl === 'none' ? 0 : Math.max(e.wl[i], e.wl[i + 1]));
            const rt = e.w + (e.tr === 'none' ? 0 : Math.max(e.wr[i], e.wr[i + 1]));
            segs.push(e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1], e.r.pedestrian ? 0 : e.w, lt, rt, e.idx);
        }
    }
    const SEG = 8;
    const nSeg = segs.length / SEG;
    const segArr = new Float64Array(segs);
    const sgrid = new NumGrid(CELL);
    let maxReach = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let s = 0; s < nSeg; s++) {
        const o = s * SEG;
        const reach = Math.max(segArr[o + 5], segArr[o + 6]) + 1;
        maxReach = Math.max(maxReach, reach);
        const x0 = Math.min(segArr[o], segArr[o + 2]) - reach, x1 = Math.max(segArr[o], segArr[o + 2]) + reach;
        const y0 = Math.min(segArr[o + 1], segArr[o + 3]) - reach, y1 = Math.max(segArr[o + 1], segArr[o + 3]) + reach;
        sgrid.addSeg(segArr[o], segArr[o + 1], segArr[o + 2], segArr[o + 3], reach, s);
        minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    }
    const stamp = new Int32Array(nSeg);
    let qid = 0;
    const roadOf = (s) => edges[segArr[s * SEG + 7]].r.src;
    const nearest = (x, y, streetsOnly = false) => {
        qid++;
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        let best = Infinity, bs = -1;
        for (let ring = 0; ring <= 12; ring++) {
            for (let ix = cx - ring; ix <= cx + ring; ix++) {
                for (let iy = cy - ring; iy <= cy + ring; iy++) {
                    if (ring && ix !== cx - ring && ix !== cx + ring && iy !== cy - ring && iy !== cy + ring) continue;
                    const l = sgrid.cellList(ix, iy);
                    if (!l) continue;
                    for (let k = 0; k < l.length; k++) {
                        const s = l[k];
                        if (stamp[s] === qid) continue;
                        stamp[s] = qid;
                        if (streetsOnly && edges[segArr[s * SEG + 7]].r.lot) continue;
                        const o = s * SEG;
                        const d2 = segDist2(x, y, segArr[o], segArr[o + 1], segArr[o + 2], segArr[o + 3]);
                        if (d2 < best) { best = d2; bs = s; }
                    }
                }
            }
            if (bs >= 0 && Math.sqrt(best) <= ring * CELL) break;
        }
        if (bs < 0) return null;
        const o = bs * SEG;
        const ax = segArr[o], ay = segArr[o + 1], dx = segArr[o + 2] - ax, dy = segArr[o + 3] - ay;
        const L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const fx = ax + dx * t - x, fy = ay + dy * t - y;
        const dist = Math.sqrt(fx * fx + fy * fy);
        let dirX, dirY;
        if (dist > 1e-9) { dirX = fx / dist; dirY = fy / dist; } else {
            const l = Math.sqrt(L2) || 1;
            dirX = -dy / l; dirY = dx / l;
        }
        return { dist, dirX, dirY, road: roadOf(bs) };
    };
    // distancia firmada al eje: lado izquierdo (+) o derecho (−) del segmento
    const within = (s, x, y, margin, carriagewayOnly) => {
        const o = s * SEG;
        const ax = segArr[o], ay = segArr[o + 1], dx = segArr[o + 2] - ax, dy = segArr[o + 3] - ay;
        const L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const fx = x - ax - dx * t, fy = y - ay - dy * t;
        const d = Math.sqrt(fx * fx + fy * fy);
        if (carriagewayOnly) return segArr[o + 4] > 0 && d < segArr[o + 4] + margin;
        const lim = dx * fy - dy * fx >= 0 ? segArr[o + 5] : segArr[o + 6];
        return d < lim + margin;
    };
    const scan = (x, y, margin, carriagewayOnly, streetsOnly = false) => {
        const r = margin <= 1 ? 0 : Math.ceil((margin - 1) / CELL); // cada segmento ya está en las celdas a su alcance + 1 m
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        for (let ix = cx - r; ix <= cx + r; ix++) {
            for (let iy = cy - r; iy <= cy + r; iy++) {
                const l = sgrid.cellList(ix, iy);
                if (!l) continue;
                for (let k = 0; k < l.length; k++) {
                    if (streetsOnly && edges[segArr[l[k] * SEG + 7]].r.lot) continue;
                    if (within(l[k], x, y, margin, carriagewayOnly)) return true;
                }
            }
        }
        return false;
    };
    const onRoad = (x, y, margin = 0) => scan(x, y, margin, false);
    const query = { nearest, onRoad, bounds: { minX, minY, maxX, maxY } };

    // asfalto de los cruces en grilla, para que el mobiliario nunca caiga ahí
    const jgrid = new NumGrid(CELL);
    for (const g of gnodes) {
        if (!g.poly || g.frames.every((f) => f.e.r.pedestrian)) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of g.poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        jgrid.add(x0, y0, x1, y1, g.poly);
    }
    const onCarriageway = (x, y, margin = 0.3) => {
        if (scan(x, y, margin, true)) return true;
        const l = jgrid.cellList(Math.floor(x / CELL), Math.floor(y / CELL));
        return !!l && l.some((p) => pointInPoly(x, y, p));
    };
    // ¿asfalto (calzada, cruce o pasillo de playa)? lo usa el retranqueo de edificios
    query.onAsphalt = onCarriageway;
    query.nearest = (x, y, streetsOnly = false) => nearest(x, y, streetsOnly);

    // --- playas de estacionamiento: pavimento entre los pasillos de OSM, cajones y autos (ver city-lots.js)
    const lotWays = edges.filter((e) => e.r.lot && e.cutLen > 1).map((e) => ({ pts: e.pts, w: e.w }));
    const lotData = buildLots(lotWays, {
        blocked: (x, y) => scan(x, y, 0.5, false, true) || (jgrid.cellList(Math.floor(x / CELL), Math.floor(y / CELL))?.some((p) => pointInPoly(x, y, p)) ?? false)
            || (lotBlocked ? !!lotBlocked(x, y) : false),
    });
    for (const [x0, y0, x1, y1] of lotData.fills) fquad(ground, [x0, y0], [x1, y0], [x1, y1], [x0, y1], Z_ASFALTO - 0.004, COL.playa);
    if (Q.zebras) {
        for (const [ax, ay, bx, by] of lotData.lines) {
            const l = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / l * 0.06, ny = (bx - ax) / l * 0.06;
            fquad(markings, [ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], Z_MARCA, COL.cajon);
        }
    }
    query.lotNear = (x, y, r = 0) => nearLot(lotData.boxes, x, y, r);

    // --- mobiliario
    const furniture = { streetTrees: [], lamps: [], signals: [], busStops: [], benches: [], signs: [], lotCars: lotData.cars };
    const occupied = new NumGrid(5); // radios ≤ 3 m: alcanza con mirar las 9 celdas vecinas
    const occupy = (x, y, r) => {
        const ix = Math.floor(x / 5), iy = Math.floor(y / 5);
        const k = occupied.k(ix, iy);
        let l = occupied.map.get(k);
        if (!l) occupied.map.set(k, (l = []));
        l.push(x, y, r);
    };
    const free = (x, y, r) => {
        const ix = Math.floor(x / 5), iy = Math.floor(y / 5);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const l = occupied.cellList(ix + dx, iy + dy);
                if (!l) continue;
                for (let i = 0; i < l.length; i += 3) {
                    const m = Math.max(r, l[i + 2]);
                    if ((l[i] - x) ** 2 + (l[i + 1] - y) ** 2 < m * m) return false;
                }
            }
        }
        return true;
    };
    const place = (list, item, r) => {
        if (onCarriageway(item.x, item.y)) return false;
        if (!free(item.x, item.y, r)) return false;
        list.push(item);
        occupy(item.x, item.y, r);
        return true;
    };
    // posición sobre un tramo recortado: s a lo largo, o desplazamiento lateral (+ izquierda)
    const at = (e, s, o) => {
        const p = pointAt(e.cut.pts, e.cut.cum, s);
        const [nx, ny] = left(p.tx, p.ty);
        return { x: p.x + nx * o, y: p.y + ny * o, nx, ny, tx: p.tx, ty: p.ty, p };
    };
    const sideW = (e, side, s) => {
        const p = pointAt(e.cut.pts, e.cut.cum, s);
        const arr = side > 0 ? e.cut.wl : e.cut.wr;
        return arr[p.i] + (arr[p.i + 1] - arr[p.i]) * p.t;
    };
    const lowerOfPair = (e, s) => {
        if (!e.partner) return true;
        const p = pointAt(e.pts, e.cum, Math.min(e.len, s + e.trim[0]));
        const partner = e.partner[Math.min(e.partner.length - 1, p.t > 0.5 ? p.i + 1 : p.i)];
        return partner < 0 || e.r.idx < partner;
    };

    // semáforos (uno por brazo que llega con autos; si hay avenidas, solo en las avenidas)
    for (const g of gnodes) {
        if (!g.signal || !g.frames) continue;
        const veh = g.frames.filter((f) => !f.e.r.pedestrian && !f.e.r.lot);
        const anyMajor = veh.some((f) => f.e.r.major);
        for (const f of veh) {
            if (anyMajor && !f.e.r.major) continue;
            const r = f.e.r;
            const incoming = f.arm.end === 0 ? f.e.ow !== 1 : f.e.ow !== -1;
            if (!incoming) continue;
            const o = f.w + Math.min(0.6, Math.max(0.2, f.sl * 0.5));
            const x = f.E[0] + f.n[0] * o + f.d[0] * 0.8, y = f.E[1] + f.n[1] * o + f.d[1] * 0.8;
            place(furniture.signals, { x, y, dirX: f.d[0], dirY: f.d[1] }, 0.8);
        }
    }
    // carteles con el nombre de la calle que cruza (uno por cruce)
    for (const g of gnodes) {
        if (!g.frames || g.arms.length < 3) continue;
        for (const f of g.frames) {
            if (f.tl !== 'vereda' || f.sl < 1 || f.e.consumed) continue;
            const own = normName(f.e.r.name);
            const other = g.frames.find((h) => h.e.r.name && normName(h.e.r.name) !== own);
            const name = other?.e.r.name ?? f.e.r.name;
            if (!name) continue;
            const o = f.w + 0.45;
            const x = f.E[0] + f.n[0] * o + f.d[0] * 0.4, y = f.E[1] + f.n[1] * o + f.d[1] * 0.4;
            if (place(furniture.signs, { x, y, name }, 0.6)) break;
        }
    }
    // paradas de colectivo
    const busLanes = [];
    lanes.forEach((l, i) => { if (l.bus && laneMeta[i].e && !laneMeta[i].escape) busLanes.push(i); });
    const stopAt = (li, sAlongEdge) => {
        const m = laneMeta[li];
        const e = m.e;
        const s = Math.max(3, Math.min(e.cutLen - 3, sAlongEdge - e.trim[0]));
        if (e.cutLen < 8) return null;
        const side = m.sign === 1 ? -1 : 1; // la vereda a la derecha de la marcha
        if ((side > 0 ? e.tl : e.tr) === 'cantero') return null;
        const sw = sideW(e, side, s);
        const pt = at(e, s, side * (e.w + Math.min(1.2, Math.max(0.4, sw * 0.4))));
        const sEdge = e.trim[0] + s; // posición sobre el tramo (desde el nodo a)
        return { x: pt.x, y: pt.y, dirX: -side * pt.nx, dirY: -side * pt.ny, travel: [pt.tx * m.sign, pt.ty * m.sign], laneS: m.sign === 1 ? sEdge : e.len - sEdge };
    };
    const stopPts = (busStops ?? []).map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
    if (stopPts.length) {
        for (const [x, y] of stopPts) {
            let best = -1, bd = Infinity, bsAlong = 0;
            for (const li of busLanes) {
                const pts = lanes[li].pts;
                for (let i = 0; i + 1 < pts.length; i++) {
                    const d2 = segDist2(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
                    if (d2 < bd) { bd = d2; best = li; }
                }
            }
            if (best < 0 || bd > 60 * 60) continue;
            const e = laneMeta[best].e;
            let bs = 0, bdd = Infinity;
            for (let i = 0; i + 1 < e.pts.length; i++) {
                const a = e.pts[i], b = e.pts[i + 1];
                const L = e.cum[i + 1] - e.cum[i];
                if (L < 1e-9) continue;
                const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (L * L)));
                const d2 = segDist2(x, y, a[0], a[1], b[0], b[1]);
                if (d2 < bdd) { bdd = d2; bs = e.cum[i] + t * L; }
            }
            bsAlong = bs;
            const st = stopAt(best, bsAlong);
            if (st && place(furniture.busStops, { x: st.x, y: st.y, dirX: st.dirX, dirY: st.dirY }, 3)) (lanes[best].stops ??= []).push(st.laneS);
        }
    } else {
        const chosen = [];
        for (const li of busLanes) {
            const e = laneMeta[li].e;
            if (laneMeta[li].k !== 0 || e.cutLen < 30) continue;
            const st = stopAt(li, e.trim[0] + e.cutLen / 2);
            if (!st) continue;
            if (chosen.some((c) => Math.hypot(c.x - st.x, c.y - st.y) < 320 && c.travel[0] * st.travel[0] + c.travel[1] * st.travel[1] > 0.3)) continue;
            if (place(furniture.busStops, { x: st.x, y: st.y, dirX: st.dirX, dirY: st.dirY }, 3)) { chosen.push(st); (lanes[li].stops ??= []).push(st.laneS); }
        }
    }
    // faroles
    for (const e of edges) {
        const r = e.r;
        const L = e.cutLen;
        if (L < 12) continue;
        if (r.pedestrian || r.lot) continue;
        if (r.major) {
            const canteroSide = e.tl === 'cantero' ? 1 : e.tr === 'cantero' ? -1 : 0;
            for (let s = 12, k = 0; s < L - 6; s += 40, k++) {
                if (canteroSide && sideW(e, canteroSide, s) * 2 >= 1.2) {
                    if (!lowerOfPair(e, s)) continue;
                    const pt = at(e, s, canteroSide * (e.w + sideW(e, canteroSide, s)));
                    place(furniture.lamps, { x: pt.x, y: pt.y, dirX: -canteroSide * pt.nx, dirY: -canteroSide * pt.ny, kind: 'avenida' }, 1.5);
                    continue;
                }
                for (const side of canteroSide ? [-canteroSide] : [1, -1]) {
                    const pt = at(e, s, side * (e.w + 0.6));
                    place(furniture.lamps, { x: pt.x, y: pt.y, dirX: -side * pt.nx, dirY: -side * pt.ny, kind: 'avenida' }, 1.5);
                }
            }
        } else {
            for (let s = 10, k = 0; s < L - 6; s += r.service ? 80 : 40, k++) {
                const side = (e.idx + k) % 2 ? 1 : -1;
                const type = side > 0 ? e.tl : e.tr;
                if (type === 'none') continue;
                const o = e.w + (type === 'verde' ? 1 : Math.min(0.5, sideW(e, side, s) * 0.5));
                const pt = at(e, s, side * o);
                place(furniture.lamps, { x: pt.x, y: pt.y, dirX: -side * pt.nx, dirY: -side * pt.ny, kind: 'calle' }, 1.5);
            }
        }
    }
    // peatonales: árboles, bancos, maceteros y faroles en dos filas
    for (const e of edges) {
        if (!e.r.pedestrian || e.cutLen < 6 || e.w < 2.5) continue;
        const o = Math.max(1, e.w - 1.6);
        for (let s = 3, k = 0; s < e.cutLen - 3; s += 6, k++) {
            const side = k % 2 ? 1 : -1;
            const pt = at(e, s, side * o);
            const kind = k % 4;
            if (kind === 0) {
                if (free(pt.x, pt.y, 2)) { furniture.streetTrees.push({ x: pt.x, y: pt.y, context: 'peatonal' }); occupy(pt.x, pt.y, 2); }
            } else if (kind === 1) {
                place(furniture.benches, { x: pt.x, y: pt.y, dirX: -side * pt.nx, dirY: -side * pt.ny }, 1);
            } else if (kind === 2) {
                if (free(pt.x, pt.y, 1)) {
                    boxTop(ground, pt.x, pt.y, [pt.tx, pt.ty], [pt.nx, pt.ny], 0.7, 0.7, Z_VEREDA, Z_VEREDA + 0.5, COL.maceta);
                    fquad(ground, ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [pt.x + pt.tx * u * 0.55 + pt.nx * v * 0.55, pt.y + pt.ty * u * 0.55 + pt.ny * v * 0.55]), Z_VEREDA + 0.52, COL.cantero);
                    occupy(pt.x, pt.y, 1);
                }
            } else {
                place(furniture.lamps, { x: pt.x, y: pt.y, dirX: -side * pt.nx, dirY: -side * pt.ny, kind: 'calle' }, 1.5);
            }
        }
    }
    // árboles de vereda, banquina y cantero
    for (const e of edges) {
        const r = e.r;
        if (r.pedestrian || r.lot) continue;
        const L = e.cutLen;
        for (const side of [1, -1]) {
            const type = side > 0 ? e.tl : e.tr;
            if (type === 'none') continue;
            if (type === 'cantero') {
                for (let s = 5, k = 0; s < L - 5; s += 8, k++) {
                    const half = sideW(e, side, s);
                    if (half < 0.8 || !lowerOfPair(e, s)) continue;
                    const pt = at(e, s, side * (e.w + half));
                    if (!onCarriageway(pt.x, pt.y, 0.5) && free(pt.x, pt.y, 2)) {
                        furniture.streetTrees.push({ x: pt.x, y: pt.y, context: 'cantero' });
                        occupy(pt.x, pt.y, 2);
                    }
                }
                continue;
            }
            // Formosa es de arbolado tupido: veredas casi continuas de árboles (poco salteo, paso corto)
            const step = type === 'verde' ? 10 : 7;
            const minW = type === 'verde' ? 1.5 : 2;
            for (let s = 5, k = 0; s < L - 5; s += step, k++) {
                const salt = e.idx * 977 + k * 2 + (side > 0 ? 1 : 0);
                if (hash01(salt, 23) < (type === 'verde' ? 0.2 : 0.06)) continue;
                const ss = Math.min(L - 5, s + (hash01(salt, 29) - 0.5) * 2);
                const sw = sideW(e, side, ss);
                if (sw < minW) continue;
                const o = e.w + (type === 'verde' ? sw * 0.5 : 0.8);
                const pt = at(e, ss, side * o);
                if (!onCarriageway(pt.x, pt.y, 0.5) && free(pt.x, pt.y, 2.5)) {
                    furniture.streetTrees.push({ x: pt.x, y: pt.y, context: 'vereda' });
                    occupy(pt.x, pt.y, 2.5);
                }
            }
        }
    }

    return {
        builders: { ground: ground.seal(), markings: markings.seal() },
        intersections,
        laneGraph,
        furniture,
        query,
        pairs: pairs.map(([a, b]) => [rs[a].src, rs[b].src]),
        debug: {
            edges: edges.map((e) => ({ pts: e.pts, cut: e.cut.pts, w: e.w, pedestrian: !!e.r.pedestrian, road: e.r.src, trim: e.trim })),
            junctionPolys: junctionPolys.filter(Boolean),
            onCarriageway,
        },
    };
}
