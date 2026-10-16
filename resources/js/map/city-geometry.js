// Geometría de la ciudad 3D, en metros locales (x = este, y = norte, z = arriba) alrededor de un origen.
// Puro (sin mapa ni WebGL): arma listas de triángulos y posiciones de árboles y faroles. Se prueba con `npm run test:js`.
import { ShapeUtils, Vector2 } from 'three';

// ------------------------------------------------------------------ utilidades

/** Número pseudoaleatorio estable a partir de un entero (misma propiedad, mismo resultado en todos los navegadores). */
export function hash01(n, salt = 0) {
    let x = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(salt + 0x85ebca6b, 0xc2b2ae35)) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
}

const pick = (list, n, salt) => list[Math.floor(hash01(n, salt) * list.length) % list.length];

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Anillo abierto (sin repetir el primer punto) y en sentido antihorario. */
export function normalizeRing(ring) {
    let pts = ring.slice();
    if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) {
        pts = pts.slice(0, -1);
    }
    if (signedArea(pts) < 0) {
        pts.reverse();
    }
    return pts;
}

export function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) {
        return pts;
    }
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
        upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Rectángulo de área mínima que contiene el polígono (calibres rotantes sobre la envolvente convexa).
 * Devuelve centro, eje largo `u`, eje corto `v` (unitarios) y medio largo / medio ancho.
 */
export function orientedBox(ring) {
    const hull = convexHull(ring);
    let best = null;
    for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i];
        const [x2, y2] = hull[(i + 1) % hull.length];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1e-9) continue;
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const [x, y] of hull) {
            const pu = x * ux + y * uy;
            const pv = -x * uy + y * ux;
            minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
            minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
        }
        const area = (maxU - minU) * (maxV - minV);
        if (!best || area < best.area) {
            best = { area, ux, uy, minU, maxU, minV, maxV };
        }
    }
    if (!best) {
        const [x, y] = ring[0] ?? [0, 0];
        return { cx: x, cy: y, u: [1, 0], v: [0, 1], halfLong: 1, halfShort: 1 };
    }
    const cu = (best.minU + best.maxU) / 2;
    const cv = (best.minV + best.maxV) / 2;
    const cx = cu * best.ux - cv * best.uy;
    const cy = cu * best.uy + cv * best.ux;
    let u = [best.ux, best.uy];
    let v = [-best.uy, best.ux];
    let halfLong = (best.maxU - best.minU) / 2;
    let halfShort = (best.maxV - best.minV) / 2;
    if (halfShort > halfLong) {
        [u, v] = [v, [-u[0], -u[1]]];
        [halfLong, halfShort] = [halfShort, halfLong];
    }
    return { cx, cy, u, v, halfLong, halfShort };
}

// ------------------------------------------------------------------ armado de triángulos

/** Acumula triángulos con normal plana, coordenadas de textura, color por vértice y a qué propiedad pertenece cada uno. */
export class MeshBuilder {
    constructor() {
        this.pos = [];
        this.nor = [];
        this.uv = [];
        this.col = [];
        this.owner = []; // id de propiedad por triángulo (para saber qué se tocó con un clic)
    }

    get vertexCount() {
        return this.pos.length / 3;
    }

    tri(a, b, c, color, id, uvs = null) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (const [i, p] of [a, b, c].entries()) {
            this.pos.push(p[0], p[1], p[2]);
            this.nor.push(nx, ny, nz);
            const t = uvs ? uvs[i] : [0.02, 0.02];
            this.uv.push(t[0], t[1]);
            this.col.push(color[0], color[1], color[2]);
        }
        this.owner.push(id);
    }

    /** Cuadrilátero a-b-c-d (antihorario visto desde afuera). */
    quad(a, b, c, d, color, id, uvs = null) {
        this.tri(a, b, c, color, id, uvs && [uvs[0], uvs[1], uvs[2]]);
        this.tri(a, c, d, color, id, uvs && [uvs[0], uvs[2], uvs[3]]);
    }

    /** Pared vertical entre dos puntos del suelo, con la textura repetida cada `cellW` metros de ancho y `cellH` de alto. */
    wall(p, q, z0, z1, color, id, cellW, cellH, uOffset = 0) {
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const u0 = uOffset / cellW, u1 = (uOffset + len) / cellW;
        const v0 = z0 / cellH, v1 = z1 / cellH;
        this.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], color, id,
            [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
        return len;
    }

    /** Caja (sin base) alineada a los ejes u/v. */
    box(cx, cy, u, v, hu, hv, z0, z1, color, id) {
        const c = (su, sv, z) => [cx + u[0] * su * hu + v[0] * sv * hv, cy + u[1] * su * hu + v[1] * sv * hv, z];
        const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let i = 0; i < 4; i++) {
            const [a1, b1] = ring[i];
            const [a2, b2] = ring[(i + 1) % 4];
            this.quad(c(a1, b1, z0), c(a2, b2, z0), c(a2, b2, z1), c(a1, b1, z1), color, id);
        }
        this.quad(c(-1, -1, z1), c(1, -1, z1), c(1, 1, z1), c(-1, 1, z1), color, id);
    }
}

