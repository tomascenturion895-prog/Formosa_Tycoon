// Tránsito de la ciudad 3D: motos, autos, camionetas, utilitarios, camiones y colectivos que andan por el grafo de carriles.
// Puro (sin DOM ni WebGL): se puede correr en un Web Worker y se prueba con `npm run test:js`.
//
// Modelo (barato y suficiente para que se vea creíble):
//  - Cada vehículo va sobre un carril (distancia `s` a lo largo de la polilínea). Al llegar al nodo cruza por un
//    "conector" (curva de Bézier del final del carril al comienzo del siguiente) y sigue por el carril elegido.
//  - Seguimiento del de adelante con el modelo IDM (acelera y frena suave) + un tope duro que nunca deja encimarse.
//  - Cruces: semáforo por eje (30 s verde, 4 s amarillo, 34 s rojo) con desfase fijo por nodo; sin semáforo,
//    prioridad de la derecha aproximada. Nadie entra al cruce si choca con alguien que ya está adentro
//    o si no tiene lugar del otro lado ("no bloquear la bocacalle").
//  - Solo se simula alrededor del foco (la cámara): lo que se aleja se recicla y aparece cerca, fuera de la vista.
// Todo el azar sale de `hash01` con un contador: misma semilla y mismos pasos → mismo tránsito.
import { hash01 } from './city-geometry.js';

/** Proporción de cada tipo (en Formosa la moto, casi siempre de 110 cc, es el medio más usado). */
export const MIX = { moto: 0.52, auto: 0.30, camioneta: 0.09, utilitario: 0.04, camion: 0.025, colectivo: 0.025 };
export const TYPES = Object.keys(MIX);

/** Medidas reales en metros (largo, ancho, alto). */
export const DIMENSIONS = {
    moto: { length: 1.9, width: 0.7, height: 1.1 },
    auto: { length: 4.3, width: 1.7, height: 1.45 },
    camioneta: { length: 5.3, width: 1.85, height: 1.8 },
    utilitario: { length: 4.4, width: 1.8, height: 1.9 },
    camion: { length: 7.5, width: 2.4, height: 3.2 },
    colectivo: { length: 12, width: 2.6, height: 3.1 },
};

// Manejo de cada tipo: factor de velocidad (± jitter), aceleración y frenada cómodas, distancia mínima parado y tiempo de seguimiento.
const DRIVE = {
    moto: { vf: 1.08, vj: 0.12, a: 2.6, b: 3.2, s0: 1.2, T: 0.7 },
    auto: { vf: 1.0, vj: 0.08, a: 2.0, b: 3.0, s0: 2.2, T: 1.0 },
    camioneta: { vf: 0.97, vj: 0.07, a: 1.8, b: 2.8, s0: 2.4, T: 1.0 },
    utilitario: { vf: 0.92, vj: 0.06, a: 1.6, b: 2.6, s0: 2.4, T: 1.1 },
    camion: { vf: 0.78, vj: 0.05, a: 1.0, b: 2.2, s0: 2.8, T: 1.2 },
    colectivo: { vf: 0.8, vj: 0.04, a: 1.1, b: 2.2, s0: 2.8, T: 1.2 },
};

