import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { MIX, TYPES, densityAt, createTraffic, parkedAlong } from '../../resources/js/map/city-traffic.js';

// ------------------------------------------------------------------ grafos de carriles sintéticos
// (el de verdad lo arma city-roads.js; acá se arma uno propio con el mismo formato LaneGraph)

/**
 * edges: [{a, b, pts:[[x,y]…] de a hacia b, oneway: 0|1, speed, major, bus}]
 * Carriles corridos a la derecha del sentido de circulación y recortados en los cruces (línea de detención).
 */
function buildLaneGraph(nodePts, edges, { signalAt = () => false } = {}) {
    const degree = new Array(nodePts.length).fill(0);
    for (const e of edges) { degree[e.a]++; degree[e.b]++; }
    const nodes = nodePts.map(([x, y], i) => ({ x, y, signal: !!signalAt(i, degree[i]) }));
    const lanes = [];
    const out = nodes.map(() => []);
    const addLane = (from, to, pts, e) => {
        const off = e.major ? 2.6 : 1.75;
        let sh = offsetLine(pts, off);
        const trim = (n) => (degree[n] >= 3 ? 7 : 0);
        sh = trimLine(sh, trim(from), trim(to));
        if (!sh) return;
        let len = 0;
        for (let i = 1; i < sh.length; i++) len += Math.hypot(sh[i][0] - sh[i - 1][0], sh[i][1] - sh[i - 1][1]);
        out[from].push(lanes.length);
        lanes.push({ from, to, pts: sh, len, speed: e.speed, major: !!e.major, bus: !!e.bus, width: 3.5 });
    };
    for (const e of edges) {
        addLane(e.a, e.b, e.pts, e);
        if (!e.oneway) addLane(e.b, e.a, e.pts.slice().reverse(), e);
    }
    return { nodes, lanes, out };
}

function offsetLine(pts, off) {
    const n = pts.length;
    return pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        return [p[0] + (dy / l) * off, p[1] - (dx / l) * off];
    });
}

function trimLine(pts, t0, t1) {
    let len = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push((len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
    if (len - t0 - t1 < 3) {
        t0 = Math.min(t0, len * 0.3);
        t1 = Math.min(t1, len * 0.3);
    }
    const at = (s) => {
        let i = 1;
        while (i < pts.length - 1 && cum[i] < s) i++;
        const u = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    };
    const res = [at(t0)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] > t0 && cum[i] < len - t1) res.push(pts[i]);
    res.push(at(len - t1));
    return res;
}

/**
 * Cuadrícula de 8×8 cuadras de 100 m (≈ 17 km de carriles): avenida con semáforos y colectivos (y = 300),
 * dos columnas con colectivos, calles de mano única y un callejón sin salida con una curva.
 */
export const GRID_N = 9; // nodos por lado
export function makeGrid() {
    const N = GRID_N;
    const nodePts = [];
    const id = (i, j) => j * N + i;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) nodePts.push([i * 100, j * 100]);
    const edges = [];
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N - 1; i++) {
            const avenue = j === 3;
            edges.push({ a: id(i, j), b: id(i + 1, j), pts: [[i * 100, j * 100], [i * 100 + 100, j * 100]], oneway: j === 5 || j === 7 ? 1 : 0,
                speed: avenue ? 16.7 : 11.1, major: avenue, bus: avenue });
        }
    }
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N - 1; j++) {
            const ow = i === 1 || i === 3 || i === 6;
            const bus = i === 0 || i === N - 1; // el colectivo da la vuelta por los bordes y la avenida
            edges.push({ a: id(i, j), b: id(i, j + 1), pts: [[i * 100, j * 100], [i * 100, j * 100 + 100]], oneway: ow ? 1 : 0,
                speed: 11.1, major: bus, bus });
        }
    }
    // callejón sin salida (con vuelta en U) desde (2, N-1) hacia el norte, con una curva
    const top = (N - 1) * 100;
    nodePts.push([200, top + 90]);
    edges.push({ a: id(2, N - 1), b: N * N, pts: [[200, top], [200, top + 40], [215, top + 90]], oneway: 0, speed: 8.3 });
    const avenueNodes = new Set(Array.from({ length: N }, (_, i) => id(i, 3)));
    const g = buildLaneGraph(nodePts, edges, { signalAt: (n, deg) => avenueNodes.has(n) && deg >= 3 });
    g.deadEnd = N * N;
    return g;
}
export const GRID_FOCUS = { x: 400, y: 400, r: 800 };

