// Entorno de la ciudad 3D: suelo con colores, río y barranca, alrededores (quintas, campos, caminos de tierra),
// plazas detalladas (Plaza San Martín y plazas genéricas) y edificios emblemáticos hechos a mano.
// Puro (sin DOM ni WebGL): solo arma triángulos en MeshBuilder y listas de posiciones. Se prueba con node --test.
// Metros locales: x = este, y = norte, z = arriba. Todo lo "aleatorio" sale de hash01 (misma ciudad en todos lados).
import { ShapeUtils, Vector2 } from 'three';
import { MeshBuilder, hash01, hexToRgb, normalizeRing, orientedBox, signedArea, PALETTE } from './city-geometry.js';

// ------------------------------------------------------------------ utilidades

const RGB = new Map();
/** Color sRGB 0..1 desde '#hex' (cacheado: no se crean arreglos nuevos en cada triángulo). */
const rgb = (hex) => {
    let c = RGB.get(hex);
    if (!c) {
        c = hexToRgb(hex);
        RGB.set(hex, c);
    }
    return c;
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, f) => [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pickOf = (list, n, salt) => list[Math.floor(hash01(n, salt) * list.length) % list.length];

/** Entero estable a partir de una posición redondeada (para usar como semilla de hash01). */
const posKey = (x, y, k = 1) => (Math.imul(Math.round(x * k) | 0, 73856093) ^ Math.imul(Math.round(y * k) | 0, 19349663)) | 0;

/** Ruido de valor suave (bilineal) en [0,1). */
function noise(x, y, scale, salt) {
    const fx = x / scale, fy = y / scale;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const h = (a, b) => hash01(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), salt);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

export function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function centroid(ring) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        const f = x1 * y2 - x2 * y1;
        a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-9) {
        let sx = 0, sy = 0;
        for (const [x, y] of ring) { sx += x; sy += y; }
        return [sx / (ring.length || 1), sy / (ring.length || 1)];
    }
    return [cx / (3 * a), cy / (3 * a)];
}

function bboxOf(rings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) {
        for (const [x, y] of r) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
}

function hull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) {
        while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop();
        lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop();
        up.push(p);
    }
    return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Recorta un polígono (convexo o no) con el semiplano nx*x + ny*y >= c. */
function clipHalf(poly, nx, ny, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const dp = p[0] * nx + p[1] * ny - c, dq = q[0] * nx + q[1] * ny - c;
        if (dp >= 0) out.push(p);
        if ((dp >= 0) !== (dq >= 0)) {
            const t = dp / (dp - dq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
    }
    return out;
}

/** Recorta `poly` con un polígono convexo antihorario. */
function clipConvex(poly, clip) {
    let out = poly;
    for (let i = 0; i < clip.length && out.length >= 3; i++) {
        const a = clip[i], b = clip[(i + 1) % clip.length];
        const nx = -(b[1] - a[1]), ny = b[0] - a[0]; // izquierda = adentro
        out = clipHalf(out, nx, ny, nx * a[0] + ny * a[1]);
    }
    return out;
}

/** Achica un polígono convexo antihorario `d` metros hacia adentro (cada lado se corre en paralelo). */
function insetConvex(poly, d) {
    const n = poly.length;
    const lines = [];
    for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        lines.push([a[0] + nx * d, a[1] + ny * d, (b[0] - a[0]) / len, (b[1] - a[1]) / len]);
    }
    const out = [];
    for (let i = 0; i < n; i++) {
        const L1 = lines[(i + n - 1) % n], L2 = lines[i];
        const den = L1[2] * L2[3] - L1[3] * L2[2];
        if (Math.abs(den) < 1e-9) {
            out.push([L2[0], L2[1]]);
            continue;
        }
        const t = ((L2[0] - L1[0]) * L2[3] - (L2[1] - L1[1]) * L2[2]) / den;
        out.push([L1[0] + L1[2] * t, L1[1] + L1[3] * t]);
    }
    // si se dio vuelta (achicado de más) no queda nada
    return signedArea(out) > 0.5 ? out : [];
}

const VEC_POOL = [];
/** Rellena un polígono (con agujeros opcionales) a la altura z, siempre mirando para arriba. */
function fillPoly(b, ring, z, color, id = 0, holes = null) {
    const r = normalizeRing(ring);
    if (r.length < 3) return 0;
    const hs = holes ? holes.map((h) => {
        const n = normalizeRing(h);
        return n.reverse();
    }) : [];
    const all = hs.length ? r.concat(...hs) : r;
    const contour = r.map(([x, y]) => new Vector2(x, y));
    const holeVecs = hs.map((h) => h.map(([x, y]) => new Vector2(x, y)));
    const tris = ShapeUtils.triangulateShape(contour, holeVecs);
    for (let [a, bb, c] of tris) {
        const cross = (all[bb][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[bb][1] - all[a][1]) * (all[c][0] - all[a][0]);
        if (cross < 0) [bb, c] = [c, bb];
        b.tri([all[a][0], all[a][1], z], [all[bb][0], all[bb][1], z], [all[c][0], all[c][1], z], color, id);
    }
    void VEC_POOL;
    return tris.length;
}

/** Polígono convexo (abanico) a la altura z: más barato que triangular. */
function fanPoly(b, poly, z, color, id = 0) {
    if (poly.length < 3) return;
    const ccw = signedArea(poly) >= 0;
    for (let i = 1; i + 1 < poly.length; i++) {
        const p = poly[0], q = ccw ? poly[i] : poly[i + 1], r = ccw ? poly[i + 1] : poly[i];
        b.tri([p[0], p[1], z], [q[0], q[1], z], [r[0], r[1], z], color, id);
    }
}

/** Cuadrilátero horizontal mirando siempre para arriba (da vuelta el orden si viene horario). */
function upQuad(b, A, B, C, D, color) {
    const cr = (C[0] - A[0]) * (D[1] - B[1]) - (C[1] - A[1]) * (D[0] - B[0]);
    if (cr >= 0) b.quad(A, B, C, D, color, 0);
    else b.quad(A, D, C, B, color, 0);
}

/** Paredes verticales alrededor de un anillo antihorario (de z0 a z1). */
function ringWalls(b, ring, z0, z1, color) {
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        b.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], color, 0);
    }
}

/** Losa: tapa + costados (polígono convexo antihorario). */
function slab(b, poly, z0, z1, top, side = top) {
    const r = signedArea(poly) >= 0 ? poly : poly.slice().reverse();
    ringWalls(b, r, z0, z1, side);
    fanPoly(b, r, z1, top);
}

/** Tira recta de ancho 2·hw entre a y b, a la altura z (camino, línea). */
function strip(b, a, c, hw, z, color, ext = 0) {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len < 1e-6) return;
    const dx = (c[0] - a[0]) / len, dy = (c[1] - a[1]) / len;
    const nx = -dy * hw, ny = dx * hw;
    const ax = a[0] - dx * ext, ay = a[1] - dy * ext, cx = c[0] + dx * ext, cy = c[1] + dy * ext;
    b.quad([ax - nx, ay - ny, z], [cx - nx, cy - ny, z], [cx + nx, cy + ny, z], [ax + nx, ay + ny, z], color, 0);
}

function circlePts(cx, cy, rx, ry, n, ux = 1, uy = 0, a0 = 0, a1 = Math.PI * 2) {
    const out = [];
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-9;
    const cnt = full ? n : n + 1;
    for (let i = 0; i < cnt; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const s = Math.cos(a) * rx, t = Math.sin(a) * ry;
        out.push([cx + ux * s - uy * t, cy + uy * s + ux * t]);
    }
    return out;
}

/** Caja orientada con eje u (unitario); v = u girado 90° antihorario. */
function obox(b, cx, cy, ux, uy, hu, hv, z0, z1, color) {
    b.box(cx, cy, [ux, uy], [-uy, ux], hu, hv, z0, z1, color, 0);
}

/** Pirámide (techo de glorieta, punta de obelisco) sobre un polígono convexo. */
function pyramid(b, base, z0, apex, color) {
    const r = signedArea(base) >= 0 ? base : base.slice().reverse();
    for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        b.tri([p[0], p[1], z0], [q[0], q[1], z0], apex, color, 0);
    }
}

/** Casa baja: paredes + techo a dos aguas (14 triángulos) o plano (10). */
export function addHouse(b, cx, cy, ux, uy, A, B, H, wall, roof, pitched) {
    const vx = -uy, vy = ux;
    const at = (s, t, z) => [cx + ux * s + vx * t, cy + uy * s + vy * t, z];
    if (!pitched) {
        b.box(cx, cy, [ux, uy], [vx, vy], A, B, 0, H, wall, 0);
        // pretil del techo plano (solo la tapa de otro color, sin triángulos extra: se recolorea la tapa)
        const n = b.col.length;
        for (let i = n - 18; i < n; i += 3) {
            b.col[i] = roof[0]; b.col[i + 1] = roof[1]; b.col[i + 2] = roof[2];
        }
        return 10;
    }
    const c = [at(-A, -B, 0), at(A, -B, 0), at(A, B, 0), at(-A, B, 0)];
    for (let i = 0; i < 4; i++) {
        const p = c[i], q = c[(i + 1) % 4];
        b.quad(p, q, [q[0], q[1], H], [p[0], p[1], H], wall, 0);
    }
    const pitch = Math.min(0.6, 2 / B);
    const ridge = H + B * pitch;
    b.tri(at(A, -B, H), at(A, B, H), at(A, 0, ridge), wall, 0);
    b.tri(at(-A, B, H), at(-A, -B, H), at(-A, 0, ridge), wall, 0);
    const o = 0.3, ez = H - o * pitch;
    b.quad(at(-A - o, -B - o, ez), at(A + o, -B - o, ez), at(A + o, 0, ridge), at(-A - o, 0, ridge), roof, 0);
    b.quad(at(A + o, B + o, ez), at(-A - o, B + o, ez), at(-A - o, 0, ridge), at(A + o, 0, ridge), roof, 0);
    return 14;
}

/** Proyecta [lng,lat] → [x,y] o deja pasar coordenadas ya locales. */
function ringsOfGeometry(geom, toLocal) {
    if (!geom) return [];
    const conv = (r) => r.map((p) => toLocal(p));
    if (geom.type === 'Polygon') return [geom.coordinates.map(conv)];
    if (geom.type === 'MultiPolygon') return geom.coordinates.map((poly) => poly.map(conv));
    return [];
}
function linesOfGeometry(geom, toLocal) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates.map((p) => toLocal(p))];
    if (geom.type === 'MultiLineString') return geom.coordinates.map((l) => l.map((p) => toLocal(p)));
    return [];
}

// ------------------------------------------------------------------ índice de polígonos (¿adentro?, ¿cruza un borde?)

/**
 * Índice espacial de un conjunto de polígonos (cada uno: anillo exterior + agujeros).
 * contains(x,y) → índice del polígono que contiene el punto (o -1); crosses(caja) → algún borde corta la caja.
 */
export class PolyIndex {
    constructor(polys, cell = 50) {
        this.cell = cell;
        this.polys = polys;
        this.bands = new Map();
        this.cells = new Map();
        const e = [];
        polys.forEach((rings, pid) => {
            for (const r of rings) {
                for (let i = 0; i < r.length; i++) {
                    const p = r[i], q = r[(i + 1) % r.length];
                    if (p[0] === q[0] && p[1] === q[1]) continue;
                    e.push(p[0], p[1], q[0], q[1], pid);
                }
            }
        });
        this.edges = Float64Array.from(e);
        const n = this.edges.length / 5;
        for (let k = 0; k < n; k++) {
            const o = k * 5;
            const x1 = this.edges[o], y1 = this.edges[o + 1], x2 = this.edges[o + 2], y2 = this.edges[o + 3];
            const b0 = Math.floor(Math.min(y1, y2) / cell), b1 = Math.floor(Math.max(y1, y2) / cell);
            for (let bnd = b0; bnd <= b1; bnd++) {
                let arr = this.bands.get(bnd);
                if (!arr) this.bands.set(bnd, (arr = []));
                arr.push(k);
            }
            // celdas que toca el borde (recorrido fino a lo largo del segmento)
            const len = Math.hypot(x2 - x1, y2 - y1);
            const steps = Math.max(1, Math.ceil(len / (cell * 0.25)));
            let last = NaN;
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const key = this.key(Math.floor((x1 + (x2 - x1) * t) / cell), Math.floor((y1 + (y2 - y1) * t) / cell));
                if (key === last) continue;
                last = key;
                let arr = this.cells.get(key);
                if (!arr) this.cells.set(key, (arr = []));
                if (arr.at(-1) !== k) arr.push(k);
            }
        }
        this.parity = new Uint8Array(polys.length);
        this.touched = [];
        this.stamp = new Uint32Array(n);
        this.tick = 0;
    }

    key(ix, iy) {
        return ix * 1048576 + iy;
    }

    contains(x, y) {
        const arr = this.bands.get(Math.floor(y / this.cell));
        if (!arr) return -1;
        const E = this.edges, par = this.parity, touched = this.touched;
        for (const k of arr) {
            const o = k * 5;
            const y1 = E[o + 1], y2 = E[o + 3];
            if ((y1 > y) === (y2 > y)) continue;
            const x1 = E[o], x2 = E[o + 2];
            if (x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) {
                const pid = E[o + 4];
                par[pid] ^= 1;
                touched.push(pid);
            }
        }
        let found = -1;
        for (const pid of touched) {
            if (par[pid] && found < 0) found = pid;
            par[pid] = 0;
        }
        touched.length = 0;
        return found;
    }

    /** Como contains, pero el polígono que contiene el punto con el menor `weight[pid]` (p. ej. el área), o -1. */
    containsMin(x, y, weight) {
        const arr = this.bands.get(Math.floor(y / this.cell));
        if (!arr) return -1;
        const E = this.edges, par = this.parity, touched = this.touched;
        for (const k of arr) {
            const o = k * 5;
            const y1 = E[o + 1], y2 = E[o + 3];
            if ((y1 > y) === (y2 > y)) continue;
            const x1 = E[o], x2 = E[o + 2];
            if (x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) {
                const pid = E[o + 4];
                par[pid] ^= 1;
                touched.push(pid);
            }
        }
        let found = -1;
        for (const pid of touched) {
            if (par[pid] && (found < 0 || weight[pid] < weight[found])) found = pid;
            par[pid] = 0;
        }
        touched.length = 0;
        return found;
    }

    /** ¿Algún borde corta (o toca) la caja? Prueba exacta segmento–caja (Liang–Barsky). */
    crosses(minX, minY, maxX, maxY) {
        const c = this.cell;
        const E = this.edges;
        this.tick++;
        for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++) {
            for (let iy = Math.floor(minY / c); iy <= Math.floor(maxY / c); iy++) {
                const arr = this.cells.get(this.key(ix, iy));
                if (!arr) continue;
                for (const k of arr) {
                    if (this.stamp[k] === this.tick) continue;
                    this.stamp[k] = this.tick;
                    const o = k * 5;
                    if (segBox(E[o], E[o + 1], E[o + 2], E[o + 3], minX, minY, maxX, maxY)) return true;
                }
            }
        }
        return false;
    }
}

function segBox(x1, y1, x2, y2, minX, minY, maxX, maxY) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return false;
        } else {
            const t = q[i] / p[i];
            if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
        }
    }
    return true;
}

// ------------------------------------------------------------------ colores

