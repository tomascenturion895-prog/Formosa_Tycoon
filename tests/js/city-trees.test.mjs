import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    SPECIES, SPECIES_KEYS, speciesFor, bloomColor, bloomAmount, placeYardTrees, createTreeLayer, speciesTriangles, sampleTrees, QUALITY_CAP,
} from '../../resources/js/map/city-trees.js';
import { lightAt } from '../../resources/js/map/daytime.js';

const count = (context, n = 4000) => {
    const out = Object.fromEntries(SPECIES_KEYS.map((k) => [k, 0]));
    for (let i = 0; i < n; i++) out[speciesFor(context, (i % 80) * 13.7 - 500, Math.floor(i / 80) * 11.3 - 300)]++;
    return out;
};

test('hay 7 especies nativas más el árbol genérico', () => {
    assert.deepEqual(SPECIES_KEYS, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'G']);
    assert.equal(SPECIES.T1.name, 'lapacho rosado');
    assert.equal(SPECIES.T3.name, 'chivato');
});

test('calendario de floración: lapachos y paratodo en invierno, chivato en verano, palmeras nunca', () => {
    assert.equal(bloomColor('T1', 8), '#e86aa6');
    assert.equal(bloomAmount('T1', 8), 1);
    assert.equal(bloomColor('T1', 4), null);
    assert.equal(bloomColor('T1', 12), null);
    assert.equal(bloomColor('T2', 7), '#c06ad0');
    assert.ok(bloomAmount('T2', 6) >= 0.5 && bloomAmount('T2', 8) >= 0.5);
    assert.equal(bloomColor('T2', 12), null);
    assert.equal(bloomColor('T3', 12), '#e8452c');
    assert.ok(bloomAmount('T3', 1) >= 0.5 && bloomAmount('T3', 11) >= 0.5);
    assert.equal(bloomColor('T3', 8), null);
    assert.equal(bloomColor('T4', 8), '#f2c230');
    assert.ok(bloomAmount('T4', 9) >= 0.5);
    assert.equal(bloomColor('T4', 1), null);
    for (const k of ['T5', 'T6', 'T7', 'G']) {
        for (let m = 1; m <= 12; m++) assert.equal(bloomColor(k, m), null, `${k} mes ${m}`);
    }
    // en abril (otoño) está todo verde
    for (const k of SPECIES_KEYS) assert.equal(bloomAmount(k, 4), 0);
});

test('floración parcial en los bordes de la temporada', () => {
    const a = bloomAmount('T1', 10);
    assert.ok(a > 0 && a < 0.5, `octubre: ${a}`);
    assert.ok(bloomAmount('T3', 2) > 0 && bloomAmount('T3', 2) < 0.5);
    assert.equal(bloomAmount('T1', 20), bloomAmount('T1', 8), 'meses fuera de rango se envuelven');
});

test('speciesFor: veredas con lapachos/chivatos/paratodos y algo de genéricos', () => {
    const c = count('vereda');
    assert.equal(c.T5 + c.T6 + c.T7, 0, 'sin palmeras en la vereda');
    for (const k of ['T1', 'T2', 'T3', 'T4']) assert.ok(c[k] > 300, `${k}: ${c[k]}`);
    assert.ok(c.T1 > c.T2, 'lapacho rosado es el más común');
    assert.ok(c.G > 300 && c.G < 1400);
});

test('speciesFor: canteros con palmeras en hileras de una especie por tramo', () => {
    const c = count('cantero');
    assert.equal(c.T5 + c.T7, 4000);
    assert.ok(c.T7 > c.T5);
    // un tramo de 60 m es casi todo de la misma especie
    let same = 0, total = 0;
    for (let s = 0; s < 40; s++) {
        const x0 = s * 600 + 5, y0 = 1000;
        const sp = [];
        for (let d = 0; d < 20; d += 1.5) sp.push(speciesFor('cantero', x0 + d, y0));
        const main = sp.filter((k) => k === 'T7').length >= sp.length / 2 ? 'T7' : 'T5';
        same += sp.filter((k) => k === main).length;
        total += sp.length;
    }
    assert.ok(same / total > 0.8, `homogeneidad ${same / total}`);
});