/** Grafo ingenuo a partir del archivo real de calles (proyección equirectangular, cruces = vértices compartidos). */
export function makeRealGraph() {
    const file = '/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/real/calles.geojson';
    if (!existsSync(file)) return null;
    const fc = JSON.parse(readFileSync(file, 'utf8'));
    const feats = fc.features.filter((f) => f.geometry?.type === 'LineString' && !/pedestrian|footway|path|steps/.test(f.properties?.highway ?? ''));
    let lon0 = 0, lat0 = 0, n = 0;
    for (const f of feats) for (const [lo, la] of f.geometry.coordinates) { lon0 += lo; lat0 += la; n++; }
    lon0 /= n; lat0 /= n;
    const R = 6371008.8, k = Math.PI / 180;
    const toLocal = ([lo, la]) => [(lo - lon0) * k * R * Math.cos(lat0 * k), (la - lat0) * k * R];
    const key = ([lo, la]) => `${lo.toFixed(7)},${la.toFixed(7)}`;
    const uses = new Map();
    for (const f of feats) {
        const cs = f.geometry.coordinates;
        cs.forEach((c, i) => uses.set(key(c), (uses.get(key(c)) ?? 0) + (i === 0 || i === cs.length - 1 ? 2 : 1)));
    }
    const nodeIdx = new Map();
    const nodePts = [];
    const nodeOf = (c) => {
        const kk = key(c);
        if (!nodeIdx.has(kk)) { nodeIdx.set(kk, nodePts.length); nodePts.push(toLocal(c)); }
        return nodeIdx.get(kk);
    };
    const edges = [];
    for (const f of feats) {
        const hw = f.properties.highway ?? '';
        const major = /primary|secondary|trunk/.test(hw);
        const speed = /primary/.test(hw) ? 16.7 : /secondary/.test(hw) ? 13.9 : /service|living/.test(hw) ? 6.9 : 11.1;
        const cs = f.geometry.coordinates;
        let start = 0;
        for (let i = 1; i < cs.length; i++) {
            if (i === cs.length - 1 || uses.get(key(cs[i])) > 1) {
                const pts = cs.slice(start, i + 1).map(toLocal);
                const a = nodeOf(cs[start]), b = nodeOf(cs[i]);
                if (a !== b) edges.push({ a, b, pts, oneway: f.properties.oneway === 1 ? 1 : 0, speed, major, bus: major });
                start = i;
            }
        }
    }
    const g = buildLaneGraph(nodePts, edges, { signalAt: () => false });
    // semáforos donde se cruzan dos avenidas
    const majorDeg = new Array(g.nodes.length).fill(0);
    for (const l of g.lanes) if (l.major) majorDeg[l.to]++;
    g.nodes.forEach((nd, i) => { nd.signal = majorDeg[i] >= 3 && g.out[i].length >= 3; });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of nodePts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    g.bounds = { minX, minY, maxX, maxY };
    return g;
}

// ------------------------------------------------------------------ utilidades de prueba

function distToPolyline(pts, x, y) {
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
    }
    return best;
}

