// Armado pesado de la ciudad 3D (triángulos de ~12.500 edificios, árboles y faroles) fuera del hilo principal.
// Corre como Web Worker (módulo); si el navegador no deja crear el worker, city3d.js importa este mismo archivo y llama
// a `buildCityData` en el hilo principal. Puro: sin DOM ni WebGL (se prueba en node).
//
// Entrada (todo plano y en arreglos tipados, para que copiarlo al worker sea barato):
//   { seq, origin: [lng, lat], chunkSize, quality,
//     buildings: { ids: Float64Array, kinds: Uint8Array (índice en KINDS), areas: Float64Array,
//                  offsets: Uint32Array (n + 1, en puntos), coords: Float64Array (lng, lat, …), visible: Uint8Array,
//                  roofs: [[id, '#hex'], …] (techos con color de dueño o de selección) },
//     roads: { offsets: Uint32Array, coords: Float64Array, highway: string[] } | null,
//     furniture: bool,
//     environment: [features de /api/entorno] | null   (solo en el primer armado: suelo, agua y alrededores),
//     roadFeatures: [features de /api/calles] | null    (solo en el primer armado: calles 3D, mobiliario, franja) }
// Salida: { seq, ms, buildings, chunks: [Chunk], furniture: { trees: Float32Array, lamps: Float32Array } | null, layers }
//   layers (solo si vino `environment`): { ground, water, ringGround, ringBuildings, periBuildings, roadsGround,
//            roadsMarkings: arrays, campo: Float32Array (x, y)…, trees: Float32Array (x, y, contexto)…,
//            lamps (x, y, dirX, dirY, tipo)…, signals / busStops / benches (x, y, dirX, dirY)…, signs (x, y)…,
//            bounds: {minX,minY,maxX,maxY} (barrio, metros locales), waterSide, info, ms }
//   Chunk = { i, j, sphere: [x, y, z, r], meshes: [{ kind: 'walls'|'plain'|'lod'|'contact', style?, arrays }],
//             roofs: Float64Array (id, inicio, cantidad)… en el 'plain' del sector, lodRoofs: ídem en el 'lod' }
//   arrays = { pos, nor, uv?, col (lineal; 4 canales en 'contact'), owner?: Uint32Array (id por triángulo) }
import { ShapeUtils, Vector2 } from 'three';
import { MeshBuilder, addBuilding, placeStreetFurniture, orientedBox, normalizeRing, signedArea, hexToRgb, defaultRoof } from './city-geometry.js';
import { localProjection, chunkCoord, CHUNK_SIZE, QUALITY } from './city-frame.js';
import { buildGround, buildOuterRing, buildPlaza, buildLandmarks, buildBlockInfill, PolyIndex } from './city-env.js';
import { normalizeRoads, buildRoadNetwork, roadProfile } from './city-roads.js';
import { FACADE_STYLES, addBuildingMold, chooseMold, defaultRoofColor, moldHeight } from './city-molds.js';
import { placeYardTrees, SPECIES_KEYS } from './city-trees.js';
import { setbackFootprint } from './city-footprint.js';
import { hash01, Grid } from './city-geometry.js';
import { periurbanStreets, periurbanBuildings, BAND } from './city-periurban.js';

export const KINDS = ['casa', 'comercio', 'supermercado', 'hotel'];

/**
 * Kit de edificios. PUNTO DE INTEGRACIÓN (city-molds.js): reemplazar `addBuilding` por `addBuildingMold` y `styles`
 * por FACADE_STYLES. Contrato: addBuilding(b, { walls: { [style]: MeshBuilder }, plain: MeshBuilder }, ctx) devuelve
 * el rango { start, count } del techo en `plain` (o null). `ctx` lo arma `buildingContext` (más abajo).
 */
export const BUILDING_KIT = {
    styles: FACADE_STYLES,
    addBuilding: (b, builders, ctx) => addBuildingMold(b, builders, ctx),
    defaultRoof: (b, ctx = {}) => defaultRoofColor(b, ctx.mold ?? chooseMold(b, ctx)),
};
/** El kit viejo (cajas de city-geometry): solo para comparar en pruebas. */
export const LEGACY_KIT = {
    styles: ['house', 'shop', 'super', 'tower'],
    addBuilding: (b, builders) => addBuilding(b, builders),
    defaultRoof: (b) => defaultRoof(b.kind, b.id),
};

/**
 * Estado de la ciudad que arma el primer armado (calles, plaza, río) y usan los rearmados (contexto de los moldes).
 * Vive en el módulo: en el worker persiste entre pedidos; en el plan B (hilo principal) también.
 */
let cityState = null;

/**
 * Contexto por edificio para los moldes: zona (centro cerca de la plaza principal, costanera del lado del río o sobre
 * la costanera, barrio), frente hacia la calle más cercana (dirección, distancia al eje y eje→línea municipal),
 * esquina (hay un cruce a mano) y su dirección. Los que dan a la peatonal son locales.
 */
function buildingContext(b, cx, cy, half, { quality }) {
    const S = cityState;
    const ctx = { zone: 'barrio', front: null, corner: false, quality };
    if (!S) return ctx;
    const near = S.query?.nearest(cx, cy, true); // sólo calles de verdad: los pasillos de playa no son frente
    if (near && near.dist < half + 45) {
        const prof = near.road ? roadProfile(near.road) : null;
        const edge = prof ? prof.carriageway / 2 + (prof.sidewalk || 0) : 7;
        ctx.front = { dirX: near.dirX, dirY: near.dirY, dist: near.dist, edge, cw: prof ? prof.carriageway : 8 };
        if (near.road?.pedestrian && near.dist < half + 14 && (b.kind === 'casa' || b.kind === 'comercio')) {
            ctx.mold = hash01(b.id | 0, 77) < 0.55 ? 'L1' : 'L3';
        }
    }
    if (S.inters) {
        let best = null, bd = half + 12;
        for (const i of S.inters.near(cx, cy)) {
            const it = S.intersections[i];
            const d = Math.hypot(it.x - cx, it.y - cy);
            if (d < bd) { bd = d; best = it; }
        }
        if (best) {
            ctx.corner = true;
            ctx.cornerDir = { dirX: (best.x - cx) / (bd || 1), dirY: (best.y - cy) / (bd || 1) };
        }
    }
    const dPlaza = S.center ? Math.hypot(cx - S.center[0], cy - S.center[1]) : Infinity;
    const bo = S.bounds;
    const sideDist = !bo ? Infinity : S.waterSide === 'east' ? bo.maxX - cx : S.waterSide === 'west' ? cx - bo.minX
        : S.waterSide === 'north' ? bo.maxY - cy : S.waterSide === 'south' ? cy - bo.minY : Infinity;
    if (dPlaza < 550) ctx.zone = 'centro';
    else if (sideDist < 200 || (near && near.dist < 45 && /costanera|ribere/i.test(near.road?.name ?? ''))) ctx.zone = 'costanera';
    return ctx;
}

