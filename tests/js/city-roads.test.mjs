import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { MeshBuilder } from '../../resources/js/map/city-geometry.js';
import { normalizeRoads, roadProfile, buildRoadNetwork } from '../../resources/js/map/city-roads.js';

// ------------------------------------------------------------------ datos de prueba

const ident = (c) => c;
const way = (coords, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

/**
 * Réplica en metros locales de las calles del barrio demo (app/Formosa/DemoDistrict.php): grilla de 8×6 manzanas de 100 m
 * con calles cada 120 m; el bulevar "Avenida 25 de Mayo" son dos vías de mano única a 14 m (este por el sur, oeste por el norte);
 * la peatonal Rivadavia termina en la plaza; la "Avenida Costanera" es una sola vía en L (borde norte y este); V2 y V8 de tierra.
 * Las vías del demo tienen dos puntos y se cruzan a mitad de segmento (sin nodo compartido).
 */
function demo() {
    const pitch = 120, half = 10, BX = 8, BY = 6, GAP = 14;
    const width = BX * pitch - 20, top = BY * pitch - half, east = BX * pitch - half;
    const f = [];
    let id = 5000000;
    const add = (coords, p) => f.push(way(coords, { osm_id: ++id, ...p }));
    for (let by = 0; by < BY; by++) {
        const y = by * pitch - half;
        if (by === 5) {
            const t = { highway: 'primary', name: 'Avenida 25 de Mayo', oneway: 1, lanes: 2, surface: 'asphalt', maxspeed: 40, width: 7 };
            add([[-half, y - GAP / 2], [width + half, y - GAP / 2]], t);
            add([[width + half, y + GAP / 2], [-half, y + GAP / 2]], t);
            continue;
        }
        const t = by % 3 === 0
            ? { highway: 'primary', name: `Calle ${by + 1}`, surface: 'asphalt', lanes: 2, maxspeed: 40 }
            : { highway: 'residential', name: `Calle ${by + 1}`, surface: 'asphalt' };
        add([[-half, y], [width + half, y]], t);
    }
    for (let bx = 0; bx < BX; bx++) {
        const x = bx * pitch - half;
        if (bx === 4) {
            add([[x, -half], [x, 4 * pitch - half]], { highway: 'pedestrian', name: 'Rivadavia', surface: 'paving_stones' });
            continue;
        }
        const t = bx === 0 ? { highway: 'secondary', name: 'Calle V1', surface: 'asphalt', maxspeed: 40 }
            : [1, 7].includes(bx) ? { highway: 'residential', name: `Calle V${bx + 1}`, surface: 'unpaved' }
                : { highway: 'residential', name: `Calle V${bx + 1}`, surface: 'asphalt' };
        add([[x, -half], [x, top]], t);
    }
    add([[-half, top], [east, top], [east, -half]], { highway: 'secondary', name: 'Avenida Costanera', surface: 'asphalt', lanes: 2, maxspeed: 60 });
    const by5 = 5 * pitch - half;
    return {
        features: f,
        signals: [1, 2, 3, 5, 6, 7].map((bx) => ({ x: bx * pitch - half, y: by5 })),
        busStops: [[60, by5 - GAP / 2 - 6], [300, by5 - GAP / 2 - 6], [780, by5 + GAP / 2 + 6], [-half + 6, 300]],
    };
}

const DEMO = demo();
const demoRoads = () => normalizeRoads(DEMO.features, ident);
let demoCache = null;
const demoNet = () => (demoCache ??= buildRoadNetwork(demoRoads(), { signals: DEMO.signals, busStops: DEMO.busStops }));

const REAL = '/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/real/calles.geojson';
const HAS_REAL = existsSync(REAL);
function realRoads() {
    const gj = JSON.parse(readFileSync(REAL, 'utf8'));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of gj.features) {
        for (const [x, y] of f.geometry.coordinates) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    const lng0 = (x0 + x1) / 2, lat0 = (y0 + y1) / 2, k = Math.cos((lat0 * Math.PI) / 180) * 111320;
    return normalizeRoads(gj, ([x, y]) => [(x - lng0) * k, (y - lat0) * 110540]);
}
let realCache = null;
const realNet = () => (realCache ??= buildRoadNetwork(realRoads()));

// ------------------------------------------------------------------ utilidades de los tests

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const near = (c, h, tol = 0.09) => hex(h).every((v, i) => Math.abs(v - c[i]) < tol);

/** Triángulos horizontales (mirando arriba) de un MeshBuilder: [{ z, cx, cy, col, pts }]. */
function flatTris(mb) {
    const out = [];
    for (let i = 0; i < mb.pos.length; i += 9) {
        if (mb.nor[i + 2] < 0.9) continue;
        const pts = [[mb.pos[i], mb.pos[i + 1]], [mb.pos[i + 3], mb.pos[i + 4]], [mb.pos[i + 6], mb.pos[i + 7]]];
        out.push({ z: mb.pos[i + 2], cx: (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy: (pts[0][1] + pts[1][1] + pts[2][1]) / 3, col: [mb.col[i], mb.col[i + 1], mb.col[i + 2]], pts });
    }
    return out;
}

function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
    return Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py);
}

