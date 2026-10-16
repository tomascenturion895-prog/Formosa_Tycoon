import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshBuilder, hash01 } from '../../resources/js/map/city-geometry.js';
import {
    FACADE_STYLES, FACADE_CELLS, MOLDS, MOLD_WEIGHTS, chooseMold, addBuildingMold, defaultRoofColor, moldHeight, moldTraits,
} from '../../resources/js/map/city-molds.js';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const rot = (ring, a, dx = 0, dy = 0) => ring.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a) + dx, x * Math.sin(a) + y * Math.cos(a) + dy]);
const builders = () => ({ walls: Object.fromEntries(FACADE_STYLES.map((s) => [s, new MeshBuilder()])), plain: new MeshBuilder() });
const triCount = (B) => B.plain.owner.length + FACADE_STYLES.reduce((n, s) => n + B.walls[s].owner.length, 0);

const SHAPES = {
    cuadrado: rect(0, 0, 10, 10),
    rectangulo: rot(rect(-5, -9, 10, 18), 0.4, 30, -12),
    enL: [[0, 0], [14, 0], [14, 6], [6, 6], [6, 16], [0, 16]],
    finito: rect(0, 0, 2.6, 28),
    muyFinito: rect(0, 0, 1.2, 9),
    triangulo: [[0, 0], [12, 0], [0, 9]],
    grande: rot(rect(0, 0, 36, 48), -0.9),
    irregular: [[0, 0], [9, -1], [11, 7], [6, 12], [-1, 9]],
};
const FRONTS = [null, { dirX: 0, dirY: -1, dist: 14 }, { dirX: 0.7071, dirY: 0.7071, dist: 6 }];

function check(B, b, range, mold) {
    for (const bld of [B.plain, ...FACADE_STYLES.map((s) => B.walls[s])]) {
        assert.equal(bld.pos.length % 9, 0);
        assert.equal(bld.pos.length / 3, bld.col.length / 3);
        assert.equal(bld.uv.length / 2, bld.pos.length / 3);
        assert.equal(bld.owner.length * 3, bld.pos.length / 3);
        for (const v of bld.pos) assert.ok(Number.isFinite(v), 'posición finita');
        for (const v of bld.nor) assert.ok(Number.isFinite(v), 'normal finita');
        for (const v of bld.uv) assert.ok(Number.isFinite(v), 'uv finita');
        for (const v of bld.col) assert.ok(v >= 0 && v <= 1, 'color 0..1');
        for (const o of bld.owner) assert.equal(o, b.id);
    }
    const h = moldHeight(b, mold);
    let maxZ = 0;
    for (const bld of [B.plain, ...FACADE_STYLES.map((s) => B.walls[s])]) {
        for (let i = 2; i < bld.pos.length; i += 3) maxZ = Math.max(maxZ, bld.pos[i]);
    }
    assert.ok(maxZ <= h + 0.02, `${mold}: altura ${maxZ.toFixed(2)} > moldHeight ${h.toFixed(2)}`);
    assert.ok(maxZ >= h * 0.6, `${mold}: moldHeight ${h.toFixed(2)} muy por encima de lo dibujado ${maxZ.toFixed(2)}`);
    // rango del techo: contiguo, solo caras que miran hacia arriba y están arriba
    assert.ok(range && range.count > 0 && range.count % 3 === 0, `${mold}: rango de techo`);
    assert.ok(range.start >= 0 && range.start + range.count <= B.plain.vertexCount);
    for (let v = range.start; v < range.start + range.count; v++) {
        assert.ok(B.plain.nor[v * 3 + 2] > 0.2, `${mold}: vértice ${v} del techo no mira hacia arriba`);
        const z = B.plain.pos[v * 3 + 2];
        assert.ok(z >= 2.0 && z <= h + 0.01, `${mold}: vértice del techo a ${z.toFixed(2)} m`);
    }
}