const SIGN_COLORS = ['#ff4f6d', '#ffd23f', '#4fd1ff', '#7dff8a', '#ff9b3d'];
/** Cartel con el nombre del hotel en la azotea (se prende de noche: va en la malla 'signs'). */
function addHotelSign(mb, box, fx, fy, height, id) {
    const ux = -fy, uy = fx;
    const ext = Math.abs(box.u[0] * ux + box.u[1] * uy) * box.halfLong + Math.abs(box.v[0] * ux + box.v[1] * uy) * box.halfShort;
    const W = Math.min(14, Math.max(4, ext * 1.3));
    const z0 = height + 0.5;
    const cx = box.cx, cy = box.cy;
    const dark = hexToRgb('#1b2233');
    mb.box(cx, cy, [ux, uy], [fx, fy], W / 2, 0.15, z0 + 0.4, z0 + 2.6, dark, 0);
    for (const s of [-1, 1]) mb.box(cx + ux * s * (W / 2 - 0.4), cy + uy * s * (W / 2 - 0.4), [ux, uy], [fx, fy], 0.08, 0.08, height, z0 + 0.4, dark, 0);
    const col = hexToRgb(SIGN_COLORS[Math.floor(hash01(id | 0, 91) * SIGN_COLORS.length) % SIGN_COLORS.length]);
    mb.box(cx + fx * 0.17, cy + fy * 0.17, [ux, uy], [fx, fy], W / 2 - 0.45, 0.03, z0 + 0.85, z0 + 2.15, col, 0);
}

const CAR_COLORS = ['#e8e8e8', '#c9ccd1', '#2b2e33', '#9aa0a8', '#b3282d', '#2a4e8f', '#f0f0ea', '#6b6f75'];
/**
 * Playa de estacionamiento del supermercado: adelante (entre la fachada y la vereda) si hay lugar, si no a un costado
 * si no pisa otra propiedad ni la calle. Asfalto con cajones pintados y autos estacionados (≈55 %).
 */
function addParking(mb, cars, ring, cx, cy, ctx, overlaps, onRoad) {
    if (!ctx.front) return;
    // si OSM ya trae los pasillos de la playa (y de ahí salen cajones y autos) no se dibuja otro lote encima
    if (cityState?.query?.lotNear?.(cx, cy, 30)) return;
    const fx = ctx.front.dirX, fy = ctx.front.dirY, ux = -fy, uy = fx;
    let hf = 0, hb = 0, hu = 0;
    for (const [x, y] of ring) {
        const f = (x - cx) * fx + (y - cy) * fy, u = Math.abs((x - cx) * ux + (y - cy) * uy);
        if (f > hf) hf = f;
        if (-f > hb) hb = -f;
        if (u > hu) hu = u;
    }
    const tries = [];
    let placed = false;
    const gap = ctx.front.dist - hf - ctx.front.edge;
    if (gap >= 7.5) tries.push({ c: [cx + fx * (hf + Math.min(gap, 22) / 2), cy + fy * (hf + Math.min(gap, 22) / 2)], a: [fx, fy], A: Math.min(gap, 22) / 2 - 0.5, B: Math.min(hu, 22) });
    for (const s of [1, -1]) {
        const off = hu + 9;
        tries.push({ c: [cx + ux * s * off + fx * (hf - hb) / 2, cy + uy * s * off + fy * (hf - hb) / 2], a: [fx, fy], A: Math.min((hf + hb) / 2, 18), B: 8 });
    }
    for (const t of tries) {
        if (t.A < 2.6 || t.B < 2.6) continue;
        const bu = [-t.a[1], t.a[0]];
        const pt = (sa, sb) => [t.c[0] + t.a[0] * sa * t.A + bu[0] * sb * t.B, t.c[1] + t.a[1] * sa * t.A + bu[1] * sb * t.B];
        const corners = [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)];
        if (corners.some(([x, y]) => onRoad(x, y)) || onRoad(t.c[0], t.c[1]) || overlaps(corners)) continue;
        placed = true;
        mb.box(t.c[0], t.c[1], t.a, bu, t.A, t.B, 0, 0.05, hexToRgb('#55585d'), 0);
        // cajones: filas de 5 m de fondo a lo largo de `a`, cajones de 2,6 m a lo largo de `bu`
        const rows = t.A * 2 >= 11 ? 2 : 1;
        const white = hexToRgb('#e8e8e2');
        for (let r = 0; r < rows; r++) {
            const a0 = rows === 2 ? (r ? t.A - 2.6 : -t.A + 2.6) : 0;
            for (let sb = -t.B + 1.3, k = 0; sb <= t.B - 1.3; sb += 2.6, k++) {
                const [x, y] = [t.c[0] + t.a[0] * a0 + bu[0] * sb, t.c[1] + t.a[1] * a0 + bu[1] * sb];
                mb.box(x + bu[0] * 1.3, y + bu[1] * 1.3, t.a, bu, 2.4, 0.05, 0.05, 0.065, white, 0);
                const key = Math.round(x * 3) * 7919 + Math.round(y * 3);
                if (hash01(key, 61) < 0.55) {
                    const dir = (r ? -1 : 1) * (hash01(key, 62) < 0.85 ? 1 : -1);
                    cars.push(x, y, t.a[0] * dir, t.a[1] * dir, Math.floor(hash01(key, 63) * CAR_COLORS.length) % CAR_COLORS.length);
                }
            }
        }
        return;
    }
    // (sin lugar en el lote: no se inventan autos sobre la calzada; los de la cuadra los pone city-traffic junto al cordón)
}
export { CAR_COLORS };