function checkInvariants(traffic, g, label) {
    // sin superposición en el mismo carril
    for (const [li, list] of traffic.laneLists.entries()) {
        const sorted = list.slice().sort((a, b) => b._s - a._s);
        for (let k = 1; k < sorted.length; k++) {
            const a = sorted[k - 1], b = sorted[k];
            const gap = a._s - b._s - a._half - b._half;
            assert.ok(gap > 0.5, `${label}: superposición en carril ${li}: hueco ${gap.toFixed(2)} m (${a.type} / ${b.type})`);
        }
    }
    for (const v of traffic.vehicles) {
        const w = traffic.where(v);
        assert.ok(w.lane >= 0 && w.lane < g.lanes.length, `${label}: carril inválido`);
        assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.heading), `${label}: posición inválida`);
        if (w.phase === 0) {
            assert.ok(w.s >= -1e-6 && w.s <= g.lanes[w.lane].len + 0.5, `${label}: s fuera del carril (${w.s} / ${g.lanes[w.lane].len})`);
            // su posición dibujada está sobre el carril (o en la boca del cruce)
            const d = distToPolyline(g.lanes[w.lane].pts, v.x, v.y);
            const nodeTo = g.nodes[g.lanes[w.lane].to], nodeFrom = g.nodes[g.lanes[w.lane].from];
            const nearNode = Math.min(Math.hypot(v.x - nodeTo.x, v.y - nodeTo.y), Math.hypot(v.x - nodeFrom.x, v.y - nodeFrom.y));
            assert.ok(d < 1.2 || nearNode < 16, `${label}: vehículo fuera del grafo (${d.toFixed(2)} m del carril)`);
        } else {
            assert.ok(w.conn && w.s >= 0 && w.s <= w.conn.len + 0.01, `${label}: fuera del conector`);
            const nd = g.nodes[g.lanes[w.conn.a].to];
            assert.ok(Math.hypot(v.x - nd.x, v.y - nd.y) < 25, `${label}: conector lejos del nodo`);
        }
        if (v.type === 'colectivo') {
            assert.ok(g.lanes[w.lane].bus, `${label}: colectivo fuera de carril de colectivos`);
            if (w.next >= 0) assert.ok(g.lanes[w.next].bus, `${label}: colectivo va a doblar a un carril sin colectivos`);
        }
    }
}

// ------------------------------------------------------------------ pruebas

