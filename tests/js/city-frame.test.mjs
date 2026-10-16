import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector3, Frustum, Sphere } from 'three';
import {
    localProjection, eyeFromMatrix, frustumPlanes, sphereVisible, fogRange, chunkCoord, sphereDistance,
    districtBounds, clampLngLat, clampZoom, LIMITS_3D, QUALITY, QUALITY_LEVELS, parseQualityMode, decideQuality,
    createFrameMeter, initialAutoQuality, median,
} from '../../resources/js/map/city-frame.js';
import { buildCityData, KINDS, addContactShadow } from '../../resources/js/map/city-build.worker.js';
import { orientedBox, normalizeRing } from '../../resources/js/map/city-geometry.js';

/** Cámara de prueba: perspectiva + mirar desde `eye` hacia `target`, con z hacia arriba (como la ciudad). */
function camera(eye, target, { fov = 37, aspect = 1.6, near = 1, far = 5000 } = {}) {
    const cam = new PerspectiveCamera(fov, aspect, near, far);
    cam.up.set(0, 0, 1);
    cam.position.set(...eye);
    cam.lookAt(new Vector3(...target));
    cam.updateMatrixWorld();
    const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    return mvp.elements;
}

test('la proyección local deja el origen en (0,0) y mide en metros', () => {
    const { toLocal, scale } = localProjection([-58.18, -26.18]);
    const [x0, y0] = toLocal(-58.18, -26.18);
    assert.ok(Math.abs(x0) < 1e-6 && Math.abs(y0) < 1e-6);
    const [, yN] = toLocal(-58.18, -26.17); // 0,01° al norte ≈ 1113 m
    assert.ok(Math.abs(yN - 1112) < 6, `norte: ${yN}`);
    const [xE] = toLocal(-58.17, -26.18); // 0,01° al este ≈ 1113 × cos(26,18°) ≈ 999 m
    assert.ok(Math.abs(xE - 999) < 6, `este: ${xE}`);
    assert.ok(scale > 0 && scale < 1e-6);
});

test('la posición del ojo sale de la matriz de proyección × vista', () => {
    for (const [eye, target] of [[[120, -800, 600], [0, 0, 0]], [[-50, 30, 2500], [10, 20, 0]], [[900, 900, 120], [800, 820, 5]]]) {
        const got = eyeFromMatrix(camera(eye, target));
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - eye[i]) < 1e-3 * Math.max(1, Math.abs(eye[i])), `${got} vs ${eye}`);
    }
    assert.equal(eyeFromMatrix(new Matrix4().makeOrthographic(-1, 1, 1, -1, 1, 10).elements), null, 'ortográfica: sin ojo');
});

test('el ojo no depende de cómo se arma la profundidad (plano lejano infinito / z invertida)', () => {
    const m = camera([200, -600, 400], [0, 0, 0]).slice();
    // cambiar la fila de profundidad (fila 2) no mueve el ojo
    m[2] *= -3; m[6] *= -3; m[10] = 0.2; m[14] = 7;
    const got = eyeFromMatrix(m);
    assert.ok(Math.abs(got[0] - 200) < 1e-3 && Math.abs(got[1] + 600) < 1e-3 && Math.abs(got[2] - 400) < 1e-3);
});

test('la pirámide de visión descarta lo que queda atrás, a los costados o más allá del plano lejano', () => {
    const m = camera([0, -800, 600], [0, 0, 0], { far: 3000 });
    const planes = frustumPlanes(m);
    assert.ok(sphereVisible(planes, 0, 0, 0, 10), 'lo que mira');
    assert.ok(!sphereVisible(planes, 0, -2000, 0, 50), 'atrás');
    assert.ok(!sphereVisible(planes, 3000, 0, 0, 50), 'muy a la derecha');
    assert.ok(!sphereVisible(planes, 0, 5000, 0, 50), 'más allá del plano lejano');
    assert.ok(!sphereVisible(planes, 800, 0, 0, 100) && sphereVisible(planes, 800, 0, 0, 400), 'una esfera grande que asoma por el borde');
    // coincide con THREE.Frustum para un montón de esferas
    const f = new Frustum().setFromProjectionMatrix(new Matrix4().fromArray(m));
    let n = 0;
    for (let x = -3000; x <= 3000; x += 250) {
        for (let y = -3000; y <= 3000; y += 250) {
            const s = new Sphere(new Vector3(x, y, 10), 120);
            assert.equal(sphereVisible(planes, x, y, 10, 120), f.intersectsSphere(s), `(${x}, ${y})`);
            n++;
        }
    }
    assert.ok(n > 500);
});

