// Física de la ciudad 3D (workstream J): playas de estacionamiento, retranqueo de edificios, estacionados y paradas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeRoads, roadProfile, buildRoadNetwork } from '../../resources/js/map/city-roads.js';
import { buildLots, nearLot } from '../../resources/js/map/city-lots.js';
import { setbackFootprint, coverage } from '../../resources/js/map/city-footprint.js';
import { createTraffic, parkedAlong } from '../../resources/js/map/city-traffic.js';
import { buildCityData } from '../../resources/js/map/city-build.worker.js';

const ident = (c) => c;
const way = (coords, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

// distancia de un punto a una polilínea
function distTo(pts, x, y) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
    }
    return best;
}

/**
 * Barrio sintético: dos calles con nombre que se cruzan en el origen, un pasaje con nombre y la playa de un súper sobre la
 * calle A hecha con pasillos de servicio SIN nombre (anillo de 70 × 30 m con un pasillo del medio y un acceso a la calle).
 */
const LOOP = [[30, 20], [100, 20], [100, 50], [30, 50], [30, 20]];
const MID = [[30, 35], [100, 35]];
const STUB = [[65, 20], [65, 0]];
function barrio() {
    return normalizeRoads([
        way([[-160, 0], [160, 0]], { highway: 'residential', name: 'Calle A', surface: 'asphalt', osm_id: 1 }),
        way([[0, -160], [0, 160]], { highway: 'residential', name: 'Calle B', surface: 'asphalt', osm_id: 2 }),
        way([[-70, 0], [-70, -90]], { highway: 'service', name: 'Pasaje X', surface: 'asphalt', osm_id: 3 }),
        way(LOOP, { highway: 'service', name: null, surface: 'asphalt', osm_id: 4 }),
        way(MID, { highway: 'service', name: null, surface: 'asphalt', osm_id: 5 }),
        way(STUB, { highway: 'service', name: null, surface: 'asphalt', osm_id: 6 }),
    ], ident);
}
let cache = null;
const net = () => (cache ??= buildRoadNetwork(barrio(), { quality: 'media' }));

test('service sin nombre = pasillo de playa (sin vereda ni cordón); el pasaje con nombre sigue siendo calle', () => {
    const roads = barrio();
    const byId = (id) => roads.find((r) => r.id === id);
    assert.equal(byId(4).lot, true);
    assert.equal(byId(3).lot, false);
    const playa = roadProfile(byId(4));
    assert.equal(playa.sidewalk, 0);
    assert.equal(playa.kerb, false);
    assert.equal(playa.curb, 0);
    assert.equal(playa.centerLine, 'none');
    assert.ok(playa.carriageway <= 6);
    const pasaje = roadProfile(byId(3));
    assert.equal(pasaje.kerb, true);
    assert.ok(pasaje.sidewalk > 0);
});

test('los pasillos de playa no entran al grafo de carriles (el tránsito no circula) pero el pasaje con nombre sí', () => {
    const lg = net().laneGraph;
    for (const l of lg.lanes) {
        for (const [x, y] of l.pts) {
            for (const w of [LOOP, MID]) assert.ok(distTo(w, x, y) > 5, `carril sobre el pasillo de la playa en ${x.toFixed(1)},${y.toFixed(1)}`);
        }
    }
    assert.ok(lg.lanes.some((l) => l.pts.every(([x, y]) => Math.abs(x + 70) < 5 && y < -5)), 'el Pasaje X tiene carriles');
    // todos los nodos del grafo tienen algún carril (nada de nodos huérfanos de la playa)
    const used = new Set();
    for (const l of lg.lanes) { used.add(l.from); used.add(l.to); }
    assert.equal(used.size, lg.nodes.length);
});