test('cada molde arma geometría válida para formas cuadradas, rectangulares, en L, finitas y triangulares', () => {
    let n = 0;
    for (const mold of MOLDS) {
        for (const [name, ring] of Object.entries(SHAPES)) {
            for (const [fi, front] of FRONTS.entries()) {
                for (const id of [3, 1234, 99991]) {
                    const b = { id, kind: 'casa', ring, area: null, name: null };
                    const B = builders();
                    const range = addBuildingMold(b, B, { zone: 'barrio', front, corner: fi === 2, mold, quality: id === 3 ? 'baja' : 'alta' });
                    try {
                        check(B, b, range, mold);
                    } catch (e) {
                        e.message = `${mold}/${name}/frente${fi}/id${id}: ${e.message}`;
                        throw e;
                    }
                    n++;
                }
            }
        }
    }
    assert.ok(n > 500);
});

test('el rango del techo se puede recolorear sin tocar otra cosa', () => {
    const b = { id: 77, kind: 'casa', ring: rect(0, 0, 10, 16), area: 160 };
    const B = builders();
    const r = addBuildingMold(b, B, { zone: 'barrio', front: { dirX: 0, dirY: -1, dist: 15 }, mold: 'C2' });
    const before = B.plain.col.slice();
    for (let v = r.start; v < r.start + r.count; v++) B.plain.col.splice(v * 3, 3, 1, 0.8, 0);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== B.plain.col[i]) changed++;
    assert.ok(changed > 0);
    // un techo con dueño usa el color pedido
    const B2 = builders();
    const r2 = addBuildingMold({ ...b, roofColor: '#ffb703' }, B2, { zone: 'barrio', mold: 'C1' });
    for (let v = r2.start; v < r2.start + r2.count; v++) {
        assert.deepEqual(B2.plain.col.slice(v * 3, v * 3 + 3).map((c) => Math.round(c * 255)), [255, 183, 3]);
    }
});

test('es determinista: misma entrada, mismos triángulos', () => {
    for (const mold of MOLDS) {
        const b = { id: 4242, kind: 'casa', ring: SHAPES.rectangulo, area: null };
        const ctx = { zone: 'centro', front: { dirX: 1, dirY: 0, dist: 10 }, mold };
        const A = builders(), B = builders();
        const ra = addBuildingMold(b, A, ctx), rb = addBuildingMold(b, B, ctx);
        assert.deepEqual(ra, rb);
        assert.deepEqual(A.plain.pos, B.plain.pos);
        assert.deepEqual(A.plain.col, B.plain.col);
        for (const s of FACADE_STYLES) assert.deepEqual(A.walls[s].uv, B.walls[s].uv);
    }
    assert.equal(chooseMold({ id: 5, kind: 'casa', ring: SHAPES.cuadrado }, { zone: 'barrio' }), chooseMold({ id: 5, kind: 'casa', ring: SHAPES.cuadrado }, { zone: 'barrio' }));
});

test('los pesos de cada zona se respetan (±3 %) sobre 5000 casas', () => {
    const ring = rect(0, 0, 8, 14);
    for (const [zone, table] of Object.entries(MOLD_WEIGHTS)) {
        const count = {};
        const N = 5000;
        for (let i = 0; i < N; i++) {
            const m = chooseMold({ id: 1000 + i * 13, kind: 'casa', ring, area: 112 }, { zone, front: null });
            count[m] = (count[m] ?? 0) + 1;
        }
        for (const [m, w] of Object.entries(table)) {
            const got = ((count[m] ?? 0) / N) * 100;
            assert.ok(Math.abs(got - w) <= 3, `${zone} ${m}: ${got.toFixed(1)} % (esperado ${w} %)`);
        }
    }
});