/** Distancia al borde del polígono (para no contar triángulos que solo tocan el borde). */
function distToRing(x, y, poly) {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(x, y, poly[i], poly[(i + 1) % poly.length]));
    return d;
}

/** Índice simple por grilla de los polígonos de los cruces. */
function polyIndex(polys, cell = 25) {
    const m = new Map();
    polys.forEach((p, i) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++) {
            for (let iy = Math.floor(y0 / cell); iy <= Math.floor(y1 / cell); iy++) {
                const k = `${ix},${iy}`;
                if (!m.has(k)) m.set(k, []);
                m.get(k).push(i);
            }
        }
    });
    return (x, y) => (m.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []).map((i) => polys[i]);
}

/** Calzada (independiente de la consulta del módulo): distancia al eje de cada tramo menor que su medio ancho. */
function carriagewayIndex(net, cell = 25) {
    const m = new Map();
    for (const e of net.debug.edges) {
        if (e.pedestrian) continue;
        for (let i = 0; i + 1 < e.pts.length; i++) {
            const a = e.pts[i], b = e.pts[i + 1];
            const r = e.w + 1;
            for (let ix = Math.floor((Math.min(a[0], b[0]) - r) / cell); ix <= Math.floor((Math.max(a[0], b[0]) + r) / cell); ix++) {
                for (let iy = Math.floor((Math.min(a[1], b[1]) - r) / cell); iy <= Math.floor((Math.max(a[1], b[1]) + r) / cell); iy++) {
                    const k = `${ix},${iy}`;
                    if (!m.has(k)) m.set(k, []);
                    m.get(k).push([a, b, e.w]);
                }
            }
        }
    }
    const junctions = polyIndex(net.debug.junctionPolys);
    return (x, y) => {
        for (const [a, b, w] of m.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []) if (segDist(x, y, a, b) < w - 0.05) return true;
        return junctions(x, y).some((p) => pointInPoly(x, y, p) && distToRing(x, y, p) > 0.05);
    };
}

// ------------------------------------------------------------------ normalización y perfiles

test('normalizeRoads: lng/lat → metros, campos nuevos opcionales y MultiLineString', () => {
    const fc = {
        type: 'FeatureCollection',
        features: [
            way([[0, 0], [0.001, 0]], { highway: 'residential', name: 'Viejo' }),
            way([[0, 0], [0, 0.001]], { highway: 'primary', name: 'Av', oneway: -1, lanes: 3, width: 10.5, surface: 'asphalt', maxspeed: 60, junction: null, bridge: false, osm_id: 77 }),
            { type: 'Feature', properties: { highway: 'track', osm_id: 5 }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [0.002, 0]], [[0, 0.002], [0.002, 0.002]]] } },
            way([[0, 0], [0, 0]], { highway: 'residential' }), // degenerada: se descarta
        ],
    };
    const roads = normalizeRoads(fc, ([lng, lat]) => [lng * 100000, lat * 110000]);
    assert.equal(roads.length, 4);
    const [viejo, av, t1, t2] = roads;
    assert.deepEqual(viejo.coords, [[0, 0], [100, 0]]);
    assert.equal(viejo.oneway, 0);
    assert.equal(viejo.lanes, null);
    assert.equal(viejo.width, null);
    assert.equal(viejo.surface, null);
    assert.equal(viejo.major, false);
    assert.equal(av.oneway, -1);
    assert.equal(av.lanes, 3);
    assert.equal(av.width, 10.5);
    assert.equal(av.maxspeed, 60);
    assert.equal(av.major, true);
    assert.equal(av.id, 77);
    assert.equal(t1.unpaved, true);
    assert.notEqual(t1.id, t2.id);
    for (const r of roads) for (const k of ['id', 'coords', 'highway', 'name', 'oneway', 'lanes', 'width', 'surface', 'major', 'pedestrian', 'service', 'unpaved', 'maxspeed']) assert.ok(k in r, k);
    // también acepta el arreglo de features y oneway como texto de OSM
    const r2 = normalizeRoads([way([[0, 0], [1, 1]], { highway: 'residential', oneway: 'yes' })], ident);
    assert.equal(r2[0].oneway, 1);
    const r3 = normalizeRoads([way([[0, 0], [1, 1]], { highway: 'secondary', junction: 'roundabout' })], ident);
    assert.equal(r3[0].oneway, 1, 'las rotondas son de mano única');
});