test('el ojo y la pirámide funcionan con la matriz del modelo de MapLibre (y invertida, en mercator)', () => {
    // MapLibre: mvp_mercator × [s, 0, 0, ox; 0, -s, 0, oy; 0, 0, s, 0]
    const s = 1.6e-8, ox = 0.33, oy = 0.57;
    const model = new Matrix4().makeTranslation(ox, oy, 0).scale(new Vector3(s, -s, s));
    const eyeLocal = [100, -700, 500];
    const local = new Matrix4().fromArray(camera(eyeLocal, [0, 0, 0]));
    // una "matriz mercator" que al multiplicar por el modelo da la local
    const merc = local.clone().multiply(model.clone().invert());
    const back = merc.clone().multiply(model).elements;
    const got = eyeFromMatrix(back);
    assert.ok(Math.hypot(got[0] - 100, got[1] + 700, got[2] - 500) < 0.05, `${got}`);
    assert.ok(sphereVisible(frustumPlanes(back), 0, 0, 0, 5));
});

test('la niebla arranca más cerca (en proporción) con poco zoom', () => {
    const lejos = fogRange(14.5, 2500);
    const cerca = fogRange(18.5, 300);
    assert.ok(lejos.near < lejos.far && cerca.near < cerca.far);
    assert.ok(lejos.far / 2500 < cerca.far / 300);
    assert.ok(lejos.far < 2500 * 2.5, 'el borde de la ciudad entera se funde');
});

test('sectores y distancias', () => {
    assert.deepEqual(chunkCoord(10, 10), [0, 0]);
    assert.deepEqual(chunkCoord(-1, 251), [-1, 1]);
    assert.equal(sphereDistance([0, 0, 100], [0, 0, 0, 150]), 0);
    assert.ok(Math.abs(sphereDistance([0, 0, 0], [300, 400, 0, 100]) - 400) < 1e-9);
});

test('límites de la cámara en 3D: el barrio más 300 m', () => {
    const b = districtBounds([[[-58.2, -26.2], [-58.18, -26.19]], [[-58.19, -26.17]]]);
    assert.ok(b[0] < -58.2 && b[2] > -58.18 && b[1] < -26.2 && b[3] > -26.17);
    assert.ok(Math.abs((-26.2 - b[1]) * 111320 - 300) < 1);
    assert.deepEqual(clampLngLat([-60, -26.18], b), [b[0], -26.18]);
    assert.equal(clampZoom(12), LIMITS_3D.minZoom);
    assert.equal(clampZoom(21), LIMITS_3D.maxZoom);
    assert.equal(districtBounds([]), null);
});

test('niveles de calidad y elección automática', () => {
    for (const q of QUALITY_LEVELS) {
        const p = QUALITY[q];
        for (const k of ['pixelRatio', 'lodDistance', 'maxTrees', 'maxVehicles', 'furnitureDistance']) assert.equal(typeof p[k], 'number', `${q}.${k}`);
        assert.equal(typeof p.sunShadows, 'boolean');
    }
    assert.ok(QUALITY.baja.lodDistance < QUALITY.media.lodDistance && QUALITY.media.lodDistance < QUALITY.alta.lodDistance);
    assert.ok(QUALITY.alta.sunShadows && !QUALITY.baja.sunShadows);
    assert.equal(parseQualityMode('alta'), 'alta');
    assert.equal(parseQualityMode(null), 'auto');
    assert.equal(parseQualityMode('ultra'), 'auto');
    assert.equal(decideQuality('alta', Array(30).fill(16)), 'alta', '60 cuadros/s: se queda');
    assert.equal(decideQuality('alta', Array(30).fill(60)), 'media', '16 cuadros/s: baja un escalón');
    assert.equal(decideQuality('alta', Array(30).fill(300)), 'baja', '3 cuadros/s: directo a baja');
    assert.equal(decideQuality('baja', Array(30).fill(60)), 'baja');
    assert.equal(decideQuality('media', []), 'media');
    assert.equal(initialAutoQuality({ mobile: true, cores: 8 }), 'baja');
    assert.equal(initialAutoQuality({ cores: 8, dpr: 1 }), 'alta');
    assert.equal(median([5, 1, 3]), 3);
});