test('sin mobiliario (farolas, árboles, carteles, semáforos) pegado a los pasillos de la playa', () => {
    const F = net().furniture;
    for (const k of ['streetTrees', 'lamps', 'signals', 'busStops', 'benches', 'signs']) {
        for (const p of F[k]) for (const w of [LOOP, MID]) assert.ok(distTo(w, p.x, p.y) > 4, `${k} en la playa (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    }
    // las calles de verdad conservan sus farolas y árboles
    assert.ok(F.lamps.length > 5 && F.streetTrees.length > 10);
});

test('la playa se pavimenta entre pasillos, con cajones alineados y autos adentro de las islas', () => {
    const n = net();
    const cars = n.furniture.lotCars;
    assert.ok(cars.length >= 8, `autos en la playa: ${cars.length}`);
    for (const c of cars) {
        assert.ok(c.x > 30 && c.x < 100 && c.y > 20 && c.y < 50, 'auto dentro del anillo de la playa');
        // ni sobre un pasillo (queda dentro de un cajón, a ≥ 2,5 + medio cajón del eje)
        for (const w of [LOOP, MID]) assert.ok(distTo(w, c.x, c.y) > 2.6, 'auto sobre el asfalto del pasillo');
        // cajones perpendiculares a los pasillos (que acá son horizontales): el auto apunta en y
        assert.ok(Math.abs(c.dirX) < 0.01 && Math.abs(Math.abs(c.dirY) - 1) < 0.01, 'auto alineado con el cajón');
    }
    assert.ok(n.query.lotNear(65, 35, 0) && !n.query.lotNear(-70, -50, 5));
    // hay asfalto de relleno (z = 0,026) y líneas de cajones
    const pos = n.builders.ground.pos;
    let fill = 0;
    for (let i = 2; i < pos.length; i += 3) if (Math.abs(pos[i] - 0.026) < 1e-6) fill++;
    assert.ok(fill > 60, `triángulos del relleno: ${fill}`);
});

test('buildLots: sólo se pavimenta lo encerrado; un pasillo suelto no inventa lote; edificios y calles no se pisan', () => {
    const ways = [{ pts: LOOP, w: 2.5 }, { pts: MID, w: 2.5 }];
    const L = buildLots(ways);
    assert.ok(L.fills.length && L.stalls.length && L.cars.length);
    const inFill = (x, y) => L.fills.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d);
    for (const s of L.stalls) assert.ok(inFill(s.x, s.y), 'cajón dentro del relleno');
    // pasillo solo
    assert.equal(buildLots([{ pts: [[0, 0], [80, 0]], w: 2.5 }]).fills.length, 0);
    // un edificio adentro: no se pavimenta ni se estaciona sobre él
    const building = (x, y) => x > 50 && x < 60 && y > 22 && y < 33;
    const B = buildLots(ways, { blocked: building });
    for (const s of B.stalls) assert.ok(!building(s.x, s.y));
    for (const c of B.cars) assert.ok(!building(c.x, c.y));
    for (const [a, b, c, d] of B.fills) assert.ok(!building((a + c) / 2, (b + d) / 2));
    assert.equal(nearLot([{ minX: 0, minY: 0, maxX: 10, maxY: 10 }], 12, 5, 3), true);
    assert.equal(nearLot([{ minX: 0, minY: 0, maxX: 10, maxY: 10 }], 20, 5, 3), false);
});

test('un pasillo de playa que es el único acceso entre dos conjuntos de calles sí queda en el grafo', () => {
    const roads = normalizeRoads([
        way([[-100, 0], [100, 0]], { highway: 'residential', name: 'Calle A', osm_id: 1 }),
        way([[150, 100], [250, 100]], { highway: 'residential', name: 'Calle D', osm_id: 2 }),
        way([[100, 0], [150, 100]], { highway: 'service', name: null, osm_id: 3 }),
    ], ident);
    const lg = buildRoadNetwork(roads).laneGraph;
    assert.ok(lg.lanes.some((l) => l.len > 105 && l.len < 125 && l.pts.some(([x]) => x > 140)), 'el acceso (≈112 m) quedó en el grafo');
    // pero un pasillo que sólo une dos puntos de la MISMA red (atajo por la playa) no
    const atajo = normalizeRoads([
        way([[-100, 0], [100, 0]], { highway: 'residential', name: 'Calle A', osm_id: 1 }),
        way([[-100, 0], [-100, 60], [100, 60], [100, 0]], { highway: 'residential', name: 'Calle E', osm_id: 2 }),
        way([[0, 0], [0, 60]], { highway: 'service', name: null, osm_id: 3 }),
    ], ident);
    const lg2 = buildRoadNetwork(atajo).laneGraph;
    assert.ok(!lg2.lanes.some((l) => l.pts.every(([x]) => Math.abs(x) < 4) && l.len > 20), 'el atajo por la playa no tiene carriles');
});

test('estacionados: dentro de la calzada (no en la vereda), a ≥ 8 m de los cruces, orientados con la marcha', () => {
    const n = net();
    const park = parkedAlong(n.laneGraph, 0.9);
    assert.ok(park.length > 20, `estacionados ${park.length}`);
    for (const p of park) {
        const c = Math.cos(p.heading), s = Math.sin(p.heading);
        const L = p.type === 'moto' ? 1 : 2.1, hw = p.type === 'moto' ? 0.5 : 0.95;
        for (const [a, b] of [[L, hw], [L, -hw], [-L, hw], [-L, -hw]]) {
            assert.ok(n.debug.onCarriageway(p.x + c * a - s * b, p.y + s * a + c * b, 0), `${p.type} con una esquina fuera de la calzada en ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
        }
        for (const it of n.intersections) assert.ok(Math.hypot(it.x - p.x, it.y - p.y) >= 8, 'estacionado a menos de 8 m del cruce');
        for (const w of [LOOP, MID]) assert.ok(distTo(w, p.x, p.y) > 5, 'estacionado en la playa');
    }
    // el pasaje angosto (4,5 m) no tiene lugar para estacionar
    assert.ok(!park.some((p) => Math.abs(p.x + 70) < 6 && p.y < -5));
});