test('perfiles: calle común, servicio, avenida, tierra y peatonal', () => {
    const P = (props) => roadProfile(normalizeRoads([way([[0, 0], [100, 0]], props)], ident)[0]);

    const calle = P({ highway: 'residential' });
    assert.ok(calle.carriageway >= 8 && calle.carriageway <= 9, `calle ${calle.carriageway}`);
    assert.equal(calle.sidewalk, 3);
    assert.equal(calle.curb, 0.15);
    assert.equal(calle.kerb, true);
    assert.equal(calle.centerLine, 'single');
    assert.equal(calle.surface, 'asphalt');
    assert.equal(P({ highway: 'tertiary' }).carriageway, 9);
    assert.equal(P({ highway: 'residential', oneway: 1 }).centerLine, 'none');

    const serv = P({ highway: 'service' });
    assert.ok(serv.carriageway >= 4 && serv.carriageway <= 5);
    assert.equal(serv.centerLine, 'none');
    assert.ok(serv.sidewalk <= 1);

    const av = P({ highway: 'primary' });
    assert.equal(av.carriageway, 14);
    assert.equal(av.centerLine, 'double');
    assert.equal(av.lanesPerDir, 2);
    assert.equal(P({ highway: 'secondary' }).carriageway, 14);
    assert.equal(P({ highway: 'trunk', lanes: 6 }).lanesPerDir, 3);
    assert.equal(P({ highway: 'trunk', lanes: 6 }).carriageway, 21);
    const avMano = P({ highway: 'primary', oneway: 1 });
    assert.equal(avMano.centerLine, 'none');
    assert.equal(avMano.carriageway, 7);

    for (const props of [{ highway: 'residential', surface: 'dirt' }, { highway: 'residential', surface: 'unpaved' }, { highway: 'track' }, { highway: 'residential', surface: 'gravel' }, { highway: 'residential', surface: 'ground' }]) {
        const t = P(props);
        assert.equal(t.surface, 'dirt', JSON.stringify(props));
        assert.equal(t.kerb, false);
        assert.equal(t.curb, 0);
        assert.equal(t.centerLine, 'none');
    }

    for (const hw of ['pedestrian', 'living_street']) {
        const pe = P({ highway: hw, name: 'Rivadavia' });
        assert.equal(pe.surface, 'paving');
        assert.equal(pe.kerb, false);
        assert.equal(pe.sidewalk, 0);
        assert.equal(pe.lanesPerDir, 0);
        assert.equal(pe.centerLine, 'none');
    }

    // ancho y carriles de OSM mandan
    assert.equal(P({ highway: 'residential', width: 6 }).carriageway, 6);
    assert.equal(P({ highway: 'residential', lanes: 4 }).lanesPerDir, 2);
    assert.equal(P({ highway: 'residential', surface: 'concrete' }).surface, 'concrete');
    assert.equal(P({ highway: 'residential', surface: 'sett' }).surface, 'cobble');
});

// ------------------------------------------------------------------ pares de avenidas (bulevares)

test('bulevar: dos manos únicas paralelas con el mismo nombre se detectan como par y llevan cantero con palmeras', () => {
    const t = { highway: 'primary', name: 'Avenida 25 de Mayo', oneway: 1, lanes: 2 };
    const roads = normalizeRoads([
        way([[0, -7], [400, -7]], t),
        way([[400, 7], [0, 7]], t),
        way([[200, -150], [200, 150]], { highway: 'residential', name: 'Cruce' }),
        // dos calles comunes paralelas a 14 m: no son par
        way([[0, 300], [400, 300]], { highway: 'residential', name: 'A' }),
        way([[0, 314], [400, 314]], { highway: 'residential', name: 'A' }),
        // dos avenidas de distinto nombre: no son par
        way([[0, 500], [400, 500]], { highway: 'primary', name: 'Uno', oneway: 1 }),
        way([[400, 514], [0, 514]], { highway: 'primary', name: 'Otro', oneway: 1 }),
        // la misma avenida pero a 60 m: no es par
        way([[0, 700], [400, 700]], { highway: 'primary', name: 'Lejos', oneway: 1 }),
        way([[400, 760], [0, 760]], { highway: 'primary', name: 'Lejos', oneway: 1 }),
    ], ident);
    const net = buildRoadNetwork(roads);
    assert.equal(net.pairs.length, 1, 'un solo par');
    assert.deepEqual(net.pairs[0].map((r) => r.name), ['Avenida 25 de Mayo', 'Avenida 25 de Mayo']);
    // árboles del cantero en el medio (y = 0), lejos del cruce
    const palmeras = net.furniture.streetTrees.filter((p) => p.context === 'cantero');
    assert.ok(palmeras.length >= 30, `palmeras ${palmeras.length}`);
    for (const p of palmeras) assert.ok(Math.abs(p.y) < 1.5, `palmera fuera del cantero en ${p.y}`);
    // el cantero es verde y elevado entre las dos manos
    const cantero = flatTris(net.builders.ground).filter((t2) => near(t2.col, '#6aa152', 0.03) && t2.z > 0.1);
    assert.ok(cantero.length > 0);
    for (const t2 of cantero) assert.ok(Math.abs(t2.cy) < 4, `cantero en ${t2.cy}`);
    // las calzadas no pisan el cantero: nada de asfalto entre y = −3 y 3 salvo en el cruce
    const asf = flatTris(net.builders.ground).filter((t2) => near(t2.col, '#33384a', 0.02) && Math.abs(t2.cy) < 3 && Math.abs(t2.cx - 200) > 20);
    assert.equal(asf.length, 0);
});