test('la mezcla de vehículos respeta las proporciones de Formosa (±4 % en 2000 apariciones)', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 3, maxVehicles: 300 });
    let total = 0;
    let guard = 0;
    while (total < 2000 && guard++ < 200000) {
        // reciclar todo cada tanto obliga a aparecer muchos vehículos nuevos
        const far = guard % 40 === 0;
        t.step(0.25, 8, far ? { x: 99999, y: 99999, r: 10 } : { x: 400, y: 400, r: 450 });
        total = Object.values(t.spawned).reduce((a, b) => a + b, 0);
    }
    assert.ok(total >= 2000, `solo aparecieron ${total}`);
    for (const type of TYPES) {
        const share = t.spawned[type] / total;
        assert.ok(Math.abs(share - MIX[type]) <= 0.04, `${type}: ${(share * 100).toFixed(1)} % (esperado ${MIX[type] * 100} %)`);
    }
    assert.ok(Math.abs(Object.values(MIX).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('densidad: horas pico llenas, madrugada casi vacía', () => {
    for (const h of [7, 8, 9, 12, 12.5, 13, 18, 19, 20]) assert.equal(densityAt(h), 1, `pico a las ${h}`);
    for (const h of [1, 2, 3.5, 5]) assert.ok(densityAt(h) <= 0.06, `madrugada ${h}: ${densityAt(h)}`);
    for (const h of [10.5, 15, 16.5]) assert.ok(Math.abs(densityAt(h) - 0.75) < 0.05, `día ${h}: ${densityAt(h)}`); // G fase 5: día más cargado
    assert.ok(Math.abs(densityAt(22.5) - 0.35) < 0.05);
    assert.equal(densityAt(31), densityAt(7)); // da la vuelta
    for (let h = 0; h < 24; h += 0.1) {
        const d = densityAt(h);
        assert.ok(d >= 0 && d <= 1);
        assert.ok(Math.abs(densityAt(h + 0.1) - d) < 0.1, 'curva suave');
    }
});

function runScenario(g, { minutes = 10, seed = 1, maxVehicles = 300, focus, hours = 8, label }) {
    const t = createTraffic(g, { seed, maxVehicles, onEnterJunction: (v, node, st) => {
        assert.notEqual(st, 2, `${label}: ${v.type} entró al cruce ${node} en rojo`);
        entries++;
        if (st >= 0) signalEntries++;
    } });
    let entries = 0, signalEntries = 0;
    const dt = 1 / 30;
    const steps = Math.round((minutes * 60) / dt);
    let speedSum = 0, speedN = 0, maxCount = 0;
    for (let i = 0; i < steps; i++) {
        t.step(dt, hours, focus);
        if (i % 15 === 0) checkInvariants(t, g, label);
        if (i > 30 * 30) for (const v of t.vehicles) { speedSum += v.speed; speedN++; }
        maxCount = Math.max(maxCount, t.vehicles.length);
    }
    return { t, avgSpeed: speedSum / Math.max(1, speedN), entries, signalEntries, maxCount };
}

test('cuadrícula: 10 minutos sin choques, sin pasar en rojo, sin salirse del grafo y sin atasco general', () => {
    const g = makeGrid();
    const r = runScenario(g, { label: 'cuadrícula', focus: GRID_FOCUS });
    assert.ok(r.maxCount >= 280, `pocos vehículos: ${r.maxCount}`);
    assert.ok(r.avgSpeed > 3, `velocidad media ${r.avgSpeed.toFixed(2)} m/s`);
    assert.ok(r.entries > 1000 && r.signalEntries > 100, `cruces: ${r.entries}, con semáforo: ${r.signalEntries}`);
    console.log(`  cuadrícula: velocidad media ${r.avgSpeed.toFixed(2)} m/s, ${r.entries} entradas a cruces (${r.signalEntries} con semáforo)`);
});

test('callejón sin salida: se pega la vuelta en U y nadie queda trabado', () => {
    const g = makeGrid();
    const dead = g.lanes.findIndex((l) => l.to === g.deadEnd);
    assert.ok(dead >= 0);
    const t = createTraffic(g, { seed: 9, maxVehicles: 200 });
    let uturns = 0;
    const prev = new Map();
    for (let i = 0; i < 30 * 60 * 4; i++) {
        t.step(1 / 30, 8, GRID_FOCUS);
        for (const v of t.vehicles) {
            const w = t.where(v);
            if (prev.get(v) === dead && w.lane !== dead && w.phase === 0) uturns++;
            prev.set(v, w.phase === 0 ? w.lane : prev.get(v));
        }
    }
    assert.ok(uturns > 0, 'nadie volvió del callejón');
});

test('archivo real: 10 minutos sin choques ni salidas del grafo', { skip: !existsSync('/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/real/calles.geojson') }, () => {
    const g = makeRealGraph();
    const b = g.bounds;
    const focus = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, r: 800 };
    const r = runScenario(g, { label: 'real', focus, maxVehicles: 300 });
    assert.ok(r.avgSpeed > 2, `velocidad media ${r.avgSpeed.toFixed(2)} m/s`);
    console.log(`  real: ${g.lanes.length} carriles, velocidad media ${r.avgSpeed.toFixed(2)} m/s, máx ${r.maxCount} vehículos`);
    // todos dentro del foco
    for (const v of r.t.vehicles) assert.ok(Math.hypot(v.x - focus.x, v.y - focus.y) <= focus.r + 30);
});

test('ciudad grande, foco chico: el círculo se llena enseguida, también en el medio (G fase 5)', { skip: !existsSync('/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/real/calles.geojson') }, () => {
    const g = makeRealGraph();
    const b = g.bounds;
    const focus = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, r: 300 };
    const t = createTraffic(g, { seed: 3, maxVehicles: 150 });
    t.step(0.05, 12, focus);
    // antes se sorteaba entre todos los carriles de la ciudad y casi todo caía fuera del foco: arrancaba con 2
    // (cupo por área: ~450/km² × π·300² ≈ 127 de 150)
    assert.ok(t.vehicles.length >= 115, `al empezar hay ${t.vehicles.length}`);
    const centro = t.vehicles.filter((v) => Math.hypot(v.x - focus.x, v.y - focus.y) < 150).length;
    assert.ok(centro >= 15, `en los 150 m del medio hay ${centro}`);
    // el foco salta a otra parte: se rellena de una vez
    const otro = { x: focus.x + 900, y: focus.y - 400, r: 300 };
    t.step(0.05, 12, otro);
    t.step(0.05, 12, otro);
    assert.ok(t.vehicles.length >= 105, `después del salto hay ${t.vehicles.length}`);
    for (const v of t.vehicles) assert.ok(Math.hypot(v.x - otro.x, v.y - otro.y) <= otro.r + 30);
});

