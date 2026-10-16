import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildGround, buildOuterRing, buildPlaza, buildLandmarks, buildBlockInfill, crossingBands, pointInRing,
} from '../../resources/js/map/city-env.js';
import { normalizeRoads, buildRoadNetwork } from '../../resources/js/map/city-roads.js';

// ------------------------------------------------------------------ fixtures (metros locales; toLocal = identidad salvo donde se dice)

const ANG = (19.7 * Math.PI) / 180; // la cuadrícula de Formosa está girada ~20°
const rot = (cx, cy, a, pts) => pts.map(([s, t]) => [cx + s * Math.cos(a) - t * Math.sin(a), cy + s * Math.sin(a) + t * Math.cos(a)]);
const poly = (ring, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
const point = ([x, y], props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [x, y] } });
const line = (pts, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts } });
const id = (p) => p;

const HALF = 1250;
const BOUNDS = { minX: -HALF, minY: -HALF, maxX: HALF, maxY: HALF };

/** Recorta la recta p + d·t al cuadrado de BOUNDS (o null). */
function clipLine(p, d) {
    let t0 = -1e9, t1 = 1e9;
    for (const [pi, di] of [[p[0], d[0]], [p[1], d[1]]]) {
        if (Math.abs(di) < 1e-12) { if (pi < -HALF || pi > HALF) return null; continue; }
        const a = (-HALF - pi) / di, b = (HALF - pi) / di;
        t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    }
    return t1 - t0 > 50 ? [[p[0] + d[0] * t0, p[1] + d[1] * t0], [p[0] + d[0] * t1, p[1] + d[1] * t1]] : null;
}

/** Cuadrícula girada de calles cada ~105 m, cortadas por el borde del recorte, + la Av. 25 de Mayo (bulevar, dos manos a 14 m). */
function makeRoads() {
    const u = [Math.cos(ANG), Math.sin(ANG)], v = [-u[1], u[0]];
    const roads = [];
    let k = 0;
    for (let o = -1800; o <= 1800; o += 105) {
        for (const [dir, nor] of [[u, v], [v, u]]) {
            const seg = clipLine([nor[0] * o, nor[1] * o], dir);
            if (!seg) continue;
            // un vértice intermedio cada ~100 m, como en OSM
            const n = Math.max(1, Math.round(Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) / 105));
            const coords = [];
            for (let i = 0; i <= n; i++) coords.push([seg[0][0] + (seg[1][0] - seg[0][0]) * i / n, seg[0][1] + (seg[1][1] - seg[0][1]) * i / n]);
            roads.push({ id: k++, coords, highway: 'residential', name: `Calle ${k}`, major: false });
        }
    }
    for (const off of [-7, 7]) {
        const seg = clipLine([v[0] * off, v[1] * off], u);
        roads.push({ id: k++, coords: off < 0 ? seg : seg.slice().reverse(), highway: 'secondary', name: 'Avenida 25 de Mayo', major: true, oneway: 1 });
    }
    return roads;
}

/** Consulta como la de city-roads: calzada + vereda (`hw` por calle) alrededor de cada segmento. */
function makeQuery(roads) {
    const segs = [];
    for (const r of roads) for (let i = 0; i + 1 < r.coords.length; i++) segs.push([r.coords[i], r.coords[i + 1], r.major ? 7 : 6]);
    return {
        bounds: { ...BOUNDS },
        onRoad(x, y, m = 0) {
            for (const [a, b, hw] of segs) {
                const ex = b[0] - a[0], ey = b[1] - a[1];
                const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey || 1)));
                if (Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y) < hw + m) return true;
            }
            return false;
        },
    };
}

// Plaza San Martín: 200 × 200 m girada como la cuadrícula, en el centro, cruzada por la avenida
const PLAZA_SM = rot(0, 0, ANG, [[-100, -100], [100, -100], [100, 100], [-100, 100]]);
const PLAZA_GEN = rot(420, -630, ANG, [[-45, -40], [45, -40], [45, 40], [-45, 40]]);