// ------------------------------------------------------------------ paleta (inspirada en la ciudad pixel)

export const PALETTE = {
    houseWalls: ['#f3e3c3', '#f6d7b0', '#efe6d2', '#f2cfa8', '#e9dcc0', '#f7e7b6'],
    houseRoofs: ['#c4553f', '#b9472f', '#a8452f', '#cf6a43', '#8f3b2c', '#9a7650'],
    shopWalls: ['#e9edf2', '#f4efe6', '#e6e0f0', '#dfeaf2'],
    awnings: ['#ff6b6b', '#4c9a4f', '#5a6aa8', '#ffb347', '#ff6b9a', '#63b3e6'],
    flatRoof: '#8d929b',
    superWalls: ['#e2f0e4', '#eef2e0'],
    towerWalls: ['#5a6aa8', '#4b5f9e', '#6d7fb3', '#3f4f7f'],
    chimney: '#86603c',
    mine: '#ffb703',
    selected: '#fff3a8',
};

/** Alturas y forma de cada tipo (en metros). */
export function buildingSpec(kind, id, area) {
    const r = hash01(id, 7);
    if (kind === 'casa') {
        return { style: 'house', wallH: 3.3 + r * 0.7 };
    }
    if (kind === 'comercio') {
        return { style: 'shop', wallH: r < 0.6 ? 3.6 : 6.6 };
    }
    if (kind === 'supermercado') {
        return { style: 'super', wallH: 6.5 };
    }
    const floors = Math.max(6, Math.min(14, Math.round((area || 600) / 80)));
    return { style: 'tower', wallH: floors * 3.2 };
}

/** Altura total aproximada (para el encuadre y para el selector de MapLibre). */
export function totalHeight(kind, id, area) {
    const s = buildingSpec(kind, id, area);
    return s.style === 'house' ? s.wallH + 2.3 : s.wallH + (s.style === 'tower' ? 3 : 0);
}

// ------------------------------------------------------------------ edificios

/**
 * Agrega un edificio a los constructores:
 *  - walls[style]: paredes con textura de ventanas (casa, comercio, súper, torre).
 *  - plain: techos, toldos, chimeneas y frentes de los techos a dos aguas (sin textura).
 * Devuelve el rango de vértices del techo en `plain`, para recolorearlo cuando cambia el dueño.
 */