test('estacionados: respetan el dato de cordón y el recorte de los cruces del carril', () => {
    const pts = [[0, 0], [100, 0]];
    const lane = (extra) => ({ from: 0, to: 1, pts, len: 100, speed: 8, major: false, bus: false, width: 3.5, ...extra });
    const g = (l) => ({ nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }], lanes: [l], out: [[0], []] });
    assert.equal(parkedAlong(g(lane({ park: 0 })), 1).length, 0, 'sin lugar: nada');
    const p = parkedAlong(g(lane({ park: 2.1, t0: 20, t1: 20 })), 1);
    assert.ok(p.length > 3);
    for (const a of p) {
        assert.ok(a.x >= 28.5 - 1.3 && a.x <= 100 - 28.5 + 1.3, `x=${a.x}`);
        assert.ok(Math.abs(a.y + (2.1 - (a.type === 'moto' ? 0.75 : a.type === 'camioneta' ? 1.23 : 1.15))) < 1e-6, 'a la derecha, pegado al cordón sin pasarse');
    }
});

test('el tránsito en marcha y los estacionados no se pisan ni salen de la calzada', () => {
    const n = net();
    const tr = createTraffic(n.laneGraph, { seed: 3, maxVehicles: 80 });
    const focus = { x: 0, y: 0, r: 300 };
    let seen = 0;
    for (let t = 0; t < 60 * 20; t++) {
        tr.step(1 / 10, 12, focus);
        if (t % 10) continue;
        for (const v of tr.vehicles) {
            if (!v.visible) continue;
            seen++;
            assert.ok(n.debug.onCarriageway(v.x, v.y, 0.3), `vehículo fuera de la calzada en ${v.x.toFixed(1)},${v.y.toFixed(1)}`);
            for (const w of [LOOP, MID]) assert.ok(distTo(w, v.x, v.y) > 4, 'vehículo en la playa');
            for (const p of tr.parked) assert.ok(Math.hypot(p.x - v.x, p.y - v.y) > 1.5, 'vehículo encima de un estacionado');
        }
    }
    assert.ok(seen > 100, `muestras ${seen}`);
});

test('colectivos: sólo se detienen en las paradas reales del carril, no en cualquier lado', () => {
    const lane = (from, to, pts, extra = {}) => ({ from, to, pts, len: 400, speed: 12, major: true, bus: true, width: 3.5, ...extra });
    const mk = (stops) => ({
        nodes: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
        lanes: [lane(0, 1, [[0, 0], [400, 0]], { stops }), lane(1, 0, [[400, 0], [0, 0]])],
        out: [[0], [1]],
    });
    const run = (g) => {
        const tr = createTraffic(g, { seed: 5, maxVehicles: 200 });
        let dwell = 0, buses = 0;
        const stopsAt = [];
        for (let t = 0; t < 3000; t++) {
            tr.step(0.1, 12, { x: 200, y: 0, r: 600 });
            for (const v of tr.vehicles) {
                if (v.type !== 'colectivo') continue;
                buses++;
                if (v._dwell > 0) { dwell++; stopsAt.push(v.x); }
            }
        }
        return { dwell, buses, stopsAt };
    };
    const sin = run(mk(null));
    assert.ok(sin.buses > 0, 'hay colectivos en la simulación');
    assert.equal(sin.dwell, 0, 'sin paradas no hay detenciones');
    const con = run(mk([200]));
    assert.ok(con.dwell > 0, 'con parada se detienen');
    for (const x of con.stopsAt) assert.ok(Math.abs(x - 200) < 3.5, `detenido en x=${x}`);
});