// sRGB → lineal con tabla (4096 pasos: error < 0,0003). Con ~5 millones de componentes por armado, `** 2.4` costaba ~0,6 s.
const LIN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) { const c = i / 4095; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const toLinear = (c) => LIN[c <= 0 ? 0 : c >= 1 ? 4095 : (c * 4095 + 0.5) | 0];

/**
 * Constructor de mallas con arreglos tipados que crecen al doble (para paredes y 'plain' de los moldes): city-molds
 * escribe directo con addTri. Evita millones de `push` y la basura que generaban (~1,4 s de 2,7 s con 13.000 edificios).
 * Mismo formato que MeshBuilder (pos/nor/uv/col por vértice, owner por triángulo) y `vertexCount`.
 */
export class FastBuilder {
    constructor(verts = 3072) {
        this.fast = true;
        this.n = 0;
        this.alloc(verts);
    }
    alloc(verts) {
        const old = this.pos ? { pos: this.pos, nor: this.nor, uv: this.uv, col: this.col, owner: this.owner } : null;
        this.cap = verts;
        this.pos = new Float32Array(verts * 3);
        this.nor = new Float32Array(verts * 3);
        this.uv = new Float32Array(verts * 2);
        this.col = new Float32Array(verts * 3);
        this.owner = new Uint32Array(Math.ceil(verts / 3));
        if (old) {
            this.pos.set(old.pos); this.nor.set(old.nor); this.uv.set(old.uv); this.col.set(old.col); this.owner.set(old.owner);
        }
    }
    get vertexCount() { return this.n; }
    addTri(a, b, c, color, id, ua, ub, uc) {
        if (this.n + 3 > this.cap) this.alloc(this.cap * 2);
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const o = this.n * 3, P = this.pos, N = this.nor, C = this.col, U = this.uv, u = this.n * 2;
        P[o] = a[0]; P[o + 1] = a[1]; P[o + 2] = a[2];
        P[o + 3] = b[0]; P[o + 4] = b[1]; P[o + 5] = b[2];
        P[o + 6] = c[0]; P[o + 7] = c[1]; P[o + 8] = c[2];
        for (let k = 0; k < 9; k += 3) { N[o + k] = nx; N[o + k + 1] = ny; N[o + k + 2] = nz; C[o + k] = color[0]; C[o + k + 1] = color[1]; C[o + k + 2] = color[2]; }
        U[u] = ua[0]; U[u + 1] = ua[1]; U[u + 2] = ub[0]; U[u + 3] = ub[1]; U[u + 4] = uc[0]; U[u + 5] = uc[1];
        this.owner[this.n / 3] = id;
        this.n += 3;
    }
    tri(a, b, c, color, id, uvs = null) {
        const z = [0.02, 0.02];
        this.addTri(a, b, c, color, id, uvs ? uvs[0] : z, uvs ? uvs[1] : z, uvs ? uvs[2] : z);
    }
}

/** MeshBuilder -> arreglos tipados (colores linealizados). Actualiza `box` [minX, minY, minZ, maxX, maxY, maxZ]. */
export function serializeBuilder(b, { uv = false, owner = true } = {}, box = null) {
    const nv = b.vertexCount;
    const pos = b.fast ? b.pos.slice(0, nv * 3) : Float32Array.from(b.pos);
    const col = new Float32Array(nv * 3);
    for (let i = 0; i < col.length; i++) col[i] = toLinear(b.col[i]);
    if (box) {
        for (let i = 0; i < pos.length; i += 3) {
            if (pos[i] < box[0]) box[0] = pos[i];
            if (pos[i + 1] < box[1]) box[1] = pos[i + 1];
            if (pos[i + 2] < box[2]) box[2] = pos[i + 2];
            if (pos[i] > box[3]) box[3] = pos[i];
            if (pos[i + 1] > box[4]) box[4] = pos[i + 1];
            if (pos[i + 2] > box[5]) box[5] = pos[i + 2];
        }
    }
    const out = { pos, nor: b.fast ? b.nor.slice(0, nv * 3) : Float32Array.from(b.nor), col };
    if (uv) out.uv = b.fast ? b.uv.slice(0, nv * 2) : Float32Array.from(b.uv);
    if (owner) out.owner = b.fast ? b.owner.slice(0, nv / 3) : Uint32Array.from(b.owner);
    return out;
}

const transferables = (arrays) => Object.values(arrays).filter((a) => a?.buffer).map((a) => a.buffer);

// ------------------------------------------------------------------ versión simple (LOD) y sombra de contacto

/** Huella para la versión simple: el rectángulo orientado si el polígono es casi rectangular (casas), si no el polígono. */
function lodFootprint(ring, box) {
    if (ring.length <= 5) return ring;
    const boxArea = 4 * box.halfLong * box.halfShort;
    if (boxArea <= Math.abs(signedArea(ring)) * 1.3) return rectOf(box, 0);
    return ring;
}

function rectOf(box, grow) {
    const A = box.halfLong + grow, B = box.halfShort + grow;
    const at = (su, sv) => [box.cx + box.u[0] * su * A + box.v[0] * sv * B, box.cy + box.u[1] * su * A + box.v[1] * sv * B];
    return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]; // antihorario (u, v forman una base derecha)
}

