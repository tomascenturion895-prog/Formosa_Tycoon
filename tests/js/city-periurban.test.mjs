// Franja periurbana: calles que siguen afuera del barrio y casas cada vez más ralas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPolyline, periurbanStreets, periurbanBuildings, distOutside, BAND } from '../../resources/js/map/city-periurban.js';
import { normalizeRoads, buildRoadNetwork } from '../../resources/js/map/city-roads.js';

// barrio de 600 × 600 m con grilla de calles cada 100 m que terminan en las calles del borde
const bounds = { minX: -300, minY: -300, maxX: 300, maxY: 300 };
function grid() {
    const f = [];
    for (let k = -300; k <= 300; k += 100) {
        f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[k, -310], [k, 310]] }, properties: { highway: 'residential', osm_id: 1000 + k } });
        f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-310, k], [310, k]] }, properties: { highway: 'residential', osm_id: 5000 + k } });
    }
    return normalizeRoads(f, (c) => c);
}

test('clipPolyline recorta a la caja y parte en pedazos', () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    assert.deepEqual(clipPolyline([[-5, 5], [15, 5]], box), [[[0, 5], [10, 5]]]);
    assert.equal(clipPolyline([[-5, 5], [5, 5], [5, 15], [5, 25]], box).length, 1);
    assert.equal(clipPolyline([[-5, -5], [-1, -1]], box).length, 0);
    assert.equal(clipPolyline([[2, 5], [12, 5], [12, 6], [2, 6]], box).length, 2);
});

test('las calles cortadas por el borde siguen afuera (asfalto y después tierra) y hay transversales', () => {
    const { added, roads, outer } = periurbanStreets(bounds, grid());
    assert.ok(added.length >= 20, `nuevas: ${added.length}`);
    assert.ok(added.some((r) => r.unpaved) && added.some((r) => !r.unpaved), 'hay de asfalto y de tierra');
    for (const r of roads) for (const [x, y] of r.coords) assert.ok(x >= outer.minX - 0.01 && x <= outer.maxX + 0.01 && y >= outer.minY - 0.01 && y <= outer.maxY + 0.01);
    // nada nuevo adentro del barrio
    for (const r of added) for (const [x, y] of r.coords) assert.ok(distOutside(bounds, x, y) > 5 || Math.abs(Math.abs(x) - 310) < 1 || Math.abs(Math.abs(y) - 310) < 1);
    // del lado bloqueado (río al este) no se prolonga nada
    const east = periurbanStreets(bounds, grid(), { blocked: (x) => x > 305 });
    assert.ok(!east.added.some((r) => r.coords.some(([x]) => x > 320)));
});

test('las casas de la franja se ralean hacia afuera y no pisan calles ni el barrio', () => {
    const { roads } = periurbanStreets(bounds, grid());
    const net = buildRoadNetwork(roads, { quality: 'baja' });
    const res = periurbanBuildings(bounds, roads, net.query, {});
    assert.ok(res.houses > 40, `casas: ${res.houses}`);
    // densidad por anillo: cerca más casas que lejos (por triángulo de techo no se puede: se cuentan centros de árboles de patio)
    const pos = res.builders.buildings.pos;
    const near = [], far = [];
    for (let i = 0; i < pos.length; i += 9) {
        const d = distOutside(bounds, pos[i], pos[i + 1]);
        assert.ok(d > 5, 'ningún triángulo adentro del barrio');
        (d < BAND / 2 ? near : far).push(d);
    }
    assert.ok(near.length > far.length * 1.5, `${near.length} cerca vs ${far.length} lejos`);
    assert.ok(res.trees.every((t) => !net.query.onRoad(t.x, t.y, 1)));
    assert.ok(res.trees.length > 20);
});
