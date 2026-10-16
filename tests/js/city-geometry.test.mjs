import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orientedBox, normalizeRing, signedArea, MeshBuilder, addBuilding, placeStreetFurniture, hash01, buildingSpec, totalHeight } from '../../resources/js/map/city-geometry.js';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const builders = () => ({ walls: { house: new MeshBuilder(), shop: new MeshBuilder(), super: new MeshBuilder(), tower: new MeshBuilder() }, plain: new MeshBuilder() });

/** Normales de cada triángulo. */
function normals(b) {
    const out = [];
    for (let i = 0; i < b.nor.length; i += 9) out.push([b.nor[i], b.nor[i + 1], b.nor[i + 2]]);
    return out;
}

test('el rectángulo mínimo de un rectángulo rotado es él mismo', () => {
    const a = Math.PI / 6;
    const rot = ([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
    const box = orientedBox(normalizeRing(rect(-6, -4, 12, 8).map(rot)));
    assert.ok(Math.abs(box.halfLong - 6) < 1e-6);
    assert.ok(Math.abs(box.halfShort - 4) < 1e-6);
    assert.ok(Math.abs(Math.abs(box.u[0] * Math.cos(a) + box.u[1] * Math.sin(a)) - 1) < 1e-6, 'eje largo alineado');
    assert.ok(Math.abs(box.cx) < 1e-6 && Math.abs(box.cy) < 1e-6);
});

test('los anillos quedan abiertos y en sentido antihorario', () => {
    const cw = rect(0, 0, 4, 2).reverse();
    const r = normalizeRing(cw);
    assert.equal(r.length, 4);
    assert.ok(signedArea(r) > 0);
});

test('una casa tiene paredes con ventanas y techo a dos aguas que mira hacia arriba y afuera', () => {
    const b = builders();
    const roof = addBuilding({ id: 1, kind: 'casa', ring: rect(0, 0, 10, 12), area: 120 }, b);
    assert.equal(b.walls.house.owner.length, 8, '4 paredes = 8 triángulos');
    assert.ok(roof.count === 12, 'dos faldones = 4 triángulos = 12 vértices');
    // los faldones apuntan hacia arriba
    const roofNormals = normals(b.plain).slice(roof.start / 3, (roof.start + roof.count) / 3);
    assert.ok(roofNormals.every((n) => n[2] > 0.5));
    // las paredes apuntan hacia afuera del centro
    const pos = b.walls.house.pos;
    const nor = normals(b.walls.house);
    for (let t = 0; t < nor.length; t++) {
        const cx = (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3 - 5;
        const cy = (pos[t * 9 + 1] + pos[t * 9 + 4] + pos[t * 9 + 7]) / 3 - 6;
        assert.ok(cx * nor[t][0] + cy * nor[t][1] > 0, `pared ${t} hacia adentro`);
    }
    assert.ok(b.walls.house.owner.every((id) => id === 1));
});

test('un comercio sigue el polígono real (aunque sea en L), con techo plano hacia arriba y toldo', () => {
    const b = builders();
    const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    const roof = addBuilding({ id: 2, kind: 'comercio', ring: L, area: 76 }, b);
    assert.equal(b.walls.shop.owner.length, 12, '6 paredes');
    const roofNormals = normals(b.plain).slice(roof.start / 3, (roof.start + roof.count) / 3);
    assert.equal(roofNormals.length, 4, 'L = 4 triángulos');
    assert.ok(roofNormals.every((n) => n[2] > 0.99));
    assert.ok(b.plain.owner.length > 4, 'hay toldo además del techo');
});

test('los hoteles son torres de 6 a 14 pisos; las casas, de una planta', () => {
    assert.ok(buildingSpec('hotel', 3, 400).wallH >= 6 * 3.2);
    assert.ok(buildingSpec('hotel', 3, 5000).wallH <= 14 * 3.2);
    assert.ok(buildingSpec('casa', 3, 100).wallH < 4);
    assert.ok(totalHeight('hotel', 3, 800) > totalHeight('comercio', 3, 800));
});

test('el mismo id da siempre la misma casa (todos los jugadores ven igual)', () => {
    const a = builders(), b = builders();
    addBuilding({ id: 77, kind: 'casa', ring: rect(0, 0, 9, 11), area: 99 }, a);
    addBuilding({ id: 77, kind: 'casa', ring: rect(0, 0, 9, 11), area: 99 }, b);
    assert.deepEqual(a.plain.col, b.plain.col);
    assert.equal(hash01(5, 1), hash01(5, 1));
});

test('el techo usa el color del dueño si se lo indica', () => {
    const b = builders();
    const roof = addBuilding({ id: 4, kind: 'casa', ring: rect(0, 0, 10, 12), area: 120, roofColor: '#ff0000' }, b);
    assert.deepEqual(b.plain.col.slice(roof.start * 3, roof.start * 3 + 3), [1, 0, 0]);
});

test('polígonos degenerados no rompen nada', () => {
    const b = builders();
    assert.equal(addBuilding({ id: 5, kind: 'casa', ring: [[0, 0], [1, 1]], area: 0 }, b), null);
    assert.ok(addBuilding({ id: 6, kind: 'casa', ring: rect(0, 0, 0.5, 0.5), area: 0.25 }, b), 'casas diminutas se agrandan a un mínimo');
});

test('árboles y faroles: nunca dentro de un edificio ni sobre la calle', () => {
    const roads = [{ coords: [[0, 0], [200, 0]], major: false }, { coords: [[100, -100], [100, 100]], major: true }];
    const boxes = [[10, 8, 30, 20], [110, 8, 130, 20], [40, -20, 60, -8]];
    const { trees, lamps } = placeStreetFurniture(roads, boxes);
    assert.ok(trees.length > 10);
    assert.ok(lamps.length > 2);
    for (const t of [...trees, ...lamps]) {
        assert.ok(!boxes.some((b) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3]), 'dentro de un edificio');
        assert.ok(Math.abs(t.y) > 4 || t.x < -1, `sobre la calle horizontal: ${t.x},${t.y}`);
        assert.ok(Math.abs(t.x - 100) > 4 || Math.abs(t.y) > 100, `sobre la avenida: ${t.x},${t.y}`);
    }
    assert.deepEqual(placeStreetFurniture(roads, boxes), { trees, lamps }, 'determinista');
});

test('el tope de árboles se respeta y se reparten por toda la ciudad', () => {
    const boxes = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) boxes.push([i * 40, j * 40, i * 40 + 8, j * 40 + 8]);
    const { trees } = placeStreetFurniture([], boxes, { maxTrees: 300 });
    assert.ok(trees.length <= 300);
    const xs = trees.map((t) => t.x);
    assert.ok(Math.max(...xs) > 1200 && Math.min(...xs) < 300, 'cubren de punta a punta');
});