function envFeatures({ water = true } = {}) {
    const f = [];
    if (water) {
        // Río Paraguay al este de la costanera, recortado por el borde de los datos
        const shore = [[1500, -1800], [1380, -1000], [1420, -300], [1330, 300], [1450, 1100], [1520, 1800]];
        f.push(poly([...shore, [1800, 1800], [1800, -1800]], { kind: 'water', name: 'Río Paraguay', osm_id: 1 }));
        f.push(poly(rot(-900, -900, 0.3, [[-60, -35], [60, -40], [70, 30], [-50, 45]]), { kind: 'water', name: 'Laguna', osm_id: 2 }));
    }
    f.push(poly([[-1600, -1600], [1000, -1600], [1000, 1600], [-1600, 1600]], { kind: 'landuse', landuse: 'residential', osm_id: 3 }));
    f.push(poly(rot(-900, 900, ANG, [[-120, -80], [120, -80], [120, 80], [-120, 80]]), { kind: 'landuse', landuse: 'cemetery', osm_id: 5 }));
    f.push(poly([[-1240, -500], [-1000, -500], [-1000, 300], [-1240, 300]], { kind: 'landuse', landuse: 'farmland', osm_id: 6 }));
    f.push(poly(PLAZA_SM, { kind: 'plaza', name: 'Plaza San Martín', osm_id: 7 }));
    f.push(poly(PLAZA_GEN, { kind: 'plaza', name: 'Plaza Belgrano', osm_id: 8 }));
    f.push(poly(rot(-400, 900, ANG, [[-150, -90], [150, -90], [150, 90], [-150, 90]]), { kind: 'park', name: 'Parque', osm_id: 9 }));
    f.push(poly(rot(-480, 900, ANG, [[-50, -32], [50, -32], [50, 32], [-50, 32]]), { kind: 'pitch', osm_id: 10 }));
    f.push(poly(rot(-300, 930, ANG, [[-12, -10], [12, -10], [12, 10], [-12, 10]]), { kind: 'playground', osm_id: 11 }));
    return f;
}

function landmarkFeatures() {
    return [
        poly(rot(-30, 160, ANG, [[-28, -11], [28, -11], [28, 11], [-28, 11]]), { kind: 'landmark', landmark: 'catedral', name: 'Catedral', osm_id: 20 }),
        point([170, -20], { kind: 'landmark', landmark: 'casa_gobierno', name: 'Casa de Gobierno', osm_id: 21 }),
        poly(rot(-260, -150, ANG, [[-40, -9], [40, -9], [40, 9], [-40, 9]]), { kind: 'landmark', landmark: 'estacion', name: 'Palacio Municipal', osm_id: 22 }),
        point([60, -260], { kind: 'landmark', landmark: 'monumento', name: 'Obelisco', osm_id: 23 }),
        point([-200, 180], { kind: 'landmark', landmark: 'museo', name: 'Museo', osm_id: 24 }),
        point([-120, -320], { kind: 'landmark', landmark: 'iglesia', name: 'Iglesia', osm_id: 25 }),
        point([1200, 0], { kind: 'landmark', landmark: 'puerto', name: 'Puerto', osm_id: 26 }),
        point([-500, -500], { kind: 'landmark', landmark: 'otro', name: 'Otro', osm_id: 27 }),
    ];
}

const ROADS = makeRoads();
const QUERY = makeQuery(ROADS);
const AVENUE = makeQuery(ROADS.filter((r) => r.major));

const tris = (b) => b.owner.length;
const finite = (b) => b.pos.every(Number.isFinite) && b.col.every(Number.isFinite) && b.nor.every(Number.isFinite);
function bboxPos(b) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < b.pos.length; i += 3) {
        minX = Math.min(minX, b.pos[i]); maxX = Math.max(maxX, b.pos[i]);
        minY = Math.min(minY, b.pos[i + 1]); maxY = Math.max(maxY, b.pos[i + 1]);
    }
    return { minX, minY, maxX, maxY };
}
function checksum(b) {
    let s = 0;
    for (let i = 0; i < b.pos.length; i++) s = (s * 31 + Math.round(b.pos[i] * 100)) % 1e9;
    for (let i = 0; i < b.col.length; i += 7) s = (s * 17 + Math.round(b.col[i] * 1000)) % 1e9;
    return `${b.pos.length}:${s}`;
}
const centroid = (r) => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];

// ------------------------------------------------------------------ suelo