test('restricciones de forma, tipo y esquina', () => {
    for (let id = 1; id < 400; id++) {
        const tiny = chooseMold({ id, kind: 'casa', ring: rect(0, 0, 5, 8), area: 40 }, { zone: 'centro' });
        assert.ok(tiny === 'C1' || tiny === 'C3', `casa chiquita: ${tiny}`);
        const narrow = chooseMold({ id, kind: 'casa', ring: rect(0, 0, 7, 9.5), area: 66.5 }, { zone: 'centro' });
        assert.notEqual(narrow, 'C6');
        const ele = chooseMold({ id, kind: 'casa', ring: SHAPES.enL, area: 132 }, { zone: 'barrio' });
        assert.ok(ele !== 'C2' && ele !== 'C6', `en L: ${ele}`);
        assert.equal(chooseMold({ id, kind: 'comercio', ring: rect(0, 0, 10, 14), area: 140 }, { zone: 'barrio', corner: true }), 'L2');
        assert.equal(chooseMold({ id, kind: 'comercio', ring: rect(0, 0, 10, 14), area: 140 }, { zone: 'barrio' }), 'L1');
        assert.ok(['L3', 'E1'].includes(chooseMold({ id, kind: 'comercio', ring: rect(0, 0, 10, 14), area: 140 }, { zone: 'centro' })));
        assert.equal(chooseMold({ id, kind: 'supermercado', ring: rect(0, 0, 40, 50) }, { zone: 'barrio' }), 'S1');
        assert.equal(chooseMold({ id, kind: 'hotel', ring: rect(0, 0, 20, 30) }, { zone: 'centro' }), 'H1');
        assert.equal(chooseMold({ id, kind: 'hotel', ring: rect(0, 0, 20, 30) }, { zone: 'costanera' }), 'E2');
        assert.equal(chooseMold({ id, kind: 'casa', ring: rect(0, 0, 20, 20), area: 400 }, { zone: 'centro' }), 'E1');
        // casa antigua solo pegada a la vereda
        const far = chooseMold({ id, kind: 'casa', ring: rect(0, 0, 9, 16), area: 144 }, { zone: 'centro', front: { dirX: 0, dirY: -1, dist: 25 } });
        assert.notEqual(far, 'C4');
    }
    // la costanera tiene más casas de dos plantas que el barrio
    let c5b = 0, c5c = 0;
    for (let id = 1; id < 3000; id++) {
        const b = { id, kind: 'casa', ring: rect(0, 0, 8, 14), area: 112 };
        if (chooseMold(b, { zone: 'barrio' }) === 'C5') c5b++;
        if (chooseMold(b, { zone: 'costanera' }) === 'C5') c5c++;
    }
    assert.ok(c5c > c5b * 1.5);
});

test('dos ids vecinos casi nunca se ven iguales', () => {
    const ring = rect(0, 0, 10, 16);
    let same = 0, prev = null;
    const N = 1500;
    for (let id = 1; id <= N; id++) {
        const B = builders();
        addBuildingMold({ id, kind: 'casa', ring, area: 160 }, B, { zone: 'barrio', front: { dirX: 0, dirY: -1, dist: 16 } });
        const sig = [B.plain.col.join(','), B.plain.pos.length, ...FACADE_STYLES.map((s) => B.walls[s].col.join(','))].join('|');
        if (sig === prev) same++;
        prev = sig;
    }
    assert.ok(same / N < 0.01, `vecinos iguales: ${same}`);
});