test('los colectivos esperan 8 s en semáforos y paradas, los camiones prefieren avenidas', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 5, maxVehicles: 300 });
    const stopped = new Map();
    let stops = 0, truckMajor = 0, truckTotal = 0;
    for (let i = 0; i < 30 * 300; i++) {
        t.step(1 / 30, 8, GRID_FOCUS);
        for (const v of t.vehicles) {
            if (v.type === 'colectivo') {
                const s = v.speed < 0.05 ? (stopped.get(v) ?? 0) + 1 / 30 : 0;
                if (s >= 7.9 && (stopped.get(v) ?? 0) < 7.9) stops++;
                stopped.set(v, s);
            }
            if (v.type === 'camion') { truckTotal++; if (g.lanes[t.where(v).lane].major) truckMajor++; }
        }
    }
    assert.ok(stops > 3, `paradas de colectivo: ${stops}`);
    const majorShare = g.lanes.filter((l) => l.major).reduce((a, l) => a + l.len, 0) / g.lanes.reduce((a, l) => a + l.len, 0);
    assert.ok(truckMajor / truckTotal > majorShare + 0.1, `camiones en avenidas ${(truckMajor / truckTotal).toFixed(2)} vs ${majorShare.toFixed(2)}`);
});

test('el foco: solo hay vehículos cerca y aparecen lejos de la vista', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 2, maxVehicles: 120 });
    const focus = { x: 0, y: 0, r: 300 };
    t.step(0.1, 12, focus);
    const seen = new Set(t.vehicles);
    for (let i = 0; i < 30 * 120; i++) {
        t.step(1 / 30, 12, focus);
        for (const v of t.vehicles) {
            assert.ok(Math.hypot(v.x, v.y) <= 300 + 20, 'fuera del foco');
            if (!seen.has(v)) {
                seen.add(v);
                assert.ok(Math.hypot(v.x, v.y) >= 0.6 * 300 - 1, `apareció a la vista (${Math.hypot(v.x, v.y).toFixed(0)} m)`);
            }
        }
    }
    // de madrugada casi no queda nadie (se van de a poco, fuera de la vista)
    for (let i = 0; i < 30 * 200; i++) t.step(1 / 30, 3, focus);
    assert.ok(t.vehicles.length <= Math.ceil(120 * 0.05) + 3, `de madrugada hay ${t.vehicles.length}`);
});

test('pasos largos (pestaña oculta) y dt raros no rompen nada', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 4, maxVehicles: 150 });
    for (const dt of [5, 0.25, 0, -1, NaN, 1e9, 0.016, 0.25, 0.25]) {
        t.step(dt, 8, GRID_FOCUS);
        checkInvariants(t, g, `dt=${dt}`);
    }
    for (let i = 0; i < 400; i++) t.step(0.25, 8, GRID_FOCUS);
    checkInvariants(t, g, 'dt=0.25');
});

test('mismo seed → mismo tránsito; otro seed → otro', () => {
    const g = makeGrid();
    const run = (seed) => {
        const t = createTraffic(g, { seed, maxVehicles: 150 });
        for (let i = 0; i < 30 * 40; i++) t.step(1 / 30, 8, GRID_FOCUS);
        return t.vehicles.map((v) => `${v.type}${v.color}${v.x.toFixed(3)},${v.y.toFixed(3)}`).sort().join('|');
    };
    assert.equal(run(7), run(7));
    assert.notEqual(run(7), run(8));
});

test('motos con acompañante (~30 %) y colores por tipo', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 11, maxVehicles: 400 });
    t.step(0.1, 8, GRID_FOCUS);
    const motos = t.vehicles.filter((v) => v.type === 'moto');
    const share = motos.filter((v) => v.passenger).length / motos.length;
    assert.ok(share > 0.18 && share < 0.42, `acompañante ${share}`);
    assert.ok(t.vehicles.every((v) => /^#[0-9a-f]{6}$/.test(v.color) && v.visible));
    assert.ok(t.vehicles.filter((v) => v.type !== 'moto').every((v) => !v.passenger));
});