test('suelo: cubre el recorte + 2 km de margen, sin NaN, y devuelve parques y plazas', () => {
    const g = buildGround(BOUNDS, envFeatures(), id, QUERY);
    assert.ok(finite(g.builders.ground) && finite(g.builders.water));
    const bb = bboxPos(g.builders.ground);
    assert.ok(bb.minX <= BOUNDS.minX - 2000 && bb.minY <= BOUNDS.minY - 2000, JSON.stringify(bb));
    assert.ok(bb.maxY >= BOUNDS.maxY + 2000, JSON.stringify(bb));
    // al este está el río: el agua (prolongada más allá del recorte de los datos) llega hasta el final del suelo
    assert.ok(bboxPos(g.builders.water).maxX >= BOUNDS.maxX + 2000);
    assert.equal(g.parks.length, 1);
    assert.deepEqual(g.plazas.map((p) => p.name).sort(), ['Plaza Belgrano', 'Plaza San Martín']);
    // todo mira para arriba (suelo plano o apenas elevado)
    for (let i = 2; i < g.builders.ground.nor.length; i += 3) assert.ok(g.builders.ground.nor[i] > 0.99);
    for (let i = 2; i < g.builders.ground.pos.length; i += 3) assert.ok(g.builders.ground.pos[i] >= 0 && g.builders.ground.pos[i] < 0.1);
});

test('suelo: sin agua en los datos no se inventa ningún río', () => {
    const g = buildGround(BOUNDS, envFeatures({ water: false }), id, QUERY);
    assert.equal(tris(g.builders.water), 0);
    assert.equal(g.waterSide, null);
    assert.equal(g.waterRings.length, 0);
    const g0 = buildGround(BOUNDS, [], id, null);
    assert.equal(tris(g0.builders.water), 0);
    assert.ok(tris(g0.builders.ground) > 1000);
});

test('suelo: el río del este se detecta, tiene orilla y el agua está a z -0.05', () => {
    const g = buildGround(BOUNDS, envFeatures(), id, QUERY);
    assert.equal(g.waterSide, 'east');
    assert.ok(tris(g.builders.water) > 0);
    for (let i = 2; i < g.builders.water.pos.length; i += 3) assert.equal(g.builders.water.pos[i], -0.05);
    // ninguna celda de pasto adentro del agua (centro de cada triángulo del suelo a z 0)
    const P = g.builders.ground.pos;
    const river = envFeatures()[0].geometry.coordinates[0];
    let inWater = 0;
    for (let i = 0; i < P.length; i += 9) {
        if (P[i + 2] !== 0) continue;
        const cx = (P[i] + P[i + 3] + P[i + 6]) / 3, cy = (P[i + 1] + P[i + 4] + P[i + 7]) / 3;
        if (pointInRing(cx, cy, river)) inWater++;
    }
    assert.equal(inWater, 0);
    // la orilla: hay color arena y tierra colorada (barranca) en el suelo
    const C = g.builders.ground.col;
    let sand = 0;
    for (let i = 0; i < C.length; i += 3) if (Math.abs(C[i] - 0xd8 / 255) < 0.01 && Math.abs(C[i + 1] - 0xc1 / 255) < 0.01) sand++;
    assert.ok(sand > 50);
});

test('suelo: un río como LineString (un tramo por miembro de la relación) se dibuja con su ancho', () => {
    const f = [line([[-1500, -200], [-600, 0], [300, 100]], { kind: 'river', name: 'Riacho Pucú', width: 20, osm_id: 40 }),
        line([[300, 100], [900, 400]], { kind: 'river', name: 'Riacho Pucú', width: 20, osm_id: 40 })];
    const g = buildGround(BOUNDS, f, id, null);
    assert.ok(tris(g.builders.water) >= 6);
    const bb = bboxPos(g.builders.water);
    assert.ok(bb.minX < -1490 && bb.maxX > 890);
    assert.equal(g.waterSide, null); // un riacho no es "el lado del río"
});

test('suelo: acepta MultiPolygon y features en lng/lat con toLocal', () => {
    const toLngLat = ([x, y]) => [x / 100000 - 58.18, y / 110540 - 26.18];
    const toLocal = ([lng, lat]) => [(lng + 58.18) * 100000, (lat + 26.18) * 110540];
    const mp = { type: 'Feature', properties: { kind: 'water', name: 'Río Paraguay' },
        geometry: { type: 'MultiPolygon', coordinates: [[[[1400, -1300], [1800, -1300], [1800, 1300], [1400, 1300], [1400, -1300]].map(toLngLat)]] } };
    const g = buildGround(BOUNDS, [mp], toLocal, null);
    assert.equal(g.waterSide, 'east');
    assert.ok(finite(g.builders.water) && tris(g.builders.water) > 0);
});

// ------------------------------------------------------------------ alrededores