test('el medidor de cuadros ignora las pausas y los primeros cuadros', () => {
    const meter = createFrameMeter({ windowMs: 1000, skip: 2 });
    let t = 0;
    let done = false;
    for (let i = 0; i < 10; i++) done = meter.frame((t += 20));
    t += 5000; // el mapa quieto: no cuenta
    meter.frame(t);
    assert.ok(!done);
    assert.ok(meter.times.every((d) => d === 20));
    while (!done) done = meter.frame((t += 50));
    assert.ok(meter.times.reduce((a, b) => a + b, 0) >= 1000);
});

// ------------------------------------------------------------------ armado por sectores (worker)

function cityInput(nx = 30, ny = 30, { visible = () => true, roofs = [] } = {}) {
    const ids = [], kinds = [], areas = [], offsets = [0], coords = [], vis = [];
    const [lng0, lat0] = [-58.18, -26.18];
    let id = 1;
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
            const kind = (i * ny + j) % 17 === 0 ? 'comercio' : (i * ny + j) % 53 === 0 ? 'hotel' : 'casa';
            const x = lng0 + i * 0.0002, y = lat0 + j * 0.0002; // ~20 m entre casas
            const w = 0.00008, h = 0.00006;
            coords.push(x, y, x + w, y, x + w, y + h, x, y + h, x, y);
            offsets.push(offsets.at(-1) + 5);
            ids.push(id);
            kinds.push(KINDS.indexOf(kind));
            areas.push(kind === 'hotel' ? 900 : 60);
            vis.push(visible(kind) ? 1 : 0);
            id++;
        }
    }
    return {
        seq: 1, origin: [lng0 + nx * 0.0001, lat0 + ny * 0.0001], quality: 'media', furniture: true,
        buildings: { ids: Float64Array.from(ids), kinds: Uint8Array.from(kinds), areas: Float64Array.from(areas), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), visible: Uint8Array.from(vis), roofs },
        roads: { offsets: Uint32Array.from([0, 2]), coords: Float64Array.from([lng0 - 0.0001, lat0 + 0.003, lng0 + nx * 0.0002, lat0 + 0.003]), highway: ['residential'] },
    };
}