// ------------------------------------------------------------------ retranqueo de huellas

test('retranqueo: una huella libre no se toca', () => {
    const ring = [[10, 10], [22, 10], [22, 20], [10, 20]];
    const r = setbackFootprint(ring, net().query);
    assert.equal(r.status, 'ok');
    assert.equal(r.ring, ring);
});

test('retranqueo: la huella que pisa la calzada se recorta contra la calle (misma propiedad, sin pisar el asfalto)', () => {
    const n = net();
    const ring = [[-26, -1], [-14, -1], [-14, 11], [-26, 11]]; // 12 × 12 sobre la calle A (calzada |y| < 4,25)
    const blocked = (x, y) => n.query.onAsphalt(x, y, 0.3);
    assert.ok(coverage(ring, blocked) > 0.1, 'antes pisaba la calzada');
    const r = setbackFootprint(ring, n.query);
    assert.equal(r.status, 'recortada');
    assert.equal(coverage(r.ring, blocked), 0);
    const area = (p) => Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
    assert.ok(area(r.ring) >= 144 * 0.35 && area(r.ring) < 144, `área ${area(r.ring)}`);
    assert.ok(r.ring.every(([x, y]) => x > -27 && x < -13 && y > 4 && y < 11.5), 'sigue siendo la misma huella, sólo recortada del lado de la calle');
});

test('retranqueo: el comercio de 12 × 12 puesto sobre la calzada o el cruce pasa a una caja chica afuera del asfalto', () => {
    const n = net();
    const blocked = (x, y) => n.query.onAsphalt(x, y, 0.3);
    for (const [cx, cy] of [[40, 0], [0, 0], [4, 4]]) {
        const ring = [[cx - 6, cy - 6], [cx + 6, cy - 6], [cx + 6, cy + 6], [cx - 6, cy + 6]];
        const r = setbackFootprint(ring, n.query);
        assert.notEqual(r.status, 'ok', `${cx},${cy}`);
        assert.equal(coverage(r.ring, blocked), 0, `${cx},${cy} sigue sobre el asfalto (${r.status})`);
        assert.ok(r.ring.length >= 3 && r.moved < 31);
    }
});

test('retranqueo en el armado: la propiedad sobre la calle se conserva (id, color, picking) y queda fuera de la calzada', () => {
    const origin = [-58.178, -26.183];
    const dLat = 1 / 110540, dLng = 1 / (111320 * Math.cos((origin[1] * Math.PI) / 180));
    const sq = (cx, cy, s) => [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s], [cx - s, cy - s]].flat();
    const rings = [sq(0, 0, 6), sq(40, 30, 6), sq(-40, -30, 6)]; // la primera, justo en el cruce
    const ids = [11, 12, 13], coords = [], offsets = [0];
    for (const r of rings) {
        for (let i = 0; i < r.length; i += 2) coords.push(origin[0] + r[i] * dLng, origin[1] + r[i + 1] * dLat);
        offsets.push(offsets.at(-1) + r.length / 2);
    }
    const line = (a, b, name, id) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] + a[0] * dLng, origin[1] + a[1] * dLat], [origin[0] + b[0] * dLng, origin[1] + b[1] * dLat]] }, properties: { highway: 'residential', name, osm_id: id } });
    const { result } = buildCityData({
        seq: 1, origin, quality: 'baja', furniture: true, environment: [],
        roadFeatures: [line([-120, 0], [120, 0], 'A', 1), line([0, -120], [0, 120], 'B', 2)],
        buildings: { ids: Float64Array.from(ids), kinds: Uint8Array.from([1, 0, 0]), areas: Float64Array.from([144, 144, 144]), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), visible: Uint8Array.from([1, 1, 1]), roofs: [] },
    });
    assert.equal(result.layers.error, undefined, result.layers.error);
    assert.equal(result.buildings, 3, 'no se borra ninguna propiedad');
    assert.ok(result.retranqueadas >= 1, `retranqueadas ${result.retranqueadas}`);
    assert.deepEqual(result.defaults.map(([id]) => id).sort(), ids, 'cada id conserva su techo (color / picking)');
    // ningún vértice de pared sobre el asfalto (la calle A/B es de 8,5 m: |y| < 4,25 o |x| < 4,25)
    for (const c of result.chunks) {
        for (const m of c.meshes) {
            if (m.kind !== 'walls' && m.kind !== 'plain') continue;
            const pos = m.arrays.pos;
            for (let i = 0; i < pos.length; i += 3) {
                if (pos[i + 2] > 6) continue;
                const x = pos[i], y = pos[i + 1];
                const hit = (Math.abs(y) < 4 && Math.abs(x) < 118) || (Math.abs(x) < 4 && Math.abs(y) < 118);
                assert.ok(!hit, `${m.kind} sobre el asfalto en ${x.toFixed(1)},${y.toFixed(1)}`);
            }
        }
    }
});