test('alrededores: nada adentro del recorte de la ciudad', () => {
    const r = buildOuterRing(BOUNDS, ROADS, { seed: 1, quality: 'media', waterSide: null });
    assert.ok(finite(r.builders.ground) && finite(r.builders.buildings));
    const inside = (x, y, m) => x > BOUNDS.minX + m && x < BOUNDS.maxX - m && y > BOUNDS.minY + m && y < BOUNDS.maxY - m;
    for (const b of [r.builders.ground, r.builders.buildings]) {
        for (let i = 0; i < b.pos.length; i += 3) assert.ok(!inside(b.pos[i], b.pos[i + 1], 0.5), `vértice adentro: ${b.pos[i]},${b.pos[i + 1]}`);
    }
    for (const t of r.trees) {
        assert.ok(!inside(t.x, t.y, 0));
        assert.equal(t.context, 'campo');
    }
    // y no más allá de 1,5 km (+ ancho de un camino)
    const bb = bboxPos(r.builders.ground);
    assert.ok(bb.minX >= BOUNDS.minX - 1510 && bb.maxY <= BOUNDS.maxY + 1510);
    assert.ok(r.houses > 50, `casas: ${r.houses}`);
});

test('alrededores: con waterSide east no se pone nada del lado del río', () => {
    const r = buildOuterRing(BOUNDS, ROADS, { seed: 1, quality: 'media', waterSide: 'east' });
    for (const b of [r.builders.ground, r.builders.buildings]) {
        for (let i = 0; i < b.pos.length; i += 3) assert.ok(b.pos[i] <= BOUNDS.maxX + 1, `vértice al este: ${b.pos[i]}`);
    }
    assert.ok(r.trees.every((t) => t.x <= BOUNDS.maxX));
    // por defecto, sin waterSide ni features: todos los lados
    const all = buildOuterRing(BOUNDS, ROADS, { seed: 1, quality: 'media' });
    assert.ok(all.trees.some((t) => t.x > BOUNDS.maxX + 100));
    // detectado de los features si se pasan
    const det = buildOuterRing(BOUNDS, ROADS, { seed: 1, quality: 'baja', envFeatures: envFeatures(), toLocal: id });
    assert.ok(det.trees.every((t) => t.x <= BOUNDS.maxX));
});

test('alrededores: los caminos de tierra arrancan donde el borde corta las calles y siguen derecho hacia afuera', () => {
    const r = buildOuterRing(BOUNDS, ROADS, { seed: 1, quality: 'media', waterSide: 'east' });
    const cont = r.dirtRoads.filter((d) => d.kind === 'continuacion');
    assert.ok(cont.length >= 20, `continuaciones: ${cont.length}`);
    assert.equal(cont.length, r.cuts.length);
    for (const d of cont) {
        const [x, y] = d.a;
        const edge = Math.min(Math.abs(x - BOUNDS.minX), Math.abs(x - BOUNDS.maxX), Math.abs(y - BOUNDS.minY), Math.abs(y - BOUNDS.maxY));
        // arranca en el borde (corrido ≤ 2 m para que la tira oblicua no entre a la ciudad)
        assert.ok(edge < 2, `arranca a ${edge} m del borde`);
        const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        assert.ok(len >= 60 && len <= 1500 + 1, `largo ${len}`);
        assert.ok(d.b[0] <= BOUNDS.maxX + 1); // nunca hacia el río
    }
    // cada corte está sobre la prolongación de un extremo de calle real
    for (const c of r.cuts) {
        const road = ROADS[c.road];
        const ends = [road.coords[0], road.coords.at(-1)];
        assert.ok(ends.some((e) => Math.hypot(e[0] - c.end[0], e[1] - c.end[1]) < 1e-6));
        assert.ok(Math.hypot(c.x - c.end[0], c.y - c.end[1]) < 160);
    }
    // también hay grilla rala de caminos rurales, alineada con la ciudad (~20°)
    assert.ok(r.dirtRoads.some((d) => d.kind === 'rural'));
    assert.ok(Math.abs(r.angle - ANG) < 2 * Math.PI / 180, `ángulo ${r.angle}`);
});

test('alrededores: presupuesto de triángulos y árboles por calidad', () => {
    const counts = {};
    for (const quality of ['baja', 'media', 'alta']) {
        const r = buildOuterRing(BOUNDS, ROADS, { seed: 3, quality, waterSide: null });
        counts[quality] = tris(r.builders.ground) + tris(r.builders.buildings);
        if (quality === 'media') assert.ok(r.trees.length <= 3000);
        if (quality === 'baja') assert.ok(r.trees.length <= 1500);
    }
    assert.ok(counts.media <= 120000, `media ${counts.media}`);
    assert.ok(counts.baja <= 60000 && counts.baja < counts.media, `baja ${counts.baja}`);
    assert.ok(counts.alta >= counts.media);
});

// ------------------------------------------------------------------ plazas