test('bulevar del demo: par detectado, cantero de 7 m y semáforos en los cruces', () => {
    const net = demoNet();
    const names = net.pairs.map(([a, b]) => `${a.name}|${b.name}`);
    assert.ok(names.length >= 1 && names.every((n) => n === 'Avenida 25 de Mayo|Avenida 25 de Mayo'), names.join(', '));
    const palmeras = net.furniture.streetTrees.filter((p) => p.context === 'cantero');
    assert.ok(palmeras.length > 50);
    for (const p of palmeras) assert.ok(Math.abs(p.y - 590) < 1, `palmera en y=${p.y}`);
    // semáforos pedidos en los cruces del bulevar (los dos nodos del cruce quedan a ≤ 15 m del punto)
    for (const [x] of DEMO.signals.map((s) => [s.x])) {
        const ns = net.laneGraph.nodes.filter((n) => Math.abs(n.x - x) < 1 && Math.abs(n.y - 590) < 8);
        assert.ok(ns.length === 2 && ns.every((n) => n.signal), `semáforo en x=${x}`);
    }
    // semáforo automático: Calle 4 (primary) × Calle V1 (secondary)
    assert.ok(net.intersections.some((i) => Math.abs(i.x + 10) < 1 && Math.abs(i.y - 350) < 1 && i.signal));
    // y no en un cruce de calles comunes
    assert.ok(net.intersections.some((i) => Math.abs(i.x - 230) < 1 && Math.abs(i.y - 230) < 1 && !i.signal));
    assert.ok(net.furniture.signals.length >= 12);
});

test('calles reales: pares de avenidas (Av. 25 de Mayo y otras)', { skip: !HAS_REAL && 'sin archivo de calles reales' }, (t) => {
    const net = realNet();
    const names = new Set(net.pairs.map(([a]) => a.name));
    t.diagnostic(`pares: ${net.pairs.length} entre vías; avenidas con bulevar: ${[...names].join(', ')}`);
    assert.ok(names.has('Avenida 25 de Mayo'));
    assert.ok(names.size >= 3);
    const norm = (n) => n.toLowerCase().replace(/^(avenida|av\.?)\s+/, '');
    for (const [a, b] of net.pairs) assert.equal(norm(a.name), norm(b.name));
});

// ------------------------------------------------------------------ cruces

function checkJunctions(net) {
    const polys = net.debug.junctionPolys;
    assert.ok(polys.length > 0);
    const inJ = polyIndex(polys);
    const vereda = flatTris(net.builders.ground).filter((t) => t.z > 0.1 && near(t.col, '#d9d4c7', 0.06));
    let bad = 0;
    for (const t of vereda) {
        if (inJ(t.cx, t.cy).some((p) => pointInPoly(t.cx, t.cy, p) && distToRing(t.cx, t.cy, p) > 0.2)) bad++;
    }
    return { bad, vereda: vereda.length };
}

test('cruces: el asfalto del cruce no tiene veredas adentro (demo)', () => {
    const net = demoNet();
    const { bad, vereda } = checkJunctions(net);
    assert.ok(vereda > 100);
    assert.equal(bad, 0);
    // cruces en X sin nodo compartido: se detectan (8×6 manzanas)
    assert.ok(net.intersections.length >= 60, `cruces ${net.intersections.length}`);
    const deg4 = net.intersections.filter((i) => i.degree === 4).length;
    assert.ok(deg4 >= 30);
});

test('cruces: el asfalto del cruce no tiene veredas adentro (calles reales)', { skip: !HAS_REAL && 'sin archivo de calles reales' }, () => {
    const { bad, vereda } = checkJunctions(realNet());
    assert.ok(vereda > 1000);
    assert.ok(bad <= vereda * 0.002, `${bad} triángulos de vereda dentro de cruces`);
});

test('cruces: el eje amarillo se corta antes del cruce y hay cebras en los cruces de avenida', () => {
    const net = demoNet();
    const inJ = polyIndex(net.debug.junctionPolys);
    const marks = flatTris(net.builders.markings);
    const amarillo = marks.filter((t) => near(t.col, '#f2c230', 0.05));
    assert.ok(amarillo.length > 0);
    for (const t of amarillo) assert.ok(!inJ(t.cx, t.cy).some((p) => pointInPoly(t.cx, t.cy, p)), `eje dentro de un cruce en ${t.cx},${t.cy}`);
    for (const t of marks) assert.ok(Math.abs(t.z - 0.05) < 1e-9);
    // cebras: franjas blancas a pocos metros de un cruce con avenida (Calle 4 × V3)
    const cebras = marks.filter((t) => near(t.col, '#f2f2ee', 0.05) && Math.abs(t.cy - 350) < 12 && Math.abs(t.cx - 230) < 12 && Math.hypot(t.cx - 230, t.cy - 350) > 4);
    assert.ok(cebras.length >= 20, `cebras ${cebras.length}`);
    // sin marcas sobre la tierra (V2: x = 110, a mitad de cuadra)
    assert.equal(marks.filter((t) => Math.abs(t.cx - 110) < 5 && t.cy > 20 && t.cy < 90).length, 0);
});