test('autos estacionados: junto al cordón de calles menores, determinísticos', () => {
    const g = makeGrid();
    const a = parkedAlong(g, 0.4), b = parkedAlong(g, 0.4);
    assert.deepEqual(a, b);
    assert.ok(a.length > 50);
    assert.ok(parkedAlong(g, 0.8).length > a.length);
    assert.equal(parkedAlong(g, 0).length, 0);
    for (const p of a) {
        assert.ok(['auto', 'camioneta', 'moto'].includes(p.type));
        // sin dato de cordón (grafo sintético) el cordón queda al borde del carril: el auto va pegado a él, sin salirse de la calzada
        // (ancho/2 − medio auto − 25 cm ≈ 0,6 m a la derecha del carril), nunca en la avenida
        const lane = g.lanes.filter((l) => !l.major).reduce((best, l) => Math.min(best, distToPolyline(l.pts, p.x, p.y)), Infinity);
        assert.ok(lane > 0.2 && lane < 1.2, `distancia al carril ${lane}`);
    }
    // no se superponen
    const byKey = a.slice().sort((p, q) => p.x - q.x || p.y - q.y);
    for (let i = 0; i < byKey.length; i++) {
        for (let j = i + 1; j < byKey.length && byKey[j].x - byKey[i].x < 6; j++) {
            assert.ok(Math.hypot(byKey[i].x - byKey[j].x, byKey[i].y - byKey[j].y) > 1.4, 'estacionados encimados');
        }
    }
    assert.ok(createTraffic(g).parked.length > 0);
});

test('rendimiento: 300 vehículos, menos de 1 ms por paso', () => {
    const g = makeRealGraph() ?? makeGrid();
    const b = g.bounds ?? { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    const focus = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, r: 800 };
    const t = createTraffic(g, { seed: 1, maxVehicles: 300 });
    for (let i = 0; i < 600; i++) t.step(1 / 60, 8, focus);
    const N = 1200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) t.step(1 / 60, 8, focus);
    const ms = (performance.now() - t0) / N;
    console.log(`  paso con ${t.vehicles.length} vehículos: ${ms.toFixed(3)} ms`);
    assert.ok(t.vehicles.length >= 250);
    assert.ok(ms < 1, `${ms.toFixed(3)} ms por paso`);
});

test('mano única: nadie circula a contramano (rumbo = sentido del carril)', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 6, maxVehicles: 250 });
    let checked = 0;
    for (let i = 0; i < 30 * 240; i++) {
        t.step(1 / 30, 8, GRID_FOCUS);
        if (i % 10) continue;
        for (const v of t.vehicles) {
            const w = t.where(v);
            if (w.phase !== 0) continue;
            const lane = g.lanes[w.lane];
            // el sentido inverso de una calle de mano única no existe en el grafo; el rumbo debe seguir al carril
            let best = 1, bd = Infinity;
            for (let k = 1; k < lane.pts.length; k++) {
                const d = distToPolyline([lane.pts[k - 1], lane.pts[k]], v.x, v.y);
                if (d < bd) { bd = d; best = k; }
            }
            const a = lane.pts[best - 1], b = lane.pts[best];
            const dot = Math.cos(v.heading) * (b[0] - a[0]) + Math.sin(v.heading) * (b[1] - a[1]);
            if (bd < 1.2) { assert.ok(dot > 0, 'va a contramano'); checked++; }
        }
    }
    assert.ok(checked > 500);
    // y las calles de mano única realmente se usan
    const oneWay = g.lanes.filter((l, i) => !g.lanes.some((m) => m.from === l.to && m.to === l.from && Math.abs(m.len - l.len) < 20));
    assert.ok(oneWay.length > 10);
});