test('plazas: P1 para San Martín (con o sin tilde), P2 para cualquier otra', () => {
    assert.equal(buildPlaza({ ring: PLAZA_SM, name: 'Plaza San Martín' }).kind, 'P1');
    assert.equal(buildPlaza({ ring: PLAZA_SM, name: 'PLAZA SAN MARTIN' }).kind, 'P1');
    assert.equal(buildPlaza({ ring: PLAZA_GEN, name: 'Plaza Belgrano' }).kind, 'P2');
    assert.equal(buildPlaza({ ring: PLAZA_GEN, name: null }).kind, 'P2');
    const empty = buildPlaza({ ring: [], name: 'Plaza San Martín' });
    assert.equal(tris(empty.builders.ground), 0);
});

test('plaza San Martín: monumento al este, lago, 2 fuentes, patinódromo, glorietas y nativos', () => {
    const p = buildPlaza({ ring: PLAZA_SM, name: 'Plaza San Martín' }, { quality: 'media' });
    const [cx, cy] = centroid(PLAZA_SM);
    assert.ok(p.monument && p.monument.x > cx + 40, `monumento en x=${p.monument?.x}`);
    assert.ok(p.monument.height > 8 && p.monument.height < 11, `altura ${p.monument.height}`); // monumento a escala 1,5 (G, fase 4)
    assert.equal(p.fountains.length, 2);
    assert.ok(p.lake && p.lake.length >= 8);
    assert.ok(tris(p.builders.water) > 0);
    assert.ok(tris(p.builders.plain) > 400);
    assert.ok(p.lamps.length >= 20 && p.lamps.every((l) => l.kind === 'plaza'));
    // ~1 árbol cada 120 m² de pasto, con palmeras y especies nativas sugeridas
    assert.ok(p.trees.length >= 100, `árboles ${p.trees.length}`);
    assert.ok(p.trees.every((t) => t.context === 'plaza'));
    assert.ok(p.trees.some((t) => t.palm));
    const sp = new Set(p.trees.map((t) => t.species));
    for (const k of ['T1', 'T3', 'T4', 'T7']) assert.ok(sp.has(k), `falta ${k}`);
    assert.ok(finite(p.builders.ground) && finite(p.builders.plain) && finite(p.builders.water));
});

test('plaza San Martín cruzada por la avenida (bulevar): nada sobre la calle, se parte en dos', () => {
    const p = buildPlaza({ ring: PLAZA_SM, name: 'Plaza San Martín' }, { quality: 'media', query: AVENUE });
    assert.equal(p.crossings.length, 1);
    // la banda sigue la avenida (dirección ~20°) y cubre las dos manos
    const b = p.crossings[0];
    assert.ok(Math.abs(Math.abs(b.nx * -Math.sin(ANG) + b.ny * Math.cos(ANG)) - 1) < 0.01);
    assert.ok(b.hi - b.lo >= 28 && b.hi - b.lo <= 45, `ancho ${b.hi - b.lo}`);
    const onRoad = (x, y) => AVENUE.onRoad(x, y, 0);
    assert.ok(p.monument && !onRoad(p.monument.x, p.monument.y));
    for (const f of p.fountains) assert.ok(!onRoad(f.x, f.y));
    for (const l of p.lamps) assert.ok(!onRoad(l.x, l.y));
    for (const t of p.trees) assert.ok(!onRoad(t.x, t.y));
    for (const bl of [p.builders.ground, p.builders.plain, p.builders.water]) {
        const P = bl.pos;
        for (let i = 0; i < P.length; i += 9) {
            const cx = (P[i] + P[i + 3] + P[i + 6]) / 3, cy = (P[i + 1] + P[i + 4] + P[i + 7]) / 3;
            assert.ok(!onRoad(cx, cy), `triángulo sobre la avenida en ${cx.toFixed(1)},${cy.toFixed(1)}`);
        }
    }
    assert.ok(p.fountains.length >= 1 && p.lake);
});

test('plazas: fuentes, faroles y monumento quedan adentro del polígono', () => {
    for (const [ring, name] of [[PLAZA_SM, 'Plaza San Martín'], [PLAZA_GEN, 'Plaza Belgrano']]) {
        for (const query of [null, AVENUE]) {
            const p = buildPlaza({ ring, name }, { quality: 'media', query });
            for (const o of [...p.fountains, ...p.lamps, ...p.trees, ...(p.monument ? [p.monument] : [])]) {
                assert.ok(pointInRing(o.x, o.y, ring), `${name}: (${o.x},${o.y}) afuera`);
            }
        }
    }
});