test('speciesFor: plaza con todo y más palmeras; costanera; patios y peatonal', () => {
    const p = count('plaza');
    for (const k of SPECIES_KEYS) assert.ok(p[k] > 0, `plaza sin ${k}`);
    assert.ok(p.T5 + p.T6 + p.T7 > 1600, 'palmeras más probables en la plaza');
    const c = count('costanera');
    assert.equal(c.T5 + c.T6 + c.T3, 4000);
    const pa = count('patio');
    assert.ok(pa.G / 4000 > 0.85 && pa.G / 4000 < 0.95, `patio G ${pa.G}`);
    assert.ok(pa.T5 + pa.T6 + pa.T7 > 0);
    assert.deepEqual(count('campo'), pa);
    const pe = count('peatonal');
    assert.equal(pe.T4 + pe.T1, 4000);
    assert.ok(pe.T4 > pe.T1);
});

test('speciesFor es determinista', () => {
    for (let i = 0; i < 50; i++) assert.equal(speciesFor('plaza', i * 3.1, -i * 7.7), speciesFor('plaza', i * 3.1, -i * 7.7));
});

// manzanas de 100 m con casas en el borde y calles cada 110 m
function fakeCity() {
    const boxes = [];
    for (let bx = 0; bx < 6; bx++) {
        for (let by = 0; by < 6; by++) {
            const x0 = bx * 110, y0 = by * 110;
            for (let i = 0; i < 8; i++) {
                boxes.push([x0 + i * 12.5, y0, x0 + i * 12.5 + 10, y0 + 14]); // frente sur
                boxes.push([x0 + i * 12.5, y0 + 86, x0 + i * 12.5 + 10, y0 + 100]); // frente norte
            }
        }
    }
    // calles en las franjas de 100 a 110 m de cada eje (más el margen a los dos lados)
    const band = (v, margin) => { const m = ((v % 110) + 110) % 110; return m > 100 - margin || m < margin; };
    const query = {
        onRoad: (x, y, margin = 0) => band(x, margin) || band(y, margin),
        nearest(x, y) {
            const my = ((y % 110) + 110) % 110;
            // calle al sur o al norte según la mitad de la manzana
            return my < 50 ? { dist: my + 5, dirX: 0, dirY: -1 } : { dist: 105 - my, dirX: 0, dirY: 1 };
        },
        bounds: { minX: 0, minY: 0, maxX: 660, maxY: 660 },
    };
    return { boxes, query };
}

test('placeYardTrees: nunca dentro de edificios ni sobre calles, separados ≥ 6 m', () => {
    const { boxes, query } = fakeCity();
    const trees = placeYardTrees(boxes, query, { max: 5000 });
    assert.ok(trees.length > 200, `pocos árboles: ${trees.length}`);
    for (const t of trees) {
        assert.equal(t.context, 'patio');
        for (const b of boxes) {
            assert.ok(!(t.x >= b[0] - 1 && t.x <= b[2] + 1 && t.y >= b[1] - 1 && t.y <= b[3] + 1), 'dentro de un edificio');
        }
        assert.ok(!query.onRoad(t.x, t.y, 2), 'sobre la calle');
    }
    for (let i = 0; i < trees.length; i++) {
        for (let j = i + 1; j < trees.length; j++) {
            assert.ok(Math.hypot(trees[i].x - trees[j].x, trees[i].y - trees[j].y) >= 6 - 1e-9);
        }
    }
    // van al fondo: hacia el centro de la manzana, no hacia la calle
    const inner = trees.filter((t) => { const my = ((t.y % 110) + 110) % 110; return my > 14 && my < 86; });
    assert.ok(inner.length / trees.length > 0.9);
});