export function addBuilding(b, { walls, plain }) {
    const { id, kind, ring: rawRing, area } = b;
    const ring = normalizeRing(rawRing);
    if (ring.length < 3) {
        return null;
    }
    const spec = buildingSpec(kind, id, area);
    const roofColor = hexToRgb(b.roofColor ?? defaultRoof(kind, id));

    if (spec.style === 'house') {
        const wallColor = hexToRgb(pick(PALETTE.houseWalls, id, 1));
        const box = orientedBox(ring);
        const A = Math.max(1.6, box.halfLong - 0.15);
        const B = Math.max(1.4, box.halfShort - 0.15);
        const H = spec.wallH;
        const pitch = Math.min(0.62, 2.3 / B); // casas anchas: el techo no crece sin límite (máx. ~2,3 m de cumbrera)
        const at = (su, sv, z) => [box.cx + box.u[0] * su + box.v[0] * sv, box.cy + box.u[1] * su + box.v[1] * sv, z];
        // paredes
        const corners = [at(-A, -B, 0), at(A, -B, 0), at(A, B, 0), at(-A, B, 0)];
        let off = 0;
        for (let i = 0; i < 4; i++) {
            off += walls.house.wall(corners[i], corners[(i + 1) % 4], 0, H, wallColor, id, 2.6, 3, off);
        }
        // frentes triangulares del techo (color de pared)
        const ridgeZ = H + B * pitch;
        plain.tri(at(A, -B, H), at(A, B, H), at(A, 0, ridgeZ), wallColor, id);
        plain.tri(at(-A, B, H), at(-A, -B, H), at(-A, 0, ridgeZ), wallColor, id);
        // chimenea (en la mitad de las casas)
        if (hash01(id, 3) < 0.5) {
            const ch = at(A * 0.45, B * 0.35, 0);
            plain.box(ch[0], ch[1], box.u, box.v, 0.3, 0.3, H, ridgeZ + 0.5, hexToRgb(PALETTE.chimney), id);
        }
        // techo a dos aguas con alero
        const o = 0.35;
        const eaveZ = H - o * pitch;
        const start = plain.vertexCount;
        plain.quad(at(-A - o, -B - o, eaveZ), at(A + o, -B - o, eaveZ), at(A + o, 0, ridgeZ), at(-A - o, 0, ridgeZ), roofColor, id);
        plain.quad(at(A + o, B + o, eaveZ), at(-A - o, B + o, eaveZ), at(-A - o, 0, ridgeZ), at(A + o, 0, ridgeZ), roofColor, id);
        return { start, count: plain.vertexCount - start };
    }

    // edificios de techo plano: las paredes siguen el polígono real
    const H = spec.wallH;
    const builder = walls[spec.style];
    const wallColor = hexToRgb(
        spec.style === 'shop' ? pick(PALETTE.shopWalls, id, 1)
            : spec.style === 'super' ? pick(PALETTE.superWalls, id, 1)
                : pick(PALETTE.towerWalls, id, 1),
    );
    const cell = spec.style === 'tower' ? [2.2, 3.2] : spec.style === 'super' ? [4, 6.5] : [3, 3.3];
    let off = 0;
    let longest = null;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const len = builder.wall([p[0], p[1]], [q[0], q[1]], 0, H, wallColor, id, cell[0], cell[1], off);
        off += len;
        if (!longest || len > longest.len) {
            longest = { p, q, len };
        }
    }
    // toldo de color sobre el frente más largo (comercios)
    if (spec.style === 'shop' && longest && longest.len > 2) {
        const dx = (longest.q[0] - longest.p[0]) / longest.len;
        const dy = (longest.q[1] - longest.p[1]) / longest.len;
        const nx = dy, ny = -dx; // afuera (anillo antihorario)
        const out = 1.1;
        const z0 = 2.7, z1 = 2.25;
        const awning = hexToRgb(pick(PALETTE.awnings, id, 5));
        const p = longest.p, q = longest.q;
        plain.quad([p[0], p[1], z0], [p[0] + nx * out, p[1] + ny * out, z1], [q[0] + nx * out, q[1] + ny * out, z1], [q[0], q[1], z0], awning, id);
    }
    // techo plano (triangulado: sirve para polígonos cóncavos)
    const start = plain.vertexCount;
    const contour = ring.map(([x, y]) => new Vector2(x, y));
    const tris = ShapeUtils.triangulateShape(contour, []);
    for (let [a, b2, c] of tris) {
        // el techo mira hacia arriba sin importar el orden en que la triangulación devuelve los vértices
        const cross = (ring[b2][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) - (ring[b2][1] - ring[a][1]) * (ring[c][0] - ring[a][0]);
        if (cross < 0) [b2, c] = [c, b2];
        plain.tri([ring[a][0], ring[a][1], H], [ring[b2][0], ring[b2][1], H], [ring[c][0], ring[c][1], H], roofColor, id);
    }
    const roof = { start, count: plain.vertexCount - start };
    // sala de máquinas sobre las torres
    if (spec.style === 'tower') {
        const box = orientedBox(ring);
        plain.box(box.cx, box.cy, box.u, box.v, Math.max(1.2, box.halfLong * 0.35), Math.max(1.2, box.halfShort * 0.35), H, H + 3, hexToRgb('#3a3f4e'), id);
    }
    return roof;
}

export function defaultRoof(kind, id) {
    return kind === 'casa' ? pick(PALETTE.houseRoofs, id, 2) : PALETTE.flatRoof;
}

// ------------------------------------------------------------------ árboles y faroles

/** Índice de grilla para preguntar rápido "¿hay algo acá cerca?". */
export class Grid {
    constructor(cell) {
        this.cell = cell;
        this.map = new Map();
    }

    key(x, y) {
        return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    }