test('plaza genérica: cruz de senderos, centro con fuente o busto, juegos, bancos y árboles', () => {
    const p = buildPlaza({ ring: PLAZA_GEN, name: 'Plaza Belgrano' }, { quality: 'media' });
    assert.ok(p.monument || p.fountains.length === 1);
    assert.ok(p.trees.length >= 8);
    assert.ok(p.lamps.length >= 4);
    assert.ok(tris(p.builders.plain) > 200); // juegos + bancos
    assert.ok(p.trees.every((t) => t.species === undefined)); // E1 decide la especie por contexto
});

test('calles que cruzan: las veredas del borde no cuentan; dos calles cruzadas dan dos bandas', () => {
    const square = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
    const border = makeQuery([{ coords: [[-120, 100], [120, 100]] }, { coords: [[-100, -120], [-100, 120]] }]);
    assert.equal(crossingBands(square, border).length, 0);
    const cross = makeQuery([{ coords: [[-120, 0], [120, 0]] }, { coords: [[30, -120], [30, 120]] }]);
    const bands = crossingBands(square, cross);
    assert.equal(bands.length, 2);
    const p = buildPlaza({ ring: square, name: 'Plaza 9 de Julio' }, { query: cross });
    for (const t of p.trees) assert.ok(!cross.onRoad(t.x, t.y, 0));
});

// ------------------------------------------------------------------ emblemáticos

test('emblemáticos: una pieza por tipo, con alturas razonables y sin NaN', () => {
    const lm = buildLandmarks(landmarkFeatures(), id);
    assert.ok(finite(lm.builders.plain));
    assert.ok(tris(lm.builders.plain) > 300);
    const by = Object.fromEntries(lm.list.map((l) => [l.kind, l]));
    for (const k of ['catedral', 'casa_gobierno', 'estacion', 'monumento', 'museo', 'iglesia', 'puerto', 'otro']) assert.ok(by[k], `falta ${k}`);
    assert.ok(by.catedral.height >= 28 && by.catedral.height <= 34); // torre de ~30 m
    assert.ok(by.casa_gobierno.height >= 21); // 6 pisos
    assert.ok(by.estacion.height >= 10 && by.estacion.height <= 20); // edificio bajo + torre del reloj
    assert.ok(by.monumento.height >= 12);
    // Polygon: en el centro de su huella; Point: en el punto
    const [cx, cy] = rot(-30, 160, ANG, [[0, 0]])[0];
    assert.ok(Math.hypot(by.catedral.x - cx, by.catedral.y - cy) < 0.5);
    assert.deepEqual([by.casa_gobierno.x, by.casa_gobierno.y], [170, -20]);
    assert.equal(lm.list.filter((l) => l.covered).length, 0);
});

test('emblemáticos: si una propiedad del juego ya cubre el lugar, no se arma un edificio encima', () => {
    const feats = landmarkFeatures();
    const catRing = feats[0].geometry.coordinates[0].slice(0, -1);
    const all = buildLandmarks(feats, id);
    const lm = buildLandmarks(feats, id, { propertyRings: [catRing, rot(170, -20, 0, [[-20, -10], [20, -10], [20, 10], [-20, 10]])] });
    const by = Object.fromEntries(lm.list.map((l) => [l.kind, l]));
    assert.equal(by.catedral.covered, true);
    assert.equal(by.casa_gobierno.covered, true);
    assert.equal(by.estacion.covered, false);
    assert.ok(by.catedral.height >= 28); // la altura sigue sirviendo para la etiqueta
    assert.ok(tris(lm.builders.plain) < tris(all.builders.plain));
    // ningún vértice del mesh dentro de la huella de la catedral
    const P = lm.builders.plain.pos;
    for (let i = 0; i < P.length; i += 3) assert.ok(!pointInRing(P[i], P[i + 1], catRing));
    // o con una función propia
    const fn = buildLandmarks(feats, id, { covered: (x, y, kind) => kind === 'estacion' });
    assert.equal(fn.list.find((l) => l.kind === 'estacion').covered, true);
});

// ------------------------------------------------------------------ determinismo y tiempo