test('tierra y peatonal: sin cordón, colores propios', () => {
    const net = demoNet();
    const g = net.builders.ground;
    const flat = flatTris(g);
    assert.ok(flat.some((t) => near(t.col, '#b5653d', 0.03) && Math.abs(t.cx - 110) < 4 && t.cy > 20 && t.cy < 90), 'tierra rojiza');
    assert.ok(flat.some((t) => near(t.col, '#7fae5c', 0.03) && Math.abs(t.cx - 110) < 10 && t.cy > 20 && t.cy < 90), 'banquina de pasto');
    assert.ok(flat.some((t) => near(t.col, '#e6dccb', 0.03) && Math.abs(t.cx - 470) < 5 && t.cy > 20 && t.cy < 90 && t.z > 0.1), 'peatonal clara');
    // ninguna cara vertical de cordón a mitad de cuadra en V2 (tierra) ni en Rivadavia (peatonal; las macetas sí)
    for (let i = 0; i < g.pos.length; i += 9) {
        if (Math.abs(g.nor[i + 2]) > 0.5 || !near([g.col[i], g.col[i + 1], g.col[i + 2]], '#cfd3d8', 0.02)) continue;
        const cx = (g.pos[i] + g.pos[i + 3] + g.pos[i + 6]) / 3, cy = (g.pos[i + 1] + g.pos[i + 4] + g.pos[i + 7]) / 3;
        if (cy > 20 && cy < 90) {
            assert.ok(Math.abs(cx - 110) > 10, `cordón en la calle de tierra ${cx},${cy}`);
            assert.ok(Math.abs(cx - 470) > 7, `cordón en la peatonal ${cx},${cy}`);
        }
    }
    // la calle común sí tiene cordón (V3: x = 230) gris claro de 0,15 m
    let curbs = 0;
    for (let i = 0; i < g.pos.length; i += 9) {
        if (Math.abs(g.nor[i + 2]) > 0.5) continue;
        const cx = (g.pos[i] + g.pos[i + 3] + g.pos[i + 6]) / 3, cy = (g.pos[i + 1] + g.pos[i + 4] + g.pos[i + 7]) / 3;
        if (Math.abs(cx - 230) < 6 && cy > 20 && cy < 90 && near([g.col[i], g.col[i + 1], g.col[i + 2]], '#cfd3d8', 0.02)) curbs++;
    }
    assert.ok(curbs >= 4);
    for (let i = 2; i < g.pos.length; i += 3) assert.ok(g.pos[i] >= -1e-9 && g.pos[i] <= 0.7, `z=${g.pos[i]}`);
});

// ------------------------------------------------------------------ grafo de carriles

function checkLaneGraph(lg, opts = {}) {
    assert.equal(lg.out.length, lg.nodes.length);
    for (const [i, l] of lg.lanes.entries()) {
        assert.ok(lg.out[l.to].length >= 1, `carril ${i}: el nodo ${l.to} no tiene salida`);
        assert.ok(lg.out[l.from].includes(i));
        assert.ok(l.pts.length >= 2 && l.len > 0 && l.speed > 0 && l.width > 0);
        assert.ok(Math.hypot(l.pts[0][0] - lg.nodes[l.from].x, l.pts[0][1] - lg.nodes[l.from].y) < 30);
    }
    // todo el grafo es fuertemente conexo: desde cualquier nodo se llega a cualquier otro (no hay zonas encerradas)
    const n = lg.nodes.length;
    const reach = (fw) => {
        const adj = Array.from({ length: n }, () => []);
        for (const l of lg.lanes) (fw ? adj[l.from] : adj[l.to]).push(fw ? l.to : l.from);
        const seen = new Uint8Array(n);
        const st = [lg.lanes[0].from];
        seen[st[0]] = 1;
        while (st.length) for (const y of adj[st.pop()]) if (!seen[y]) { seen[y] = 1; st.push(y); }
        return seen.reduce((a, b) => a + b, 0);
    };
    if (opts.connected !== false) {
        assert.equal(reach(true), n, 'todos los nodos alcanzables');
        assert.equal(reach(false), n, 'desde todos los nodos se vuelve');
    }
    // un auto que dobla al azar nunca queda trabado
    let at = lg.lanes[0].to;
    for (let k = 0; k < 5000; k++) {
        const o = lg.out[at];
        assert.ok(o.length, `trabado en ${at}`);
        at = lg.lanes[o[(k * 7919) % o.length]].to;
    }
}