test('la cantidad se adapta al ÁREA del foco (densidad realista, sin embotellar el foco chico)', () => {
    const g = makeGrid();
    const settle = (r, hours = 12) => {
        const t = createTraffic(g, { seed: 8, maxVehicles: 320 });
        let spd = 0, n = 0;
        for (let i = 0; i < 30 * 70; i++) {
            t.step(1 / 30, hours, { x: 400, y: 400, r });
            if (i > 30 * 50) for (const v of t.vehicles) { spd += v.speed; n++; }
        }
        return { count: t.vehicles.length, avgSpeed: spd / Math.max(1, n) };
    };
    const chico = settle(250), grande = settle(500);
    // foco chico: limitado por el área (~450/km² → ~90), muy por debajo del tope de 320
    assert.ok(chico.count >= 70 && chico.count <= 160, `foco chico: ${chico.count}`);
    // foco grande: crece con el área hasta acercarse al tope
    assert.ok(grande.count >= 260, `foco grande: ${grande.count}`);
    assert.ok(grande.count > chico.count * 1.7, `no escaló con el área: ${chico.count} → ${grande.count}`);
    assert.ok(chico.count <= 320 && grande.count <= 320, 'pasó el tope maxVehicles');
    // antes, meter 320 en un foco de 250 m lo embotellaba (casi todos parados); ahora fluye
    assert.ok(chico.avgSpeed > 2.5, `foco chico embotellado: ${chico.avgSpeed.toFixed(2)} m/s`);
    console.log(`  área: r250 ${chico.count} veh @ ${chico.avgSpeed.toFixed(2)} m/s; r500 ${grande.count} veh @ ${grande.avgSpeed.toFixed(2)} m/s`);
});

test('rumbo para dibujar: sigue al movimiento, sin saltos ni giros de 180° entre cuadros', () => {
    const g = makeGrid();
    const t = createTraffic(g, { seed: 6, maxVehicles: 250 });
    const prev = new Map(); // id -> {x, y, heading}
    let checkedMotion = 0, checkedFrames = 0;
    for (let i = 0; i < 30 * 120; i++) {
        t.step(1 / 30, 8, GRID_FOCUS);
        for (const v of t.vehicles) {
            const p = prev.get(v.id); // la id es nueva al reciclar: no se compara entre vidas del objeto
            if (p) {
                const adiff = (a, b) => { const d = a - b; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };
                const dh = adiff(v.heading, p.heading);
                assert.ok(dh < 1.2, `salto de rumbo ${(dh * 180 / Math.PI).toFixed(0)}° (${v.type})`);
                checkedFrames++;
                const dx = v.x - p.x, dy = v.y - p.y, dist = Math.hypot(dx, dy);
                if (dist > 0.3 && t.where(v).phase === 0) {
                    const mh = Math.atan2(dy, dx);
                    const diff = adiff(v.heading, mh);
                    assert.ok(diff < 0.7, `rumbo ${(v.heading * 180 / Math.PI).toFixed(0)}° vs movimiento ${(mh * 180 / Math.PI).toFixed(0)}° (${v.type})`);
                    checkedMotion++;
                }
            }
            prev.set(v.id, { x: v.x, y: v.y, heading: v.heading });
        }
    }
    assert.ok(checkedMotion > 2000, `pocas muestras de movimiento: ${checkedMotion}`);
    assert.ok(checkedFrames > 20000, `pocos cuadros: ${checkedFrames}`);
});

test('la cantidad de vehículos activos sigue a la densidad horaria', () => {
    const g = makeGrid();
    const count = (hours) => {
        const t = createTraffic(g, { seed: 8, maxVehicles: 200 });
        for (let i = 0; i < 30 * 240; i++) t.step(1 / 30, hours, GRID_FOCUS);
        return t.vehicles.length;
    };
    const pico = count(8), dia = count(15), noche = count(22.5), madrugada = count(3);
    assert.ok(pico >= 180, `pico ${pico}`);
    assert.ok(Math.abs(dia - 150) <= 25, `día ${dia}`); // 0,75 × 200 (G fase 5)
    assert.ok(Math.abs(noche - 70) <= 25, `noche ${noche}`);
    assert.ok(madrugada <= 15, `madrugada ${madrugada}`);
    assert.ok(pico > dia && dia > noche && noche > madrugada);
});