const GRASS = ['#6fb35e', '#6aae59', '#74b862', '#67aa57', '#71b25f'];
const DRY = '#98b25f';
const EARTH = '#b49a6a';
const LANDUSE = {
    residential: ['#93c07e', '#97c283', '#8fbb7c'],
    // commercial / retail: sin color propio (eran parches verdes claros en forma de rombo sobre las playas y manzanas del súper)
    industrial: ['#a6a69c', '#9fa096', '#acaba0'],
    railway: ['#a59f8f', '#9d9787'],
    cemetery: ['#86b27e', '#8bb784', '#7fad78'],
    farmland: ['#a9c45a', '#c4c06a'],
    farmyard: ['#b4b27a', '#aaa872'],
    meadow: ['#7ec86a', '#84c96d'],
    grass: ['#78c766', '#7cc96a'],
    village_green: ['#78c766'],
    recreation_ground: ['#72c262'],
    forest: ['#3f8a46', '#45904a', '#3a8241'],
    wood: ['#3f8a46', '#45904a'],
    orchard: ['#6aa84f', '#73b057'],
    brownfield: ['#b4a57d'],
    construction: ['#c0a77a'],
    military: ['#9aa58a'],
    scrub: ['#6e9f52'],
    wetland: ['#6fa889', '#76ad8a'],
};
const WATER = ['#5a8fb0', '#5891b2', '#5d8cad'];
const BANK_SAND = '#d8c18e';
const BANK_EARTH = '#a8673f';
const BANK_GREEN = '#5d9c4f';
const PARK = '#5fb85a';
const PLAZA_LAWN = '#63ba57';
const PITCH = '#4caa4c';
const PLAYGROUND = '#e2cd98';

// ------------------------------------------------------------------ 1) suelo

/**
 * Suelo de la ciudad y sus alrededores: grilla low-poly (celdas de ~40 m adentro, más grandes afuera) con manchas de pasto
 * seco, colores por uso del suelo, parques/plazas/canchas apenas elevados, agua (río, lagunas) con su orilla de arena y
 * la barranca del lado del río. Las celdas que caen en el agua se descartan (el agua va en su propio mesh, a z -0.05).
 *
 * @param bounds      {minX,minY,maxX,maxY} de la ciudad (metros locales)
 * @param envFeatures features de /api/entorno (lng/lat); sin agua no se inventa ningún río
 * @param toLocal     [lng,lat] → [x,y]
 * @param roadQuery   opcional (query de city-roads): las líneas de canchas no se pintan sobre calles
 * @returns {{ builders:{ground,water}, parks:[ring], plazas:[{ring,name}], waterSide:'east'|'west'|'north'|'south'|null,
 *            waterRings:[ring], extent }}
 */
export function buildGround(bounds, envFeatures = [], toLocal = (p) => p, roadQuery = null, { quality = 'media', margin = 2000 } = {}) {
    const ground = new MeshBuilder();
    const water = new MeshBuilder();
    const big = 200; // celdas grandes de afuera; el suelo termina justo en múltiplos de `big`
    const ext = {
        minX: Math.floor((bounds.minX - margin) / big) * big, minY: Math.floor((bounds.minY - margin) / big) * big,
        maxX: Math.ceil((bounds.maxX + margin) / big) * big, maxY: Math.ceil((bounds.maxY + margin) / big) * big,
    };

    // ---- clasificar features
    const waterPolys = []; // [[outer, ...holes]]
    const riverLines = [];
    const parks = [], plazas = [], pitches = [], playgrounds = [], landuse = [];
    const allRings = [];
    for (const f of envFeatures ?? []) {
        const p = f?.properties ?? {};
        const kind = p.kind;
        const g = f?.geometry;
        if (!g) continue;
        if (kind === 'river') {
            for (const l of linesOfGeometry(g, toLocal)) {
                if (l.length < 2) continue;
                // sin ancho: los ríos grandes de la zona (Paraguay, Paraná, Bermejo) son anchos; arroyos y riachos, angostos
            const w = Number(p.width) > 0 ? Number(p.width)
                : /paraguay|paran[aá]/i.test(p.name ?? '') ? 400 : /bermejo|pilcomayo/i.test(p.name ?? '') ? 80
                    : /stream|arroyo|riacho/i.test(`${p.waterway ?? ''} ${p.name ?? ''}`) ? 6 : 25;
                riverLines.push({ line: l, w });
                allRings.push(l);
            }
            continue;
        }
        const polys = ringsOfGeometry(g, toLocal)
            .map((rings) => rings.map((r) => normalizeRing(r)).filter((r) => r.length >= 3))
            .filter((rings) => rings.length > 0);
        if (!polys.length) continue;
        for (const rings of polys) allRings.push(rings[0]);
        if (kind === 'water') waterPolys.push(...polys);
        else if (kind === 'park') parks.push(...polys.map((r) => ({ ring: r[0], name: p.name ?? null })));
        else if (kind === 'plaza') plazas.push(...polys.map((r) => ({ ring: r[0], name: p.name ?? null })));
        else if (kind === 'pitch') pitches.push(...polys.map((r) => r[0]));
        else if (kind === 'playground') playgrounds.push(...polys.map((r) => r[0]));
        else if (kind === 'landuse') landuse.push(...polys.map((r) => ({ rings: r, type: String(p.landuse ?? 'grass') })));
    }

    // ---- agua: polígonos, ríos como línea con ancho, y prolongación más allá del recorte de los datos
    const clip = allRings.length ? bboxOf(allRings) : null;
    const tol = 3;
    /** Lado del recorte de datos sobre el que está apoyado el borde p–q (bordes artificiales), o null. */
    const sideOfEdge = (p, q) => {
        if (!clip) return null;
        if (Math.abs(p[0] - clip.maxX) < tol && Math.abs(q[0] - clip.maxX) < tol) return 'east';
        if (Math.abs(p[0] - clip.minX) < tol && Math.abs(q[0] - clip.minX) < tol) return 'west';
        if (Math.abs(p[1] - clip.maxY) < tol && Math.abs(q[1] - clip.maxY) < tol) return 'north';
        if (Math.abs(p[1] - clip.minY) < tol && Math.abs(q[1] - clip.minY) < tol) return 'south';
        return null;
    };
    const extrusions = [];
    let waterArea = 0, wcx = 0, wcy = 0;
    for (const rings of waterPolys) {
        const outer = rings[0];
        const a = Math.abs(signedArea(outer));
        const [cx, cy] = centroid(outer);
        waterArea += a; wcx += cx * a; wcy += cy * a;
        for (let i = 0; i < outer.length; i++) {
            const p = outer[i], q = outer[(i + 1) % outer.length];
            const s = sideOfEdge(p, q);
            if (!s || Math.hypot(q[0] - p[0], q[1] - p[1]) < 1) continue;
            let r = null;
            if (s === 'east' && ext.maxX > clip.maxX) r = [p, q, [ext.maxX, q[1]], [ext.maxX, p[1]]];
            if (s === 'west' && ext.minX < clip.minX) r = [p, q, [ext.minX, q[1]], [ext.minX, p[1]]];
            if (s === 'north' && ext.maxY > clip.maxY) r = [p, q, [q[0], ext.maxY], [p[0], ext.maxY]];
            if (s === 'south' && ext.minY < clip.minY) r = [p, q, [q[0], ext.minY], [p[0], ext.minY]];
            if (r) extrusions.push([normalizeRing(r)]);
        }
    }
    // esquinas: si el agua llega a una esquina del recorte, se rellena el cuadrante de afuera
    if (clip && waterPolys.length) {
        const tmp = new PolyIndex(waterPolys, 100);
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const cx = sx > 0 ? clip.maxX : clip.minX, cy = sy > 0 ? clip.maxY : clip.minY;
            if (tmp.contains(cx - sx * 2, cy - sy * 2) < 0) continue;
            const ex = sx > 0 ? ext.maxX : ext.minX, ey = sy > 0 ? ext.maxY : ext.minY;
            if ((ex - cx) * sx <= 0 || (ey - cy) * sy <= 0) continue;
            extrusions.push([normalizeRing([[cx, cy], [ex, cy], [ex, ey], [cx, ey]])]);
        }
    }
    const riverPolys = [];
    for (const { line, w } of riverLines) {
        for (let i = 0; i + 1 < line.length; i++) {
            const a = line[i], c = line[i + 1];
            const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
            if (len < 0.5) continue;
            const dx = (c[0] - a[0]) / len, dy = (c[1] - a[1]) / len, hw = w / 2;
            const e0 = i === 0 ? 0 : hw * 0.6, e1 = i + 2 === line.length ? 0 : hw * 0.6; // solapan en las uniones
            riverPolys.push([normalizeRing([
                [a[0] - dx * e0 + dy * hw, a[1] - dy * e0 - dx * hw], [c[0] + dx * e1 + dy * hw, c[1] + dy * e1 - dx * hw],
                [c[0] + dx * e1 - dy * hw, c[1] + dy * e1 + dx * hw], [a[0] - dx * e0 - dy * hw, a[1] - dy * e0 + dx * hw],
            ])]);
        }
    }
    const allWater = [...waterPolys, ...extrusions, ...riverPolys];
    const waterIdx = allWater.length ? new PolyIndex(allWater, 50) : null;

    let waterSide = null;
    if (waterArea > 0) {
        const cx = wcx / waterArea, cy = wcy / waterArea;
        const mx = (bounds.minX + bounds.maxX) / 2, my = (bounds.minY + bounds.maxY) / 2;
        const dx = (cx - mx) / Math.max(1, bounds.maxX - bounds.minX), dy = (cy - my) / Math.max(1, bounds.maxY - bounds.minY);
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 0.15) {
            waterSide = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'north' : 'south');
        }
    }

    // ---- uso del suelo (el polígono más chico gana)
    const luIdx = landuse.length ? new PolyIndex(landuse.map((l) => l.rings), 80) : null;
    const luArea = landuse.map((l) => Math.abs(signedArea(l.rings[0])));
    /** Uso del suelo en (x,y): si hay varios superpuestos gana el más chico. */
    const landuseAt = (x, y) => (luIdx ? luIdx.containsMin(x, y, luArea) : -1);

    // ---- grilla del suelo
    const small = quality === 'baja' ? 66.67 : 40;
    const leaf = quality === 'baja' ? 9 : 6.5;
    const innerPad = 150;
    const inner = { minX: bounds.minX - innerPad, minY: bounds.minY - innerPad, maxX: bounds.maxX + innerPad, maxY: bounds.maxY + innerPad };
    const distOut = (x, y) => {
        const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX), dy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
        return Math.hypot(dx, dy);
    };
    const tmpC = [0, 0, 0];
    const colorAt = (x, y, salt, li) => {
        const k = posKey(x, y, 0.1);
        // mezcla continua (no por escalones): sin el efecto tablero de celdas
        let c = mix(mix(rgb(GRASS[1]), rgb(GRASS[2]), noise(x, y, 110, 3)), rgb(GRASS[3]), noise(x, y, 260, 4) * 0.5);
        const dry = noise(x, y, 380, 5);
        if (dry > 0.6) c = mix(c, rgb(DRY), Math.min(1, (dry - 0.6) * 3.2));
        const d = distOut(x, y);
        if (d > 1200) c = mix(c, rgb(EARTH), Math.min(0.45, ((d - 1200) / (margin - 1200)) * 0.45 * (0.6 + noise(x, y, 260, 9) * 0.8)));
        if (d < 600) {
            if (li >= 0) {
                const pal = LANDUSE[landuse[li].type];
                // mezcla parcial: el uso del suelo tiñe, pero sin dibujar un "borde de bandeja"
                if (pal) c = mix(c, rgb(pal[Math.floor(hash01(li, 3) * pal.length) % pal.length]), landuse[li].type === 'residential' ? 0.35 : 0.8);
            }
        }
        const j = 0.985 + hash01(k, salt) * 0.03;
        tmpC[0] = Math.min(1, c[0] * j); tmpC[1] = Math.min(1, c[1] * j); tmpC[2] = Math.min(1, c[2] * j);
        return tmpC;
    };
    const quadCell = (x0, y0, s) => {
        const x1 = x0 + s, y1 = y0 + s;
        const cx = x0 + s / 2, cy = y0 + s / 2;
        // cultivos dentro de la ciudad: franjas
        const li = luIdx && distOut(cx, cy) < 600 ? landuseAt(cx, cy) : -1;
        {
            if (li >= 0 && landuse[li].type === 'farmland') {
                const n = 4, w = s / n;
                for (let i = 0; i < n; i++) {
                    const col = rgb(i % 2 ? '#a9c45a' : '#c4c06a');
                    ground.quad([x0 + i * w, y0, 0], [x0 + (i + 1) * w, y0, 0], [x0 + (i + 1) * w, y1, 0], [x0 + i * w, y1, 0], col, 0);
                }
                return;
            }
        }
        const c1 = colorAt(cx, cy, 1, li).slice();
        const c2 = colorAt(cx, cy, 2, li);
        ground.tri([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], c1, 0);
        ground.tri([x0, y0, 0], [x1, y1, 0], [x0, y1, 0], c2, 0);
    };
    const emit = (x0, y0, s) => {
        if (!waterIdx) return quadCell(x0, y0, s);
        if (!waterIdx.crosses(x0, y0, x0 + s, y0 + s)) {
            if (waterIdx.contains(x0 + s / 2, y0 + s / 2) < 0) quadCell(x0, y0, s);
            return;
        }
        if (s > leaf) {
            const h = s / 2;
            emit(x0, y0, h); emit(x0 + h, y0, h); emit(x0, y0 + h, h); emit(x0 + h, y0 + h, h);
        }
        // hoja que cruza la orilla: se descarta (la tapa la franja de arena)
    };
    const gx0 = Math.floor(ext.minX / big) * big, gy0 = Math.floor(ext.minY / big) * big;
    const gx1 = Math.ceil(ext.maxX / big) * big, gy1 = Math.ceil(ext.maxY / big) * big;
    const sub = Math.round(big / small);
    for (let x = gx0; x < gx1; x += big) {
        for (let y = gy0; y < gy1; y += big) {
            const isInner = x + big > inner.minX && x < inner.maxX && y + big > inner.minY && y < inner.maxY;
            if (!isInner) {
                emit(x, y, big);
                continue;
            }
            const s = big / sub;
            for (let i = 0; i < sub; i++) {
                for (let j = 0; j < sub; j++) emit(x + i * s, y + j * s, s);
            }
        }
    }

    // ---- agua
    allWater.forEach((rings, i) => {
        const col = rgb(WATER[i % WATER.length]);
        fillPoly(water, rings[0], -0.05, col, 0, rings.length > 1 ? rings.slice(1) : null);
    });
    // ---- orillas: arena (y barranca de tierra colorada del lado del río grande)
    const onExt = (p, q) => (Math.abs(p[0] - q[0]) < tol && (Math.abs(p[0] - ext.minX) < tol || Math.abs(p[0] - ext.maxX) < tol))
        || (Math.abs(p[1] - q[1]) < tol && (Math.abs(p[1] - ext.minY) < tol || Math.abs(p[1] - ext.maxY) < tol));
    const bank = (ring, isHole, mainRiver) => {
        const n = ring.length;
        const sign = isHole ? -1 : 1; // los agujeros (islas) vienen invertidos: la orilla va hacia adentro de la isla
        const bands = mainRiver ? [[0, 5, BANK_SAND], [5, 13, BANK_EARTH], [13, 19, BANK_GREEN]] : [[0, 4, BANK_SAND], [4, 9, '#b98a5a']];
        for (let i = 0; i < n; i++) {
            const p = ring[i], q = ring[(i + 1) % n];
            if (sideOfEdge(p, q) || onExt(p, q)) continue; // borde artificial del recorte de datos o del final del suelo
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len < 0.01) continue;
            const nx = ((q[1] - p[1]) / len) * sign, ny = (-(q[0] - p[0]) / len) * sign;
            for (const [a, bnd, hex] of bands) {
                const col = rgb(hex);
                const z = 0.01;
                const P = (pt, d) => [pt[0] + nx * d, pt[1] + ny * d, z];
                upQuad(ground, P(p, a), P(q, a), P(q, bnd), P(p, bnd), col);
            }
            // esquina convexa: abanico hasta el borde siguiente
            const r = ring[(i + 2) % n];
            const len2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
            if (len2 < 0.01) continue;
            const nx2 = ((r[1] - q[1]) / len2) * sign, ny2 = (-(r[0] - q[0]) / len2) * sign;
            const turn = nx * ny2 - ny * nx2;
            if (turn * sign < 0 || sideOfEdge(q, r)) continue; // gira hacia afuera = esquina convexa vista desde la tierra
            const w = bands.at(-1)[1];
            const col = rgb(bands.at(-1)[2]);
            const A = [q[0], q[1], 0.01], B = [q[0] + nx * w, q[1] + ny * w, 0.01], C = [q[0] + nx2 * w, q[1] + ny2 * w, 0.01];
            const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
            if (cr >= 0) ground.tri(A, B, C, col, 0); else ground.tri(A, C, B, col, 0);
        }
    };
    let mainIdx = -1, mainA = 0;
    waterPolys.forEach((rings, i) => {
        const a = Math.abs(signedArea(rings[0]));
        if (a > mainA) { mainA = a; mainIdx = i; }
    });
    waterPolys.forEach((rings, i) => {
        const main = i === mainIdx && waterSide !== null;
        bank(rings[0], false, main);
        for (const h of rings.slice(1)) bank(h, true, false);
    });
    for (const rings of extrusions) bank(rings[0], false, true);
    for (const { line, w } of riverLines) {
        // ríos angostos: orilla de arena a los costados de la línea
        for (let i = 0; i + 1 < line.length; i++) {
            for (const side of [1, -1]) {
                const a = line[i], c = line[i + 1];
                const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
                if (len < 0.5) continue;
                const nx = ((c[1] - a[1]) / len) * side, ny = (-(c[0] - a[0]) / len) * side;
                const o = w / 2 + 3;
                strip(ground, [a[0] + nx * o, a[1] + ny * o], [c[0] + nx * o, c[1] + ny * o], 3.2, 0.01, rgb(BANK_SAND), 1);
            }
        }
    }
    // los bordes artificiales hacia afuera de la extensión también: la orilla de las prolongaciones ya va arriba

    // ---- parques, plazas, canchas, juegos (apenas elevados)
    const parkRings = [];
    for (const { ring } of parks) {
        fillPoly(ground, ring, 0.01, mix(rgb(PARK), rgb('#6cc163'), hash01(posKey(...ring[0]), 2)));
        parkRings.push(ring);
    }
    const plazaOut = [];
    for (const { ring, name } of plazas) {
        fillPoly(ground, ring, 0.01, rgb(PLAZA_LAWN));
        plazaOut.push({ ring, name });
    }
    for (const ring of playgrounds) fillPoly(ground, ring, 0.012, rgb(PLAYGROUND));
    for (const ring of pitches) {
        fillPoly(ground, ring, 0.012, rgb(PITCH));
        const bx = orientedBox(ring);
        const A = bx.halfLong - 1.2, B = bx.halfShort - 1.2;
        if (A < 4 || B < 3) continue;
        const ux = bx.u[0], uy = bx.u[1], vx = bx.v[0], vy = bx.v[1];
        const at = (s, t) => [bx.cx + ux * s + vx * t, bx.cy + uy * s + vy * t];
        const white = rgb('#f2f2ea');
        const lw = 0.14;
        const lines = [[at(-A, -B), at(A, -B)], [at(A, -B), at(A, B)], [at(A, B), at(-A, B)], [at(-A, B), at(-A, -B)], [at(0, -B), at(0, B)]];
        const r = Math.min(B * 0.35, 9);
        const circ = circlePts(bx.cx, bx.cy, r, r, 14);
        for (let i = 0; i < circ.length; i++) lines.push([circ[i], circ[(i + 1) % circ.length]]);
        for (const [a, c] of lines) {
            if (roadQuery && roadQuery.onRoad((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 0)) continue;
            strip(ground, a, c, lw, 0.02, white, lw);
        }
    }

    return {
        builders: { ground, water },
        parks: parkRings,
        plazas: plazaOut,
        pitches: pitches.slice(),
        playgrounds: playgrounds.slice(),
        waterSide,
        waterRings: allWater.map((r) => r[0]),
        extent: ext,
    };
}