/** Prisma de la huella con paredes de un color y la tapa del color del techo. Devuelve el rango de la tapa. */
export function addLodBuilding(lod, ring, height, wallRgb, roofRgb, id) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        lod.quad([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], height], [p[0], p[1], height], wallRgb, id);
    }
    const start = lod.vertexCount;
    if (n === 4) {
        lod.quad([ring[0][0], ring[0][1], height], [ring[1][0], ring[1][1], height], [ring[2][0], ring[2][1], height], [ring[3][0], ring[3][1], height], roofRgb, id);
    } else {
        const tris = ShapeUtils.triangulateShape(ring.map(([x, y]) => new Vector2(x, y)), []);
        for (let [a, b, c] of tris) {
            const cross = (ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) - (ring[b][1] - ring[a][1]) * (ring[c][0] - ring[a][0]);
            if (cross < 0) [b, c] = [c, b];
            lod.tri([ring[a][0], ring[a][1], height], [ring[b][0], ring[b][1], height], [ring[c][0], ring[c][1], height], roofRgb, id);
        }
    }
    return { start, count: lod.vertexCount - start };
}

const CONTACT_Z = 0.17;
const CONTACT_ALPHA = 0.32;

/** Sombra de contacto: un marco que se desvanece alrededor de la base (alfa por vértice: oscuro pegado a la pared). */
export function addContactShadow(target, box, height) {
    const m = Math.min(4, Math.max(1.2, 1.2 + height * 0.08));
    const inner = rectOf(box, -0.1);
    const outer = rectOf(box, m);
    for (let i = 0; i < 4; i++) {
        const a = inner[i], b = inner[(i + 1) % 4], c = outer[(i + 1) % 4], d = outer[i];
        for (const [p, alpha] of [[a, CONTACT_ALPHA], [b, CONTACT_ALPHA], [c, 0], [a, CONTACT_ALPHA], [c, 0], [d, 0]]) {
            target.pos.push(p[0], p[1], CONTACT_Z);
            target.col.push(0, 0, 0, alpha);
        }
    }
}

// ------------------------------------------------------------------ armado

function newChunk(i, j, styles) {
    return {
        i, j,
        walls: Object.fromEntries(styles.map((st) => [st, new FastBuilder(1536)])),
        plain: new FastBuilder(6144),
        signs: new MeshBuilder(),
        parking: new MeshBuilder(),
        lod: new MeshBuilder(),
        contact: { pos: [], col: [] },
        roofs: [],
        lodRoofs: [],
    };
}

/**
 * Arma todos los sectores. Devuelve { result, transfer } (transfer: buffers para pasar sin copiar al hilo principal).
 */