test('el armado reparte los edificios en sectores de ~250 m con su esfera y sus rangos de techo', () => {
    const { result, transfer } = buildCityData(cityInput());
    assert.equal(result.buildings, 900);
    assert.ok(result.chunks.length >= 4 && result.chunks.length <= 16, `${result.chunks.length} sectores`);
    assert.ok(transfer.length > result.chunks.length * 3);
    let roofs = 0;
    for (const c of result.chunks) {
        const kinds = c.meshes.map((m) => m.kind);
        assert.ok(kinds.includes('plain') && kinds.includes('lod') && kinds.includes('contact'), kinds.join());
        const plain = c.meshes.find((m) => m.kind === 'plain').arrays;
        const [cx, cy, cz, r] = c.sphere;
        for (let v = 0; v < plain.pos.length; v += 3) {
            assert.ok(Math.hypot(plain.pos[v] - cx, plain.pos[v + 1] - cy, plain.pos[v + 2] - cz) <= r + 1e-3, 'todo adentro de la esfera');
        }
        assert.equal(plain.owner.length, plain.pos.length / 9, 'un dueño por triángulo');
        for (let k = 0; k < c.roofs.length; k += 3) {
            const [id, start, count] = [c.roofs[k], c.roofs[k + 1], c.roofs[k + 2]];
            assert.ok(count > 0 && (start + count) * 3 <= plain.pos.length);
            assert.equal(plain.owner[start / 3], id, 'el rango de techo es de ese edificio');
            roofs++;
        }
        const lod = c.meshes.find((m) => m.kind === 'lod').arrays;
        assert.equal(c.lodRoofs.length, c.roofs.length);
        for (let k = 0; k < c.lodRoofs.length; k += 3) {
            const start = c.lodRoofs[k + 1], count = c.lodRoofs[k + 2];
            for (let v = start; v < start + count; v++) assert.ok(lod.nor[v * 3 + 2] > 0.99, 'la tapa simple mira para arriba');
        }
        const contact = c.meshes.find((m) => m.kind === 'contact').arrays;
        assert.equal(contact.col.length / 4, contact.pos.length / 3, 'sombra de contacto con alfa por vértice');
    }
    assert.equal(roofs, 900);
    assert.ok(result.furniture.trees.length > 0 && result.furniture.trees.length % 4 === 0);
});

test('la versión simple tiene muchos menos triángulos que el detalle', () => {
    const { result } = buildCityData(cityInput());
    let detail = 0, lod = 0;
    for (const c of result.chunks) {
        for (const m of c.meshes) {
            if (m.kind === 'walls' || m.kind === 'plain') detail += m.arrays.pos.length / 9;
            if (m.kind === 'lod') lod += m.arrays.pos.length / 9;
        }
    }
    assert.ok(lod < detail * 0.6, `${lod} vs ${detail}`);
});

test('los tipos ocultos no se arman y el color de techo pedido llega al detalle y a la versión simple', () => {
    const { result } = buildCityData(cityInput(10, 10, { visible: (k) => k !== 'casa', roofs: [[1, '#ffb703']] }));
    const ids = new Set();
    for (const c of result.chunks) for (let k = 0; k < c.roofs.length; k += 3) ids.add(c.roofs[k]);
    assert.ok(ids.size > 0 && ids.size < 20);
    assert.ok(ids.has(1), 'la 1 es un comercio');
    const c = result.chunks.find((ch) => [...ch.roofs].some((v, k) => k % 3 === 0 && v === 1));
    const k = [...c.roofs].findIndex((v, i) => i % 3 === 0 && v === 1);
    const plain = c.meshes.find((m) => m.kind === 'plain').arrays;
    assert.ok(plain.col[c.roofs[k + 1] * 3] > 0.9, 'techo dorado (lineal)');
    const lod = c.meshes.find((m) => m.kind === 'lod').arrays;
    assert.ok(lod.col[c.lodRoofs[k + 1] * 3] > 0.9, 'también en la versión simple');
});

test('la sombra de contacto es un marco que se desvanece hacia afuera', () => {
    const t = { pos: [], col: [] };
    addContactShadow(t, orientedBox(normalizeRing([[0, 0], [10, 0], [10, 6], [0, 6]])), 4);
    assert.equal(t.pos.length / 3, 24, '8 triángulos');
    const alphas = [];
    for (let v = 0; v < t.pos.length / 3; v++) {
        const [x, y] = [t.pos[v * 3], t.pos[v * 3 + 1]];
        const inside = x >= -0.01 && x <= 10.01 && y >= -0.01 && y <= 6.01;
        alphas.push([inside, t.col[v * 4 + 3]]);
    }
    assert.ok(alphas.every(([inside, a]) => (inside ? a > 0.2 : a === 0)));
});

test('arma ~12.500 edificios en tiempo razonable', () => {
    const t = performance.now();
    const { result } = buildCityData({ ...cityInput(112, 112), furniture: false });
    const ms = performance.now() - t;
    assert.equal(result.buildings, 112 * 112);
    assert.ok(ms < 4000, `${Math.round(ms)} ms`);
});