test('determinismo: misma entrada, mismos triángulos', () => {
    const a = buildGround(BOUNDS, envFeatures(), id, QUERY), b = buildGround(BOUNDS, envFeatures(), id, QUERY);
    assert.equal(checksum(a.builders.ground), checksum(b.builders.ground));
    const r1 = buildOuterRing(BOUNDS, ROADS, { seed: 7, waterSide: 'east' }), r2 = buildOuterRing(BOUNDS, ROADS, { seed: 7, waterSide: 'east' });
    assert.equal(checksum(r1.builders.ground), checksum(r2.builders.ground));
    assert.equal(checksum(r1.builders.buildings), checksum(r2.builders.buildings));
    assert.deepEqual(r1.trees, r2.trees);
    const r3 = buildOuterRing(BOUNDS, ROADS, { seed: 8, waterSide: 'east' });
    assert.notEqual(checksum(r1.builders.buildings), checksum(r3.builders.buildings));
    const p1 = buildPlaza({ ring: PLAZA_SM, name: 'Plaza San Martín' }, { query: AVENUE });
    const p2 = buildPlaza({ ring: PLAZA_SM, name: 'Plaza San Martín' }, { query: AVENUE });
    assert.equal(checksum(p1.builders.plain), checksum(p2.builders.plain));
    assert.deepEqual(p1.trees, p2.trees);
    const l1 = buildLandmarks(landmarkFeatures(), id), l2 = buildLandmarks(landmarkFeatures(), id);
    assert.equal(checksum(l1.builders.plain), checksum(l2.builders.plain));
});