// ------------------------------------------------------------------ 2) alrededores

// Chaco húmedo: verdes apagados y ocres, poco contraste entre surcos (de lejos se ve campo, no un mantel a rayas).
const CROPS = [
    ['#7f9c56', '#77944f'], ['#8c9a5c', '#849255'], ['#9c9561', '#948d5a'], ['#a3966a', '#9a8e63'],
    ['#72924f', '#6b8a49'], ['#958a64', '#8d825d'],
];
const PASTURE = ['#7c9f5b', '#83a560', '#789a57', '#87a663', '#7fa05d'];
const DIRT = '#b5653d';
const GALPON = ['#9aa3a8', '#a7aeb2', '#8e979c'];

/** Orientación dominante de las calles (ángulo módulo 90°), ponderada por largo. */
function dominantAngle(roads) {
    const bins = new Float64Array(90);
    for (const r of roads ?? []) {
        const c = r.coords ?? r;
        for (let i = 0; i + 1 < c.length; i++) {
            const dx = c[i + 1][0] - c[i][0], dy = c[i + 1][1] - c[i][1];
            const len = Math.hypot(dx, dy);
            if (len < 5) continue;
            let a = (Math.atan2(dy, dx) * 180) / Math.PI;
            a = ((a % 90) + 90) % 90;
            bins[Math.floor(a) % 90] += len;
        }
    }
    let best = 0, bestV = -1;
    for (let i = 0; i < 90; i++) {
        const v = bins[(i + 89) % 90] + bins[i] * 2 + bins[(i + 1) % 90];
        if (v > bestV) { bestV = v; best = i; }
    }
    let deg = best + 0.5;
    if (deg > 45) deg -= 90;
    return bestV > 0 ? (deg * Math.PI) / 180 : 0;
}

/**
 * Alrededores procedurales, 1,5 km alrededor de `bounds`: quintas, campos sembrados, casas bajas dispersas, caminos de
 * tierra que siguen las calles cortadas por el borde y una grilla rala de caminos rurales. Nada adentro de `bounds`.
 *
 * @param roads   Road[] (de city-roads, con `coords` locales)
 * @param opts.waterSide  'east'|'west'|'north'|'south'|null — ese lado (el río) queda vacío
 * @param opts.water      anillos de agua (p. ej. waterRings de buildGround): nada se pone encima
 * @param opts.envFeatures, opts.toLocal  si no se pasa waterSide, se detecta del agua de estos features
 * @returns {{ builders:{ground, buildings}, trees:[{x,y,context:'campo'}], houses, dirtRoads:[{a,b,w,kind}], cuts:[{x,y,end}] }}
 */