/** Colores de cada tipo. Utilitario: el color es la franja lateral (la carrocería es blanca). Colectivo: librea única, a confirmar. */
export const COLORS = {
    moto: ['#c62828', '#1d1d1f', '#1f4fa3', '#8a8f98'],
    auto: ['#f2f2ef', '#f2f2ef', '#b8bcc2', '#b8bcc2', '#1c1d21', '#b3202a', '#234e9c'],
    camioneta: ['#f2f2ef', '#9aa0a6', '#1c1d21', '#a8231f'],
    utilitario: ['#1f6fb2', '#d32f2f', '#2e7d32', '#f2a516'],
    camion: ['#c0392b', '#1f4f9c', '#f0f0ec'],
    colectivo: ['#0e8f8a'], // blanco con franja verde azulada (librea a confirmar)
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ------------------------------------------------------------------ densidad según la hora

// Hora → densidad (0 a 1). Picos 7–9, 12–13 y 18–20; de día ~0,6; a la noche 0,35; de 1 a 5 casi vacío.
const DENSITY_KEYS = [
    [0, 0.18], [1, 0.05], [5, 0.05], [6, 0.3], [7, 1], [9, 1], [9.75, 0.75], [11.5, 0.75], [12, 1], [13, 1],
    [13.75, 0.75], [17.5, 0.75], [18, 1], [20, 1], [21, 0.4], [22.5, 0.35], [24, 0.18],
];

export function densityAt(hours) {
    const h = (((Number(hours) || 0) % 24) + 24) % 24;
    for (let i = 1; i < DENSITY_KEYS.length; i++) {
        const [h1, d1] = DENSITY_KEYS[i];
        if (h <= h1) {
            const [h0, d0] = DENSITY_KEYS[i - 1];
            return d0 + (d1 - d0) * ((h - h0) / (h1 - h0 || 1));
        }
    }
    return DENSITY_KEYS[0][1];
}

// ------------------------------------------------------------------ geometría de polilíneas

function prepPath(pts) {
    const n = pts.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        xs[i] = pts[i][0];
        ys[i] = pts[i][1];
        if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    return { xs, ys, cum, len: n ? cum[n - 1] : 0 };
}

/** Punto a distancia `s` sobre la polilínea (se recorta a los extremos). Escribe en `out`. */
function pointOn(p, s, out) {
    const { xs, ys, cum } = p;
    const n = cum.length;
    if (n === 1 || s <= 0) {
        out[0] = xs[0]; out[1] = ys[0];
        return out;
    }
    if (s >= p.len) {
        out[0] = xs[n - 1]; out[1] = ys[n - 1];
        return out;
    }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / seg;
    out[0] = xs[lo] + (xs[hi] - xs[lo]) * t;
    out[1] = ys[lo] + (ys[hi] - ys[lo]) * t;
    return out;
}

function dirAt(p, i0, i1) {
    const dx = p.xs[i1] - p.xs[i0], dy = p.ys[i1] - p.ys[i0];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return d1 * d2 < 0 && d3 * d4 < 0;
}

// ------------------------------------------------------------------ autos estacionados

/**
 * Autos, camionetas y motos estacionados en paralelo junto al cordón, a la derecha de los carriles de calles menores.
 * Determinístico (sale de las coordenadas del carril). `density` 0 a 1 = proporción de lugares ocupados.
 * Reglas (para que nunca queden en la vereda ni en un cruce):
 *  - sólo donde el carril trae `park` (distancia del carril al cordón derecho; 0 = no se puede: calle angosta, sin cordón,
 *    avenida…). Sin ese dato (grafos sintéticos) se toma ancho/2 = el cordón al borde del carril.
 *  - el auto queda DENTRO de la calzada, con el costado a ~25 cm del cordón (centro a `park` − (ancho/2 + 0,25) del carril).
 *  - a ≥ 8,5 m del recorte del cruce en los dos extremos (`t0`/`t1` del carril): nunca en el cruce ni sobre la senda.
 */
export function parkedAlong(laneGraph, density = 0.35) {
    const out = [];
    const lanes = laneGraph?.lanes ?? [];
    const tmp = [0, 0];
    for (const lane of lanes) {
        if (!lane || lane.major || lane.bus || !lane.pts || lane.pts.length < 2) continue;
        const p = prepPath(lane.pts);
        if (p.len < 30) continue;
        const gap = lane.park !== undefined ? lane.park : (lane.width ?? 3.5) * 0.5;
        if (!(gap > 1.6)) continue; // sin lugar entre el carril y el cordón
        const sMin = Math.max(10, (lane.t0 ?? 0) + 8.5), sMax = p.len - Math.max(12, (lane.t1 ?? 0) + 8.5);
        const key = Math.round(p.xs[0] * 3 + p.ys[0] * 7 + p.xs.at(-1) * 11 + p.ys.at(-1) * 13);
        let s = sMin + hash01(key, 901) * 4;
        let slot = 0;
        while (s < sMax) {
            const r = hash01(key + slot * 7919, 902);
            const kind = r < 0.22 ? 'moto' : r < 0.85 ? 'auto' : 'camioneta';
            const L = DIMENSIONS[kind].length;
            const room = kind === 'moto' ? 1.3 : L + 1.4;
            const sc = s + L / 2;
            if (sc + L / 2 > sMax) break;
            if (hash01(key + slot * 7919, 903) < density) {
                pointOn(p, sc, tmp);
                // dirección local del tramo
                let i = 1;
                while (i < p.cum.length - 1 && p.cum[i] < sc) i++;
                const [dx, dy] = dirAt(p, i - 1, i);
                const colors = COLORS[kind];
                const off = gap - ((kind === 'moto' ? 0.5 : kind === 'camioneta' ? 0.98 : 0.9) + 0.25);
                out.push({
                    type: kind,
                    x: tmp[0] + dy * off,
                    y: tmp[1] - dx * off,
                    heading: Math.atan2(dy, dx),
                    color: colors[Math.floor(hash01(key + slot * 7919, 904) * colors.length) % colors.length],
                    variant: hash01(key + slot * 7919, 905) < 0.5 ? 0 : 1,
                    speed: 0,
                    braking: false,
                    passenger: false,
                    visible: true,
                    parked: true,
                });
            }
            s += room + (kind === 'moto' ? 0.4 : 1 + hash01(key + slot * 7919, 906) * 2.5);
            slot++;
        }
    }
    return out;
}

// ------------------------------------------------------------------ simulación

const CYCLE = 68; // eje A: verde 0–30, amarillo 30–34, rojo 34–68; eje B: rojo 0–34, verde 34–64, amarillo 64–68
const GREEN = 0, YELLOW = 1, RED = 2;
const MIN_GAP = 0.8; // tope duro entre paragolpes (m)
const LAT_ACC = 2.2; // aceleración lateral cómoda en curvas (m/s²)
// Densidad urbana objetivo (vehículos por m² de foco) para que la cantidad se adapte al radio que mira la cámara.
// Antes se metía `maxVehicles` entero sin importar el radio: a nivel de calle el foco se achica a ~250 m y 320
// vehículos (≈1630/km²) hacían un embotellamiento irreal. ~450/km² fluye bien (los autos esperan en la línea de detención, antes de la senda,
// y no en el medio del cruce: eso cuesta algo de caudal, de ahí 560 → 450) y se mantiene el tope `maxVehicles` cuando la
// cámara se aleja y el foco crece.
const AREA_DENSITY = 450e-6;

/**
 * @param laneGraph { nodes:[{x,y,signal}], lanes:[{from,to,pts,len,speed,major,bus,width}], out:[[laneIndex…]] }
 * @param options { seed, maxVehicles, onEnterJunction?(vehicle, node, signalState) } (el callback es para pruebas)
 */
export function createTraffic(laneGraph, { seed = 1, maxVehicles = 150, onEnterJunction = null } = {}) {
    const nodes = laneGraph?.nodes ?? [];
    const rawLanes = laneGraph?.lanes ?? [];
    const outs = laneGraph?.out ?? [];
    const NL = rawLanes.length;
    const salt = (seed | 0) * 7919 + 17;
    let rc = 0;
    const rnd = () => hash01(rc++, salt);

    // --- carriles preparados
    const lanes = rawLanes.map((ln, i) => {
        const p = prepPath(ln.pts ?? []);
        const n = p.cum.length;
        const ok = n >= 2 && p.len > 0.05;
        const lane = {
            i, from: ln.from, to: ln.to, path: p, len: p.len, ok,
            // dónde se detiene el frente del primero de la fila (antes de la senda / del cruce); sin dato = en el nodo
            stopS: p.len - clamp(Number(ln.stop) || 0, 0, Math.max(0, p.len - 14)),
            speed: ln.speed > 0 ? ln.speed : 11, major: !!ln.major, bus: !!ln.bus,
            startDir: ok ? dirAt(p, 0, 1) : [1, 0], endDir: ok ? dirAt(p, n - 2, n - 1) : [1, 0],
            bends: [], // [s, vmax] en vértices con curva marcada
            stops: Array.isArray(ln.stops) && ln.stops.length ? ln.stops.slice().sort((a, b) => a - b) : null, // paradas de colectivo (m desde el inicio del carril)
        };
        for (let k = 1; k < n - 1 && ok; k++) {
            const [ax, ay] = dirAt(p, k - 1, k);
            const [bx, by] = dirAt(p, k, k + 1);
            const ang = Math.acos(clamp(ax * bx + ay * by, -1, 1));
            if (ang > 0.15) {
                const R = Math.min(p.cum[k] - p.cum[k - 1], p.cum[k + 1] - p.cum[k]) / ang;
                lane.bends.push(p.cum[k], clamp(Math.sqrt(LAT_ACC * Math.max(R, 1)), 2.5, 40));
            }
        }
        return lane;
    });
    const inLanes = nodes.map(() => []);
    for (const l of lanes) if (l.ok && inLanes[l.to]) inLanes[l.to].push(l.i);

    // tablas acumuladas de longitud para elegir dónde aparecer (uniforme por metro)
    function cumTable(filter, weight = () => 1) {
        const idx = [], acc = [];
        let total = 0;
        for (const l of lanes) {
            if (!l.ok || l.len < 30 || !filter(l)) continue;
            total += l.len * weight(l);
            idx.push(l.i);
            acc.push(total);
        }
        return { idx, acc, total };
    }
    // las avenidas llevan más tránsito por metro que las calles de barrio (×3 al aparecer)
    const W_ALL = (l) => (l.major ? 3 : 1);
    const ALL = () => true, BUS = (l) => l.bus, MAJOR = (l) => l.major;
    let tblAll = cumTable(ALL, W_ALL);
    let tblBus = cumTable(BUS);
    let tblMajor = cumTable(MAJOR);
    const globalTables = { tblAll, tblBus, tblMajor };
    // Con foco (la ciudad grande tiene cientos de km de carriles y el foco es un círculo de pocos cientos de metros)
    // se sortea solo entre los carriles que tocan el círculo: si no, casi todos los intentos caen afuera y el foco
    // queda vacío durante un minuto. Las tablas locales se rehacen cuando el foco se mueve o cambia de radio.
    const laneBox = lanes.map((l) => {
        if (!l.ok) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < l.path.xs.length; k++) {
            const x = l.path.xs[k], y = l.path.ys[k];
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return [x0, y0, x1, y1];
    });
    const tablesAt = { x: NaN, y: NaN, r: NaN };
    function useTablesFor(fx, fy, r) {
        if (!Number.isFinite(r)) {
            if (Number.isNaN(tablesAt.r)) return;
            ({ tblAll, tblBus, tblMajor } = globalTables);
            tablesAt.x = tablesAt.y = tablesAt.r = NaN;
            return;
        }
        if (Math.hypot(fx - tablesAt.x, fy - tablesAt.y) < r * 0.12 && Math.abs(r - tablesAt.r) < r * 0.1) return;
        tablesAt.x = fx; tablesAt.y = fy; tablesAt.r = r;
        const near = (l) => {
            const b = laneBox[l.i];
            if (!b) return false;
            const dx = Math.max(b[0] - fx, 0, fx - b[2]), dy = Math.max(b[1] - fy, 0, fy - b[3]);
            return dx * dx + dy * dy < r * r;
        };
        tblAll = cumTable(near, W_ALL);
        tblBus = cumTable((l) => l.bus && near(l));
        tblMajor = cumTable((l) => l.major && near(l));
    }

    // --- conectores (giros dentro del cruce), con caché
    const connCache = new Map();
    let connIds = 0;
    function getConn(a, b) {
        const key = a * NL + b;
        let c = connCache.get(key);
        if (c) return c;
        const A = lanes[a], B = lanes[b];
        const p0x = A.path.xs[A.path.xs.length - 1], p0y = A.path.ys[A.path.ys.length - 1];
        const p3x = B.path.xs[0], p3y = B.path.ys[0];
        const d0 = A.endDir, d1 = B.startDir;
        const dist = Math.hypot(p3x - p0x, p3y - p0y);
        const dot = d0[0] * d1[0] + d0[1] * d1[1];
        let pts;
        if (dist < 0.05) {
            pts = [[p0x, p0y]];
        } else {
            const k = dot < -0.5 ? Math.max(dist * 0.9, 3) : dist * 0.45;
            const p1x = p0x + d0[0] * k, p1y = p0y + d0[1] * k;
            const p2x = p3x - d1[0] * k, p2y = p3y - d1[1] * k;
            pts = [];
            const SEG = 8;
            for (let j = 0; j <= SEG; j++) {
                const t = j / SEG, u = 1 - t;
                pts.push([
                    u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x,
                    u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y,
                ]);
            }
        }
        const path = prepPath(pts);
        const ang = Math.acos(clamp(dot, -1, 1));
        const R = path.len / Math.max(ang, 0.01);
        c = {
            id: connIds++, a, b, node: A.to, path, len: path.len,
            vmax: clamp(Math.sqrt(LAT_ACC * Math.max(R, 1)), 2.5, Math.min(A.speed, B.speed) * 1.15),
            uturn: dot < -0.7,
        };
        connCache.set(key, c);
        return c;
    }

    // Zona de conflicto entre dos giros: hasta qué distancia de `cu` hay puntos a menos de ~2,2 m de `cv`
    // (o donde las trazas se cruzan). -1 = no se tocan. Quien ya pasó esa distancia con la cola deja libre el cruce.
    const conflictCache = new Map();
    function conflictExit(cu, cv) {
        if (cu === cv) return -1;
        const key = cu.id * 1e6 + cv.id;
        let r = conflictCache.get(key);
        if (r !== undefined) return r;
        r = -1;
        const p = cu.path, q = cv.path;
        if (cu.b === cv.b) r = cu.len; // se juntan en el mismo carril de salida
        for (let i = 0; i < p.xs.length; i++) {
            for (let j = 0; j < q.xs.length; j++) {
                const dx = p.xs[i] - q.xs[j], dy = p.ys[i] - q.ys[j];
                let hit = dx * dx + dy * dy < 2.2 * 2.2;
                if (!hit && i > 0 && j > 0) hit = segmentsCross(p.xs[i - 1], p.ys[i - 1], p.xs[i], p.ys[i], q.xs[j - 1], q.ys[j - 1], q.xs[j], q.ys[j]);
                if (hit) {
                    const seg = i + 1 < p.cum.length ? p.cum[i + 1] - p.cum[i] : 0;
                    r = Math.max(r, Math.min(cu.len, p.cum[i] + seg * 0.5));
                }
            }
        }
        if (r < 0 && cu.a === cv.a) r = 0;
        conflictCache.set(key, r);
        return r;
    }
    const conflict = (c1, c2) => c1 !== c2 && conflictExit(c1, c2) >= 0;

    /** Posición de la cola de u medida a lo largo del giro con el que entró al cruce. */
    function rearAlong(u) {
        const c = u._boxConn;
        if (u._phase === 1 && u._conn === c) return u._s - u._half;
        if (u._phase === 0 && u._lane === c.b) return c.len + u._s - u._half;
        return -1;
    }

    // --- semáforos
    const nodeBase = new Float64Array(nodes.length).fill(NaN);
    function axisOf(laneIdx) {
        const l = lanes[laneIdx];
        const node = l.to;
        if (Number.isNaN(nodeBase[node])) {
            const first = inLanes[node][0] ?? laneIdx;
            nodeBase[node] = Math.atan2(lanes[first].endDir[1], lanes[first].endDir[0]);
        }
        let d = Math.atan2(l.endDir[1], l.endDir[0]) - nodeBase[node];
        d = ((d % Math.PI) + Math.PI) % Math.PI;
        return d < Math.PI / 4 || d > (3 * Math.PI) / 4 ? 0 : 1;
    }
    function signalState(node, axis, t) {
        const u = (((t + hash01(node, salt + 11) * CYCLE) % CYCLE) + CYCLE) % CYCLE;
        if (axis === 0) return u < 30 ? GREEN : u < 34 ? YELLOW : RED;
        return u < 34 ? RED : u < 64 ? GREEN : YELLOW;
    }

    // --- estado
    const laneVeh = lanes.map(() => []);
    const box = nodes.map(() => []);
    const vehicles = [];
    const pool = [];
    const spawned = Object.fromEntries(TYPES.map((t) => [t, 0]));
    let nextId = 1;
    let time = 0;
    let pendingType = null;
    let pendingFails = 0;
    let spawnAcc = 0;
    let freshFill = true;
    const focusNow = { x: 0, y: 0, r: Infinity };
    const tmpA = [0, 0], tmpB = [0, 0];

    function pickType() {
        const r = rnd();
        let acc = 0;
        for (const t of TYPES) {
            acc += MIX[t];
            if (r < acc) return t;
        }
        return 'auto';
    }

    function chooseNext(laneIdx, type) {
        const l = lanes[laneIdx];
        const list = outs[l.to] ?? [];
        let total = 0;
        const cand = [];
        for (let pass = 0; pass < 2 && cand.length === 0; pass++) {
            for (const o of list) {
                const L = lanes[o];
                if (!L || !L.ok) continue;
                if (type === 'colectivo' && !L.bus) continue;
                const dot = l.endDir[0] * L.startDir[0] + l.endDir[1] * L.startDir[1];
                const uturn = (L.to === l.from && dot < -0.7) || dot < -0.95;
                if (pass === 0 && uturn) continue; // sin vuelta en U salvo calle sin salida
                let w = 1 + (dot > 0.8 ? 1.6 : 0);
                if (type === 'camion' && L.major) w *= 4;
                if (type !== 'colectivo' && L.bus && l.bus && dot > 0.8) w *= 1.5;
                cand.push(o, w);
                total += w;
            }
        }
        if (!cand.length) return -1;
        let r = rnd() * total;
        for (let k = 0; k < cand.length; k += 2) {
            r -= cand[k + 1];
            if (r <= 0) return cand[k];
        }
        return cand[cand.length - 2];
    }

    function setNext(v) {
        v._next = chooseNext(v._lane, v.type);
        v._conn = v._next >= 0 ? getConn(v._lane, v._next) : null;
    }

    function insertSorted(list, v) {
        // ordenadas de adelante (s mayor) hacia atrás
        let k = list.length;
        while (k > 0 && list[k - 1]._s < v._s) k--;
        list.splice(k, 0, v);
    }

    function removeFrom(list, v) {
        const k = list.indexOf(v);
        if (k >= 0) list.splice(k, 1);
    }

    function leaveBox(v) {
        if (v._box >= 0) {
            removeFrom(box[v._box], v);
            v._box = -1;
            v._boxConn = null;
        }
    }

    function despawn(v) {
        if (v._phase === 0) removeFrom(laneVeh[v._lane], v);
        leaveBox(v);
        v.visible = false;
        const k = vehicles.indexOf(v);
        if (k >= 0) {
            vehicles[k] = vehicles[vehicles.length - 1];
            vehicles.pop();
        }
        pool.push(v);
    }

    function trySpawn(type, inner) {
        const tbl = type === 'colectivo' ? tblBus : type === 'camion' && tblMajor.total > 0 && rnd() < 0.8 ? tblMajor : tblAll;
        if (tbl.total <= 0) return false;
        const half = DIMENSIONS[type].length / 2;
        const { x: fx, y: fy, r } = focusNow;
        for (let attempt = 0; attempt < 14; attempt++) {
            const target = rnd() * tbl.total;
            let lo = 0, hi = tbl.acc.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (tbl.acc[mid] < target) lo = mid + 1; else hi = mid;
            }
            const lane = lanes[tbl.idx[lo]];
            const s = 12 + half + rnd() * Math.max(0, lane.len - 24 - 2 * half);
            if (s > lane.len - 12 - half) continue;
            pointOn(lane.path, s, tmpA);
            const d = Math.hypot(tmpA[0] - fx, tmpA[1] - fy);
            if (d > r || (!inner && d < 0.6 * r)) continue;
            let free = true, gapAhead = Infinity;
            for (const u of laneVeh[lane.i]) {
                const dd = u._s - s;
                if (Math.abs(dd) < u._half + half + 7) { free = false; break; }
                if (dd > 0) gapAhead = Math.min(gapAhead, dd - u._half - half);
            }
            if (!free) continue;
            if (lane.len - s < 40 && box[lane.to].length > 0) continue;
            const v = pool.pop() ?? {};
            const drv = DRIVE[type];
            const id = nextId++;
            const colors = COLORS[type];
            Object.assign(v, {
                type, id, x: tmpA[0], y: tmpA[1], heading: 0, speed: 0,
                color: colors[Math.floor(rnd() * colors.length) % colors.length],
                braking: false, passenger: type === 'moto' && rnd() < 0.3, visible: true,
                variant: rnd() < 0.5 ? 0 : 1,
                _lane: lane.i, _s: s, _phase: 0, _next: -1, _conn: null, _prevConn: null,
                _box: -1, _boxConn: null, _half: half, _len: half * 2,
                _vf: drv.vf + (rnd() * 2 - 1) * drv.vj, _a: drv.a, _b: drv.b, _s0: drv.s0, _T: drv.T,
                _acc: 0, _wait: 0, _served: -1, _dwell: 0,
            });
            v.speed = gapAhead > 40 ? lane.speed * v._vf * 0.6 : 0;
            insertSorted(laneVeh[lane.i], v);
            setNext(v);
            vehicles.push(v);
            spawned[type]++;
            placeVehicle(v);
            return true;
        }
        return false;
    }

    // --- permiso para entrar al cruce
    function permission(v, commit) {
        const lane = lanes[v._lane];
        const node = lane.to;
        const c = v._conn;
        if (!c) return false;
        const nd = nodes[node];
        if (nd?.signal) {
            const st = signalState(node, axisOf(v._lane), time);
            if (st === RED) { v._why = 'rojo'; return false; }
            if (st === YELLOW && !commit) {
                const dist = lane.stopS - v._s - v._half; // hasta la línea de detención
                if (dist > (v.speed * v.speed) / (2 * 3.5) + 0.5) { v._why = 'amarillo'; return false; }
            }
        }
        const members = box[node];
        let need = v._len + 1.5;
        for (let k = 0; k < members.length; k++) {
            const u = members[k];
            if (u === v) continue;
            if (u._boxConn !== c) {
                const ex = conflictExit(u._boxConn, c);
                if (ex >= 0 && rearAlong(u) < ex + 0.6) { v._why = 'cruce ocupado'; return false; }
            }
            if (u._boxConn === c) need += u._len + 1.5;
        }
        const outList = laneVeh[c.b];
        if (outList.length) {
            const last = outList[outList.length - 1];
            if (last._s - last._half < need) { v._why = 'sin lugar'; return false; }
        }
        if (!nd?.signal && v._wait < 6) {
            const me = lane.endDir;
            const ins = inLanes[node];
            for (let k = 0; k < ins.length; k++) {
                const I = ins[k];
                if (I === v._lane) continue;
                const od = lanes[I].endDir;
                if (me[0] * od[1] - me[1] * od[0] <= 0.5) continue; // no viene por la derecha
                const f = laneVeh[I][0];
                if (!f || f._box === node || !f._conn) continue;
                const d = lanes[I].len - f._s - f._half;
                if (d > 10 || !conflict(f._conn, c)) continue;
                // cede al que viene andando por la derecha; si los dos están parados, pasa el que espera hace más
                if (f.speed > 1 || (d < 4 && (f._wait > v._wait + 0.3 || (Math.abs(f._wait - v._wait) <= 0.3 && f.id < v.id)))) { v._why = 'derecha'; return false; }
            }
        }
        return true;
    }

    function register(v) {
        const node = lanes[v._lane].to;
        leaveBox(v);
        v._box = node;
        v._boxConn = v._conn;
        box[node].push(v);
        if (onEnterJunction) {
            const st = nodes[node]?.signal ? signalState(node, axisOf(v._lane), time) : -1;
            onEnterJunction(v, node, st);
        }
    }

    // líder: distancia libre (paragolpes a paragolpes) y velocidad del de adelante en el camino del vehículo
    let gapOut = Infinity, leadSpeed = 0;
    function connLeader(v, frontInConn) {
        // frontInConn: posición del frente de v medida desde el comienzo del conector
        const c = v._conn;
        const members = box[c.node];
        let best = null, bestPos = Infinity;
        for (let k = 0; k < members.length; k++) {
            const u = members[k];
            if (u === v || u._phase !== 1 || u._conn !== c) continue;
            const rear = u._s - u._half;
            if (rear > frontInConn - 0.01 && rear < bestPos) { bestPos = rear; best = u; }
        }
        if (best) {
            gapOut = bestPos - frontInConn;
            leadSpeed = best.speed;
            return;
        }
        const outList = laneVeh[c.b];
        if (outList.length) {
            const last = outList[outList.length - 1];
            gapOut = c.len + last._s - last._half - frontInConn;
            leadSpeed = last.speed;
        }
    }

    function findLeader(v) {
        gapOut = Infinity;
        leadSpeed = 0;
        if (v._phase === 1) {
            connLeader(v, v._s + v._half);
            return;
        }
        const lane = lanes[v._lane];
        const list = laneVeh[v._lane];
        const k = list.indexOf(v);
        if (k > 0) {
            const a = list[k - 1];
            gapOut = a._s - v._s - a._half - v._half;
            leadSpeed = a.speed;
            return;
        }
        const distEnd = lane.len - v._s - v._half;
        if (v._next < 0) {
            gapOut = distEnd + 2; // calle sin salida de mano única: se frena y se recicla
            return;
        }
        if (v._box === lane.to) {
            connLeader(v, -distEnd);
            return;
        }
        const look = Math.max(30, (v.speed * v.speed) / (2 * 2) + 15);
        const distStop = lane.stopS - v._s - v._half; // hasta la línea de detención (antes de la senda y del cruce)
        if (distStop < look) {
            if (permission(v, false)) connLeader(v, -distEnd);
            else { gapOut = distStop; leadSpeed = 0; }
        }
    }

    function desiredSpeed(v) {
        const lane = lanes[v._lane];
        const b = v._b;
        if (v._phase === 1) {
            return Math.min(v._conn.vmax, lanes[v._conn.b].speed * v._vf);
        }
        let v0 = lane.speed * v._vf;
        const bends = lane.bends;
        for (let k = 0; k < bends.length; k += 2) {
            const d = bends[k] - v._s;
            if (d < -v._half) continue;
            v0 = Math.min(v0, Math.sqrt(bends[k + 1] * bends[k + 1] + 2 * b * Math.max(0, d)));
            if (d > 80) break;
        }
        if (v._conn) {
            const d = lane.len - v._s;
            v0 = Math.min(v0, Math.sqrt(v._conn.vmax * v._conn.vmax + 2 * b * Math.max(0, d)));
        }
        return Math.max(v0, 1);
    }

    function enterLane(v, laneIdx, s) {
        v._prevConn = v._conn;
        v._lane = laneIdx;
        v._s = s;
        v._phase = 0;
        insertSorted(laneVeh[laneIdx], v);
        setNext(v);
    }

    /** Avanza `ds` metros por el camino; devuelve false si el vehículo se recicló. */
    function advance(v, ds) {
        let guard = 0;
        while (guard++ < 6) {
            if (v._phase === 0) {
                const lane = lanes[v._lane];
                const sOld = v._s;
                v._s += ds;
                ds = 0;
                if (v._box >= 0 && v._box !== lane.to && v._s >= v._half) leaveBox(v);
                if (v._box !== lane.to && v._s + v._half >= (v._next < 0 ? lane.len : lane.stopS)) {
                    if (v._next < 0) {
                        despawn(v);
                        return false;
                    }
                    if (permission(v, true)) {
                        register(v);
                        v._why = '';
                    } else {
                        v._s = Math.max(sOld, Math.min(v._s, (v._next < 0 ? lane.len : lane.stopS) - v._half - 0.01));
                        if (v._s < sOld + 1e-6) v.speed = 0;
                        return true;
                    }
                }
                if (v._s >= lane.len) {
                    removeFrom(laneVeh[v._lane], v);
                    const rest = v._s - lane.len;
                    v._phase = 1;
                    v._s = 0;
                    ds = rest;
                    continue;
                }
                return true;
            }
            // en el conector
            const c = v._conn;
            v._s += ds;
            ds = 0;
            if (v._s >= c.len) {
                const rest = v._s - c.len;
                enterLane(v, c.b, 0);
                if (rest > 0) { ds = rest; continue; }
            }
            return true;
        }
        return true;
    }

    // posición y rumbo para dibujar: punto medio entre "eje delantero" y "eje trasero" sobre el camino
    function pathPoint(v, off, out) {
        if (v._phase === 0) {
            const lane = lanes[v._lane];
            const p = v._s + off;
            if (p > lane.len && v._conn) {
                const q = p - lane.len;
                if (q <= v._conn.len || v._next < 0) return pointOn(v._conn.path, q, out);
                return pointOn(lanes[v._next].path, q - v._conn.len, out);
            }
            if (p < 0 && v._prevConn && v._prevConn.b === v._lane && v._prevConn.len > 0) {
                return pointOn(v._prevConn.path, v._prevConn.len + p, out);
            }
            return pointOn(lane.path, p, out);
        }
        const c = v._conn;
        const p = v._s + off;
        if (p > c.len) return pointOn(lanes[c.b].path, p - c.len, out);
        if (p < 0) return pointOn(lanes[c.a].path, lanes[c.a].len + p, out);
        return pointOn(c.path, p, out);
    }

    function placeVehicle(v) {
        const h = Math.max(v._half * 0.7, 0.5);
        pathPoint(v, h, tmpA);
        pathPoint(v, -h, tmpB);
        v.x = (tmpA[0] + tmpB[0]) * 0.5;
        v.y = (tmpA[1] + tmpB[1]) * 0.5;
        const dx = tmpA[0] - tmpB[0], dy = tmpA[1] - tmpB[1];
        if (dx * dx + dy * dy > 1e-6) v.heading = Math.atan2(dy, dx);
    }

    function stepOnce(dt) {
        time += dt;
        for (let k = 0; k < vehicles.length; k++) {
            const v = vehicles[k];
            if (v._dwell > 0) {
                v._dwell -= dt;
                v.speed = 0;
                v._acc = 0;
                v.braking = true;
                continue;
            }
            findLeader(v);
            let gap = gapOut, vl = leadSpeed;
            // parada de colectivo: sólo en las paradas reales (carteles de parada del mapa), no en cualquier lado
            if (v.type === 'colectivo' && v._phase === 0 && v._box < 0) {
                const lane = lanes[v._lane];
                if (lane.stops) {
                    let ps = -1;
                    for (const st of lane.stops) if (st > v._s - 0.5 && !(v._served === lane.i * 1e5 + Math.round(st))) { ps = st; break; }
                    if (ps >= 0) {
                        const dStop = ps - v._s;
                        if (dStop + v._s0 < gap) { gap = dStop + v._s0; vl = 0; } // el IDM frena a s0 del obstáculo: para justo en la parada
                        if (dStop < 1.5 && v.speed < 0.6) {
                            v._dwell = 8;
                            v._served = lane.i * 1e5 + Math.round(ps);
                            v.speed = 0;
                            continue;
                        }
                    }
                }
            }
            const v0 = desiredSpeed(v);
            const sp = v.speed, A = v._a, B = v._b;
            let acc = sp <= v0 ? A * (1 - (sp / v0) ** 4) : -Math.min(B * 1.5, (sp - v0) * 2 + 0.5);
            if (gap < Infinity) {
                const sStar = v._s0 + Math.max(0, sp * v._T + (sp * (sp - vl)) / (2 * Math.sqrt(A * B)));
                acc -= A * (sStar / Math.max(gap, 0.05)) ** 2;
            }
            acc = Math.max(acc, -9);
            let nv = sp + acc * dt;
            if (nv < 0) nv = 0;
            let ds = ((sp + nv) / 2) * dt;
            if (gap < Infinity && ds > gap - MIN_GAP) {
                ds = Math.max(0, gap - MIN_GAP);
                nv = Math.min(nv, vl);
            }
            v.speed = nv;
            v._acc = acc;
            v.braking = acc < -1 || (nv < 0.3 && gap < 6);
            v._wait = nv < 0.3 ? v._wait + dt : 0;
            if (!advance(v, ds)) k--; // se recicló: el último ocupó su lugar
        }
    }

    function manage(dt, hours) {
        const { x: fx, y: fy, r } = focusNow;
        // El cupo se adapta al área del foco (densidad ~constante por km²) y nunca pasa de `maxVehicles`.
        const areaCap = Number.isFinite(r) ? AREA_DENSITY * Math.PI * r * r : Infinity;
        const target = Math.round(densityAt(hours) * Math.min(maxVehicles, areaCap));
        // fuera del foco → se reciclan; si sobran, se van los que están lejos de la vista
        let removedOut = 0;
        const before = vehicles.length;
        for (let k = vehicles.length - 1; k >= 0; k--) {
            const v = vehicles[k];
            const d = Math.hypot(v.x - fx, v.y - fy);
            if (d > r || (v._wait > 90 && d > 0.6 * r)) {
                despawn(v);
                removedOut++;
            } else if (vehicles.length > target && d > 0.6 * r && rnd() < dt * 0.5) {
                despawn(v);
            }
        }
        if (before > 8 && removedOut > before * 0.6) freshFill = true; // el foco saltó lejos: se rellena todo
        // pocos para lo que corresponde (recién empezado, o el foco se fue a otra parte): se rellena todo el círculo,
        // no solo el anillo de afuera, así lo que mira la cámara no queda vacío mientras los autos "llegan"
        if (vehicles.length < target * 0.5) freshFill = true;
        const deficit = target - vehicles.length;
        if (deficit <= 0) {
            spawnAcc = 0;
            freshFill = false;
            return;
        }
        spawnAcc = Math.min(spawnAcc + dt * Math.max(2, maxVehicles / 8), deficit);
        let budget = freshFill ? deficit : Math.floor(spawnAcc);
        let fails = 0;
        const maxFails = freshFill ? 24 : 4;
        while (budget > 0 && fails < maxFails) {
            const type = pendingType ?? pickType();
            pendingType = type;
            if (trySpawn(type, freshFill)) {
                pendingType = null;
                pendingFails = 0;
                budget--;
                spawnAcc = Math.max(0, spawnAcc - 1);
            } else {
                fails++;
                if (++pendingFails > 20) {
                    pendingType = type === 'colectivo' || type === 'camion' ? 'auto' : null;
                    pendingFails = 0;
                }
            }
        }
        freshFill = false; // el relleno completo es de una sola vez (al empezar o tras un salto del foco)
    }

    function step(dt, hours = 12, focus = null) {
        dt = clamp(Number(dt) || 0, 0, 0.25);
        if (focus) {
            focusNow.x = focus.x;
            focusNow.y = focus.y;
            focusNow.r = focus.r ?? 800;
        } else {
            focusNow.r = Infinity;
        }
        useTablesFor(focusNow.x, focusNow.y, focusNow.r);
        const n = Math.max(1, Math.ceil(dt / 0.1));
        const h = dt / n;
        if (dt > 0) for (let i = 0; i < n; i++) stepOnce(h);
        manage(dt, hours);
        for (let k = 0; k < vehicles.length; k++) placeVehicle(vehicles[k]);
    }

    return {
        step,
        vehicles,
        parked: parkedAlong(laneGraph, 0.35),
        /** Cuántos se crearon de cada tipo (diagnóstico y pruebas). */
        spawned,
        get time() { return time; },
        /** Estado del semáforo (0 verde, 1 amarillo, 2 rojo) para quien entra al nodo por ese carril. */
        signalFor(laneIdx, t = time) {
            return signalState(lanes[laneIdx].to, axisOf(laneIdx), t);
        },
        /** Camino actual de un vehículo (para pruebas): { lane, phase, s, conn:{a,b,len} }. */
        where(v) {
            return { lane: v._lane, phase: v._phase, s: v._s, next: v._next, conn: v._conn && { a: v._conn.a, b: v._conn.b, len: v._conn.len } };
        },
        laneLists: laneVeh,
    };
}