test('tiempo: suelo + alrededores + plazas en menos de 400 ms (media)', () => {
    const env = envFeatures();
    // calentamiento (JIT) con baja
    buildOuterRing(BOUNDS, ROADS, { quality: 'baja', waterSide: 'east' });
    const t0 = performance.now();
    const g = buildGround(BOUNDS, env, id, QUERY, { quality: 'media' });
    const r = buildOuterRing(BOUNDS, ROADS, { quality: 'media', waterSide: g.waterSide, water: g.waterRings });
    const ps = g.plazas.map((p) => buildPlaza(p, { quality: 'media', query: AVENUE }));
    const ms = performance.now() - t0;
    const total = tris(g.builders.ground) + tris(g.builders.water) + tris(r.builders.ground) + tris(r.builders.buildings)
        + ps.reduce((s, p) => s + tris(p.builders.ground) + tris(p.builders.plain) + tris(p.builders.water), 0);
    console.log(`entorno media: ${ms.toFixed(0)} ms, ${total} triángulos, ${r.trees.length} árboles de campo, ${r.houses} casas`);
    assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------------ calles reales (si está el archivo)

const REAL = '/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad/real/calles.geojson';
test('calles reales de Formosa: caminos de tierra en los cortes y nada adentro', { skip: !fs.existsSync(REAL) && 'sin archivo de calles reales' }, () => {
    const gj = JSON.parse(fs.readFileSync(REAL, 'utf8'));
    let lng0 = 0, lat0 = 0, n = 0;
    for (const f of gj.features) for (const [lng, lat] of f.geometry?.coordinates ?? []) { lng0 += lng; lat0 += lat; n++; }
    lng0 /= n; lat0 /= n;
    const C = Math.cos((lat0 * Math.PI) / 180);
    const toLocal = ([lng, lat]) => [(lng - lng0) * C * 111320, (lat - lat0) * 110540];
    const roads = gj.features.filter((f) => f.geometry?.type === 'LineString').map((f, i) => ({ id: i, coords: f.geometry.coordinates.map(toLocal), major: /primary|secondary|trunk/.test(f.properties.highway ?? '') }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of roads) for (const [x, y] of r.coords) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const bounds = { minX, minY, maxX, maxY };
    const r = buildOuterRing(bounds, roads, { quality: 'media', waterSide: 'east' });
    assert.ok(r.cuts.length > 0);
    const P = r.builders.buildings.pos;
    for (let i = 0; i < P.length; i += 3) assert.ok(!(P[i] > minX + 0.5 && P[i] < maxX - 0.5 && P[i + 1] > minY + 0.5 && P[i + 1] < maxY - 0.5));
    assert.ok(tris(r.builders.ground) + tris(r.builders.buildings) <= 120000);
});

// ------------------------------------------------------------------ relleno interior de manzanas (buildBlockInfill)

/** Damero chico: calles cada 100 m en los dos ejes dentro de una caja, para probar el relleno. */
function infillFixture() {
    const bounds = { minX: -500, minY: -500, maxX: 500, maxY: 500 };
    const ident = (p) => p;
    const feats = [];
    let k = 0;
    for (let o = -600; o <= 600; o += 100) {
        feats.push(line([[o, -600], [o, 600]], { highway: 'residential', osm_id: ++k }));
        feats.push(line([[-600, o], [600, o]], { highway: 'residential', osm_id: ++k }));
    }
    const roads = normalizeRoads(feats, ident);
    const net = buildRoadNetwork(roads);
    // dos propiedades reales en el interior + una plaza: el relleno no las puede pisar
    const prop1 = [[140, 140], [175, 140], [175, 175], [140, 175]];
    const prop2 = [[-220, -60], [-185, -60], [-185, -25], [-220, -25]];
    const plaza = [[-45, -45], [45, -45], [45, 45], [-45, 45]];
    const keepOut = [prop1, prop2, plaza];
    return { bounds, roads, net, keepOut, prop1, prop2, plaza };
}

const infillVerts = (res) => res.builders.buildings.pos;

test('relleno: llena el interior del damero dejando patios y es determinístico por semilla', () => {
    const { bounds, roads, net, keepOut } = infillFixture();
    const a = buildBlockInfill(bounds, roads, net.query, { keepOut, quality: 'media', seed: 1 });
    const b = buildBlockInfill(bounds, roads, net.query, { keepOut, quality: 'media', seed: 1 });
    assert.ok(a.houses > 80, `pocas casas de relleno: ${a.houses}`);
    assert.ok(a.trees.length > 30, `pocos árboles de patio: ${a.trees.length}`);
    // mismo hash de posición -> ciudad idéntica
    assert.equal(a.houses, b.houses);
    assert.deepEqual(Array.from(infillVerts(a)), Array.from(infillVerts(b)));
    assert.deepEqual(a.trees, b.trees);
    // otra semilla -> otra ciudad
    const c = buildBlockInfill(bounds, roads, net.query, { keepOut, quality: 'media', seed: 2 });
    assert.notEqual(a.houses, c.houses);
});

test('relleno: ningún vértice cae sobre la calzada/vereda ni dentro de propiedades reales o plazas', () => {
    const { bounds, roads, net, keepOut, prop1, prop2, plaza } = infillFixture();
    const res = buildBlockInfill(bounds, roads, net.query, { keepOut, quality: 'media', seed: 7 });
    const P = infillVerts(res);
    assert.ok(P.length > 0);
    for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1];
        assert.ok(!net.query.onRoad(x, y, 0), `vértice de relleno sobre la calle: ${x},${y}`);
        for (const ring of [prop1, prop2, plaza]) {
            assert.ok(!pointInRing(x, y, ring), `vértice de relleno dentro de un polígono protegido: ${x},${y}`);
        }
        // todo adentro del barrio
        assert.ok(x >= bounds.minX - 1 && x <= bounds.maxX + 1 && y >= bounds.minY - 1 && y <= bounds.maxY + 1);
    }
    // los árboles tampoco pisan calle ni polígonos protegidos
    for (const t of res.trees) {
        assert.ok(!net.query.onRoad(t.x, t.y, 0));
        for (const ring of [prop1, prop2, plaza]) assert.ok(!pointInRing(t.x, t.y, ring));
    }
});

test('relleno: la densidad decae hacia el borde del distrito', () => {
    const { bounds, roads, net, keepOut } = infillFixture();
    const res = buildBlockInfill(bounds, roads, net.query, { keepOut, quality: 'media', seed: 3, fade: 300 });
    const P = infillVerts(res);
    const ed = (x, y) => Math.min(x - bounds.minX, bounds.maxX - x, y - bounds.minY, bounds.maxY - y);
    // casas por m² en dos franjas de distinto ancho: pegada al borde vs el interior (comparo DENSIDAD, no cantidad)
    const area = (a, b) => (1000 - 2 * a) ** 2 - (1000 - 2 * b) ** 2; // área con ed en [a,b] en una caja 1000×1000
    let borde = 0, interior = 0;
    const seen = new Set();
    for (let i = 0; i < P.length; i += 3) {
        const kx = Math.round(P[i]), ky = Math.round(P[i + 1]), key = kx * 100000 + ky;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = ed(P[i], P[i + 1]);
        if (d >= 20 && d < 120) borde++;
        else if (d >= 200 && d < 420) interior++;
    }
    const dBorde = borde / area(20, 120), dInterior = interior / area(200, 420);
    assert.ok(dInterior > dBorde * 1.3, `densidad interior=${dInterior.toFixed(5)} borde=${dBorde.toFixed(5)}: no decae hacia el borde`);
});

test('relleno: sin query no arma nada (defensivo)', () => {
    const { bounds, roads } = infillFixture();
    const res = buildBlockInfill(bounds, roads, null, { quality: 'media' });
    assert.equal(res.houses, 0);
    assert.equal(res.builders.buildings.pos.length, 0);
});