export function buildOuterRing(bounds, roads = [], { seed = 1, quality = 'media', waterSide, water = null, envFeatures = null, toLocal = (p) => p, width = 1500 } = {}) {
    const ground = new MeshBuilder();
    const buildings = new MeshBuilder();
    const q = quality === 'baja' ? 0.5 : quality === 'alta' ? 1.4 : 1;
    const maxTrees = quality === 'baja' ? 1500 : quality === 'alta' ? 4500 : 3000;
    const S = (n) => (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) | 0;

    let waterRings = water;
    if (waterSide === undefined || (!waterRings && envFeatures)) {
        if (envFeatures) {
            const g = buildGround(bounds, envFeatures.filter((f) => f?.properties?.kind === 'water' || f?.properties?.kind === 'river'), toLocal, null, { quality: 'baja', margin: width + 200 });
            if (waterSide === undefined) waterSide = g.waterSide;
            if (!waterRings) waterRings = g.waterRings;
        } else if (waterSide === undefined) waterSide = null;
    }
    const wIdx = waterRings && waterRings.length ? new PolyIndex(waterRings.map((r) => [r]), 60) : null;
    const W = width;
    const inB = (x, y, pad = 0) => x > bounds.minX - pad && x < bounds.maxX + pad && y > bounds.minY - pad && y < bounds.maxY + pad;
    const distOut = (x, y) => {
        const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX), dy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
        return Math.hypot(dx, dy);
    };
    const sideBlocked = (x, y, m = 0) => (waterSide === 'east' && x > bounds.maxX - m) || (waterSide === 'west' && x < bounds.minX + m)
        || (waterSide === 'north' && y > bounds.maxY - m) || (waterSide === 'south' && y < bounds.minY + m);
    /** ¿Se puede poner algo en (x,y)? pad: distancia mínima al recorte de la ciudad; side: al lado del río. */
    const allowed = (x, y, pad = 0, side = Math.max(0, pad)) => !inB(x, y, pad) && distOut(x, y) <= W && !sideBlocked(x, y, side)
        && !(wIdx && wIdx.contains(x, y) >= 0);

    const th = dominantAngle(roads);
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    const toW = (s, t) => [s * ux + t * vx, s * uy + t * vy];
    const toR = (x, y) => [x * ux + y * uy, x * vx + y * vy];

    // ---- caminos de tierra: índice para no poner casas ni árboles encima
    const dirtRoads = [];
    const cuts = [];
    const roadCell = 40;
    const roadGrid = new Map();
    const addDirt = (a, b, w, kind) => {
        dirtRoads.push({ a, b, w, kind });
        const k = dirtRoads.length - 1;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / (roadCell / 2)));
        for (let i = 0; i <= n; i++) {
            const x = a[0] + ((b[0] - a[0]) * i) / n, y = a[1] + ((b[1] - a[1]) * i) / n;
            const key = Math.floor(x / roadCell) * 1048576 + Math.floor(y / roadCell);
            let arr = roadGrid.get(key);
            if (!arr) roadGrid.set(key, (arr = []));
            if (arr.at(-1) !== k) arr.push(k);
        }
    };
    const nearDirt = (x, y, m) => {
        const ix = Math.floor(x / roadCell), iy = Math.floor(y / roadCell);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const arr = roadGrid.get((ix + dx) * 1048576 + iy + dy);
                if (!arr) continue;
                for (const k of arr) {
                    const { a, b, w } = dirtRoads[k];
                    const ex = b[0] - a[0], ey = b[1] - a[1];
                    const L2 = ex * ex + ey * ey || 1;
                    const t = clamp(((x - a[0]) * ex + (y - a[1]) * ey) / L2, 0, 1);
                    if (Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y) < w / 2 + m) return true;
                }
            }
        }
        return false;
    };

    // 2a) calles cortadas por el borde: siguen derecho como camino de tierra
    const cutDist = 150;
    const seen = new Set();
    let ri = 0;
    for (const r of roads ?? []) {
        ri++;
        const c = r.coords ?? r;
        if (!c || c.length < 2) continue;
        for (const end of [0, 1]) {
            const p = end ? c.at(-1) : c[0];
            // dirección: desde un punto unos metros atrás
            let k = end ? c.length - 2 : 1;
            let prev = c[k];
            while (Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 15) {
                const nk = end ? k - 1 : k + 1;
                if (nk < 0 || nk >= c.length) break;
                k = nk; prev = c[k];
            }
            const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            if (len < 1) continue;
            const dx = (p[0] - prev[0]) / len, dy = (p[1] - prev[1]) / len;
            // lado del borde más cercano hacia donde apunta
            const sides = [
                { d: bounds.maxX - p[0], nx: 1, ny: 0 }, { d: p[0] - bounds.minX, nx: -1, ny: 0 },
                { d: bounds.maxY - p[1], nx: 0, ny: 1 }, { d: p[1] - bounds.minY, nx: 0, ny: -1 },
            ];
            let best = null;
            for (const s of sides) {
                const dot = dx * s.nx + dy * s.ny;
                if (s.d < -1 || s.d > cutDist || dot < 0.45) continue;
                const t = Math.max(0, s.d) / dot;
                if (!best || t < best.t) best = { ...s, t };
            }
            if (!best) continue;
            const sx = p[0] + dx * best.t, sy = p[1] + dy * best.t;
            const key = `${Math.round(sx / 12)},${Math.round(sy / 12)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const L = 500 + hash01(S(ri * 2 + end), 11) * 1000;
            const w = r.major ? 7 : 5.5;
            // arranca un poco afuera para que las esquinas de la tira (calle oblicua al borde) no entren a la ciudad
            const dot = dx * best.nx + dy * best.ny;
            const d0 = ((w / 2) * Math.sqrt(Math.max(0, 1 - dot * dot))) / dot + 0.3;
            // avanza mientras esté permitido (con medio ancho de margen del lado del río)
            let ok = 0;
            const step = 20;
            for (let d = step; d <= L; d += step) {
                const x = sx + dx * d, y = sy + dy * d;
                if (!allowed(x, y, -0.5, w / 2 + 1)) break;
                ok = d;
            }
            if (ok < 60) continue;
            const a = [sx + dx * d0, sy + dy * d0];
            const b = [sx + dx * ok, sy + dy * ok];
            addDirt(a, b, w, 'continuacion');
            cuts.push({ x: sx, y: sy, end: [p[0], p[1]], road: ri - 1 });
        }
    }

    // 2b) grilla rala de caminos rurales (alineada con las calles de la ciudad)
    const ext = { minX: bounds.minX - W, minY: bounds.minY - W, maxX: bounds.maxX + W, maxY: bounds.maxY + W };
    const corners = [[ext.minX, ext.minY], [ext.maxX, ext.minY], [ext.maxX, ext.maxY], [ext.minX, ext.maxY]].map(([x, y]) => toR(x, y));
    const rs0 = Math.min(...corners.map((c) => c[0])), rs1 = Math.max(...corners.map((c) => c[0]));
    const rt0 = Math.min(...corners.map((c) => c[1])), rt1 = Math.max(...corners.map((c) => c[1]));
    const G = 450;
    const off = hash01(S(7), 3) * G;
    const runs = (fixed, along, alongIsS, lo, hi) => {
        let start = null;
        const step = 25;
        for (let d = lo; d <= hi + step; d += step) {
            const [x, y] = alongIsS ? toW(d, fixed) : toW(fixed, d);
            const ok = d <= hi && allowed(x, y, 8);
            if (ok && start === null) start = d;
            if (!ok && start !== null) {
                if (d - step - start >= 60) {
                    const a = alongIsS ? toW(start, fixed) : toW(fixed, start);
                    const b = alongIsS ? toW(d - step, fixed) : toW(fixed, d - step);
                    addDirt(a, b, 4.5, 'rural');
                }
                start = null;
            }
        }
    };
    const lineS = [], lineT = [];
    for (let t = Math.floor((rt0 - off) / G) * G + off; t <= rt1; t += G) { lineT.push(t); runs(t, 's', true, rs0, rs1); }
    for (let s = Math.floor((rs0 - off) / G) * G + off; s <= rs1; s += G) { lineS.push(s); runs(s, 't', false, rt0, rt1); }

    // ---- parcelas
    const trees = [];
    const treeCands = [];
    let houses = 0;
    const blocks = [];
    for (let i = 0; i + 1 < lineS.length; i++) {
        for (let j = 0; j + 1 < lineT.length; j++) blocks.push([lineS[i], lineT[j], lineS[i + 1], lineT[j + 1]]);
    }
    const pushTree = (x, y, prio) => {
        if (!allowed(x, y, 4) || nearDirt(x, y, 2.5)) return;
        treeCands.push({ x, y, prio });
    };
    let pid = 0;
    for (const [s0, t0, s1, t1] of blocks) {
        // ¿la manzana rural toca la zona permitida?
        const bc = toW((s0 + s1) / 2, (t0 + t1) / 2);
        if (distOut(bc[0], bc[1]) > W + G * 0.75) continue;
        if (inB(bc[0], bc[1], -G)) continue;
        // subdivisión en parcelas: cerca de la ciudad, más chicas
        const dBlock = distOut(bc[0], bc[1]);
        // cerca, parcelas chicas; lejos, potreros y lotes grandes (una o dos parcelas por manzana rural)
        const nS = dBlock < 450 ? 3 + Math.floor(hash01(S(pid + 1), 1) * 2) : dBlock < 1000 ? 2 : 1 + Math.floor(hash01(S(pid + 1), 1) * 2);
        const nT = dBlock < 450 ? 3 : dBlock < 1000 ? 1 + Math.floor(hash01(S(pid + 1), 2) * 2) : 1;
        const ws = (s1 - s0) / nS, wt = (t1 - t0) / nT;
        for (let a = 0; a < nS; a++) {
            for (let b = 0; b < nT; b++) {
                pid++;
                const ps0 = s0 + a * ws + (a === 0 ? 5 : 2.5), ps1 = s0 + (a + 1) * ws - (a === nS - 1 ? 5 : 2.5);
                const pt0 = t0 + b * wt + (b === 0 ? 5 : 2.5), pt1 = t0 + (b + 1) * wt - (b === nT - 1 ? 5 : 2.5);
                let poly = [toW(ps0, pt0), toW(ps1, pt0), toW(ps1, pt1), toW(ps0, pt1)];
                const pc = toW((ps0 + ps1) / 2, (pt0 + pt1) / 2);
                if (inB(pc[0], pc[1], 0) || sideBlocked(pc[0], pc[1])) continue;
                const area0 = signedArea(poly);
                // recorte contra el borde de la ciudad (lado donde queda el centro) y el lado del río
                const pad = 4;
                if (pc[0] > bounds.maxX) poly = clipHalf(poly, 1, 0, bounds.maxX + pad);
                else if (pc[0] < bounds.minX) poly = clipHalf(poly, -1, 0, -(bounds.minX - pad));
                if (pc[1] > bounds.maxY) poly = clipHalf(poly, 0, 1, bounds.maxY + pad);
                else if (pc[1] < bounds.minY) poly = clipHalf(poly, 0, -1, -(bounds.minY - pad));
                if (waterSide === 'east') poly = clipHalf(poly, -1, 0, -bounds.maxX);
                if (waterSide === 'west') poly = clipHalf(poly, 1, 0, bounds.minX);
                if (waterSide === 'north') poly = clipHalf(poly, 0, -1, -bounds.maxY);
                if (waterSide === 'south') poly = clipHalf(poly, 0, 1, bounds.minY);
                if (poly.length < 3 || signedArea(poly) < area0 * 0.25) continue;
                // todos los vértices permitidos (sin agua, dentro del anillo)
                if (poly.some(([x, y]) => inB(x, y, 1) || distOut(x, y) > W + 1 || (wIdx && wIdx.contains(x, y) >= 0))) continue;
                const [cx, cy] = centroid(poly);
                const d = distOut(cx, cy);
                const r = hash01(S(pid), 5);
                const near = d < 400, mid = d < 900;
                const dens = clamp(1 - d / W, 0, 1);
                let type;
                if (near) type = r < 0.42 ? 'quinta' : r < 0.67 ? 'lotes' : r < 0.82 ? 'pasto' : 'cultivo';
                else if (mid) type = r < 0.2 ? 'quinta' : r < 0.45 ? 'cultivo' : r < 0.82 ? 'pasto' : 'monte';
                else type = r < 0.04 ? 'quinta' : r < 0.3 ? 'cultivo' : r < 0.72 ? 'pasto' : 'monte';
                // ejes locales de la parcela
                const [ls0, lt0] = [ps0, pt0];
                const lw = ps1 - ps0, lh = pt1 - pt0;
                const P = (fs, ft) => toW(ls0 + fs * lw, lt0 + ft * lh);
                const z = 0.06; // más alto que el suelo (0): de lejos no titila
                if (type === 'cultivo') {
                    const pal = CROPS[Math.floor(hash01(S(pid), 6) * CROPS.length) % CROPS.length];
                    const alongS = hash01(S(pid), 7) < 0.5;
                    const n = Math.max(4, Math.round((alongS ? lh : lw) / (10 + hash01(S(pid), 8) * 6) * q));
                    for (let k = 0; k < n; k++) {
                        const f0 = k / n, f1 = (k + 1) / n;
                        const band = alongS
                            ? [toW(ls0, lt0 + f0 * lh), toW(ls0 + lw, lt0 + f0 * lh), toW(ls0 + lw, lt0 + f1 * lh), toW(ls0, lt0 + f1 * lh)]
                            : [toW(ls0 + f0 * lw, lt0), toW(ls0 + f1 * lw, lt0), toW(ls0 + f1 * lw, lt0 + lh), toW(ls0 + f0 * lw, lt0 + lh)];
                        const piece = clipConvex(band, poly);
                        if (piece.length >= 3) fanPoly(ground, piece, z, rgb(pal[k % 2]));
                    }
                    // cortina de árboles en un lado, a veces
                    if (hash01(S(pid), 9) < 0.35 * q) {
                        const nT2 = Math.floor(lw / 9);
                        for (let k = 0; k <= nT2; k++) {
                            const [x, y] = P(k / Math.max(1, nT2), 0.0);
                            pushTree(x + vx * 3, y + vy * 3, 1);
                        }
                    }
                    continue;
                }
                const baseHex = type === 'monte' ? '#557d43' : type === 'quinta' ? '#7aa25e' : type === 'lotes' ? '#82a663' : PASTURE[Math.floor(hash01(S(pid), 6) * PASTURE.length) % PASTURE.length];
                fanPoly(ground, poly, z, shade(rgb(baseHex), 0.97 + hash01(S(pid), 4) * 0.06));
                const inPoly = (x, y) => pointInRing(x, y, poly);
                if (type === 'monte') {
                    const n = Math.round((14 + hash01(S(pid), 10) * 18) * q);
                    for (let k = 0; k < n; k++) {
                        const [x, y] = P(0.1 + hash01(S(pid * 31 + k), 1) * 0.8, 0.1 + hash01(S(pid * 31 + k), 2) * 0.8);
                        if (inPoly(x, y)) pushTree(x, y, 2);
                    }
                    continue;
                }
                if (type === 'pasto') {
                    const n = Math.floor(hash01(S(pid), 10) * 4 * q);
                    for (let k = 0; k < n; k++) {
                        const [x, y] = P(0.15 + hash01(S(pid * 17 + k), 1) * 0.7, 0.15 + hash01(S(pid * 17 + k), 2) * 0.7);
                        if (inPoly(x, y)) pushTree(x, y, 3);
                    }
                    continue;
                }
                // quinta y lotes: casas sobre el frente (lado t0) y árboles
                const nHouses = type === 'lotes' ? Math.max(1, Math.round((1 + hash01(S(pid), 12) * 4) * dens * q + 0.3)) : (hash01(S(pid), 12) < 0.85 * Math.max(q, 0.6) ? 1 : 0);
                for (let k = 0; k < nHouses; k++) {
                    const fs = (k + 0.5) / nHouses + (hash01(S(pid * 7 + k), 3) - 0.5) * 0.12;
                    const ft = type === 'lotes' ? 0.14 : 0.18 + hash01(S(pid * 7 + k), 4) * 0.2;
                    const [hx, hy] = P(clamp(fs, 0.1, 0.9), ft);
                    const hk = S(pid * 7 + k);
                    const galpon = type === 'quinta' && hash01(hk, 5) < 0.18;
                    const A = galpon ? 6 + hash01(hk, 6) * 3 : 3.5 + hash01(hk, 6) * 1.6;
                    const B = galpon ? 4.5 + hash01(hk, 7) * 1.5 : 2.6 + hash01(hk, 7) * 1.2;
                    if (!inPoly(hx, hy) || !allowed(hx, hy, A + 2) || nearDirt(hx, hy, A + 2)) continue;
                    const rot = hash01(hk, 8) < 0.5;
                    const hux = rot ? vx : ux, huy = rot ? vy : uy;
                    const wall = rgb(galpon ? pickOf(GALPON, hk, 1) : pickOf(PALETTE.houseWalls, hk, 1));
                    const roof = rgb(galpon ? '#8c969c' : hash01(hk, 9) < 0.7 ? pickOf(PALETTE.houseRoofs, hk, 2) : '#b9b6ad');
                    const pitched = galpon || hash01(hk, 9) < 0.7;
                    addHouse(buildings, hx, hy, hux, huy, A, B, galpon ? 4.2 : 2.8 + hash01(hk, 10) * 0.5, wall, roof, pitched);
                    houses++;
                    // patio de tierra delante
                    if (!galpon && hash01(hk, 11) < 0.5) {
                        const [fx, fy] = [hx - vx * (B + 3), hy - vy * (B + 3)];
                        if (inPoly(fx, fy)) {
                            const pr = [[fx - ux * 3 - vx * 1.5, fy - uy * 3 - vy * 1.5], [fx + ux * 3 - vx * 1.5, fy + uy * 3 - vy * 1.5], [fx + ux * 3 + vx * 1.5, fy + uy * 3 + vy * 1.5], [fx - ux * 3 + vx * 1.5, fy - uy * 3 + vy * 1.5]];
                            fanPoly(ground, pr, 0.09, rgb('#c09062'));
                        }
                    }
                    // árbol al lado de la casa
                    pushTree(hx + hux * (A + 4), hy + huy * (A + 4), 0);
                }
                if (type === 'quinta') {
                    // frutales en grilla + huerta en franjas + cortina en el fondo
                    const gs = 0.5 + hash01(S(pid), 13) * 0.2;
                    const cols = Math.max(2, Math.round(lw / 12)), rows = Math.max(2, Math.round(lh * 0.4 / 12));
                    for (let a2 = 0; a2 < cols; a2++) {
                        for (let b2 = 0; b2 < rows; b2++) {
                            if (hash01(S(pid * 101 + a2 * 13 + b2), 1) > 0.75 * q) continue;
                            const [x, y] = P((a2 + 0.5) / cols * 0.6 + (hash01(S(pid), 14) < 0.5 ? 0.05 : 0.35), gs + (b2 + 0.5) / rows * 0.35);
                            if (inPoly(x, y)) pushTree(x, y, 1);
                        }
                    }
                    if (hash01(S(pid), 15) < 0.6) {
                        const n = 6;
                        const sA = hash01(S(pid), 14) < 0.5 ? 0.7 : 0.08;
                        for (let k = 0; k < n; k++) {
                            const piece = clipConvex([P(sA + k * 0.035, 0.45), P(sA + (k + 1) * 0.035 - 0.008, 0.45), P(sA + (k + 1) * 0.035 - 0.008, 0.85), P(sA + k * 0.035, 0.85)], poly);
                            if (piece.length >= 3) fanPoly(ground, piece, 0.09, rgb(k % 2 ? '#6b8f48' : '#8d7552'));
                        }
                    }
                    const nb = Math.floor(lw / 8);
                    for (let k = 0; k <= nb; k++) {
                        const [x, y] = P(k / Math.max(1, nb), 0.97);
                        if (hash01(S(pid * 3 + k), 2) < 0.8) pushTree(x, y, 1);
                    }
                }
            }
        }
    }

    // ---- caminos de tierra (encima de las parcelas)
    for (const { a, b, w } of dirtRoads) {
        const k = posKey(a[0], a[1]);
        strip(ground, a, b, w / 2, 0.12, shade(rgb(DIRT), 0.95 + hash01(k, 1) * 0.1), 0);
    }
    // árboles al costado de algunos caminos rurales
    let rk = 0;
    for (const { a, b, w, kind } of dirtRoads) {
        rk++;
        if (hash01(S(rk), 21) > 0.45) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
        const side = hash01(S(rk), 22) < 0.5 ? 1 : -1;
        for (let d = 10; d < len - 10; d += 14) {
            if (hash01(S(rk * 997 + d), 23) < 0.25) continue;
            const o = w / 2 + 4;
            pushTree(a[0] + dx * d - dy * o * side, a[1] + dy * d + dx * o * side, kind === 'continuacion' ? 0 : 2);
        }
    }

    // ---- límite de árboles: primero los prioritarios (casas), después repartidos
    treeCands.sort((A, B) => A.prio - B.prio);
    if (treeCands.length <= maxTrees) {
        for (const t of treeCands) trees.push({ x: t.x, y: t.y, context: 'campo' });
    } else {
        const stride = treeCands.length / maxTrees;
        for (let i = 0; i < treeCands.length && trees.length < maxTrees; i += stride) {
            const t = treeCands[Math.floor(i)];
            trees.push({ x: t.x, y: t.y, context: 'campo' });
        }
    }

    return { builders: { ground, buildings }, trees, houses, dirtRoads, cuts, angle: th };
}

// ------------------------------------------------------------------ 2b) relleno interior del damero

const INFILL_ZINC = '#aeb3b5';

/**
 * Relleno interior de las manzanas del damero: casas bajas de DECORADO (id 0, no son propiedades del juego) sobre el
 * frente de cada calle, dentro del barrio, para tapar los huecos que deja OSM (manzanas medio vacías, "muchos espacios
 * verdes sin nada"). Determinístico por hash de posición (misma ciudad siempre). NUNCA pisa: propiedades reales, calzada
 * ni vereda (query.onRoad), plazas/parques/agua/pitch/landmarks (keepOut + discs) ni el lado del río (blocked). La
 * densidad es alta en el interior del damero y DECAE hacia el borde real del distrito, para empalmar con la franja
 * periurbana (buildOuterRing/periurbanBuildings) sin duplicarla: esto es relleno INTERIOR, no un segundo anillo.
 *
 * @param bounds   caja del barrio (metros locales)
 * @param roads    Road[] (coords locales) — las calles reales recortadas al barrio
 * @param query    query de city-roads (onRoad/nearest) — null => no se arma nada
 * @param opts.keepOut  Ring[] a respetar (propiedades reales + parques/plazas/agua/pitch/playground)
 * @param opts.discs    [[x,y,r],…] discos extra a respetar (landmarks)
 * @param opts.blocked  (x,y)=>bool (agua / lado del río)
 * @param opts.quality  'baja' | 'media' | 'alta'
 * @param opts.fade     ancho (m) del decaimiento de densidad hacia el borde del distrito
 * @returns { builders:{buildings}, trees:[{x,y,context:'patio'}], houses }
 */
export function buildBlockInfill(bounds, roads, query, { keepOut = [], discs = [], blocked = () => false, quality = 'media', seed = 1, fade = 300 } = {}) {
    const b = new MeshBuilder();
    const trees = [];
    if (!query || !Array.isArray(roads) || !roads.length) return { builders: { buildings: b }, trees, houses: 0 };
    const q = quality === 'baja' ? 0.8 : quality === 'alta' ? 1.1 : 1;
    const keepIdx = keepOut.length ? new PolyIndex(keepOut.map((r) => [r]), 40) : null;
    const discHit = (x, y) => {
        for (let i = 0; i < discs.length; i++) {
            const dx = x - discs[i][0], dy = y - discs[i][1];
            if (dx * dx + dy * dy < discs[i][2] * discs[i][2]) return true;
        }
        return false;
    };
    const blockedAll = (x, y) => blocked(x, y) || discHit(x, y) || (!!keepIdx && keepIdx.contains(x, y) >= 0)
        || (!!query.lotNear && query.lotNear(x, y, 2)); // ni sobre una playa de estacionamiento
    // ocupación propia (celdas de 4 m): el relleno no se pisa a sí mismo
    const occ = new Set();
    const cell = 4;
    const cellsOf = (x, y, r) => {
        const out = [];
        for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
            for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) out.push(i * 65536 + j);
        }
        return out;
    };
    const free = (x, y, r) => cellsOf(x, y, r).every((k) => !occ.has(k));
    const take = (x, y, r) => cellsOf(x, y, r).forEach((k) => occ.add(k));
    const inBounds = (x, y) => x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
    const edgeDist = (x, y) => Math.min(x - bounds.minX, bounds.maxX - x, y - bounds.minY, bounds.maxY - y);

    // Grilla de lotes alineada a la orientación dominante del damero: así las casas de relleno quedan en filas paralelas
    // a las calles (como una manzana real), con patio entre filas, en vez de caer con ángulos sueltos.
    const th = dominantAngle(roads);
    const ex = Math.cos(th), ey = Math.sin(th);      // "a lo largo de la cuadra"
    const fx = -ey, fy = ex;                         // "a lo ancho" (fondo del lote)
    const mx = (bounds.minX + bounds.maxX) / 2, my = (bounds.minY + bounds.maxY) / 2;
    // rango en los ejes rotados que cubre toda la caja del barrio
    let uMax = 0, vMax = 0;
    for (const [sx, sy] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.minX, bounds.maxY], [bounds.maxX, bounds.maxY]]) {
        uMax = Math.max(uMax, Math.abs((sx - mx) * ex + (sy - my) * ey));
        vMax = Math.max(vMax, Math.abs((sx - mx) * fx + (sy - my) * fy));
    }
    const STEP_U = 9.5;  // paso a lo largo de la cuadra
    const STEP_V = 15;   // paso a lo ancho (deja ~7 m de patio entre filas)
    let houses = 0;
    for (let v = -vMax; v <= vMax; v += STEP_V) {
        for (let u = -uMax; u <= uMax; u += STEP_U) {
            const cx = mx + ex * u + fx * v, cy = my + ey * u + fy * v;
            if (!inBounds(cx, cy)) continue;
            const ed = edgeDist(cx, cy);
            if (ed < 3) continue;
            const k = (posKey(cx, cy) ^ seed) | 0;
            // densidad: alta en el interior del damero (hasta ~0.9), decae a ~0.3 hacia el borde del distrito.
            // El hash es lo primero (barato): descarta buena parte de las celdas antes de tocar calles o índices.
            const dens = (0.3 + 0.6 * clamp(ed / fade, 0, 1)) * q;
            if (hash01(k, 3) > dens) continue;
            const A = 3 + hash01(k, 1) * 1.6;     // medio frente
            const B = 2.8 + hash01(k, 7) * 1.4;   // medio fondo
            const jx = (hash01(k, 20) - 0.5) * 2, jy = (hash01(k, 21) - 0.5) * 2;
            const hx = cx + ex * jx + fx * jy, hy = cy + ey * jx + fy * jy;
            const R = Math.hypot(A, B);
            if (!free(hx, hy, R + 0.5)) continue;
            // una sola consulta a la calle cubre toda la huella (margen R+1): nada de relleno sobre calzada/vereda
            if (query.onRoad(hx, hy, R + 1)) continue;
            // keepOut en centro + borde de la huella (esquinas y medios, con el alero del techo): nunca pisa
            // propiedad real / plaza / parque / agua / pitch / landmark
            const Ao = A + 0.6, Bo = B + 0.6; // incluye el alero del techo a dos aguas
            let bad = false;
            for (const [su, sv] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                const x = hx + ex * su * Ao + fx * sv * Bo, y = hy + ey * su * Ao + fy * sv * Bo;
                if (blockedAll(x, y)) { bad = true; break; }
            }
            if (bad) continue;
            take(hx, hy, R + 0.5);
            const wall = rgb(pickOf(PALETTE.houseWalls, k, 11));
            const chapa = hash01(k, 12) < 0.4;
            const roof = rgb(chapa ? INFILL_ZINC : pickOf(PALETTE.houseRoofs, k, 13));
            addHouse(b, hx, hy, ex, ey, A, B, 2.6 + hash01(k, 14) * 0.7, wall, roof, !chapa || hash01(k, 15) < 0.5);
            houses++;
            // árbol de patio detrás de la casa (Formosa es muy arbolada): cae en la franja de patio entre filas
            if (hash01(k, 17) < 0.75) {
                const side = hash01(k, 19) < 0.5 ? 1 : -1;
                const tx = hx + fx * side * (B + 3 + hash01(k, 16) * 2.5) + ex * (hash01(k, 18) - 0.5) * A;
                const ty = hy + fy * side * (B + 3 + hash01(k, 16) * 2.5) + ey * (hash01(k, 18) - 0.5) * A;
                if (inBounds(tx, ty) && edgeDist(tx, ty) > 2 && !blockedAll(tx, ty) && free(tx, ty, 1.6) && !query.onRoad(tx, ty, 1.5)) {
                    trees.push({ x: tx, y: ty, context: 'patio' });
                    take(tx, ty, 1.6);
                }
            }
        }
    }
    return { builders: { buildings: b }, trees, houses };
}

// ------------------------------------------------------------------ 3) plazas

const PAVING = '#e6dfcc';
const PAVING2 = '#d9cfba';
const CURB = '#cdc4ad';
const LAWN = ['#5cb34f', '#61b854', '#58ad4c'];
const BRONZE = '#5b4a33';
const GRANITE = '#cfc8b8';
const WOOD = '#8a5a35';
const IRON = '#3e4a46';

/** Banco de plaza (asiento + respaldo) mirando hacia (fx,fy). */
function bench(b, x, y, fx, fy, z) {
    const ux = -fy, uy = fx; // a lo largo
    obox(b, x, y, ux, uy, 0.85, 0.22, z + 0.38, z + 0.46, rgb(WOOD));
    obox(b, x - fx * 0.24, y - fy * 0.24, ux, uy, 0.85, 0.05, z + 0.46, z + 0.85, rgb(WOOD));
    obox(b, x, y, ux, uy, 0.7, 0.2, z, z + 0.38, rgb(IRON));
}

/** Fuente: pileta octogonal con borde, agua y columna con plato. */
function fountain(b, water, x, y, r, z) {
    const outer = circlePts(x, y, r, r, 12);
    const inner = circlePts(x, y, r - 0.45, r - 0.45, 12);
    const rimZ = z + 0.55;
    ringWalls(b, outer, z, rimZ, rgb('#d8d0bd'));
    // tapa del borde (anillo)
    for (let i = 0; i < 12; i++) {
        const a = outer[i], c = outer[(i + 1) % 12], d = inner[(i + 1) % 12], e = inner[i];
        b.quad([a[0], a[1], rimZ], [c[0], c[1], rimZ], [d[0], d[1], rimZ], [e[0], e[1], rimZ], rgb('#e8e1cf'), 0);
    }
    // pared interior (mirando hacia adentro)
    for (let i = 0; i < 12; i++) {
        const p = inner[(i + 1) % 12], q2 = inner[i];
        b.quad([p[0], p[1], z + 0.2], [q2[0], q2[1], z + 0.2], [q2[0], q2[1], rimZ], [p[0], p[1], rimZ], rgb('#b9b09c'), 0);
    }
    fanPoly(water, inner, z + 0.4, rgb('#6aa6c8'));
    // columna y platos
    obox(b, x, y, 1, 0, 0.28, 0.28, z + 0.4, z + 1.7, rgb('#d8d0bd'));
    const plate = circlePts(x, y, Math.min(1.4, r * 0.35), Math.min(1.4, r * 0.35), 8);
    slab(b, plate, z + 1.6, z + 1.8, rgb('#e8e1cf'), rgb('#cfc6b2'));
    fanPoly(water, circlePts(x, y, Math.min(1.25, r * 0.31), Math.min(1.25, r * 0.31), 8), z + 1.81, rgb('#7ab3d3'));
    obox(b, x, y, 1, 0, 0.12, 0.12, z + 1.8, z + 2.5, rgb('#d8d0bd'));
    if (r > 4) {
        const top = circlePts(x, y, 0.6, 0.6, 8);
        slab(b, top, z + 2.45, z + 2.6, rgb('#e8e1cf'), rgb('#cfc6b2'));
    }
}

/** Glorieta: piso octogonal, 8 columnas y techo en punta. */
function glorieta(b, x, y, r, z, roofHex) {
    const floor = circlePts(x, y, r, r, 8, Math.cos(Math.PI / 8), Math.sin(Math.PI / 8));
    slab(b, floor, z - 0.1, z + 0.35, rgb('#e9e2d0'), rgb(CURB));
    const posts = circlePts(x, y, r - 0.35, r - 0.35, 8, Math.cos(Math.PI / 8), Math.sin(Math.PI / 8));
    for (const [px, py] of posts) obox(b, px, py, 1, 0, 0.12, 0.12, z + 0.35, z + 2.9, rgb('#f4f1e8'));
    const eave = circlePts(x, y, r + 0.5, r + 0.5, 8, Math.cos(Math.PI / 8), Math.sin(Math.PI / 8));
    slab(b, eave, z + 2.9, z + 3.1, rgb(roofHex), rgb('#f4f1e8'));
    pyramid(b, eave, z + 3.1, [x, y, z + 4.8], rgb(roofHex));
}

/**
 * Monumento ecuestre a escala `k` (1,5: pedestal ~5 m + caballo y jinete ~4,5 m, se lee desde la vereda de enfrente).
 * Se arma en el origen y se copia girado/escalado.
 */
function equestrian(b, x, y, fx, fy, z, k = 1.5) {
    const t = new MeshBuilder();
    const top = equestrianUnit(t, 0, 0, 1, 0, 0);
    for (let i = 0; i < t.pos.length; i += 3) {
        const lx = t.pos[i] * k, ly = t.pos[i + 1] * k;
        b.pos.push(x + fx * lx - fy * ly, y + fy * lx + fx * ly, z + t.pos[i + 2] * k);
        const nx = t.nor[i], ny = t.nor[i + 1];
        b.nor.push(fx * nx - fy * ny, fy * nx + fx * ny, t.nor[i + 2]);
    }
    b.uv.push(...t.uv);
    b.col.push(...t.col);
    b.owner.push(...t.owner);
    return z + top * k;
}

/** Monumento ecuestre a escala 1 (pedestal ~3 m + caballo y jinete ~3 m) mirando hacia (fx,fy). */
function equestrianUnit(b, x, y, fx, fy, z) {
    const sx = -fy, sy = fx;
    const P = (f, s) => [x + fx * f + sx * s, y + fy * f + sy * s];
    slab(b, [P(-3.4, -2.8), P(3.4, -2.8), P(3.4, 2.8), P(-3.4, 2.8)], z, z + 0.45, rgb('#d9d2c2'), rgb(CURB));
    slab(b, [P(-2.9, -2.3), P(2.9, -2.3), P(2.9, 2.3), P(-2.9, 2.3)], z + 0.45, z + 0.8, rgb('#d9d2c2'), rgb(CURB));
    obox(b, x, y, fx, fy, 2.3, 1.3, z + 0.8, z + 3.1, rgb(GRANITE));
    obox(b, x, y, fx, fy, 2.55, 1.5, z + 3.1, z + 3.35, rgb('#e2dccd'));
    // placa de bronce en el frente
    const [px, py] = P(2.32, 0);
    obox(b, px, py, fx, fy, 0.03, 0.6, z + 1.6, z + 2.3, rgb(BRONZE));
    const base = z + 3.35;
    const br = rgb(BRONZE);
    const dark = rgb('#4a3c29');
    // patas (una delantera levantada)
    for (const [f, s, h] of [[0.85, 0.32, 1.0], [0.85, -0.32, 0.55], [-0.85, 0.32, 1.0], [-0.85, -0.32, 1.0]]) {
        const [lx, ly] = P(f, s);
        obox(b, lx, ly, fx, fy, 0.11, 0.1, base + (1.0 - h), base + 1.05, dark);
    }
    // cuerpo, cuello, cabeza, cola
    const [cx, cy] = P(0, 0);
    obox(b, cx, cy, fx, fy, 1.15, 0.38, base + 0.95, base + 1.7, br);
    const [nx, ny] = P(1.15, 0);
    obox(b, nx, ny, fx, fy, 0.28, 0.22, base + 1.45, base + 2.35, br);
    const [hx, hy] = P(1.45, 0);
    obox(b, hx, hy, fx, fy, 0.42, 0.17, base + 2.1, base + 2.42, br);
    const [tx, ty] = P(-1.25, 0);
    obox(b, tx, ty, fx, fy, 0.1, 0.07, base + 0.9, base + 1.55, dark);
    // jinete: piernas, torso, cabeza, brazo en alto
    obox(b, cx + fx * 0.1, cy + fy * 0.1, fx, fy, 0.25, 0.48, base + 1.4, base + 1.85, br);
    obox(b, cx - fx * 0.05, cy - fy * 0.05, fx, fy, 0.2, 0.26, base + 1.85, base + 2.65, br);
    obox(b, cx - fx * 0.05, cy - fy * 0.05, fx, fy, 0.13, 0.13, base + 2.68, base + 2.95, br);
    obox(b, cx - fx * 0.12, cy - fy * 0.12, fx, fy, 0.18, 0.18, base + 2.93, base + 3.02, dark); // bicornio
    const [ax, ay] = P(0.35, 0.3);
    obox(b, ax, ay, fx, fy, 0.08, 0.07, base + 2.3, base + 3.35, br);
    return z + 3.35 + 3.0;
}

/** Busto sobre pedestal (plaza genérica). */
function bust(b, x, y, z) {
    slab(b, circlePts(x, y, 1.6, 1.6, 8), z, z + 0.35, rgb('#d9d2c2'), rgb(CURB));
    obox(b, x, y, 1, 0, 0.55, 0.55, z + 0.35, z + 2.2, rgb(GRANITE));
    obox(b, x, y, 1, 0, 0.32, 0.22, z + 2.2, z + 2.6, rgb(BRONZE));
    obox(b, x, y, 1, 0, 0.15, 0.15, z + 2.6, z + 2.95, rgb(BRONZE));
}

/** Juegos: arenero con tobogán, hamacas y sube y baja. */
function playground(b, cx, cy, ux, uy, z) {
    const vx = -uy, vy = ux;
    const P = (s, t) => [cx + ux * s + vx * t, cy + uy * s + vy * t];
    slab(b, [P(-8, -5.5), P(8, -5.5), P(8, 5.5), P(-8, 5.5)], z - 0.05, z + 0.08, rgb('#e3cf9a'), rgb(CURB));
    const zz = z + 0.08;
    // tobogán
    let [x, y] = P(-4.5, 1.5);
    obox(b, x, y, ux, uy, 0.8, 0.8, zz + 1.4, zz + 1.6, rgb('#ff6b6b'));
    for (const [s, t] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
        const [px, py] = P(-4.5 + s, 1.5 + t);
        obox(b, px, py, ux, uy, 0.06, 0.06, zz, zz + 1.4, rgb('#3a6fb0'));
    }
    const a = P(-3.7, 1.1), c = P(-0.8, 1.1), d = P(-0.8, 1.9), e = P(-3.7, 1.9);
    b.quad([a[0], a[1], zz + 1.55], [c[0], c[1], zz + 0.1], [d[0], d[1], zz + 0.1], [e[0], e[1], zz + 1.55], rgb('#ffcc33'), 0);
    b.quad([e[0], e[1], zz + 1.55], [d[0], d[1], zz + 0.1], [c[0], c[1], zz + 0.1], [a[0], a[1], zz + 1.55], rgb('#e6b21f'), 0);
    // hamacas
    for (const s of [1.5, 5.5]) {
        for (const t of [-1.8, -3.6]) {
            [x, y] = P(s, t);
            obox(b, x, y, ux, uy, 0.06, 0.06, zz, zz + 2.2, rgb('#3a6fb0'));
        }
    }
    [x, y] = P(3.5, -2.7);
    obox(b, x, y, ux, uy, 2.1, 0.06, zz + 2.15, zz + 2.3, rgb('#3a6fb0'));
    for (const s of [2.7, 4.3]) {
        [x, y] = P(s, -2.7);
        obox(b, x, y, ux, uy, 0.3, 0.15, zz + 0.45, zz + 0.52, rgb('#ff6b6b'));
    }
    // sube y baja
    [x, y] = P(4, 2.5);
    obox(b, x, y, ux, uy, 0.15, 0.15, zz, zz + 0.4, rgb('#4c9a4f'));
    obox(b, x, y, ux, uy, 1.8, 0.12, zz + 0.4, zz + 0.5, rgb('#ffb347'));
}

/** Distancia de (x,y) al borde del anillo. */
function distToRing(x, y, ring) {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const ex = c[0] - a[0], ey = c[1] - a[1];
        const t = clamp(((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1);
        const d = Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y);
        if (d < best) best = d;
    }
    return best;
}

/**
 * Calles que atraviesan una plaza, como bandas rectas {nx,ny,lo,hi} (lo ≤ n·p ≤ hi es calle). Se muestrea la plaza cada
 * 4 m; las muestras pegadas al borde (veredas de las calles que la rodean) no cuentan. Para cada dirección se busca la
 * franja de ≤ 45 m con más muestras (un bulevar de dos manos a 14 m entra entero) y se acepta si es alargada; se repite
 * una vez más por si cruzan dos calles.
 */
export function crossingBands(ring, query, { step = 4, edge = 9, maxWidth = 45 } = {}) {
    const bb = bboxOf([ring]);
    let pts = [];
    for (let x = bb.minX + step / 2; x <= bb.maxX; x += step) {
        for (let y = bb.minY + step / 2; y <= bb.maxY; y += step) {
            if (pointInRing(x, y, ring) && query.onRoad(x, y, 0) && distToRing(x, y, ring) > edge) pts.push([x, y]);
        }
    }
    const bands = [];
    const proj = new Float64Array(pts.length);
    for (let round = 0; round < 2 && pts.length >= 6; round++) {
        let best = null;
        for (let deg = 0; deg < 180; deg += 2) {
            const a = (deg * Math.PI) / 180;
            const nx = -Math.sin(a), ny = Math.cos(a);
            const n = pts.length;
            for (let i = 0; i < n; i++) proj[i] = pts[i][0] * nx + pts[i][1] * ny;
            const t = proj.subarray(0, n).sort();
            let j = 0;
            for (let i = 0; i < n; i++) {
                while (t[i] - t[j] > maxWidth) j++;
                const cnt = i - j + 1, span = t[i] - t[j];
                if (!best || cnt > best.cnt || (cnt === best.cnt && span < best.span - 0.5)) best = { cnt, span, nx, ny, lo: t[j], hi: t[i] };
            }
        }
        if (!best || best.cnt < 6) break;
        const inBand = pts.filter(([x, y]) => { const v = x * best.nx + y * best.ny; return v >= best.lo - 1e-6 && v <= best.hi + 1e-6; });
        // alargada: a lo largo mide bastante más que el ancho
        let s0 = Infinity, s1 = -Infinity;
        for (const [x, y] of inBand) { const s = -x * best.ny + y * best.nx; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
        if (s1 - s0 < Math.max(20, (best.span + step) * 1.5)) break;
        const pad = step * 0.75 + 1.2;
        bands.push({ nx: best.nx, ny: best.ny, lo: best.lo - pad, hi: best.hi + pad });
        pts = pts.filter(([x, y]) => { const v = x * best.nx + y * best.ny; return v < best.lo - pad || v > best.hi + pad; });
    }
    return bands;
}

/**
 * Plaza detallada.
 *  - P1 (nombre /san mart[ií]n/i): Plaza San Martín — senderos diagonales y perimetral, canteros elevados, monumento
 *    ecuestre al ESTE con explanada al frente (oeste), patinódromo/anfiteatro, lago artificial, 2 fuentes, glorietas,
 *    bancos, faroles bajos, árboles y palmeras.
 *  - P2: plaza genérica — cruz de senderos, monumento o fuente en el centro, juegos, bancos, árboles.
 * Si una avenida cruza la plaza (`query.onRoad`), el diseño se parte a los dos lados y nada se pone sobre la calle.
 *
 * @param plaza {ring, name}
 * Árboles: context 'plaza'; palmeras con `palm: true`. En P1 además `species` (E1): lapachos T1/T2 en el borde,
 * chivato T3 / paratodo T4 adentro, pindó T7 a lo largo de las diagonales, palma blanca T5 en la isla del lago.
 *
 * @param opts.query  consulta de calles (city-roads `query`, usa onRoad): calles que cruzan → `crossings`
 * @returns {{ kind:'P1'|'P2', builders:{ground, plain, water}, trees, lamps:[{x,y,kind:'plaza',z}], fountains:[{x,y,r,z}],
 *            monument:{x,y,height}|null, lake:ring|null, crossings:[{nx,ny,lo,hi}] }}
 */
export function buildPlaza(plaza, { quality = 'media', query = null } = {}) {
    const ground = new MeshBuilder();
    const plain = new MeshBuilder();
    const water = new MeshBuilder();
    const ring = normalizeRing(plaza?.ring ?? []);
    const name = plaza?.name ?? '';
    const P1 = /san mart[ií]n/i.test(name);
    const out = { kind: P1 ? 'P1' : 'P2', builders: { ground, plain, water }, trees: [], lamps: [], fountains: [], monument: null, lake: null, crossings: [] };
    if (ring.length < 3) return out;
    const area = Math.abs(signedArea(ring));
    const bx = orientedBox(ring);
    const hullR = normalizeRing(hull(ring));
    const seedK = posKey(bx.cx, bx.cy);
    const lite = quality === 'baja';

    // ---- calles que cruzan: bandas rectas estimadas con las muestras sobre la calle
    const onRoad = (x, y, m = 0) => !!(query && query.onRoad(x, y, m));
    const bands = query ? crossingBands(ring, query) : [];
    out.crossings = bands;
    const pieces = (poly) => {
        let res = poly.length >= 3 ? [poly] : [];
        for (const { nx, ny, lo, hi } of bands) {
            res = res.flatMap((p) => [clipHalf(p, nx, ny, hi), clipHalf(p, -nx, -ny, -lo)])
                .filter((p) => p.length >= 3 && Math.abs(signedArea(p)) > 0.5);
        }
        return res;
    };

    // ---- piso de la plaza (baldosas claras a 0.12) con cordón
    const zP = 0.12;
    for (const piece of pieces(ring)) {
        fillPoly(ground, piece, zP, rgb(PAVING));
        ringWalls(ground, normalizeRing(piece), 0, zP, rgb(CURB));
    }

    // ---- marco: eje este (para el monumento) y eje norte
    let E = [bx.u[0], bx.u[1]], halfE = bx.halfLong, halfN = bx.halfShort;
    if (Math.abs(bx.v[0]) > Math.abs(bx.u[0])) { E = [bx.v[0], bx.v[1]]; halfE = bx.halfShort; halfN = bx.halfLong; }
    if (E[0] < 0) E = [-E[0], -E[1]];
    const N = [-E[1], E[0]];
    const C = [bx.cx, bx.cy];
    const at = (e, n) => [C[0] + E[0] * e + N[0] * n, C[1] + E[1] * e + N[1] * n];

    const pathW = P1 ? 5 : 3.5;
    const perim = P1 ? 5 : 3.5;
    const zL = 0.32; // canteros de pasto elevados
    const inner = insetConvex(hullR, perim);
    const blocked = []; // círculos {x,y,r} ocupados por elementos (para árboles y bancos)
    const block = (x, y, r) => blocked.push({ x, y, r });
    const isBlocked = (x, y, m = 0) => blocked.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + m);
    const okPoint = (x, y, r = 1) => pointInRing(x, y, ring) && !onRoad(x, y, r) && (!inner.length || pointInRing(x, y, inner));

    // ---- canteros (triángulos entre senderos) y senderos implícitos (lo que queda de baldosa)
    const A = halfE - perim, B = halfN - perim;
    const panels = [];
    if (A > 6 && B > 6) {
        const c = [0, 0];
        const corners = [[A, B], [-A, B], [-A, -B], [A, -B]];
        const mids = [[0, B], [-A, 0], [0, -B], [A, 0]];
        if (P1 || area > 6000) {
            // cuadrantes partidos por la diagonal: 8 triángulos
            const order = [[A, 0], [A, B], [0, B], [-A, B], [-A, 0], [-A, -B], [0, -B], [A, -B]];
            for (let i = 0; i < 8; i++) panels.push([c, order[i], order[(i + 1) % 8]]);
        } else {
            for (let i = 0; i < 4; i++) panels.push([c, mids[(i + 3) % 4], corners[i], mids[i]]);
        }
    }
    const lawnPolys = [];
    for (const pl of panels) {
        const world = normalizeRing(pl.map(([e, n]) => at(e, n)));
        let poly = insetConvex(world, pathW / 2);
        if (poly.length < 3) continue;
        if (inner.length) poly = clipConvex(poly, inner);
        for (const piece of pieces(poly)) {
            if (Math.abs(signedArea(piece)) < 12) continue;
            lawnPolys.push(piece);
            const col = rgb(LAWN[lawnPolys.length % LAWN.length]);
            slab(ground, piece, zP, zL, col, rgb(CURB));
        }
    }
    const inLawn = (x, y, m = 0) => lawnPolys.some((p) => pointInRing(x, y, p) && (m <= 0 || insetOk(p, x, y, m)));
    function insetOk(p, x, y, m) {
        for (let i = 0; i < p.length; i++) {
            const a = p[i], c = p[(i + 1) % p.length];
            const ex = c[0] - a[0], ey = c[1] - a[1];
            const L = Math.hypot(ex, ey) || 1;
            if (((x - a[0]) * ey - (y - a[1]) * ex) / L > -m && ((x - a[0]) * -ey + (y - a[1]) * ex) / L < m) return false;
        }
        return true;
    }

    // círculo central pavimentado (cubre las puntas de los canteros)
    const centerR = P1 ? Math.min(16, Math.min(A, B) * 0.22) : Math.min(7, Math.min(A, B) * 0.3);
    const placeAt = (x, y, r) => {
        if (okPoint(x, y, r + 1) && !isBlocked(x, y, r)) return [x, y];
        // corrimiento: se busca un lugar cerca, lejos de la calle
        for (let k = 1; k <= 12; k++) {
            for (const [dx, dy] of [[N[0], N[1]], [-N[0], -N[1]], [E[0], E[1]], [-E[0], -E[1]]]) {
                const x2 = x + dx * k * 4, y2 = y + dy * k * 4;
                if (okPoint(x2, y2, r + 1) && !isBlocked(x2, y2, r)) return [x2, y2];
            }
        }
        return null;
    };
    const lamp = (x, y) => {
        if (okPoint(x, y, 0.5) && !isBlocked(x, y, 0.3)) out.lamps.push({ x, y, kind: 'plaza', z: zL });
    };

    if (P1) {
        // ---- monumento al este con explanada al oeste
        const mon = placeAt(...at(halfE - perim - 8, 0), 9);
        if (mon) {
            const ex0 = -34, ex1 = 6;
            const exp = [[ex0, -16], [ex1, -16], [ex1, 16], [ex0, 16]].map(([e, n]) => [mon[0] + E[0] * e + N[0] * n, mon[1] + E[1] * e + N[1] * n]);
            for (const piece of pieces(normalizeRing(exp))) {
                fanPoly(ground, piece, zL + 0.02, rgb(PAVING2));
                // guarda de otro color alrededor
                ringWalls(ground, normalizeRing(piece), zP, zL + 0.02, rgb(CURB));
            }
            const h = equestrian(plain, mon[0], mon[1], -E[0], -E[1], zL + 0.02);
            out.monument = { x: mon[0], y: mon[1], height: h };
            block(mon[0], mon[1], 6);
            for (let e = ex0 + 2; e < ex1; e += 6) {
                for (const n of [-15, 15]) {
                    const [x, y] = [mon[0] + E[0] * e + N[0] * n, mon[1] + E[1] * e + N[1] * n];
                    block(x, y, 2);
                }
            }
            // la explanada entera no lleva árboles
            for (let e = ex0; e <= ex1; e += 8) for (let n = -16; n <= 16; n += 8) block(mon[0] + E[0] * e + N[0] * n, mon[1] + E[1] * e + N[1] * n, 5.5);
            // faroles en las esquinas de la explanada
            for (const [e, n] of [[ex0 + 1, -15], [ex0 + 1, 15], [ex1 - 1, -15], [ex1 - 1, 15]]) lamp(mon[0] + E[0] * e + N[0] * n, mon[1] + E[1] * e + N[1] * n);
        }

        // ---- círculo central + fuente principal
        const cen = placeAt(C[0], C[1], centerR);
        if (cen) {
            const circ = circlePts(cen[0], cen[1], centerR, centerR, 20);
            for (const piece of pieces(circ)) fanPoly(ground, piece, zL + 0.01, rgb(PAVING2));
            const r = Math.min(6, centerR * 0.45);
            fountain(plain, water, cen[0], cen[1], r, zL + 0.01);
            out.fountains.push({ x: cen[0], y: cen[1], r, z: zL + 0.42 });
            block(cen[0], cen[1], centerR);
            for (let k = 0; k < 6; k++) {
                const a = (k / 6) * Math.PI * 2 + 0.3;
                lamp(cen[0] + Math.cos(a) * (centerR - 1.2), cen[1] + Math.sin(a) * (centerR - 1.2));
            }
        }

        // ---- patinódromo (anfiteatro) en el cantero oeste-norte y lago en el oeste-sur
        const inc = (p, q2, r2) => {
            const a = Math.hypot(q2[0] - r2[0], q2[1] - r2[1]), b2 = Math.hypot(p[0] - r2[0], p[1] - r2[1]), c2 = Math.hypot(p[0] - q2[0], p[1] - q2[1]);
            const s = a + b2 + c2;
            return { e: (a * p[0] + b2 * q2[0] + c2 * r2[0]) / s, n: (a * p[1] + b2 * q2[1] + c2 * r2[1]) / s, r: Math.sqrt(((s / 2 - a) * (s / 2 - b2) * (s / 2 - c2)) / (s / 2)) };
        };
        const wn = inc([0, 0], [-A, B], [-A, 0]);
        const ws = inc([0, 0], [-A, -B], [-A, 0]);
        const fit = Math.max(6, wn.r - pathW / 2 - 1);
        // patinódromo
        {
            const rx = Math.min(22, fit * 1.05), ry = Math.min(13, fit * 0.62);
            const pos = placeAt(...at(wn.e, wn.n), Math.max(rx, ry) * 0.8);
            if (pos) {
                const floor = circlePts(pos[0], pos[1], rx, ry, 20, E[0], E[1]);
                slab(ground, floor, zP, zL + 0.12, rgb('#c9ced2'), rgb(CURB));
                const line = circlePts(pos[0], pos[1], rx - 1.5, ry - 1.5, 20, E[0], E[1]);
                for (let i = 0; i < line.length; i++) strip(ground, line[i], line[(i + 1) % line.length], 0.08, zL + 0.13, rgb('#f2f2ea'), 0.08);
                // gradas escalonadas del lado norte (más lejos del centro)
                const steps = lite ? 2 : 3;
                for (let s = 0; s < steps; s++) {
                    const r0x = rx + 0.2 + s * 1.1, r0y = ry + 0.2 + s * 1.1;
                    const r1x = r0x + 1.1, r1y = r0y + 1.1;
                    const zt = zL + 0.12 + 0.42 * (s + 1);
                    const a0 = 0.15, a1 = Math.PI - 0.15, n = 12;
                    const o0 = circlePts(pos[0], pos[1], r0x, r0y, n, E[0], E[1], a0, a1);
                    const o1 = circlePts(pos[0], pos[1], r1x, r1y, n, E[0], E[1], a0, a1);
                    for (let i = 0; i < n; i++) {
                        const p = o0[i], q2 = o0[i + 1], p1 = o1[i], q1 = o1[i + 1];
                        plain.quad([p[0], p[1], zt], [p1[0], p1[1], zt], [q1[0], q1[1], zt], [q2[0], q2[1], zt], rgb('#ddd6c6'), 0);
                        plain.quad([q2[0], q2[1], zt - 0.42 * (s + 1)], [p[0], p[1], zt - 0.42 * (s + 1)], [p[0], p[1], zt], [q2[0], q2[1], zt], rgb('#bfb7a6'), 0);
                    }
                    // espalda de la última grada
                    if (s === steps - 1) {
                        for (let i = 0; i < n; i++) {
                            const p1 = o1[i], q1 = o1[i + 1];
                            plain.quad([p1[0], p1[1], zL], [q1[0], q1[1], zL], [q1[0], q1[1], zt], [p1[0], p1[1], zt], rgb('#bfb7a6'), 0);
                        }
                    }
                }
                block(pos[0], pos[1], Math.max(rx, ry) + 1.1 * steps + 1);
                block(pos[0] + E[0] * rx * 0.6, pos[1] + E[1] * rx * 0.6, ry + 1.1 * steps);
                block(pos[0] - E[0] * rx * 0.6, pos[1] - E[1] * rx * 0.6, ry + 1.1 * steps);
                for (const k of [-1, 1]) lamp(pos[0] + E[0] * k * (rx + 1.5), pos[1] + E[1] * k * (rx + 1.5));
            }
        }
        // lago artificial (polígono irregular con borde de piedra)
        {
            const R = Math.min(17, fit * 0.85);
            const pos = placeAt(...at(ws.e, ws.n), R * 1.1);
            if (pos) {
                const n = lite ? 10 : 14;
                const pts = [];
                for (let i = 0; i < n; i++) {
                    const a = (i / n) * Math.PI * 2;
                    const w = 0.78 + hash01(seedK + i, 31) * 0.34;
                    const s = Math.cos(a) * R * 1.25 * w, t = Math.sin(a) * R * 0.8 * w;
                    pts.push([pos[0] + E[0] * s + N[0] * t, pos[1] + E[1] * s + N[1] * t]);
                }
                const lake = normalizeRing(pts);
                if (lake.every(([x, y]) => !onRoad(x, y, 1) && pointInRing(x, y, ring))) {
                    // borde: anillo de piedra (un poco más grande) y agua
                    const rimO = lake.map(([x, y]) => [pos[0] + (x - pos[0]) * 1.08, pos[1] + (y - pos[1]) * 1.08]);
                    fillPoly(ground, rimO, zL + 0.1, rgb('#cbbf9f'));
                    ringWalls(ground, rimO, zP, zL + 0.1, rgb('#b3a888'));
                    fillPoly(water, lake, zL + 0.06 + 0.06, rgb('#4f8fb5'));
                    out.lake = lake;
                    block(pos[0], pos[1], R * 1.3);
                    // isla con una palmera
                    const ir = 2.2;
                    slab(ground, circlePts(pos[0] + E[0] * R * 0.3, pos[1] + E[1] * R * 0.3, ir, ir, 8), zL, zL + 0.3, rgb('#5cb34f'), rgb('#b3a888'));
                    out.trees.push({ x: pos[0] + E[0] * R * 0.3, y: pos[1] + E[1] * R * 0.3, context: 'plaza', palm: true, species: 'T5' });
                }
            }
        }
        // segunda fuente: sobre el eje oeste, entre el patinódromo y el lago
        {
            const r = 3.4;
            // si el eje oeste cae sobre la calle, se prueban otros cruces de senderos
            let pos = null;
            for (const [e, n] of [[-0.62, 0], [0, 0.6], [0, -0.6], [-0.35, 0.55], [-0.35, -0.55], [0.3, 0.6], [0.3, -0.6]]) {
                const [x, y] = at(e * A, n * B);
                if (okPoint(x, y, r + 4) && !isBlocked(x, y, r + 3.5)) { pos = [x, y]; break; }
            }
            if (!pos && out.fountains.length === 0) pos = placeAt(...at(-A * 0.62, 0), r + 3.5);
            if (pos) {
                const circ = circlePts(pos[0], pos[1], r + 3, r + 3, 14);
                for (const piece of pieces(circ)) fanPoly(ground, piece, zL + 0.01, rgb(PAVING2));
                fountain(plain, water, pos[0], pos[1], r, zL + 0.01);
                out.fountains.push({ x: pos[0], y: pos[1], r, z: zL + 0.42 });
                block(pos[0], pos[1], r + 3);
            }
        }
        // glorietas en los cruces de las diagonales con el anillo medio
        {
            const roofs = ['#b9472f', '#3f7a5a'];
            let gi = 0;
            for (const [se, sn] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                if (lite && gi >= 2) break;
                const [x, y] = at(se * A * 0.55, sn * B * 0.55);
                if (!okPoint(x, y, 6) || isBlocked(x, y, 4)) continue;
                glorieta(plain, x, y, 3.6, zL, roofs[gi % 2]);
                block(x, y, 5.5);
                lamp(x + E[0] * 5.5, y + E[1] * 5.5);
                gi++;
            }
        }
    } else {
        // ---- plaza genérica: centro con fuente o busto, juegos en un cuadrante
        const cen = placeAt(C[0], C[1], centerR);
        if (cen) {
            const circ = circlePts(cen[0], cen[1], centerR, centerR, 16);
            for (const piece of pieces(circ)) fanPoly(ground, piece, zL + 0.01, rgb(PAVING2));
            if (hash01(seedK, 41) < 0.5 && centerR >= 4) {
                const r = Math.min(3.2, centerR * 0.5);
                fountain(plain, water, cen[0], cen[1], r, zL + 0.01);
                out.fountains.push({ x: cen[0], y: cen[1], r, z: zL + 0.42 });
            } else {
                bust(plain, cen[0], cen[1], zL + 0.01);
                out.monument = { x: cen[0], y: cen[1], height: zL + 2.95 };
            }
            block(cen[0], cen[1], centerR);
        }
        if (area > 2500) {
            // el cuadrante más grande y lejos de la calle
            const cands = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([se, sn]) => at(se * A * 0.5, sn * B * 0.5));
            const ok = cands.map(([x, y], i) => ({ x, y, i, good: okPoint(x, y, 10) && inLawn(x, y) }));
            const k = Math.floor(hash01(seedK, 43) * 4);
            const sel = [0, 1, 2, 3].map((d) => ok[(k + d) % 4]).find((c) => c.good);
            if (sel && Math.min(A, B) > 18) {
                playground(plain, sel.x, sel.y, E[0], E[1], zL);
                block(sel.x, sel.y, 10);
            }
        }
    }

    // ---- bancos y faroles a lo largo de los senderos (ejes y diagonales)
    const paths = [];
    if (A > 6 && B > 6) {
        paths.push([at(-A, 0), at(A, 0)], [at(0, -B), at(0, B)]);
        if (P1 || area > 6000) paths.push([at(-A, -B), at(A, B)], [at(-A, B), at(A, -B)]);
    }
    const palms = [];
    let bi = 0;
    for (const [a, c] of paths) {
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const dx = (c[0] - a[0]) / len, dy = (c[1] - a[1]) / len;
        const nx = -dy, ny = dx;
        const diag = Math.abs(dx * E[0] + dy * E[1]) < 0.95 && Math.abs(dx * N[0] + dy * N[1]) < 0.95;
        for (let d = 8; d < len - 6; d += P1 ? 13 : 11) {
            bi++;
            const side = bi % 2 ? 1 : -1;
            const off = pathW / 2 + 0.45;
            const x = a[0] + dx * d + nx * off * side, y = a[1] + dy * d + ny * off * side;
            if (!lite || bi % 2) {
                if (okPoint(x, y, 1) && !isBlocked(x, y, 1) && inLawn(x, y)) {
                    bench(plain, x, y, -nx * side, -ny * side, zL);
                    block(x, y, 1.4);
                }
            }
            if (bi % 2 === 0) lamp(a[0] + dx * (d + 6) - nx * (pathW / 2 + 0.3) * side, a[1] + dy * (d + 6) - ny * (pathW / 2 + 0.3) * side);
            if (P1 && diag) {
                for (const s of [1, -1]) {
                    const px = a[0] + dx * (d + 6) + nx * (pathW / 2 + 1.8) * s, py = a[1] + dy * (d + 6) + ny * (pathW / 2 + 1.8) * s;
                    if (okPoint(px, py, 1.5) && !isBlocked(px, py, 1.2) && inLawn(px, py)) palms.push({ x: px, y: py });
                }
            }
        }
    }
    for (const p of palms) {
        out.trees.push(P1 ? { x: p.x, y: p.y, context: 'plaza', palm: true, species: 'T7' } : { x: p.x, y: p.y, context: 'plaza', palm: true });
        block(p.x, p.y, 2);
    }
    // faroles del sendero perimetral
    if (inner.length) {
        for (let i = 0; i < hullR.length; i++) {
            const a = hullR[i], c = hullR[(i + 1) % hullR.length];
            const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
            const dx = (c[0] - a[0]) / len, dy = (c[1] - a[1]) / len;
            const nx = -dy, ny = dx; // hacia adentro
            for (let d = 10; d < len - 5; d += 24) lamp(a[0] + dx * d + nx * (perim - 0.6), a[1] + dy * d + ny * (perim - 0.6));
        }
    }

    // ---- árboles en los canteros (~1 cada 120 m² de pasto)
    let lawnArea = 0;
    for (const p of lawnPolys) lawnArea += Math.abs(signedArea(p));
    const target = Math.round((lawnArea / 120) * (lite ? 0.6 : 1));
    const step = 11;
    const cand = [];
    const bb = bboxOf([ring]);
    let k = 0;
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
        for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
            k++;
            const jx = x + (hash01(seedK + k, 51) - 0.5) * step * 0.8, jy = y + (hash01(seedK + k, 52) - 0.5) * step * 0.8;
            if (!inLawn(jx, jy, 1.6) || isBlocked(jx, jy, 2.5) || onRoad(jx, jy, 2)) continue;
            const t = { x: jx, y: jy, context: 'plaza' };
            if (P1) {
                // Plaza San Martín: nativos — lapachos en el borde, chivatos y paratodos adentro, alguna palma blanca
                const h = hash01(posKey(jx, jy), 53);
                t.species = distToRing(jx, jy, ring) < 20 ? (h < 0.6 ? 'T1' : h < 0.85 ? 'T2' : 'T4') : (h < 0.45 ? 'T3' : h < 0.8 ? 'T4' : h < 0.92 ? 'T1' : 'T5');
                if (t.species === 'T5') t.palm = true;
            }
            cand.push(t);
        }
    }
    const stride = cand.length > target ? cand.length / Math.max(1, target) : 1;
    for (let i = 0; i < cand.length && out.trees.length < target + palms.length + 1; i += stride) out.trees.push(cand[Math.floor(i)]);
    return out;
}

// ------------------------------------------------------------------ 4) edificios emblemáticos

const DEFAULT_FOOT = {
    catedral: [26, 11], iglesia: [16, 7], casa_gobierno: [32, 16], estacion: [36, 8], monumento: [5, 5], museo: [16, 11], puerto: [24, 12], otro: [12, 9],
};

/** Paredes de una caja orientada + bandas de color (ventanas) en las cuatro caras. */
function bandedBlock(b, cx, cy, ux, uy, A, B, z0, z1, wall, band, floors, bandFrac = 0.4, period = 0) {
    obox(b, cx, cy, ux, uy, A, B, z0, z1, wall);
    if (!floors) return;
    const vx = -uy, vy = ux;
    const fh = (z1 - z0) / floors;
    const c = [[-A, -B], [A, -B], [A, B], [-A, B]].map(([s, t]) => [cx + ux * s + vx * t, cy + uy * s + vy * t]);
    for (let i = 0; i < 4; i++) {
        const p = c[i], q = c[(i + 1) % 4];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const L = Math.hypot(ex, ey);
        const nx = ey / L * 0.06, ny = -ex / L * 0.06; // hacia afuera, apenas despegado
        const i0 = 0.06, i1 = 0.94;
        const P0 = [p[0] + ex * i0 + nx, p[1] + ey * i0 + ny], P1 = [p[0] + ex * i1 + nx, p[1] + ey * i1 + ny];
        // period > 0: ventanas sueltas (una cada `period` m, de medio período de ancho); si no, una banda corrida
        const nWin = period > 0 ? Math.max(1, Math.round((L * (i1 - i0)) / period)) : 1;
        for (let f = 0; f < floors; f++) {
            const za = z0 + f * fh + fh * (0.5 - bandFrac / 2) + fh * 0.08, zb = za + fh * bandFrac;
            for (let w = 0; w < nWin; w++) {
                const t0 = nWin > 1 ? (w + 0.25) / nWin : 0, t1 = nWin > 1 ? (w + 0.75) / nWin : 1;
                const A0 = [P0[0] + (P1[0] - P0[0]) * t0, P0[1] + (P1[1] - P0[1]) * t0], A1 = [P0[0] + (P1[0] - P0[0]) * t1, P0[1] + (P1[1] - P0[1]) * t1];
                b.quad([A0[0], A0[1], za], [A1[0], A1[1], za], [A1[0], A1[1], zb], [A0[0], A0[1], zb], band, 0);
            }
        }
    }
}

/** Techo a dos aguas sobre una caja orientada (cumbrera a lo largo de u). */
function gableRoof(b, cx, cy, ux, uy, A, B, z, rise, roof, gable, over = 0.4) {
    const vx = -uy, vy = ux;
    const at = (s, t, h) => [cx + ux * s + vx * t, cy + uy * s + vy * t, h];
    const r = z + rise;
    b.tri(at(A, -B, z), at(A, B, z), at(A, 0, r), gable, 0);
    b.tri(at(-A, B, z), at(-A, -B, z), at(-A, 0, r), gable, 0);
    const e = z - over * (rise / B);
    b.quad(at(-A - over, -B - over, e), at(A + over, -B - over, e), at(A + over, 0, r), at(-A - over, 0, r), roof, 0);
    b.quad(at(A + over, B + over, e), at(-A - over, B + over, e), at(-A - over, 0, r), at(A + over, 0, r), roof, 0);
}

function landmarkFrame(f, toLocal, kind) {
    const g = f.geometry;
    if (g?.type === 'Polygon' || g?.type === 'MultiPolygon') {
        const rings = ringsOfGeometry(g, toLocal);
        let best = null;
        for (const r of rings) {
            const o = normalizeRing(r[0]);
            const a = Math.abs(signedArea(o));
            if (o.length >= 3 && (!best || a > best.a)) best = { r: o, a };
        }
        if (best) {
            const bx = orientedBox(best.r);
            const [dA, dB] = DEFAULT_FOOT[kind] ?? DEFAULT_FOOT.otro;
            return {
                x: bx.cx, y: bx.cy, ux: bx.u[0], uy: bx.u[1],
                A: clamp(bx.halfLong, dA * 0.4, dA * 2.5), B: clamp(bx.halfShort, dB * 0.4, dB * 2.5),
            };
        }
    }
    if (g?.type === 'Point') {
        const [x, y] = toLocal(g.coordinates);
        const [A, B] = DEFAULT_FOOT[kind] ?? DEFAULT_FOOT.otro;
        const ang = Number(f.properties?.angle ?? 0) * Math.PI / 180;
        return { x, y, ux: Math.cos(ang), uy: Math.sin(ang), A, B };
    }
    return null;
}

/**
 * Edificios emblemáticos hechos a mano, low-poly, en el centroide del feature (Polygon: su huella y orientación;
 * Point: huella por defecto). Catedral, Casa de Gobierno (6 pisos), Estación (1915, hoy Palacio Municipal), monumento…
 *
 * Regla anti doble edificio / z-fighting: si el centro del emblemático cae adentro de una propiedad del juego
 * (`opts.propertyRings`, anillos locales) o `opts.covered(x, y)` devuelve true, NO se arma su mesh (la propiedad ya
 * tiene su edificio); igual se devuelve en `list` con `covered: true` y la altura que habría tenido (para etiquetas).
 * Los monumentos (obelisco) se arman siempre salvo que `covered` diga lo contrario explícitamente.
 *
 * @returns {{ builders:{plain}, list:[{kind,name,x,y,height,covered}] }}
 */
export function buildLandmarks(landmarks = [], toLocal = (p) => p, { propertyRings = null, covered = null } = {}) {
    const mesh = new MeshBuilder();
    const list = [];
    const propIdx = propertyRings && propertyRings.length ? new PolyIndex(propertyRings.map((r) => [normalizeRing(r)]), 60) : null;
    for (const f of landmarks ?? []) {
        const kind = f?.properties?.landmark ?? 'otro';
        const fr = landmarkFrame(f, toLocal, kind);
        if (!fr || !Number.isFinite(fr.x) || !Number.isFinite(fr.y)) continue;
        let { x, y, ux, uy, A, B } = fr;
        // cubierto: una propiedad encima (salvo el monumento, que va en la plaza) o lo que diga `covered` (el
        // integrador le pasa además el marco {ux, uy, A, B} para ver si la huella pisa una calle)
        const isCovered = (kind !== 'monumento' && !!propIdx && propIdx.contains(x, y) >= 0) || (!!covered && !!covered(x, y, kind, fr));
        const plain = isCovered ? new MeshBuilder() : mesh; // cubierto: se arma aparte solo para saber la altura
        const vx = -uy, vy = ux;
        const at = (s, t) => [x + ux * s + vx * t, y + uy * s + vy * t];
        const name = f.properties?.name ?? null;
        let height = 10;
        if (kind === 'catedral' || kind === 'iglesia') {
            const cat = kind === 'catedral';
            const cream = rgb(cat ? '#f2e8d2' : '#efe3c8');
            const trim = rgb('#fbf7ee');
            const roof = rgb(cat ? '#7e8794' : '#a8452f');
            const H = cat ? 13 : 9;
            // nave (la fachada va del lado -u)
            const tw = Math.min(B * 0.75, cat ? 4.2 : 3); // medio ancho de la torre
            const naveA = A - tw;
            const [nx, ny] = at(tw, 0);
            bandedBlock(plain, nx, ny, ux, uy, naveA, B, 0, H, cream, rgb('#c7b48e'), 1, 0.5, 4.5);
            gableRoof(plain, nx, ny, ux, uy, naveA, B, H, B * 0.7, roof, cream, 0.5);
            // cúpula/crucero al fondo
            const [kx, ky] = at(A - B * 0.9, 0);
            obox(plain, kx, ky, ux, uy, B * 0.55, B * 0.55, H, H + 3.5, cream);
            pyramid(plain, circlePts(kx, ky, B * 0.6, B * 0.6, 8, ux, uy), H + 3.5, [kx, ky, H + 8], roof);
            // torre campanario sobre la fachada
            const T = cat ? 30 : 20;
            const [tx, ty] = at(-A + tw, 0);
            obox(plain, tx, ty, ux, uy, tw, tw, 0, T * 0.62, cream);
            obox(plain, tx, ty, ux, uy, tw + 0.25, tw + 0.25, T * 0.62, T * 0.65, trim);
            // campanario (aberturas oscuras en las 4 caras)
            obox(plain, tx, ty, ux, uy, tw * 0.85, tw * 0.85, T * 0.65, T * 0.8, cream);
            for (const [s, t] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const px = tx + (ux * s + vx * t) * (tw * 0.85 + 0.04), py = ty + (uy * s + vy * t) * (tw * 0.85 + 0.04);
                const ax = s ? vx : ux, ay = s ? vy : uy;
                obox(plain, px, py, ax, ay, tw * 0.4, 0.03, T * 0.67, T * 0.77, rgb('#3b3a40'));
            }
            obox(plain, tx, ty, ux, uy, tw * 0.95, tw * 0.95, T * 0.8, T * 0.82, trim);
            pyramid(plain, circlePts(tx, ty, tw * 1.2, tw * 1.2, 4, Math.cos(Math.PI / 4) * ux - Math.sin(Math.PI / 4) * uy, Math.sin(Math.PI / 4) * ux + Math.cos(Math.PI / 4) * uy), T * 0.82, [tx, ty, T - 1.2], roof);
            // cruz
            obox(plain, tx, ty, ux, uy, 0.08, 0.08, T - 1.4, T + 0.6, trim);
            obox(plain, tx, ty, vx, vy, 0.5, 0.08, T - 0.3, T - 0.1, trim);
            // portal
            const [px, py] = at(-A - 0.05, 0);
            obox(plain, px, py, ux, uy, 0.08, tw * 0.45, 0, T * 0.22, rgb('#6b4a32'));
            height = T + 0.6;
        } else if (kind === 'casa_gobierno') {
            const white = rgb('#f3eee2');
            const H = 6 * 3.5;
            bandedBlock(plain, x, y, ux, uy, A, B, 0, H, white, rgb('#5f7895'), 6, 0.42);
            obox(plain, x, y, ux, uy, A + 0.3, B + 0.3, H, H + 0.6, rgb('#e2dccd'));
            obox(plain, x, y, ux, uy, A * 0.3, B * 0.4, H + 0.6, H + 3, rgb('#d9d3c3'));
            // pórtico al frente (lado -v): columnas + losa + frontón
            const pw = Math.min(A * 0.55, 12), depth = 5;
            const [fx, fy] = at(0, -B - depth / 2);
            const nCol = 6;
            for (let i = 0; i < nCol; i++) {
                const s = -pw + (2 * pw * i) / (nCol - 1);
                const [cx, cy] = [fx + ux * s - vx * (depth / 2 - 0.6), fy + uy * s - vy * (depth / 2 - 0.6)];
                obox(plain, cx, cy, ux, uy, 0.42, 0.42, 0.4, 8, white);
            }
            obox(plain, fx, fy, ux, uy, pw + 0.9, depth / 2, 8, 9, rgb('#e9e3d4'));
            obox(plain, fx, fy, ux, uy, pw + 1.6, depth / 2 + 0.8, 0, 0.4, rgb('#d6cfbf'));
            const g1 = [fx - ux * (pw + 0.9) - vx * depth / 2, fy - uy * (pw + 0.9) - vy * depth / 2];
            const g2 = [fx + ux * (pw + 0.9) - vx * depth / 2, fy + uy * (pw + 0.9) - vy * depth / 2];
            plain.tri([g1[0], g1[1], 9], [g2[0], g2[1], 9], [fx - vx * depth / 2, fy - vy * depth / 2, 11], white, 0);
            // mástil con bandera
            const [mx, my] = at(0, -B - depth - 3);
            obox(plain, mx, my, ux, uy, 0.08, 0.08, 0, 14, rgb('#d8d8d8'));
            obox(plain, mx + ux * 1.1, my + uy * 1.1, ux, uy, 1.0, 0.03, 12.6, 13.5, rgb('#7cc3ef'));
            obox(plain, mx + ux * 1.1, my + uy * 1.1, ux, uy, 1.0, 0.035, 12.9, 13.2, rgb('#ffffff'));
            height = H + 3;
        } else if (kind === 'estacion') {
            const cream = rgb('#f1dfb8');
            const roof = rgb('#b4462e');
            const H = 6.5;
            bandedBlock(plain, x, y, ux, uy, A, B, 0, H, cream, rgb('#8a5a3c'), 1, 0.5, 3.4);
            // zócalo y cornisa blanca
            obox(plain, x, y, ux, uy, A + 0.08, B + 0.08, 0, 0.7, rgb('#c9b28a'));
            obox(plain, x, y, ux, uy, A + 0.15, B + 0.15, H - 0.45, H, rgb('#fbf6ea'));
            gableRoof(plain, x, y, ux, uy, A, B, H, B * 0.55, roof, cream, 0.8);
            // alero/andén techado del lado de las vías (+v)
            const [ax, ay] = at(0, B + 2.4);
            for (let s = -A + 3; s <= A - 3; s += 6) obox(plain, ax + ux * s + vx * 2, ay + uy * s + vy * 2, ux, uy, 0.12, 0.12, 0, 3.6, rgb('#5a4636'));
            const e1 = at(-A + 1, B), e2 = at(A - 1, B), e3 = at(A - 1, B + 5), e4 = at(-A + 1, B + 5);
            plain.quad([e1[0], e1[1], 4.2], [e2[0], e2[1], 4.2], [e3[0], e3[1], 3.6], [e4[0], e4[1], 3.6], rgb('#8f3b2c'), 0);
            plain.quad([e4[0], e4[1], 3.55], [e3[0], e3[1], 3.55], [e2[0], e2[1], 4.15], [e1[0], e1[1], 4.15], rgb('#6a2c20'), 0);
            // torre del reloj en el centro
            const tw = 2.6, T = H + B * 0.55 + 5.5; // asoma bien por encima de la cumbrera
            obox(plain, x, y, ux, uy, tw, tw, 0, T - 2.5, cream);
            obox(plain, x, y, ux, uy, tw + 0.2, tw + 0.2, T - 2.5, T - 2.2, rgb('#fbf6ea'));
            for (const [s, t] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const px = x + (ux * s + vx * t) * (tw + 0.04), py = y + (uy * s + vy * t) * (tw + 0.04);
                const fx = s ? vx : ux, fy = s ? vy : uy;
                obox(plain, px, py, fx, fy, 0.9, 0.03, T - 5.2, T - 3.4, rgb('#fdfbf3'));
                obox(plain, px + (ux * s + vx * t) * 0.03, py + (uy * s + vy * t) * 0.03, fx, fy, 0.08, 0.02, T - 4.4, T - 3.6, rgb('#2a2a2a'));
            }
            pyramid(plain, circlePts(x, y, (tw + 0.4) * Math.SQRT2, (tw + 0.4) * Math.SQRT2, 4, Math.cos(Math.PI / 4) * ux - Math.sin(Math.PI / 4) * uy, Math.sin(Math.PI / 4) * ux + Math.cos(Math.PI / 4) * uy), T - 2.2, [x, y, T + 1], roof);
            height = T + 1;
        } else if (kind === 'monumento') {
            const white = rgb('#f1ece0');
            slab(plain, circlePts(x, y, 4.2, 4.2, 4, Math.SQRT1_2, Math.SQRT1_2), 0, 0.5, rgb('#d9d2c2'), rgb(CURB));
            obox(plain, x, y, ux, uy, 2, 2, 0.5, 2.6, rgb(GRANITE));
            obox(plain, x, y, ux, uy, 2.2, 2.2, 2.6, 2.9, rgb('#e2dccd'));
            // fuste del obelisco (afinado)
            const h0 = 2.9, h1 = 17, r0 = 1.15, r1 = 0.7;
            const b0 = [[-r0, -r0], [r0, -r0], [r0, r0], [-r0, r0]].map(([s, t]) => [x + ux * s + vx * t, y + uy * s + vy * t]);
            const b1 = [[-r1, -r1], [r1, -r1], [r1, r1], [-r1, r1]].map(([s, t]) => [x + ux * s + vx * t, y + uy * s + vy * t]);
            for (let i = 0; i < 4; i++) {
                const p = b0[i], q2 = b0[(i + 1) % 4], p1 = b1[i], q1 = b1[(i + 1) % 4];
                plain.quad([p[0], p[1], h0], [q2[0], q2[1], h0], [q1[0], q1[1], h1], [p1[0], p1[1], h1], white, 0);
            }
            pyramid(plain, b1, h1, [x, y, h1 + 1.6], white);
            height = h1 + 1.6;
        } else if (kind === 'museo') {
            const w = rgb('#f0e4cc');
            bandedBlock(plain, x, y, ux, uy, A, B, 0, 8, w, rgb('#7a6a55'), 2, 0.4);
            obox(plain, x, y, ux, uy, A + 0.3, B + 0.3, 8, 8.8, rgb('#fbf6ea'));
            const [fx, fy] = at(0, -B - 1.5);
            for (let i = 0; i < 4; i++) {
                const s = -A * 0.35 + (A * 0.7 * i) / 3;
                obox(plain, fx + ux * s, fy + uy * s, ux, uy, 0.35, 0.35, 0, 6, rgb('#fbf6ea'));
            }
            obox(plain, fx, fy, ux, uy, A * 0.42, 1.7, 6, 6.8, rgb('#fbf6ea'));
            height = 8.8;
        } else if (kind === 'puerto') {
            obox(plain, x, y, ux, uy, A, B, 0, 7, rgb('#c9d3d9'));
            gableRoof(plain, x, y, ux, uy, A, B, 7, B * 0.3, rgb('#7d8a92'), rgb('#c9d3d9'), 0.3);
            const [gx, gy] = at(A + 4, 0);
            obox(plain, gx, gy, ux, uy, 0.5, 0.5, 0, 16, rgb('#f2b134'));
            obox(plain, gx + vx * 5, gy + vy * 5, vx, vy, 7, 0.4, 15, 15.8, rgb('#f2b134'));
            height = 16;
        } else {
            bandedBlock(plain, x, y, ux, uy, A, B, 0, 9, rgb('#ece3d0'), rgb('#6f86a0'), 3, 0.38);
            obox(plain, x, y, ux, uy, A + 0.25, B + 0.25, 9, 9.6, rgb('#d9d2c2'));
            height = 9.6;
        }
        list.push({ kind, name, x, y, height, covered: isCovered });
    }
    return { builders: { plain: mesh }, list };
}