test('carriles: sin trampas, del lado derecho y con mano única respetada (demo)', () => {
    const net = demoNet();
    const lg = net.laneGraph;
    checkLaneGraph(lg);
    // bulevar: la mano sur (y = 583) va al este, la norte (y = 597) al oeste
    const along = (y) => lg.lanes.filter((l) => l.len > 30 && l.pts.every((p) => Math.abs(p[1] - y) < 4));
    const sur = along(583), norte = along(597);
    assert.ok(sur.length > 10 && norte.length > 10);
    for (const l of sur) assert.ok(l.pts.at(-1)[0] > l.pts[0][0], 'mano sur hacia el este');
    for (const l of norte) assert.ok(l.pts.at(-1)[0] < l.pts[0][0], 'mano norte hacia el oeste');
    // carriles de avenida: major y bus
    assert.ok(sur.every((l) => l.major && l.bus));
    assert.ok(Math.abs(sur[0].speed - 40 / 3.6) < 1e-9);
    // calles de doble mano: el carril queda a la derecha del eje según la marcha
    let checked = 0;
    for (const l of lg.lanes) {
        if (l.from === l.to || l.len < 40) continue;
        // punto a mitad de largo, lejos de los cruces (ahí la calle más cercana es ambigua)
        let acc = 0, i = 0;
        const seg = (k) => Math.hypot(l.pts[k + 1][0] - l.pts[k][0], l.pts[k + 1][1] - l.pts[k][1]);
        while (i < l.pts.length - 2 && acc + seg(i) < l.len / 2) acc += seg(i++);
        const u = (l.len / 2 - acc) / (seg(i) || 1);
        const m = [l.pts[i][0] + (l.pts[i + 1][0] - l.pts[i][0]) * u, l.pts[i][1] + (l.pts[i + 1][1] - l.pts[i][1]) * u];
        const n2 = l.pts[i + 1];
        if (lg.nodes.some((n) => Math.hypot(n.x - m[0], n.y - m[1]) < 15)) continue;
        const q = net.query.nearest(m[0], m[1]);
        if (!q || q.road.oneway || q.road.pedestrian) continue;
        const tx = n2[0] - m[0], ty = n2[1] - m[1];
        // el eje queda a la izquierda de la marcha: (−ty, tx) apunta hacia el eje
        assert.ok(-ty * q.dirX + tx * q.dirY > 0, `carril a contramano en ${m}`);
        assert.ok(q.dist > 0.5);
        checked++;
    }
    assert.ok(checked > 100, `chequeados ${checked}`);
    // la peatonal no tiene carriles
    assert.ok(!lg.lanes.some((l) => l.pts.every((p) => Math.abs(p[0] - 470) < 3)));
    // calle de tierra: 25 km/h
    const tierra = lg.lanes.find((l) => l.pts.every((p) => Math.abs(p[0] - 110) < 4) && l.len > 50);
    assert.ok(Math.abs(tierra.speed - 25 / 3.6) < 1e-9);
});

test('carriles: oneway = −1 va al revés; callejón sin salida con vuelta en U; servicio a 15 km/h', () => {
    const roads = normalizeRoads([
        way([[0, 0], [300, 0]], { highway: 'residential', name: 'Principal' }),
        way([[100, 0], [100, 120]], { highway: 'residential', name: 'Al revés', oneway: -1 }),
        way([[200, 0], [200, -80]], { highway: 'service', name: 'Pasaje' }),
        way([[300, 0], [300, 200], [100, 200], [100, 120]], { highway: 'residential', name: 'Vuelta' }),
    ], ident);
    const net = buildRoadNetwork(roads);
    const lg = net.laneGraph;
    checkLaneGraph(lg);
    const rev = lg.lanes.filter((l) => l.pts.every((p) => Math.abs(p[0] - 100) < 5) && l.len > 30);
    assert.ok(rev.length >= 1);
    for (const l of rev) assert.ok(l.pts.at(-1)[1] < l.pts[0][1], 'oneway=-1: de norte a sur');
    const uturn = lg.lanes.filter((l) => l.from === l.to);
    assert.ok(uturn.length >= 2, 'vuelta en U en las puntas sueltas'); // (0,0) y (200,−80)
    const pasaje = lg.lanes.find((l) => l.from !== l.to && l.pts.every((p) => Math.abs(p[0] - 200) < 4));
    assert.ok(Math.abs(pasaje.speed - 15 / 3.6) < 1e-9);
    // maxspeed de OSM manda
    const v = buildRoadNetwork(normalizeRoads([way([[0, 0], [100, 0]], { highway: 'residential', maxspeed: 20 })], ident));
    assert.ok(Math.abs(v.laneGraph.lanes[0].speed - 20 / 3.6) < 1e-9);
    // calle sola de mano única: también tiene salida (vuelta o escape)
    const solo = buildRoadNetwork(normalizeRoads([way([[0, 0], [100, 0]], { highway: 'residential', oneway: 1 })], ident));
    checkLaneGraph(solo.laneGraph);
});

test('carriles: sin trampas en las calles reales', { skip: !HAS_REAL && 'sin archivo de calles reales' }, (t) => {
    const lg = realNet().laneGraph;
    checkLaneGraph(lg);
    t.diagnostic(`carriles ${lg.lanes.length}, nodos ${lg.nodes.length}, semáforos ${lg.nodes.filter((n) => n.signal).length}`);
});

// ------------------------------------------------------------------ mobiliario