export function buildCityData(input) {
    const t0 = (globalThis.performance ?? Date).now();
    const { buildings: B, origin, chunkSize = CHUNK_SIZE, quality = 'media' } = input;
    const part = input.part ?? 0, parts = input.parts ?? 1;
    const preset = QUALITY[quality] ?? QUALITY.media;
    const { toLocal } = localProjection(origin);
    const kit = BUILDING_KIT;
    const roofOf = new Map(B.roofs ?? []);
    const chunks = new Map();
    const n = B.ids.length;
    let count = 0, retranqueadas = 0;

    // ---- huellas en metros locales (todas, también las ocultas: el suelo y la franja se arman alrededor de todas)
    const rings = new Array(n), allBoxes = [], centers = new Array(n);
    for (let k = 0; k < n; k++) {
        const ring = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sx = 0, sy = 0;
        for (let p = B.offsets[k]; p < B.offsets[k + 1]; p++) {
            const pt = toLocal(B.coords[p * 2], B.coords[p * 2 + 1]);
            ring.push(pt);
            if (pt[0] < minX) minX = pt[0];
            if (pt[0] > maxX) maxX = pt[0];
            if (pt[1] < minY) minY = pt[1];
            if (pt[1] > maxY) maxY = pt[1];
            sx += pt[0];
            sy += pt[1];
        }
        rings[k] = ring;
        centers[k] = ring.length ? [sx / ring.length, sy / ring.length, Math.hypot(maxX - minX, maxY - minY) / 2] : null;
        if (ring.length) allBoxes.push([minX, minY, maxX, maxY]);
    }
    const boxGrid = new Grid(40);
    allBoxes.forEach((bx, i) => boxGrid.addBox(bx[0], bx[1], bx[2], bx[3], i));

    // ¿esa caja pisa otra propiedad? (la usan el estacionamiento y el retranqueo)
    const overlapsOthers = (self) => (corners) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of corners) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        for (const i of boxGrid.near((x0 + x1) / 2, (y0 + y1) / 2)) {
            if (i === self) continue;
            const bx = allBoxes[i];
            if (bx[0] < x1 && bx[2] > x0 && bx[1] < y1 && bx[3] > y0) return true;
        }
        for (const [x, y] of corners) for (const i of boxGrid.near(x, y)) if (i !== self) { const bx = allBoxes[i]; if (x > bx[0] && x < bx[2] && y > bx[1] && y < bx[3]) return true; }
        return false;
    };
    // ---- primer armado: suelo, calles, franja, plazas, hitos (deja el estado para el contexto de los moldes)
    const transfer = [];
    let env = null;
    if (input.environment && allBoxes.length) {
        env = buildEnvironment(input, allBoxes, rings, toLocal, quality, overlapsOthers);
        transfer.push(...env.transfer);
    }
    const cars = [];
    for (const c of env?.pending?.cars ?? []) cars.push(c.x, c.y, c.dirX, c.dirY, Math.floor(hash01(c.key, 163) * CAR_COLORS.length) % CAR_COLORS.length);
    const defaults = [];
    const onRoad = (x, y) => !!cityState?.query?.onRoad(x, y, 0.5);

    for (let k = 0; k < n; k++) {
        let ring = rings[k];
        if (!B.visible[k] || ring.length < 3) continue;
        const id = B.ids[k];
        let [sxm, sym, half] = centers[k];
        const b = { id, kind: KINDS[B.kinds[k]] ?? 'casa', ring, area: B.areas[k], roofColor: roofOf.get(id) ?? undefined };
        const [ci, cj] = chunkCoord(sxm, sym, chunkSize);
        if (parts > 1 && (((ci + cj) % parts) + parts) % parts !== part) continue; // otra parte (otro worker) arma este sector
        const key = `${ci},${cj}`;
        let c = chunks.get(key);
        if (!c) chunks.set(key, (c = newChunk(ci, cj, kit.styles)));

        // ---- retranqueo: si la huella pisa la calzada, un cruce o un pasillo de playa se la recorta contra la calle (o se la
        // reduce a una caja chica fuera del asfalto). La propiedad no se borra: conserva id, picking y color.
        const adj = cityState?.adjusted?.get(id);
        if (adj) {
            ring = adj;
            b.ring = ring;
            let sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const [x, y] of ring) { sx += x; sy += y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
            sxm = sx / ring.length; sym = sy / ring.length; half = Math.hypot(x1 - x0, y1 - y0) / 2;
            retranqueadas++;
        }

        // ---- detalle: molde según zona, frente y esquina (el mismo ctx para molde, techo y altura)
        const ctx = buildingContext(b, sxm, sym, half, { quality });
        ctx.mold = ctx.mold ?? chooseMold(b, ctx);
        const before = kit.styles.map((st) => c.walls[st].vertexCount);
        const plainBefore = c.plain.vertexCount;
        const range = kit.addBuilding(b, { walls: c.walls, plain: c.plain }, ctx);
        if (!range) continue;
        count++;
        c.roofs.push(id, range.start, range.count);
        const defHex = kit === BUILDING_KIT ? defaultRoofColor(b, ctx.mold) : kit.defaultRoof(b);
        defaults.push([id, defHex]);
        if (kit === BUILDING_KIT && b.kind === 'hotel') {
            const box0 = orientedBox(normalizeRing(ring));
            const fx = ctx.front?.dirX ?? box0.v[0], fy = ctx.front?.dirY ?? box0.v[1];
            addHotelSign(c.signs, box0, fx, fy, moldHeight(b, ctx.mold), id);
        }
        if (kit === BUILDING_KIT && b.kind === 'supermercado' && cityState) {
            addParking(c.parking, cars, normalizeRing(ring), sxm, sym, ctx, overlapsOthers(k), onRoad);
        }

        // ---- color promedio de las paredes y alturas (sirve para cualquier molde)
        let r = 0, g = 0, bl = 0, nv = 0, wallTop = 0, top = 0;
        kit.styles.forEach((st, si) => {
            const mb = c.walls[st];
            for (let v = before[si]; v < mb.vertexCount; v++) {
                r += mb.col[v * 3]; g += mb.col[v * 3 + 1]; bl += mb.col[v * 3 + 2];
                if (mb.pos[v * 3 + 2] > wallTop) wallTop = mb.pos[v * 3 + 2];
                nv++;
            }
        });
        for (let v = plainBefore; v < c.plain.vertexCount; v++) {
            if (c.plain.pos[v * 3 + 2] > top) top = c.plain.pos[v * 3 + 2];
        }
        if (!nv) wallTop = top;
        const wallRgb = nv ? [(r / nv) * 0.92, (g / nv) * 0.92, (bl / nv) * 0.92] : [0.8, 0.8, 0.8];
        const height = top > wallTop + 0.5 ? wallTop + (top - wallTop) * 0.4 : Math.max(wallTop, top, 2);

        // ---- versión simple y sombra de contacto
        const norm = normalizeRing(ring);
        const box = orientedBox(norm);
        const roofRgb = hexToRgb(b.roofColor ?? defHex);
        const lr = addLodBuilding(c.lod, lodFootprint(norm, box), height, wallRgb, roofRgb, id);
        c.lodRoofs.push(id, lr.start, lr.count);
        if (preset.contactShadows !== false) addContactShadow(c.contact, box, height);
    }

    // ---- sectores -> arreglos tipados
    const outChunks = [];
    for (const c of chunks.values()) {
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        const meshes = [];
        for (const st of kit.styles) {
            if (c.walls[st].vertexCount) meshes.push({ kind: 'walls', style: st, arrays: serializeBuilder(c.walls[st], { uv: true }, box) });
        }
        if (c.plain.vertexCount) meshes.push({ kind: 'plain', arrays: serializeBuilder(c.plain, {}, box) });
        if (c.signs.vertexCount) meshes.push({ kind: 'signs', arrays: serializeBuilder(c.signs, { owner: false }, box) });
        if (c.parking.vertexCount) meshes.push({ kind: 'parking', arrays: serializeBuilder(c.parking, { owner: false }, box) });
        if (c.lod.vertexCount) meshes.push({ kind: 'lod', arrays: serializeBuilder(c.lod, {}) });
        if (c.contact.pos.length) {
            meshes.push({ kind: 'contact', arrays: { pos: Float32Array.from(c.contact.pos), col: Float32Array.from(c.contact.col) } });
        }
        if (!meshes.length || !Number.isFinite(box[0])) continue;
        for (const m of meshes) transfer.push(...transferables(m.arrays));
        const cx = (box[0] + box[3]) / 2, cy = (box[1] + box[4]) / 2, cz = (box[2] + box[5]) / 2;
        const radius = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2 + 4.5; // + margen de la sombra de contacto
        const roofs = Float64Array.from(c.roofs);
        const lodRoofs = Float64Array.from(c.lodRoofs);
        transfer.push(roofs.buffer, lodRoofs.buffer);
        outChunks.push({ i: c.i, j: c.j, sphere: [cx, cy, cz, radius], meshes, roofs, lodRoofs });
    }

    // ---- árboles y faroles (PUNTO DE INTEGRACIÓN: city-roads furniture / city-trees placeYardTrees)
    let furniture = null;
    if (input.furniture && input.roads && !input.roadFeatures) { // servidor sin calles completas: faroles y árboles viejos
        const R = input.roads;
        const roads = [];
        for (let k = 0; k + 1 < R.offsets.length; k++) {
            const coords = [];
            for (let p = R.offsets[k]; p < R.offsets[k + 1]; p++) coords.push(toLocal(R.coords[p * 2], R.coords[p * 2 + 1]));
            roads.push({ coords, major: /primary|secondary|trunk|motorway/.test(R.highway[k] ?? '') });
        }
        const { trees, lamps } = placeStreetFurniture(roads, allBoxes, { maxTrees: preset.maxTrees });
        const t = new Float32Array(trees.length * 4);
        trees.forEach((tr, i) => t.set([tr.x, tr.y, tr.s, tr.c], i * 4));
        const l = new Float32Array(lamps.length * 2);
        lamps.forEach((lp, i) => l.set([lp.x, lp.y], i * 2));
        furniture = { trees: t, lamps: l };
        transfer.push(t.buffer, l.buffer);
    }

    // ---- capas extra: layers[nombre] = serializeBuilder(builder, …); city3d.js las convierte en mallas de esa capa.
    //      (PUNTO DE INTEGRACIÓN pendiente: city-roads buildRoadNetwork / plaza / hitos)
    const layers = env && input.layersWanted !== false ? env.layers : {};
    if (env && input.layersWanted !== false && !layers.error && cityState?.query) {
        // árboles de patio (detrás de las casas, nunca sobre calles ni edificios) + vereda + franja
        const yard = placeYardTrees(allBoxes, cityState.query, { max: quality === 'baja' ? 1200 : quality === 'alta' ? 5000 : 3000 });
        const list = [...env.pending.trees, ...yard];
        const a = new Float32Array(list.length * 4);
        list.forEach((t, i) => a.set([t.x, t.y, Math.max(0, TREE_CONTEXTS.indexOf(t.context)), t.species ? SPECIES_KEYS.indexOf(t.species) : -1], i * 4));
        layers.trees = a;
        transfer.push(a.buffer);
        layers.info = { ...(layers.info ?? {}), yardTrees: yard.length };
    }
    const carArr = Float32Array.from(cars);
    transfer.push(carArr.buffer);

    const ms = (globalThis.performance ?? Date).now() - t0;
    return { result: { seq: input.seq, part, ms, buildings: count, retranqueadas, chunks: outChunks, furniture, layers, defaults, cars: carArr }, transfer };
}

