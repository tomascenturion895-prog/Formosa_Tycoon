// Integración del entorno (city-env) en el armado de la ciudad (city-build.worker.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCityData, boundsOfBoxes } from '../../resources/js/map/city-build.worker.js';

const origin = [-58.178, -26.183];
function input(environment, withRoads = true) {
    // 3×3 manzanas de casas cuadradas de 10 m alrededor del origen
    const ids = [], kinds = [], areas = [], offsets = [0], coords = [], visible = [];
    const dLng = 10 / (111320 * Math.cos((origin[1] * Math.PI) / 180)), dLat = 10 / 110540;
    let id = 1;
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            const x = origin[0] + i * dLng * 10, y = origin[1] + j * dLat * 10;
            coords.push(x, y, x + dLng, y, x + dLng, y + dLat, x, y + dLat, x, y);
            offsets.push(offsets.at(-1) + 5);
            ids.push(id++); kinds.push(0); areas.push(100); visible.push(1);
        }
    }
    const roads = withRoads ? {
        offsets: Uint32Array.from([0, 2]), coords: Float64Array.from([origin[0] - 0.004, origin[1] + dLat * 5, origin[0] + 0.004, origin[1] + dLat * 5]), highway: ['residential'],
    } : null;
    return {
        seq: 1, origin, quality: 'baja', furniture: withRoads, environment, roads,
        buildings: { ids: Float64Array.from(ids), kinds: Uint8Array.from(kinds), areas: Float64Array.from(areas), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), visible: Uint8Array.from(visible), roofs: [] },
    };
}

test('con entorno vacío (servidor viejo) igual hay suelo y alrededores', () => {
    const { result } = buildCityData(input([]));
    const L = result.layers;
    assert.equal(L.error, undefined);
    assert.ok(L.ground.pos.length > 0, 'suelo');
    assert.ok(L.ringGround.pos.length > 0, 'alrededores');
    assert.ok(L.campo.length > 0, 'árboles del campo');
    assert.equal(L.water, undefined, 'sin agua inventada');
    assert.ok(!L.ground.pos.some(Number.isNaN));
});

test('con agua del entorno hay malla de agua y lado del río', () => {
    const e = origin[0] + 0.004;
    const water = { type: 'Feature', properties: { kind: 'water', name: 'Río Paraguay' }, geometry: { type: 'Polygon', coordinates: [[[e, origin[1] - 0.02], [e + 0.02, origin[1] - 0.02], [e + 0.02, origin[1] + 0.02], [e, origin[1] + 0.02], [e, origin[1] - 0.02]]] } };
    const { result } = buildCityData(input([water]));
    assert.ok(result.layers.water?.pos.length > 0);
    assert.equal(result.layers.waterSide, 'east');
});

test('los rearmados (sin entorno) no rehacen el suelo', () => {
    const { result } = buildCityData(input(null, false));
    assert.deepEqual(Object.keys(result.layers), []);
});

test('caja del barrio a partir de las cajas', () => {
    assert.deepEqual(boundsOfBoxes([[0, 0, 10, 5], [-3, 2, 4, 9]]), { minX: -3, minY: 0, maxX: 10, maxY: 9 });
});

test('con las calles completas hay calles 3D, mobiliario, franja y árboles de vereda', () => {
    const inp = input([]);
    const dLat = 10 / 110540, dLng = 10 / (111320 * Math.cos((origin[1] * Math.PI) / 180));
    inp.roadFeatures = [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] - dLng * 20, origin[1] + dLat * 5], [origin[0] + dLng * 20, origin[1] + dLat * 5]] }, properties: { highway: 'primary', name: 'Av. Prueba', osm_id: 1 } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] + dLng * 5, origin[1] - dLat * 20], [origin[0] + dLng * 5, origin[1] + dLat * 20]] }, properties: { highway: 'residential', name: 'Calle', osm_id: 2 } },
    ];
    const { result } = buildCityData(inp);
    const L = result.layers;
    assert.equal(L.error, undefined, L.error);
    assert.ok(L.roadsGround.pos.length > 0 && L.roadsMarkings.pos.length > 0);
    assert.ok(L.lamps.length >= 5 * 4, 'faroles');
    assert.ok(L.trees.length > 0, 'árboles de vereda / patio');
    assert.ok(L.info.houses > 0, JSON.stringify(L.info)); // las calles ya pasan el borde: casas sin calles nuevas
    assert.equal(result.furniture, null, 'sin los faroles viejos');
});