// ------------------------------------------------------------------ datos reales (si están)

const MUESTRA = '/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/ft-test/storage/app/private/formosa/muestra.json';
test('datos reales: tras el retranqueo ninguna propiedad pisa > 5 % de calzada o cruce; estacionados y tránsito dentro de la calzada', { skip: !existsSync(MUESTRA) && 'sin muestra real' }, (t) => {
    const d = JSON.parse(readFileSync(MUESTRA, 'utf8'));
    const feats = d.roads.features;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of feats) for (const [x, y] of f.geometry.coordinates) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const lng0 = (x0 + x1) / 2, lat0 = (y0 + y1) / 2, k = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const toLocal = ([x, y]) => [(x - lng0) * k, (y - lat0) * 110540];
    const signals = d.environment.features.filter((f) => f.properties.kind === 'signal').map((f) => toLocal(f.geometry.coordinates));
    const n = buildRoadNetwork(normalizeRoads(feats, toLocal), { signals, quality: 'media' });
    const strict = (x, y) => n.query.onAsphalt(x, y, 0.3);
    let moved = 0, worst = 0;
    for (const p of d.properties) {
        const ring = p.geometry.coordinates[0].slice(0, -1).map(toLocal);
        const r = setbackFootprint(ring, n.query);
        if (r.status !== 'ok') moved++;
        const c = coverage(r.ring, strict);
        worst = Math.max(worst, c);
        assert.ok(c <= 0.05, `propiedad ${p.id} (${p.kind}) con ${(c * 100).toFixed(0)} % sobre el asfalto`);
    }
    t.diagnostic(`${d.properties.length} propiedades, ${moved} retranqueadas, peor cobertura ${(worst * 100).toFixed(1)} %`);
    // estacionados
    const parked = parkedAlong(n.laneGraph, 0.35);
    let bad = 0;
    for (const p of parked) {
        const c = Math.cos(p.heading), s = Math.sin(p.heading);
        const L = p.type === 'moto' ? 1 : 2.1, hw = p.type === 'moto' ? 0.5 : 0.95;
        if (![[L, hw], [L, -hw], [-L, hw], [-L, -hw]].every(([a, b]) => n.debug.onCarriageway(p.x + c * a - s * b, p.y + s * a + c * b, 0.05))) bad++;
        for (const it of n.intersections) assert.ok(Math.hypot(it.x - p.x, it.y - p.y) >= 8);
    }
    assert.ok(bad <= parked.length * 0.005, `estacionados con una esquina fuera de la calzada: ${bad}/${parked.length}`);
    // sin carriles ni mobiliario en las playas
    const lots = normalizeRoads(feats, toLocal).filter((r) => r.lot);
    assert.ok(lots.length > 20, `pasillos de playa ${lots.length}`);
    t.diagnostic(`pasillos de playa ${lots.length}, autos de playa ${n.furniture.lotCars.length}, estacionados ${parked.length}`);
});

test('semáforo: los autos esperan en la línea de detención, antes del cruce y de la senda (no en el medio)', () => {
    const n = buildRoadNetwork(barrio(), { signals: [{ x: 0, y: 0 }], quality: 'media' });
    const lg = n.laneGraph;
    assert.ok(lg.nodes.some((nd) => nd.signal), 'hay un semáforo');
    const tr = createTraffic(lg, { seed: 4, maxVehicles: 200 });
    let rojo = 0;
    for (let t = 0; t < 10 * 400; t++) {
        tr.step(0.1, 12, { x: 0, y: 0, r: 250 });
        for (const v of tr.vehicles) {
            if (v._why !== 'rojo' || v._phase !== 0 || v._box >= 0 || v.speed > 0.2) continue;
            const l = lg.lanes[v._lane];
            rojo++;
            const frente = l.len - v._s - v._half; // del paragolpes al nodo
            assert.ok(frente >= l.t1 + 1, `parado en rojo a ${frente.toFixed(1)} m del nodo (el cruce empieza a ${l.t1.toFixed(1)} m)`);
        }
    }
    assert.ok(rojo > 20, `autos parados en rojo observados: ${rojo}`);
});
