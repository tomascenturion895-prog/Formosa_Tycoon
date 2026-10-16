// Borde de la ciudad 3D: una franja periurbana (~350 m) entre el barrio del juego y el campo, para que la ciudad no
// termine en un corte. Las calles que llegan al borde siguen (primero asfaltadas, después de tierra), aparecen
// calles transversales cada vez más ralas, y sobre ellas casas bajas con patio y árboles, alguna despensa de esquina
// y algún galpón, cada vez más espaciadas. Más afuera siguen las quintas y los campos (city-env buildOuterRing).
// Puro (sin DOM ni WebGL): arma calles como features (para city-roads) y triángulos en MeshBuilder.
import { MeshBuilder, hash01, hexToRgb, PALETTE } from './city-geometry.js';
import { normalizeRoads, roadProfile } from './city-roads.js';
import { addHouse } from './city-env.js';

export const BAND = 350;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const posKey = (x, y) => (Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(y) | 0, 19349663)) | 0;
const RGB = new Map();
const rgb = (hex) => {
    let c = RGB.get(hex);
    if (!c) RGB.set(hex, (c = hexToRgb(hex)));
    return c;
};

/** Distancia de un punto afuera de la caja (0 adentro). */
export function distOutside(b, x, y) {
    const dx = Math.max(b.minX - x, 0, x - b.maxX), dy = Math.max(b.minY - y, 0, y - b.maxY);
    return Math.hypot(dx, dy);
}