test('colores de techo por defecto: tejas, chapa o terraza gris', () => {
    const ring = rect(0, 0, 10, 16);
    for (let id = 1; id < 200; id++) {
        const b = { id, kind: 'casa', ring };
        assert.match(defaultRoofColor(b, 'C2'), /^#[0-9a-f]{6}$/);
        const [r, g, bl] = [1, 3, 5].map((k) => parseInt(defaultRoofColor(b, 'C2').slice(k, k + 2), 16));
        assert.ok(r > g && r > bl, 'tejas rojizas');
        const flat = defaultRoofColor(b, 'C1');
        const [fr, fg, fb] = [1, 3, 5].map((k) => parseInt(flat.slice(k, k + 2), 16));
        assert.ok(Math.max(fr, fg, fb) - Math.min(fr, fg, fb) < 30 && fr > 0x80, `terraza gris clara ${flat}`);
    }
});

test('las texturas no tocan el DOM al importar y cada estilo tiene su tamaño de celda', async () => {
    const mod = await import('../../resources/js/map/city-textures.js');
    assert.equal(typeof mod.makeFacadeTextures, 'function');
    for (const s of FACADE_STYLES) {
        assert.equal(FACADE_CELLS[s].length, 2);
        assert.ok(FACADE_CELLS[s][0] > 1 && FACADE_CELLS[s][1] > 2);
    }
});

/** Ciudad de prueba: casas, comercios, hoteles y súper con formas, zonas, frentes y esquinas variadas. */
function fakeCity(N) {
    const items = [];
    for (let i = 0; i < N; i++) {
        const r = hash01(i, 1);
        const kind = r < 0.84 ? 'casa' : r < 0.97 ? 'comercio' : r < 0.985 ? 'hotel' : 'supermercado';
        const w = kind === 'supermercado' ? 30 + hash01(i, 2) * 30 : kind === 'hotel' ? 15 + hash01(i, 2) * 15 : 6 + hash01(i, 2) * 10;
        const d = kind === 'supermercado' ? 30 + hash01(i, 3) * 30 : 10 + hash01(i, 3) * 15;
        const x = (i % 110) * 22, y = Math.floor(i / 110) * 30;
        const shape = hash01(i, 4) < 0.1
            ? [[x, y], [x + w, y], [x + w, y + d / 2], [x + w / 2, y + d / 2], [x + w / 2, y + d], [x, y + d]]
            : rot(rect(-w / 2, -d / 2, w, d), hash01(i, 5) * 3, x, y);
        const zone = hash01(i, 6) < 0.2 ? 'centro' : hash01(i, 6) < 0.3 ? 'costanera' : 'barrio';
        items.push([{ id: i + 1, kind, ring: shape, area: null }, { zone, front: { dirX: 0, dirY: -1, dist: d / 2 + 8 + hash01(i, 7) * 6 }, corner: hash01(i, 8) < 0.15, quality: 'alta' }]);
    }
    return items;
}

test('presupuesto: 12.500 edificios mezclados en menos de 1,2 s y pocos triángulos por molde', () => {
    const items = fakeCity(12500);
    // triángulos por molde (una pasada aparte, para no medir el conteo)
    const perMold = {};
    const B0 = builders();
    for (const [b, ctx] of items) {
        const before = triCount(B0);
        addBuildingMold(b, B0, ctx);
        const p = (perMold[moldTraits(b, ctx).mold] ??= { n: 0, tris: 0 });
        p.n++;
        p.tris += triCount(B0) - before;
    }
    // tiempo: la mejor de tres pasadas (la máquina de pruebas puede estar ocupada con otras cosas)
    const times = [];
    for (let rep = 0; rep < 3; rep++) {
        const B = builders();
        const t0 = performance.now();
        for (const [b, ctx] of items) addBuildingMold(b, B, ctx);
        times.push(performance.now() - t0);
    }
    const ms = Math.min(...times);
    const report = Object.entries(perMold).sort().map(([m, p]) => `${m}:${(p.tris / p.n).toFixed(0)}(${p.n})`).join(' ');
    console.log(`# 12.500 edificios: ${times.map((t) => t.toFixed(0)).join(' / ')} ms, ${triCount(B0)} triángulos; promedio por molde: ${report}`);
    assert.ok(ms < 1200, `tardó ${ms.toFixed(0)} ms`);
    for (const [m, p] of Object.entries(perMold)) {
        const limit = m.startsWith('C') || m.startsWith('L') ? 150 : 400;
        assert.ok(p.tris / p.n <= limit, `${m}: ${(p.tris / p.n).toFixed(0)} triángulos en promedio`);
    }
});

// ------------------------------------------------------------------ variedad (casas vecinas distintas)

const LOOK = ['mold', 'wall', 'roof', 'trim', 'gallery', 'galRoof', 'galCols', 'tankColor', 'ac', 'fence', 'gate', 'eave', 'roofRoom',
    'precaria', 'unfinished', 'roofType', 'chimney', 'tile', 'garage', 'ironRail', 'style', 'cornice', 'pitched'];
const lookOf = (t) => LOOK.map((k) => String(t[k] ?? '-')).join('|') + '|' + t.height.toFixed(2);

test('vecinos: ids consecutivos casi nunca comparten molde + color de pared + color de techo, y nunca todos los rasgos', () => {
    const ring = rect(0, 0, 10, 16);
    for (const zone of ['barrio', 'centro', 'costanera']) {
        let sameAll = 0, sameLook = 0, prev = null;
        const N = 5000;
        for (let id = 1; id <= N; id++) {
            const t = moldTraits({ id, kind: 'casa', ring, area: 160 }, { zone, front: { dirX: 0, dirY: -1, dist: 16 } });
            const cur = { all: lookOf(t), look: `${t.mold}|${t.wall}|${t.roof}` };
            if (prev && cur.all === prev.all) sameAll++;
            if (prev && cur.look === prev.look) sameLook++;
            prev = cur;
        }
        assert.ok(sameAll / N < 0.002, `${zone}: ${sameAll} pares idénticos en todo`);
        assert.ok(sameLook / N < 0.02, `${zone}: ${sameLook} pares con mismo molde, pared y techo`);
    }
    // también entre vecinos no consecutivos (las ids de OSM de una cuadra no son correlativas pero sí cercanas)
    let same = 0, n = 0;
    for (let id = 1; id <= 2000; id++) {
        const a = lookOf(moldTraits({ id, kind: 'casa', ring, area: 160 }, { zone: 'barrio' }));
        for (const k of [2, 3, 7, 10]) {
            n++;
            if (a === lookOf(moldTraits({ id: id + k, kind: 'casa', ring, area: 160 }, { zone: 'barrio' }))) same++;
        }
    }
    assert.ok(same / n < 0.002, `vecinos cercanos idénticos: ${same}/${n}`);
});

test('cada rasgo varía según el hash: color, galería, tanque, cerco, portón, aire, alero, altura', () => {
    const ring = rect(0, 0, 10, 16);
    const N = 3000;
    const all = { C1: [], C2: [], C3: [], C5: [] };
    for (let id = 1; id <= N; id++) {
        for (const mold of Object.keys(all)) all[mold].push(moldTraits({ id, kind: 'casa', ring, area: 160 }, { zone: 'barrio', mold }));
    }
    const frac = (list, f) => list.filter(f).length / list.length;
    const distinct = (list, k) => new Set(list.map((t) => t[k])).size;
    const between = (x, a, b, what) => assert.ok(x >= a && x <= b, `${what}: ${(x * 100).toFixed(1)} %`);
    const c1 = all.C1;
    between(frac(c1, (t) => t.gallery), 0.6, 0.8, 'C1 con galería');
    between(frac(c1, (t) => t.tank), 0.78, 0.92, 'C1 con tanque');
    between(frac(c1, (t) => t.ac), 0.45, 0.65, 'C1 con aire');
    between(frac(c1, (t) => t.gate), 0.35, 0.55, 'C1 con portón');
    between(frac(c1, (t) => t.roofRoom), 0.2, 0.4, 'C1 con lavadero en la terraza');
    for (const f of [0, 1, 2, 3]) between(frac(c1, (t) => t.fence === f), 0.18, 0.32, `C1 cerco ${f}`);
    assert.ok(distinct(c1, 'wall') >= 8, 'colores de pared C1');
    assert.ok(distinct(c1.filter((t) => t.tank), 'tankColor') >= 3, 'colores de tanque');
    assert.ok(distinct(c1, 'trim') >= 6, 'remates de pretil');
    // altura ±10 %
    const hs = c1.map((t) => t.H);
    assert.ok(Math.min(...hs) >= 3.2 * 0.9 - 1e-9 && Math.max(...hs) <= 3.2 * 1.1 + 1e-9);
    assert.ok(Math.max(...hs) - Math.min(...hs) > 0.5, 'la altura varía');
    // tejas: alero, pendiente, tipo de techo, color
    const c2 = all.C2;
    const eaves = c2.map((t) => t.eave);
    assert.ok(Math.min(...eaves) < 0.45 && Math.max(...eaves) > 0.7, 'aleros de distinto largo');
    assert.ok(distinct(c2, 'roof') >= 6, 'tonos de teja');
    for (const k of [0, 1, 2]) between(frac(c2, (t) => t.roofType === k), 0.25, 0.42, `C2 techo tipo ${k}`);
    between(frac(c2, (t) => t.chimney), 0.3, 0.5, 'C2 con chimenea');
    // chapa: hay casillas precarias y casas con pretil, con o sin la franja de bloque sin terminar
    between(frac(all.C3, (t) => t.precaria), 0.25, 0.45, 'C3 precaria');
    between(frac(all.C3.filter((t) => !t.precaria), (t) => t.unfinished), 0.35, 0.55, 'C3 sin terminar');
    // dos plantas: techo plano o de tejas, baranda de hierro o de mampostería, portón de garaje de varios colores
    between(frac(all.C5, (t) => t.tile), 0.25, 0.45, 'C5 con tejas');
    between(frac(all.C5, (t) => t.ironRail), 0.4, 0.6, 'C5 baranda de hierro');
    assert.ok(distinct(all.C5, 'garage') >= 5, 'portones de garaje');
});

test('la variedad se ve en la geometría: el dúplex nunca repite color en unidades vecinas', () => {
    for (let id = 1; id < 400; id++) {
        const B = builders();
        addBuildingMold({ id, kind: 'casa', ring: rect(0, 0, 18, 10), area: 180 }, B, { zone: 'barrio', mold: 'C6', front: { dirX: 0, dirY: -1, dist: 12 } });
        // color de cada tramo del frente (las paredes de la fachada que miran a -y)
        const wb = B.walls.casa;
        const fronts = [];
        for (let t = 0; t < wb.owner.length; t += 2) {
            const v = t * 3;
            if (wb.nor[v * 3 + 1] < -0.99) fronts.push([Math.min(wb.pos[v * 3], wb.pos[v * 3 + 3], wb.pos[v * 3 + 6]), wb.col.slice(v * 3, v * 3 + 3).join(',')]);
        }
        fronts.sort((a, b) => a[0] - b[0]);
        for (let k = 1; k < fronts.length; k++) assert.notEqual(fronts[k][1], fronts[k - 1][1], `dúplex ${id}: unidades vecinas del mismo color`);
    }
});

// ------------------------------------------------------------------ techo recoloreable (dueño)

/** Área en planta de los triángulos del rango. */
function rangeArea(B, r) {
    let a = 0;
    for (let v = r.start; v < r.start + r.count; v += 3) {
        const P = B.plain.pos;
        const ax = P[v * 3], ay = P[v * 3 + 1], bx = P[v * 3 + 3], by = P[v * 3 + 4], cx = P[v * 3 + 6], cy = P[v * 3 + 7];
        a += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    }
    return a;
}

test('techo del dueño: cubre toda la planta, usa el color pedido y el color por defecto coincide con defaultRoofColor', () => {
    const shapes = { rect: rect(0, 0, 10, 16), enL: SHAPES.enL, irregular: SHAPES.irregular, grande: SHAPES.grande };
    for (const mold of MOLDS) {
        for (const [name, ring] of Object.entries(shapes)) {
            for (const id of [11, 222, 3333, 44444]) {
                for (const quality of ['baja', 'alta']) {
                    const b = { id, kind: 'casa', ring, area: null };
                    const ctx = { zone: 'barrio', front: { dirX: 0, dirY: -1, dist: 14 }, corner: true, mold, quality };
                    const t = moldTraits(b, ctx);
                    const B = builders();
                    const r = addBuildingMold(b, B, ctx);
                    const where = `${mold}→${t.mold}/${name}/${id}/${quality}`;
                    // sin dueño: el color del rango es exactamente defaultRoofColor
                    const def = defaultRoofColor(b, mold);
                    for (let v = r.start; v < r.start + r.count; v++) {
                        assert.equal('#' + B.plain.col.slice(v * 3, v * 3 + 3).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join(''), def, `${where}: color de techo`);
                    }
                    // el rango tapa la planta (≥ 90 % en techos planos; los de tejas, con alero, más)
                    const area = Math.abs(ring.reduce((s, p, i) => {
                        const q = ring[(i + 1) % ring.length];
                        return s + p[0] * q[1] - q[0] * p[1];
                    }, 0) / 2);
                    const covered = rangeArea(B, r);
                    const isRect = name === 'rect';
                    if (t.roofKind === 'plano' || t.mold === 'C3' || !isRect) {
                        // techos planos/chapa: la planta (menos la galería de C1/C2, que tiene su propio techito)
                        assert.ok(covered >= area * (t.gallery ? 0.55 : 0.9) - 0.5, `${where}: techo cubre ${covered.toFixed(1)} de ${area.toFixed(1)} m²`);
                    } else {
                        assert.ok(covered >= area * (t.gallery ? 0.6 : 1.0), `${where}: tejas cubren ${covered.toFixed(1)} de ${area.toFixed(1)} m²`);
                    }
                    // con dueño: todo el rango con el color del dueño y nada más de ese color fuera del rango
                    const B2 = builders();
                    const r2 = addBuildingMold({ ...b, roofColor: '#ff00ff' }, B2, ctx);
                    assert.deepEqual(r2, r);
                    for (let v = 0; v < B2.plain.vertexCount; v++) {
                        const isMagenta = B2.plain.col[v * 3] === 1 && B2.plain.col[v * 3 + 1] === 0 && B2.plain.col[v * 3 + 2] === 1;
                        assert.equal(isMagenta, v >= r.start && v < r.start + r.count, `${where}: vértice ${v}`);
                    }
                    // el resto de la geometría no cambia con el dueño
                    assert.deepEqual(B2.plain.pos, B.plain.pos);
                }
            }
        }
    }
});

test('edificios en altura: departamentos de 3–5 pisos, hoteles de 7–11, torres solo en la costanera', () => {
    for (let id = 1; id < 600; id++) {
        const big = { id, kind: 'casa', ring: rect(0, 0, 25, 30), area: 750 };
        const e1 = moldTraits(big, { zone: 'centro' });
        assert.equal(e1.mold, 'E1');
        assert.ok(e1.floors >= 3 && e1.floors <= 5);
        const h1 = moldTraits({ ...big, kind: 'hotel' }, { zone: 'centro' });
        assert.equal(h1.mold, 'H1');
        assert.ok(h1.floors >= 7 && h1.floors <= 11 && h1.height > 20);
        const e2 = moldTraits({ ...big, kind: 'hotel' }, { zone: 'costanera' });
        assert.equal(e2.mold, 'E2');
        assert.ok(e2.floors >= 10 && e2.floors <= 15);
        // en el barrio nada pasa de dos plantas (salvo hotel / súper)
        for (const kind of ['casa', 'comercio']) {
            const m = chooseMold({ ...big, kind }, { zone: 'barrio' });
            assert.ok(!['E1', 'E2', 'H1'].includes(m), `barrio ${kind}: ${m}`);
            assert.ok(moldHeight({ ...big, kind }, m) < 10);
        }
        assert.notEqual(chooseMold({ ...big, kind: 'hotel' }, { zone: 'barrio' }), 'E2');
    }
});

test('texturas de fachada (con un canvas de mentira): de día fondo blanco, de noche negro con solo algunas ventanas prendidas', async () => {
    const { makeFacadeTextures } = await import('../../resources/js/map/city-textures.js');
    const made = [];
    globalThis.document = {
        createElement(tag) {
            assert.equal(tag, 'canvas');
            const rects = [];
            const c = { width: 0, height: 0, rects, getContext: () => ({ fillStyle: '#000', fillRect(x, y, w, h) { rects.push([x, y, w, h, this.fillStyle]); } }) };
            made.push(c);
            return c;
        },
    };
    try {
        for (const style of FACADE_STYLES) {
            made.length = 0;
            const t = makeFacadeTextures(style);
            assert.deepEqual(t.cell, FACADE_CELLS[style]);
            assert.ok([128, 256].includes(t.day.width) && t.day.width === t.day.height && t.night.width === t.day.width);
            const [bgDay, ...day] = t.day.rects;
            const [bgNight, ...lit] = t.night.rects;
            assert.deepEqual(bgDay, [0, 0, t.day.width, t.day.width, '#ffffff'], `${style}: fondo de día`);
            assert.deepEqual(bgNight, [0, 0, t.day.width, t.day.width, '#000000'], `${style}: fondo de noche`);
            assert.ok(day.length > 4, `${style}: dibuja ventanas`);
            assert.ok(lit.length >= 1, `${style}: alguna ventana prendida`);
            for (const [x, y, w, h] of [...day, ...lit]) {
                assert.ok(Number.isInteger(x) && Number.isInteger(y) && w > 0 && h > 0, `${style}: píxeles enteros (look pixel)`);
                assert.ok(x >= 0 && y >= 0 && x + w <= t.day.width && y + h <= t.day.width, `${style}: dentro del lienzo`);
            }
            for (const r of lit) assert.match(r[4], /^#(ff|a9)/, `${style}: luz cálida (o tele) ${r[4]}`);
            // en los de varias ventanas no se prenden todas
            if (['departamentos', 'hotel', 'torre'].includes(style)) {
                const area = lit.reduce((s, r) => s + r[2] * r[3], 0);
                const total = day.filter((r) => /^#(5|4|7)/.test(r[4])).reduce((s, r) => s + r[2] * r[3], 0);
                assert.ok(area < total * 0.85, `${style}: ${area} de ${total} px de vidrio prendidos`);
            }
        }
    } finally {
        delete globalThis.document;
    }
});