    addBox(minX, minY, maxX, maxY, value) {
        for (let x = Math.floor(minX / this.cell); x <= Math.floor(maxX / this.cell); x++) {
            for (let y = Math.floor(minY / this.cell); y <= Math.floor(maxY / this.cell); y++) {
                const k = `${x},${y}`;
                if (!this.map.has(k)) this.map.set(k, []);
                this.map.get(k).push(value);
            }
        }
    }

    near(x, y) {
        return this.map.get(this.key(x, y)) ?? [];
    }
}

/**
 * Árboles a lo largo de las veredas y en los espacios libres de las manzanas, y faroles cada tanto sobre las calles.
 * Nunca dentro de un edificio ni sobre una calle. Determinista: siempre los mismos lugares.
 *
 * @param roads   lista de { coords: [[x,y],…], major: bool } en metros locales
 * @param boxes   lista de [minX, minY, maxX, maxY] de los edificios
 */
export function placeStreetFurniture(roads, boxes, { maxTrees = 7000, maxLamps = 2500 } = {}) {
    const blocked = new Grid(8);
    boxes.forEach((b, i) => blocked.addBox(b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1, i));
    const insideBuilding = (x, y) => blocked.near(x, y).some((i) => {
        const b = boxes[i];
        return x >= b[0] - 1 && x <= b[2] + 1 && y >= b[1] - 1 && y <= b[3] + 1;
    });
    // puntos de las calles para no plantar sobre otra calle (cruces)
    const roadPts = new Grid(6);
    const segments = [];
    for (const r of roads) {
        for (let i = 0; i + 1 < r.coords.length; i++) {
            const a = r.coords[i], b = r.coords[i + 1];
            segments.push({ a, b, half: r.major ? 6 : 4.5 });
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            for (let d = 0; d <= len; d += 3) {
                const t = len ? d / len : 0;
                const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
                roadPts.addBox(x, y, x, y, { x, y, half: r.major ? 6 : 4.5 });
            }
        }
    }
    const onRoad = (x, y, margin) => {
        const c = roadPts.cell;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const p of roadPts.near(x + dx * c, y + dy * c)) {
                    if (Math.hypot(p.x - x, p.y - y) < p.half + margin) return true;
                }
            }
        }
        return false;
    };

    const trees = [];
    const lamps = [];
    let n = 0;
    for (const s of segments) {
        const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
        if (len < 1) continue;
        const dx = (s.b[0] - s.a[0]) / len, dy = (s.b[1] - s.a[1]) / len;
        const nx = -dy, ny = dx;
        for (let d = 6; d < len - 4; d += 14) {
            n++;
            for (const side of [1, -1]) {
                if (trees.length >= maxTrees) break;
                const off = s.half + 2.2;
                const x = s.a[0] + dx * d + nx * off * side, y = s.a[1] + dy * d + ny * off * side;
                if (hash01(n, side + 11) < 0.25 || insideBuilding(x, y) || onRoad(x, y, 1)) continue;
                trees.push({ x, y, s: 0.8 + hash01(n, side + 21) * 0.5, c: hash01(n, side + 31) });
            }
            // un farol cada ~42 m, del lado derecho
            if (n % 3 === 0 && lamps.length < maxLamps) {
                const off = s.half + 0.8;
                const x = s.a[0] + dx * d + nx * off, y = s.a[1] + dy * d + ny * off;
                if (!insideBuilding(x, y) && !onRoad(x, y, 0.3)) {
                    lamps.push({ x, y });
                }
            }
        }
    }
    // árboles en los espacios libres de las manzanas (patios, plazas)
    if (boxes.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const b of boxes) {
            minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
        }
        const step = 11;
        const candidates = [];
        let k = 0;
        for (let x = minX; x <= maxX; x += step) {
            for (let y = minY; y <= maxY; y += step) {
                k++;
                if (hash01(k, 41) > 0.32) continue;
                const jx = x + (hash01(k, 42) - 0.5) * step * 0.8, jy = y + (hash01(k, 43) - 0.5) * step * 0.8;
                if (insideBuilding(jx, jy) || onRoad(jx, jy, 3)) continue;
                candidates.push({ x: jx, y: jy, s: 0.9 + hash01(k, 44) * 0.7, c: hash01(k, 45) });
            }
        }
        // si sobran, se toman salteados para que queden repartidos por toda la ciudad y no amontonados en un rincón
        const room = Math.max(0, maxTrees - trees.length);
        const stride = candidates.length > room ? candidates.length / room : 1;
        for (let i = 0; i < candidates.length && trees.length < maxTrees; i += stride) {
            trees.push(candidates[Math.floor(i)]);
        }
    }
    return { trees, lamps };
}