// Suelo hasta 3,5 km afuera del barrio y alrededores (quintas, campos) en los primeros 2,5 km: con la cámara lejos
// (zoom 14,5, 75°) el ojo queda a ~3 km del borde y el suelo de abajo de la pantalla tiene que existir.
export const ENV_MARGIN = 3500;
export const RING_WIDTH = 1900; // con la bruma del borde (hasta 1,4 km) más allá no se ve: armar menos campo
/** Contextos de árboles (índice en los arreglos que van al hilo principal). */
export const TREE_CONTEXTS = ['vereda', 'cantero', 'peatonal', 'patio', 'plaza', 'costanera', 'campo'];
export const LAMP_KINDS = ['calle', 'avenida', 'plaza'];
/** Última red de calles armada (la usan los rearmados: frente de los edificios, etc.). */
let lastNetwork = null;
export const currentNetwork = () => lastNetwork;

/** Distancia de un punto al borde de un anillo. */
function distToEdge(x, y, ring) {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y));
    }
    return best;
}

/**
 * Plaza menos tupida (que se vean los caminos, el césped y la explanada): sin árboles en la explanada del monumento
 * ni junto a las fuentes; las palmeras de los caminos (pindó) se quedan; el resto, casi todos sobre el perímetro y
 * pocos adentro (≈ la mitad del total).
 */
export function thinPlazaTrees(P, ring) {
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length || 1; cy /= ring.length || 1;
    const mon = P.monument;
    let ex = 1, ey = 0;
    if (mon) {
        const l = Math.hypot(mon.x - cx, mon.y - cy) || 1;
        ex = (mon.x - cx) / l; ey = (mon.y - cy) / l;
    }
    return P.trees.filter((t) => {
        if (mon) {
            const e = (t.x - mon.x) * ex + (t.y - mon.y) * ey, n = Math.abs(-(t.x - mon.x) * ey + (t.y - mon.y) * ex);
            if (e > -38 && e < 9 && n < 19) return false;
        }
        for (const f of P.fountains ?? []) if (Math.hypot(t.x - f.x, t.y - f.y) < f.r + 6) return false;
        if (t.species === 'T7' || t.palm) return true;
        const key = Math.round(t.x * 2) * 7919 + Math.round(t.y * 2);
        const [edge, inner] = P.kind === 'P1' ? [0.8, 0.3] : [0.95, 0.6]; // las genéricas ya son ralas
        return hash01(key, 71) < (distToEdge(t.x, t.y, ring) < 12 ? edge : inner);
    });
}

/** Caja del barrio (metros locales) a partir de las cajas de todas las propiedades. */
export function boundsOfBoxes(boxes) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [x0, y0, x1, y1] of boxes) {
        if (x0 < b.minX) b.minX = x0;
        if (y0 < b.minY) b.minY = y0;
        if (x1 > b.maxX) b.maxX = x1;
        if (y1 > b.maxY) b.maxY = y1;
    }
    return b;
}

/**
 * Suelo (pasto con manchas, tierra, parques, agua con su orilla) y alrededores (quintas, campos, casas bajas, caminos
 * de tierra que siguen las calles cortadas) con city-env. Si algo falla, la ciudad se arma igual sin entorno.
 */