export function grow(b, d) {
    return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

/** Recorta una polilínea a una caja (Liang–Barsky por segmento). Devuelve los pedazos adentro. */
export function clipPolyline(coords, box) {
    const out = [];
    let cur = null;
    const inside = (p) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
    for (let i = 0; i + 1 < coords.length; i++) {
        const a = coords[i], b = coords[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        let t0 = 0, t1 = 1, ok = true;
        for (const [p, q] of [[-dx, a[0] - box.minX], [dx, box.maxX - a[0]], [-dy, a[1] - box.minY], [dy, box.maxY - a[1]]]) {
            if (p === 0) { if (q < 0) { ok = false; break; } continue; }
            const r = q / p;
            if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
        }
        if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
        const A = [a[0] + dx * t0, a[1] + dy * t0], B = [a[0] + dx * t1, a[1] + dy * t1];
        if (!cur) cur = [A];
        else if (Math.hypot(cur.at(-1)[0] - A[0], cur.at(-1)[1] - A[1]) > 0.01) { out.push(cur); cur = [A]; }
        cur.push(B);
        if (t1 < 1 || !inside(b)) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out.filter((c) => c.length >= 2 && Math.hypot(c.at(-1)[0] - c[0][0], c.at(-1)[1] - c[0][1]) > 2);
}

/**
 * Calles de la franja: recorta las calles reales a la caja barrio+franja, prolonga las que el borde corta y agrega
 * transversales entre prolongaciones vecinas (más ralas cuanto más lejos).
 *
 * @param bounds     caja del barrio (metros locales)
 * @param roads      Road[] (normalizeRoads, coords locales)
 * @param opts.blocked (x,y) => true donde no puede ir nada (agua, lado del río)
 * @returns { roads: Road[] (reales recortadas + nuevas), added: Road[] (solo las nuevas), outer: caja barrio+franja }
 */
export function periurbanStreets(bounds, roads, { band = BAND, blocked = () => false, seed = 1 } = {}) {
    const outer = grow(bounds, band);
    const kept = [];
    for (const r of roads ?? []) {
        const pieces = clipPolyline(r.coords, outer);
        if (pieces.length === 1 && pieces[0].length === r.coords.length) { kept.push(r); continue; }
        pieces.forEach((coords, k) => kept.push({ ...r, coords, id: r.id * 8 + k + 1 }));
    }
    const feats = [];
    let fid = 0;
    const H = (n, s) => hash01((Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed, 0x165667b1)) | 0, s);
    const addStreet = (coords, paved, name = null) => {
        fid++;
        feats.push({
            type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
            properties: { highway: 'residential', name, surface: paved ? 'asphalt' : 'dirt', osm_id: 9e12 + fid },
        });
    };
    // ---- prolongaciones de las calles que llegan al borde
    const conts = [];
    const seen = new Set();
    const sides = (p) => [
        { d: bounds.maxX - p[0], nx: 1, ny: 0, side: 'e' }, { d: p[0] - bounds.minX, nx: -1, ny: 0, side: 'o' },
        { d: bounds.maxY - p[1], nx: 0, ny: 1, side: 'n' }, { d: p[1] - bounds.minY, nx: 0, ny: -1, side: 's' },
    ];
    kept.forEach((r, ri) => {
        const c = r.coords;
        if (r.pedestrian || r.service) return;
        for (const end of [0, 1]) {
            const p = end ? c.at(-1) : c[0];
            if (distOutside(bounds, p[0], p[1]) > 60) continue;
            let k = end ? c.length - 2 : 1, prev = c[k];
            while (Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 15) {
                const nk = end ? k - 1 : k + 1;
                if (nk < 0 || nk >= c.length) break;
                k = nk; prev = c[k];
            }
            const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            if (len < 1) continue;
            const dx = (p[0] - prev[0]) / len, dy = (p[1] - prev[1]) / len;
            let best = null;
            for (const s of sides(p)) {
                const dot = dx * s.nx + dy * s.ny;
                if (s.d > 60 || s.d < -60 || dot < 0.7) continue;
                if (!best || s.d < best.d) best = { ...s, dot };
            }
            if (!best) continue;
            const key = `${Math.round(p[0] / 10)},${Math.round(p[1] / 10)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // cuánto falta hasta el borde de afuera de la franja
            const out0 = -best.d; // distancia afuera del barrio (negativa si está adentro)
            const L = (band - out0) / best.dot;
            let ok = 0;
            for (let d = 10; d <= L; d += 10) {
                if (blocked(p[0] + dx * d, p[1] + dy * d)) break;
                ok = d;
            }
            if (ok < 40) continue;
            const paved = clamp(110 + H(ri * 2 + end, 1) * 80 - out0, 0, ok);
            const at = (d) => [p[0] + dx * d, p[1] + dy * d];
            if (paved > 10) addStreet([[p[0], p[1]], at(paved)], true, r.name ?? null);
            if (ok - paved > 10) addStreet([paved > 10 ? at(paved) : [p[0], p[1]], at(ok)], false, r.name ?? null);
            conts.push({ p, dx, dy, dot: best.dot, out0, len: ok, side: best.side, along: best.nx ? p[1] : p[0], major: !!r.major });
        }
    });
    // ---- transversales entre prolongaciones vecinas del mismo lado, a 100/210/320 m del borde
    for (const side of ['n', 's', 'e', 'o']) {
        const list = conts.filter((c) => c.side === side).sort((a, b) => a.along - b.along);
        for (let i = 0; i + 1 < list.length; i++) {
            const A = list[i], B = list[i + 1];
            const gap = Math.abs(B.along - A.along);
            if (gap < 50 || gap > 260) continue;
            [100, 210, 320].forEach((D, k) => {
                if (D > band - 15) return;
                const keep = [0.9, 0.6, 0.3][k];
                if (H(posKey(A.p[0], A.p[1]) + k * 7919, 3) > keep) return;
                const da = (D - A.out0) / A.dot, db = (D - B.out0) / B.dot;
                if (da < 20 || db < 20 || da > A.len || db > B.len) return;
                const a = [A.p[0] + A.dx * da, A.p[1] + A.dy * da], b = [B.p[0] + B.dx * db, B.p[1] + B.dy * db];
                const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                if (blocked(mid[0], mid[1])) return;
                addStreet([a, b], D < 140);
            });
        }
    }
    const added = normalizeRoads(feats, (c) => c);
    return { roads: [...kept, ...added], added, outer };
}

const SHOP_WALLS = ['#f2e6c4', '#e8eef0', '#f4dcc2'];
const AWNINGS = ['#d9573f', '#2f7fbf', '#3f9a5a', '#e2a33a'];
const ZINC = '#aeb3b5';

/**
 * Casas de la franja sobre las calles que pasan por ella (reales y nuevas): lotes a los dos lados, cada vez más
 * espaciados hacia afuera; patio con árbol atrás; alguna despensa en las esquinas cercanas y algún galpón lejos.
 *
 * @param query  query de city-roads (onRoad) para no pisar calles ni veredas
 * @returns { builders:{buildings}, trees:[{x,y,context:'patio'}], houses, shops, sheds }
 */
export function periurbanBuildings(bounds, roads, query, { band = BAND, blocked = () => false, quality = 'media', seed = 1 } = {}) {
    const b = new MeshBuilder();
    const trees = [];
    const q = quality === 'baja' ? 0.6 : quality === 'alta' ? 1.15 : 1;
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
    let houses = 0, shops = 0, sheds = 0;
    roads.forEach((r, ri) => {
        if (r.pedestrian || r.service) return;
        const prof = roadProfile(r);
        const edge = prof.carriageway / 2 + (prof.sidewalk || 0) + 1.5;
        const c = r.coords;
        let s0 = 0;
        for (let i = 0; i + 1 < c.length; i++) {
            const a = c[i], e = c[i + 1];
            const L = Math.hypot(e[0] - a[0], e[1] - a[1]);
            if (L < 8) { s0 += L; continue; }
            const ux = (e[0] - a[0]) / L, uy = (e[1] - a[1]) / L;
            for (const side of [1, -1]) {
                const nx = -uy * side, ny = ux * side;
                let s = 6 + hash01(ri * 31 + i * 7 + (side > 0 ? 1 : 0), 41 + seed) * 6;
                while (s < L - 6) {
                    const k = posKey(a[0] + ux * s + nx * 10, a[1] + uy * s + ny * 10) ^ seed;
                    const A = 3.2 + hash01(k, 1) * 1.8; // medio frente
                    const lot = A * 2 + 3 + hash01(k, 2) * 5;
                    const px = a[0] + ux * s, py = a[1] + uy * s;
                    const d = distOutside(bounds, px, py);
                    s += lot;
                    if (d < 8 || d > band) continue;
                    // densidad: casi llena al lado del barrio, rala hacia el campo
                    const t = d / band;
                    const dens = (0.92 * (1 - t) ** 1.4 + 0.06) * q;
                    if (hash01(k, 3) > dens) continue;
                    const shed = d > 120 && hash01(k, 4) < 0.05;
                    const nearEnd = s0 + s - lot < s0 + 20 || s > L - 18;
                    const shop = !shed && nearEnd && d < 220 && hash01(k, 5) < 0.3;
                    const hA = shed ? 6 + hash01(k, 6) * 4 : shop ? A + 0.4 : A;
                    const hB = shed ? 5 + hash01(k, 7) * 3 : 4 + hash01(k, 7) * 2.5;
                    const setback = shop ? 0 : 1.5 + hash01(k, 8) * (2 + t * 6);
                    const off = edge + setback + hB;
                    const cx = px + nx * off, cy = py + ny * off;
                    const R = Math.hypot(hA, hB);
                    if (distOutside(bounds, cx, cy) < R + 2 || blocked(cx, cy)) continue;
                    if (!free(cx, cy, R)) continue;
                    let onRoad = false;
                    for (const [fu, fv] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
                        const x = cx + ux * fu * hA + nx * fv * hB, y = cy + uy * fu * hA + ny * fv * hB;
                        if (query?.onRoad(x, y, 1)) { onRoad = true; break; }
                    }
                    if (onRoad) continue;
                    take(cx, cy, R);
                    if (shed) {
                        addHouse(b, cx, cy, ux, uy, hA, hB, 4.5, rgb(ZINC), rgb('#8f979b'), true);
                        sheds++;
                        continue;
                    }
                    if (shop) {
                        const wall = rgb(SHOP_WALLS[Math.floor(hash01(k, 9) * SHOP_WALLS.length) % SHOP_WALLS.length]);
                        addHouse(b, cx, cy, ux, uy, hA, hB, 3.4, wall, rgb('#d4cfc4'), false);
                        // toldo sobre la vereda
                        const aw = rgb(AWNINGS[Math.floor(hash01(k, 10) * AWNINGS.length) % AWNINGS.length]);
                        b.box(cx - nx * (hB + 0.6), cy - ny * (hB + 0.6), [ux, uy], [nx, ny], hA * 0.9, 0.6, 2.35, 2.5, aw, 0);
                        shops++;
                        continue;
                    }
                    const wall = rgb(PALETTE.houseWalls[Math.floor(hash01(k, 11) * PALETTE.houseWalls.length) % PALETTE.houseWalls.length]);
                    const chapa = hash01(k, 12) < 0.45;
                    const roof = rgb(chapa ? ZINC : PALETTE.houseRoofs[Math.floor(hash01(k, 13) * PALETTE.houseRoofs.length) % PALETTE.houseRoofs.length]);
                    // u = frente de la casa (a lo largo de la calle); techo a dos aguas con la cumbrera paralela a la calle
                    addHouse(b, cx, cy, ux, uy, hA, hB, 2.7 + hash01(k, 14) * 0.6, wall, roof, !chapa || hash01(k, 15) < 0.5);
                    houses++;
                    // patio del fondo con uno o dos árboles; a veces uno al frente
                    const back = hB + 3 + hash01(k, 16) * 4;
                    for (let n = 0, m = hash01(k, 17) < 0.55 ? 2 : 1; n < m; n++) {
                        const tx = cx + nx * back + ux * (hash01(k, 18 + n) - 0.5) * hA * 1.6;
                        const ty = cy + ny * back + uy * (hash01(k, 18 + n) - 0.5) * hA * 1.6;
                        if (distOutside(bounds, tx, ty) > 4 && !blocked(tx, ty) && free(tx, ty, 1.5) && !query?.onRoad(tx, ty, 1.5)) {
                            trees.push({ x: tx, y: ty, context: 'patio' });
                            take(tx, ty, 1.5);
                        }
                    }
                }
            }
            s0 += L;
        }
    });
    return { builders: { buildings: b }, trees, houses, shops, sheds };
}