test('moldes con contexto: techo por defecto de cada edificio, cartel del hotel y autos del súper', () => {
    const inp = input([]);
    inp.buildings.kinds = Uint8Array.from([0, 1, 0, 3, 0, 2, 0, 1, 0]); // casa, comercio, hotel, supermercado…
    const dLat = 10 / 110540, dLng = 10 / (111320 * Math.cos((origin[1] * Math.PI) / 180));
    inp.roadFeatures = [-6, 4].flatMap((k, i) => [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] - dLng * 30, origin[1] + dLat * k], [origin[0] + dLng * 30, origin[1] + dLat * k]] }, properties: { highway: 'residential', osm_id: 10 + i } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] + dLng * k, origin[1] - dLat * 30], [origin[0] + dLng * k, origin[1] + dLat * 30]] }, properties: { highway: 'residential', osm_id: 20 + i } },
    ]);
    const { result } = buildCityData(inp);
    assert.equal(result.layers.error, undefined, result.layers.error);
    assert.equal(result.defaults.length, result.buildings);
    assert.ok(result.defaults.every(([, hex]) => /^#[0-9a-f]{6}$/i.test(hex)));
    assert.ok(result.chunks.some((c) => c.meshes.some((m) => m.kind === 'signs')), 'cartel del hotel');
    assert.ok(result.chunks.some((c) => c.meshes.some((m) => m.kind === 'walls' && m.style !== 'house')), 'estilos de fachada de city-molds');
    assert.ok(result.cars.length % 5 === 0);
    // el rearmado (sin entorno) usa el mismo contexto: mismos techos por defecto
    const again = buildCityData({ ...input(null, false), buildings: inp.buildings });
    assert.deepEqual(again.result.defaults, result.defaults);
});

test('armado en dos partes (dos workers): los sectores se reparten sin repetirse y suman todos los edificios', () => {
    const mk = () => { const i = input([]); i.roadFeatures = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[origin[0] - 0.003, origin[1]], [origin[0] + 0.003, origin[1]]] }, properties: { highway: 'residential', osm_id: 1 } }]; return i; };
    const whole = buildCityData(mk()).result;
    const a = buildCityData({ ...mk(), part: 0, parts: 2 }).result;
    const b = buildCityData({ ...mk(), part: 1, parts: 2, layersWanted: false }).result;
    assert.equal(a.buildings + b.buildings, whole.buildings);
    const keys = (r) => r.chunks.map((c) => `${c.i},${c.j}`);
    assert.equal(new Set([...keys(a), ...keys(b)]).size, keys(a).length + keys(b).length, 'ningún sector en las dos partes');
    assert.deepEqual(Object.keys(b.layers), [], 'la parte 1 no devuelve capas');
    assert.ok(a.layers.ground, 'la parte 0 devuelve el suelo');
    const defs = new Map([...a.defaults, ...b.defaults]);
    for (const [id, hex] of whole.defaults) assert.equal(defs.get(id), hex, 'mismo techo por defecto que el armado entero');
});

test('FastBuilder (arreglos tipados del worker) da la misma malla que MeshBuilder en los moldes', async () => {
    const { FastBuilder, serializeBuilder } = await import('../../resources/js/map/city-build.worker.js');
    const { addBuildingMold, FACADE_STYLES, MOLDS } = await import('../../resources/js/map/city-molds.js');
    const { MeshBuilder } = await import('../../resources/js/map/city-geometry.js');
    const ring = [[0, 0], [10, 0], [10, 14], [0, 14]];
    for (const mold of MOLDS) {
        const kind = mold === 'S1' ? 'supermercado' : mold === 'H1' || mold === 'E2' ? 'hotel' : mold.startsWith('L') ? 'comercio' : 'casa';
        const b = { id: 7, kind, ring: mold === 'S1' || mold === 'H1' || mold === 'E2' ? [[0, 0], [30, 0], [30, 34], [0, 34]] : ring, area: 140 };
        const ctx = { zone: 'centro', front: { dirX: 0, dirY: -1, dist: 15, edge: 7 }, corner: false, quality: 'media', mold };
        const slow = { walls: Object.fromEntries(FACADE_STYLES.map((s) => [s, new MeshBuilder()])), plain: new MeshBuilder() };
        const fast = { walls: Object.fromEntries(FACADE_STYLES.map((s) => [s, new FastBuilder(3)])), plain: new FastBuilder(3) };
        const r1 = addBuildingMold(b, slow, ctx), r2 = addBuildingMold(b, fast, ctx);
        assert.deepEqual(r1, r2, mold);
        for (const k of ['plain', ...FACADE_STYLES]) {
            const A = k === 'plain' ? slow.plain : slow.walls[k], B = k === 'plain' ? fast.plain : fast.walls[k];
            const a = serializeBuilder(A, { uv: true }), c = serializeBuilder(B, { uv: true });
            assert.deepEqual([...c.pos], [...a.pos], `${mold} ${k} pos`);
            assert.deepEqual([...c.col], [...a.col], `${mold} ${k} col`);
            assert.deepEqual([...c.uv], [...a.uv], `${mold} ${k} uv`);
            assert.deepEqual([...c.owner], [...a.owner], `${mold} ${k} owner`);
        }
    }
});