function buildEnvironment(input, allBoxes, rings, toLocal, quality, overlapsOthers = null) {
    const layers = {}, transfer = [];
    const pending = { trees: [] };
    const bounds = boundsOfBoxes(allBoxes);
    const lngLat = (c) => toLocal(c[0], c[1]);
    const features = Array.isArray(input.environment) ? input.environment : [];
    const now = () => (globalThis.performance ?? Date).now();
    const ms = {};
    const wanted = input.layersWanted !== false; // la parte 1 solo necesita las calles (contexto de los moldes)
    const put = (name, builder) => {
        if (!wanted || !builder?.vertexCount) return;
        layers[name] = serializeBuilder(builder, { owner: false });
        transfer.push(...transferables(layers[name]));
    };
    const flat = (name, list, fields) => {
        if (!wanted) return;
        const a = new Float32Array(list.length * fields.length);
        list.forEach((o, i) => fields.forEach((f, k) => { a[i * fields.length + k] = typeof f === 'function' ? f(o) : o[f]; }));
        layers[name] = a;
        transfer.push(a.buffer);
    };
    try {
        let t = now();
        const g = buildGround(bounds, features, lngLat, null, { quality, margin: ENV_MARGIN });
        ms.ground = Math.round(now() - t);
        const waterIdx = g.waterRings?.length ? new PolyIndex(g.waterRings.map((r) => [r]), 60) : null;
        const side = g.waterSide;
        const blocked = (x, y) => (side === 'east' && x > bounds.maxX + 5) || (side === 'west' && x < bounds.minX - 5)
            || (side === 'north' && y > bounds.maxY + 5) || (side === 'south' && y < bounds.minY - 5)
            || (waterIdx ? waterIdx.contains(x, y) >= 0 : false);

        // ---- calles: reales (recortadas a barrio + franja) y las nuevas de la franja
        t = now();
        let roads = [];
        if (Array.isArray(input.roadFeatures)) roads = normalizeRoads(input.roadFeatures, lngLat);
        else if (input.roads) {
            const R = input.roads, feats = [];
            for (let k = 0; k + 1 < R.offsets.length; k++) {
                const coordinates = [];
                for (let p = R.offsets[k]; p < R.offsets[k + 1]; p++) coordinates.push([R.coords[p * 2], R.coords[p * 2 + 1]]);
                feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { highway: R.highway[k] || 'residential' } });
            }
            roads = normalizeRoads(feats, lngLat);
        }
        const peri = periurbanStreets(bounds, roads, { band: BAND, blocked });
        const allRoads = peri.roads;
        let net = null;
        const landmarkDiscs = [];
        if (input.roadFeatures && allRoads.length) {
            const pts = (kind) => features.filter((f) => f?.properties?.kind === kind && f.geometry?.type === 'Point').map((f) => lngLat(f.geometry.coordinates));
            const plaza = features.find((f) => f?.properties?.kind === 'plaza' && /san mart[ií]n/i.test(f.properties.name ?? '') && f.geometry?.type === 'Polygon');
            let center = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
            if (plaza) {
                const ring = plaza.geometry.coordinates[0].map(lngLat);
                center = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
            }
            // edificios reales: ahí no se pavimenta la playa de estacionamiento
            const propIdx = new PolyIndex(rings.filter((r) => r.length >= 3).map((r) => [r]), 40);
            net = buildRoadNetwork(allRoads, { signals: pts('signal'), busStops: pts('bus_stop'), quality, center, centerRadius: 700, lotBlocked: (x, y) => propIdx.contains(x, y) >= 0 });
            lastNetwork = net;
            const inters = new Grid(40);
            net.intersections.forEach((it, i) => { if (it.degree >= 3) inters.addBox(it.x - 50, it.y - 50, it.x + 50, it.y + 50, i); });
            cityState = { query: net.query, intersections: net.intersections, inters, center, bounds, waterSide: side, adjusted: new Map() };
            // retranqueo: huellas que pisan calzada, cruce o pasillo de playa → recortadas contra la calle (o caja chica afuera).
            // Se calcula una vez por armado de calles (las dos partes tienen el mismo resultado) y lo usan moldes, relleno y árboles.
            {
                const ids = input.buildings?.ids;
                for (let k = 0; k < rings.length && ids; k++) {
                    if (!rings[k] || rings[k].length < 3) continue;
                    const fp = setbackFootprint(rings[k], net.query, { overlaps: overlapsOthers ? overlapsOthers(k) : null });
                    if (fp.status === 'recortada' || fp.status === 'caja') cityState.adjusted.set(ids[k], fp.ring);
                }
            }
            if (!wanted) return { layers, transfer, pending }; // parte 1: con el contexto alcanza
            put('roadsGround', net.builders.ground);
            put('roadsMarkings', net.builders.markings);
            const F = net.furniture;
            pending.cars = F.lotCars ?? []; // autos de las playas de OSM (pasillos con cajones)
            const lamps = [...F.lamps], benches = [...F.benches], planters = [], bins = [];
            pending.trees.push(...F.streetTrees);
            // peatonal: en la línea del medio, maceteros con arbolito, bancos espalda con espalda, cestos y faroles bajos
            for (const r of allRoads) {
                if (!r.pedestrian || r.highway === 'footway' || r.highway === 'path') continue;
                const c = r.coords;
                let total = 0;
                for (let i = 0; i + 1 < c.length; i++) total += Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
                let acc = 0, k = 0;
                for (let i = 0; i + 1 < c.length; i++) {
                    const a = c[i], e = c[i + 1];
                    const L = Math.hypot(e[0] - a[0], e[1] - a[1]);
                    if (L < 1) continue;
                    const ux = (e[0] - a[0]) / L, uy = (e[1] - a[1]) / L;
                    for (let s0 = Math.ceil(acc / 7) * 7 - acc; s0 < L; s0 += 7) {
                        const along = acc + s0;
                        if (along < 13 || along > total - 13) continue;
                        const x = a[0] + ux * s0, y = a[1] + uy * s0;
                        const slot = k++ % 4;
                        if (slot === 0) { planters.push({ x, y, dirX: ux, dirY: uy }); pending.trees.push({ x, y, context: 'peatonal' }); }
                        else if (slot === 1) { benches.push({ x: x - uy * 0.45, y: y + ux * 0.45, dirX: -uy, dirY: ux }); benches.push({ x: x + uy * 0.45, y: y - ux * 0.45, dirX: uy, dirY: -ux }); bins.push({ x: x + ux * 1.6, y: y + uy * 1.6, dirX: ux, dirY: uy }); }
                        else if (slot === 2) lamps.push({ x, y, dirX: ux, dirY: uy, kind: 'plaza' });
                        else { planters.push({ x, y, dirX: ux, dirY: uy }); pending.trees.push({ x, y, context: 'peatonal' }); bins.push({ x: x + ux * 1.4, y: y + uy * 1.4, dirX: ux, dirY: uy }); }
                    }
                    acc += L;
                }
            }
            // plazas (P1 San Martín, P2 genéricas): paseo, monumento, fuentes, árboles y faroles
            const plazaArrays = [];
            for (const pl of g.plazas ?? []) {
                const P = buildPlaza(pl, { quality, query: net.query });
                const one = {};
                for (const part of ['ground', 'plain', 'water']) {
                    if (P.builders[part]?.vertexCount) {
                        one[part] = serializeBuilder(P.builders[part], { owner: false });
                        transfer.push(...transferables(one[part]));
                    }
                }
                plazaArrays.push({ kind: P.kind, name: pl.name ?? null, ...one });
                pending.trees.push(...thinPlazaTrees(P, pl.ring).map((t) => ({ ...t, context: 'plaza' })));
                for (const l of P.lamps) lamps.push({ x: l.x, y: l.y, dirX: 1, dirY: 0, kind: 'plaza' });
                for (const f of P.fountains ?? []) layers.fountains = [...(layers.fountains ?? []), [f.x, f.y, f.r, f.z ?? 0]];
            }
            layers.plazas = plazaArrays;
            // edificios emblemáticos (catedral, casa de gobierno, estación…): sin malla si hay una propiedad encima
            const lmFeatures = features.filter((f) => f?.properties?.kind === 'landmark');
            if (lmFeatures.length) {
                // ni sobre una calle: los hitos vienen de coordenadas aproximadas y con las calles reales a veces la
                // huella cae arriba de una avenida (se revisa una grilla de 4×4 puntos de la huella)
                const onStreet = (x, y, kind, fr) => {
                    if (!net?.query || !fr) return false;
                    const { ux, uy, A, B } = fr;
                    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                        const s = (i / 3 - 0.5) * 2 * A * 0.9, t = (j / 3 - 0.5) * 2 * B * 0.9;
                        if (net.query.onRoad(x + ux * s - uy * t, y + uy * s + ux * t, 0)) return true;
                    }
                    return false;
                };
                const lm = buildLandmarks(lmFeatures, lngLat, { propertyRings: rings.filter((r) => r.length >= 3), covered: onStreet });
                put('landmarks', lm.builders.plain);
                layers.landmarkList = lm.list;
                for (const it of lm.list ?? []) landmarkDiscs.push([it.x, it.y, Math.max(16, (it.height ?? 10) * 1.2)]);
            }
            flat('lamps', lamps, ['x', 'y', 'dirX', 'dirY', (o) => Math.max(0, LAMP_KINDS.indexOf(o.kind))]);
            flat('signals', F.signals, ['x', 'y', 'dirX', 'dirY']);
            flat('busStops', F.busStops, ['x', 'y', 'dirX', 'dirY']);
            flat('benches', benches, ['x', 'y', 'dirX', 'dirY']);
            flat('planters', planters, ['x', 'y', 'dirX', 'dirY']);
            flat('bins', bins, ['x', 'y', 'dirX', 'dirY']);
            flat('signs', F.signs, ['x', 'y']);
            layers.info = { ways: allRoads.length, added: peri.added.length, intersections: net.intersections.length, lanes: net.laneGraph.lanes.length };
            // grafo de carriles para el tránsito (city-traffic, en el hilo principal): solo datos, sin funciones
            const LG = net.laneGraph;
            layers.laneGraph = {
                nodes: LG.nodes.map((n) => ({ x: n.x, y: n.y, signal: !!n.signal })),
                lanes: LG.lanes.map((l) => ({ from: l.from, to: l.to, pts: l.pts, len: l.len, speed: l.speed, major: !!l.major, bus: !!l.bus, width: l.width, park: l.park ?? 0, t0: l.t0 ?? 0, t1: l.t1 ?? 0, stop: l.stop ?? 0, stops: l.stops ?? null })),
                out: LG.out,
            };
        }
        ms.roads = Math.round(now() - t);

        // ---- franja periurbana: casas, despensas, galpones, árboles de patio
        t = now();
        const houses = periurbanBuildings(bounds, allRoads, net?.query ?? null, { band: BAND, blocked, quality });
        put('periBuildings', houses.builders.buildings);
        pending.trees.push(...houses.trees);
        layers.info = { ...(layers.info ?? {}), houses: houses.houses, shops: houses.shops, sheds: houses.sheds };
        ms.peri = Math.round(now() - t);

        // ---- relleno interior del damero: casas+árboles de decorado en los huecos de las manzanas (no pisa nada real)
        t = now();
        if (net?.query) {
            const ids = input.buildings?.ids;
            const keepOut = [
                ...rings.map((r, k) => cityState.adjusted.get(ids?.[k]) ?? r).filter((r) => r.length >= 3),
                ...(g.parks ?? []),
                ...(g.plazas ?? []).map((p) => p.ring),
                ...(g.pitches ?? []),
                ...(g.playgrounds ?? []),
                ...(g.waterRings ?? []),
            ];
            const infill = buildBlockInfill(bounds, allRoads, net.query, { keepOut, discs: landmarkDiscs, blocked, quality });
            put('infillBuildings', infill.builders.buildings);
            pending.trees.push(...infill.trees);
            layers.info = { ...(layers.info ?? {}), infill: infill.houses };
        }
        ms.infill = Math.round(now() - t);

        // ---- alrededores (afuera de la franja)
        t = now();
        const ring = buildOuterRing(peri.outer, allRoads, { quality, waterSide: g.waterSide, water: g.waterRings, width: RING_WIDTH - BAND });
        ms.ring = Math.round(now() - t);
        put('ground', g.builders.ground);
        put('water', g.builders.water);
        put('ringGround', ring.builders.ground);
        put('ringBuildings', ring.builders.buildings);
        flat('campo', ring.trees, ['x', 'y']);
        layers.bounds = bounds;
        layers.waterSide = g.waterSide;
        layers.ms = ms;
    } catch (err) {
        layers.error = String(err?.stack ?? err);
    }
    return { layers, transfer, pending };
}

// Dentro de un worker: atiende pedidos de armado.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    globalThis.onmessage = (e) => {
        try {
            const { result, transfer } = buildCityData(e.data);
            globalThis.postMessage(result, transfer);
        } catch (err) {
            globalThis.postMessage({ seq: e.data?.seq, error: String(err?.stack ?? err) });
        }
    };
}