test('placeYardTrees: determinista y con tope repartido', () => {
    const { boxes, query } = fakeCity();
    const a = placeYardTrees(boxes, query, { max: 100 });
    const b = placeYardTrees(boxes, query, { max: 100 });
    assert.deepEqual(a, b);
    assert.equal(a.length, 100);
    const west = a.filter((t) => t.x < 330).length;
    assert.ok(west > 25 && west < 75, `repartido: ${west} al oeste`);
    assert.deepEqual(placeYardTrees([], null, { max: 10 }), []);
});

const someTrees = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
        const ctx = ['vereda', 'cantero', 'plaza', 'costanera', 'patio', 'peatonal'][i % 6];
        out.push({ x: (i % 100) * 9.3, y: Math.floor(i / 100) * 8.1, context: ctx });
    }
    return out;
};

test('createTreeLayer: arma las mallas, cuenta por especie y respeta la especie pedida', () => {
    const trees = someTrees(600);
    trees[0].species = 'T6';
    const layer = createTreeLayer(THREE, trees, { month: 8, quality: 'media' });
    assert.equal(layer.count, 600);
    const sum = Object.values(layer.species).reduce((a, b) => a + b, 0);
    assert.equal(sum, 600);
    const meshes = layer.group.children;
    assert.ok(meshes.length >= 2 && meshes.every((m) => m.isInstancedMesh && m.frustumCulled === false));
    let inst = 0;
    for (const m of meshes) if (m.name.endsWith('-copa')) inst += m.count;
    assert.equal(inst, 600);
    // fake light: noche y día no rompen, y la noche oscurece las copas
    layer.setLight(lightAt(12));
    const crown = meshes.find((m) => m.name.endsWith('-copa'));
    const day = crown.material.color.clone();
    layer.setLight(lightAt(23));
    assert.ok(crown.material.color.b < day.b + 1e-9 && crown.material.color.g < day.g);
    layer.setLight({ tint: [1, 1, 1], night: 0, lights: 0 });
    layer.dispose();
});

test('createTreeLayer: en agosto los lapachos tienen copas rosas y en abril verdes', () => {
    const trees = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 0, context: 'vereda', species: 'T1' }));
    const pinkish = (month) => {
        const l = createTreeLayer(THREE, trees, { month });
        const crown = l.group.children.find((m) => m.name === 'T1-copa');
        const c = new THREE.Color();
        let pink = 0;
        for (let i = 0; i < crown.count; i++) {
            crown.getColorAt(i, c);
            if (c.r > c.g) pink++;
        }
        l.dispose();
        return pink;
    };
    assert.equal(pinkish(8), 40);
    assert.equal(pinkish(4), 0);
});

test('presupuesto de triángulos: 7000 árboles en media < 350k', () => {
    const tri = speciesTriangles('media');
    for (const k of SPECIES_KEYS) assert.ok(tri[k].total <= 56 && tri[k].crown <= 50, `${k}: ${JSON.stringify(tri[k])}`);
    const layer = createTreeLayer(THREE, someTrees(7000), { month: 1, quality: 'media' });
    assert.equal(layer.count, 7000);
    assert.ok(layer.triangles < 350_000, `${layer.triangles}`);
    layer.dispose();
    const low = speciesTriangles('baja');
    for (const k of SPECIES_KEYS) assert.ok(low[k].total < tri[k].total);
});

test('tope por calidad: muestra repartida en el espacio, no los primeros N', () => {
    const trees = someTrees(9000); // ordenados por y
    const layer = createTreeLayer(THREE, trees, { month: 1, quality: 'baja' });
    assert.equal(layer.count, QUALITY_CAP.baja);
    assert.equal(Object.values(layer.species).reduce((a, b) => a + b, 0), QUALITY_CAP.baja);
    layer.dispose();
    const kept = sampleTrees(trees, 3000);
    const maxY = Math.max(...trees.map((t) => t.y));
    const north = kept.filter((t) => t.y > maxY / 2).length;
    assert.ok(north > 1300 && north < 1700, `mitad norte: ${north}`);
    assert.deepEqual(sampleTrees(trees, 3000), kept, 'determinista');
    assert.equal(createTreeLayer(THREE, someTrees(13000), { quality: 'alta' }).count, 12000);
});