function checkFurniture(net) {
    const onCw = carriagewayIndex(net);
    const F = net.furniture;
    for (const k of ['streetTrees', 'lamps', 'signals', 'busStops', 'benches', 'signs']) {
        for (const p of F[k]) {
            assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), k);
            assert.ok(!onCw(p.x, p.y), `${k} sobre la calzada en ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
            if ('dirX' in p) assert.ok(Math.abs(Math.hypot(p.dirX, p.dirY) - 1) < 1e-6, `${k}: dirección unitaria`);
        }
    }
}

test('mobiliario del demo: nunca sobre la calzada, y de todos los tipos', () => {
    const net = demoNet();
    checkFurniture(net);
    const F = net.furniture;
    const ctx = new Set(F.streetTrees.map((p) => p.context));
    assert.deepEqual([...ctx].sort(), ['cantero', 'peatonal', 'vereda']);
    assert.ok(F.lamps.some((l) => l.kind === 'avenida') && F.lamps.some((l) => l.kind === 'calle'));
    assert.ok(F.benches.length >= 5);
    for (const b of F.benches) assert.ok(Math.abs(b.x - 470) < 6, 'bancos en la peatonal');
    assert.ok(F.signs.length >= 20);
    for (const s of F.signs) assert.equal(typeof s.name, 'string');
    // las 4 paradas pedidas, cerca de donde se pidieron y del lado de la vereda
    assert.equal(F.busStops.length, 4);
    for (const [x, y] of DEMO.busStops) assert.ok(F.busStops.some((b) => Math.hypot(b.x - x, b.y - y) < 12), `parada ${x},${y}`);
    // árboles de vereda a ~0,8 m del cordón, no en las esquinas
    const inJ = polyIndex(net.debug.junctionPolys);
    for (const p of F.streetTrees) assert.ok(!inJ(p.x, p.y).some((poly) => pointInPoly(p.x, p.y, poly)));
    const v3 = F.streetTrees.filter((p) => p.context === 'vereda' && p.y > 20 && p.y < 90 && Math.abs(p.x - 230) < 10);
    assert.ok(v3.length >= 10);
    for (const p of v3) assert.ok(Math.abs(Math.abs(p.x - 230) - (4.25 + 0.8)) < 0.05, `árbol a ${Math.abs(p.x - 230)} del eje`);
    // faroles en calles comunes: ~40 m entre sí sobre la misma cuadra
    const lamps = F.lamps.filter((l) => Math.abs(l.x - 230) < 10 && l.y > 0 && l.y < 100).map((l) => l.y).sort((a, b) => a - b);
    assert.ok(lamps.length >= 2 && lamps.length <= 3, `faroles ${lamps}`);
});

test('mobiliario: paradas automáticas cada ~350 m en avenidas con colectivo', () => {
    const roads = normalizeRoads([way([[0, 0], [1500, 0]], { highway: 'primary', name: 'Av. Larga' }), way([[700, -100], [700, 100]], { highway: 'residential' })], ident);
    const net = buildRoadNetwork(roads);
    const stops = net.furniture.busStops;
    assert.ok(stops.length >= 2, `paradas ${stops.length}`);
    for (const s of stops) assert.ok(Math.abs(Math.abs(s.y) - 7) < 1.5, 'sobre la vereda, junto al cordón');
    checkFurniture(net);
});

test('mobiliario de las calles reales: nunca sobre la calzada', { skip: !HAS_REAL && 'sin archivo de calles reales' }, (t) => {
    const net = realNet();
    checkFurniture(net);
    const F = net.furniture;
    t.diagnostic(Object.entries(F).map(([k, v]) => `${k} ${v.length}`).join(', '));
});

// ------------------------------------------------------------------ consultas

test('consultas: nearest y onRoad coinciden con la cuenta a mano', () => {
    const net = demoNet();
    const roads = demoRoads();
    const { nearest, onRoad, bounds } = net.query;
    assert.ok(bounds.minX < -10 && bounds.maxX > 950 && bounds.minY < -10 && bounds.maxY > 710);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 2000; k++) {
        const x = -100 + rnd() * 1150, y = -100 + rnd() * 900;
        let best = Infinity;
        for (const r of roads) for (let i = 0; i + 1 < r.coords.length; i++) best = Math.min(best, segDist(x, y, r.coords[i], r.coords[i + 1]));
        const q = nearest(x, y);
        assert.ok(q, `sin resultado en ${x},${y}`);
        assert.ok(Math.abs(q.dist - best) < 1e-6, `nearest ${q.dist} vs ${best}`);
        // dir apunta hacia el eje
        const fx = x + q.dirX * q.dist, fy = y + q.dirY * q.dist;
        let d2 = Infinity;
        for (let i = 0; i + 1 < q.road.coords.length; i++) d2 = Math.min(d2, segDist(fx, fy, q.road.coords[i], q.road.coords[i + 1]));
        assert.ok(d2 < 1e-6);
    }
    // onRoad: calzada + vereda (V3 x = 230: medio ancho 4,25 + vereda 3)
    assert.ok(onRoad(230, 50));
    assert.ok(onRoad(236, 50), 'vereda');
    assert.ok(!onRoad(238, 50), 'dentro de la manzana');
    assert.ok(onRoad(238, 50, 1), 'con margen');
    assert.ok(!onRoad(290, 50, 5));
    assert.ok(!onRoad(5000, 5000));
    assert.equal(nearest(1e5, 1e5), null, 'muy lejos: null');
    // la calle encontrada es la de entrada (mismo objeto)
    const q = nearest(231, 50);
    assert.equal(q.road.name, 'Calle V3');
});

test('consultas: rápidas (≈100 mil por segundo)', (t) => {
    const { nearest, onRoad } = demoNet().query;
    let acc = 0;
    const N = 100000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
        const x = (i * 7.31) % 1000 - 30, y = (i * 3.17) % 760 - 30;
        if (onRoad(x, y)) acc++;
        acc += nearest(x, y)?.dist ?? 0;
    }
    const ms = performance.now() - t0;
    t.diagnostic(`${N} nearest + ${N} onRoad en ${ms.toFixed(0)} ms`);
    assert.ok(acc > 0);
    assert.ok(ms < 2000, `${ms} ms`);
});

// ------------------------------------------------------------------ determinismo, calidad, compatibilidad

test('determinismo: dos corridas dan exactamente lo mismo y no se toca la entrada', () => {
    const roads = demoRoads();
    const before = JSON.stringify(roads);
    const a = buildRoadNetwork(roads, { signals: DEMO.signals, busStops: DEMO.busStops });
    const b = buildRoadNetwork(roads, { signals: DEMO.signals, busStops: DEMO.busStops });
    assert.equal(JSON.stringify(roads), before);
    for (const k of ['ground', 'markings']) {
        for (const f of ['pos', 'nor', 'col']) assert.deepEqual(Array.from(a.builders[k][f]), Array.from(b.builders[k][f]), `${k}.${f}`);
    }
    assert.deepEqual(a.furniture, b.furniture);
    assert.deepEqual(a.laneGraph, b.laneGraph);
    assert.deepEqual(a.intersections, b.intersections);
    // el orden de entrada de las calles no cambia el resultado... salvo el orden: misma cantidad de todo
    const c = buildRoadNetwork(roads.slice().reverse(), { signals: DEMO.signals, busStops: DEMO.busStops });
    assert.equal(c.intersections.length, a.intersections.length);
});

test('calidad: baja sin cebras ni flechas ni curvas en las esquinas; alta con más detalle', () => {
    const roads = demoRoads();
    const nets = Object.fromEntries(['baja', 'media', 'alta'].map((q) => [q, buildRoadNetwork(roads, { quality: q })]));
    const tri = (n, k) => n.builders[k].pos.length / 9;
    assert.ok(tri(nets.baja, 'markings') < tri(nets.media, 'markings'));
    assert.ok(tri(nets.baja, 'ground') < tri(nets.media, 'ground'));
    assert.ok(tri(nets.alta, 'ground') > tri(nets.media, 'ground'));
    // en baja no hay cebras: cerca de un cruce de avenida solo queda la línea de detención (calle 4 × V3)
    const blancas = (n) => flatTris(n.builders.markings).filter((t) => near(t.col, '#f2f2ee', 0.05) && Math.abs(t.cy - 350) < 12 && Math.abs(t.cx - 230) < 12).length;
    assert.ok(blancas(nets.baja) <= 6, `blancas en baja: ${blancas(nets.baja)}`);
    assert.ok(blancas(nets.media) >= blancas(nets.baja) + 20);
});

test('compatibilidad: los constructores son MeshBuilder y se pueden seguir usando', () => {
    const net = buildRoadNetwork(normalizeRoads([way([[0, 0], [100, 0]], { highway: 'residential' })], ident));
    const g = net.builders.ground;
    assert.ok(g instanceof MeshBuilder);
    const n = g.vertexCount;
    assert.equal(g.nor.length, n * 3);
    assert.equal(g.col.length, n * 3);
    assert.equal(g.uv.length, n * 2);
    assert.equal(g.owner.length, n / 3);
    const f32 = Float32Array.from(g.pos);
    assert.equal(f32.length, n * 3);
    g.tri([0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 0, 0], 0);
    assert.equal(g.vertexCount, n + 3);
    // vacío
    const empty = buildRoadNetwork([]);
    assert.equal(empty.builders.ground.vertexCount, 0);
    assert.equal(empty.laneGraph.lanes.length, 0);
    assert.equal(empty.query.nearest(0, 0), null);
    assert.equal(empty.query.onRoad(0, 0), false);
});

test('rendimiento: calles reales en menos de 300 ms', { skip: !HAS_REAL && 'sin archivo de calles reales' }, (t) => {
    const roads = realRoads();
    const times = [];
    let net;
    for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        net = buildRoadNetwork(roads);
        times.push(performance.now() - t0);
    }
    const tris = (k) => net.builders[k].pos.length / 9;
    t.diagnostic(`${roads.length} vías: ${times.map((x) => x.toFixed(0)).join(' / ')} ms; triángulos piso ${tris('ground')}, marcas ${tris('markings')}`);
    assert.ok(Math.min(...times) < 300, `mejor tiempo ${Math.min(...times).toFixed(0)} ms`);
});
