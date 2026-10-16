import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicleLayer, vehicleModelStats } from '../../resources/js/map/city-vehicles.js';
import { DIMENSIONS, createTraffic } from '../../resources/js/map/city-traffic.js';

const mk = (type, x, extra = {}) => ({ type, x, y: 5, heading: 0.4, speed: 5, color: '#cc2222', braking: false, passenger: false, visible: true, ...extra });
const NOCHE = { night: 1, lights: 1 };
const DIA = { night: 0, lights: 0 };

test('capa de vehículos: se arma con three real y actualiza de día y de noche', () => {
    const layer = createVehicleLayer(THREE, { maxPerType: 20 });
    assert.ok(layer.group instanceof THREE.Group);
    const meshes = layer.group.children.filter((c) => c.isInstancedMesh);
    assert.ok(meshes.length >= 10);
    assert.ok(meshes.every((m) => m.frustumCulled === false && m.count === 0));
    const vs = [mk('moto', 0, { passenger: true }), mk('moto', 10), mk('auto', 20), mk('auto', 30, { variant: 1, braking: true }),
        mk('camioneta', 40), mk('utilitario', 50), mk('camion', 60), mk('colectivo', 70), mk('auto', 80, { visible: false })];
    layer.update(vs, DIA);
    let s = layer.stats();
    assert.equal(s.moto, 2); assert.equal(s.camioneta, 1); assert.equal(s.colectivo, 1);
    assert.equal(s.auto0 + s.auto1, 2); // el invisible no se dibuja
    const cones = layer.group.children.find((c) => c.renderOrder === 2);
    assert.equal(cones.count, 0);
    layer.update(vs, NOCHE);
    assert.equal(cones.count, 8); // un cono por vehículo visible
    // matriz: posición y rotación por instancia
    const moto = layer.group.children.find((c) => c.name === 'moto' && c.isInstancedMesh);
    const e = moto.instanceMatrix.array;
    assert.ok(Math.abs(e[12] - 0) < 1e-6 && Math.abs(e[13] - 5) < 1e-6 && Math.abs(e[14] - 0.03) < 1e-6);
    assert.ok(Math.abs(e[0] - Math.cos(0.4)) < 1e-6);
    // pasajeros: una instancia extra
    layer.update([mk('moto', 0, { passenger: true }), mk('moto', 5)], DIA);
    // estacionados con los mismos modelos
    layer.update([], DIA, [{ type: 'auto', x: 1, y: 1, heading: 0, color: '#ffffff' }, { type: 'camioneta', x: 9, y: 1, heading: 1, color: '#222222' }]);
    s = layer.stats();
    assert.equal(s.auto0 + s.auto1, 1); assert.equal(s.camioneta, 1);
    // tope por tipo
    layer.update(Array.from({ length: 50 }, (_, i) => mk('moto', i)), DIA);
    assert.equal(layer.stats().moto, 20);
    layer.dispose();
});

test('orientación = rumbo: el modelo mira hacia donde avanza (sin contramano ni de costado)', () => {
    const layer = createVehicleLayer(THREE, { maxPerType: 8 });
    const auto = layer.group.children.find((c) => c.name === 'auto0' && c.isInstancedMesh);
    for (const h of [0, 0.4, Math.PI / 2, Math.PI, -Math.PI / 2, 2.5]) {
        layer.update([mk('auto', 3, { y: 7, heading: h })], DIA);
        const e = auto.instanceMatrix.array;
        // el +x local (frente del modelo) va a (cos h, sin h): el morro apunta al rumbo
        assert.ok(Math.hypot(e[0] - Math.cos(h), e[1] - Math.sin(h)) < 1e-6, `frente a ${(h * 180 / Math.PI).toFixed(0)}°`);
        // el +y local (izquierda) va a (-sin h, cos h): sistema derecho, sin espejar (si no, iría de costado/espejado)
        assert.ok(Math.hypot(e[4] + Math.sin(h), e[5] - Math.cos(h)) < 1e-6, `costado a ${(h * 180 / Math.PI).toFixed(0)}°`);
        // z hacia arriba y apoyado en el piso
        assert.ok(Math.abs(e[10] - 1) < 1e-6 && Math.abs(e[14] - 0.03) < 1e-6, 'apoya en el piso');
        assert.ok(Math.abs(e[12] - 3) < 1e-6 && Math.abs(e[13] - 7) < 1e-6, 'posición');
    }
    layer.dispose();
});

test('modelos a escala real: cajas contenedoras acordes a las medidas', () => {
    const layer = createVehicleLayer(THREE, { maxPerType: 2 });
    const byName = {};
    for (const m of layer.group.children) if (m.isInstancedMesh && m.name) {
        m.geometry.computeBoundingBox();
        (byName[m.name] ??= new THREE.Box3()).union(m.geometry.boundingBox);
    }
    const map = { moto: 'moto', auto: 'auto0', camioneta: 'camioneta', utilitario: 'utilitario', camion: 'camion', colectivo: 'colectivo' };
    for (const [type, kind] of Object.entries(map)) {
        const b = byName[kind], d = DIMENSIONS[type];
        const size = b.getSize(new THREE.Vector3());
        assert.ok(Math.abs(size.x - d.length) < d.length * 0.2, `${type} largo ${size.x}`);
        assert.ok(size.y <= d.width * 1.25 && size.y >= d.width * 0.6, `${type} ancho ${size.y}`);
        // la moto mide 1,1 m hasta el manubrio; con el conductor sentado llega a ~1,6 m
        if (type === 'moto') assert.ok(size.z >= d.height && size.z <= 1.8, `moto alto ${size.z}`);
        else assert.ok(Math.abs(size.z - d.height) < d.height * 0.25, `${type} alto ${size.z}`);
    }
    layer.dispose();
});

test('triángulos por modelo razonables (low-poly)', () => {
    const st = vehicleModelStats();
    for (const [k, n] of Object.entries(st)) assert.ok(n > 20 && n < 900, `${k}: ${n}`);
    console.log('  triángulos:', JSON.stringify(st));
});

test('capa con tránsito real de city-traffic', () => {
    const nodes = [{ x: 0, y: 0, signal: false }, { x: 200, y: 0, signal: false }];
    const lanes = [
        { from: 0, to: 1, pts: [[0, -1.75], [200, -1.75]], len: 200, speed: 11, major: true, bus: true, width: 3.5 },
        { from: 1, to: 0, pts: [[200, 1.75], [0, 1.75]], len: 200, speed: 11, major: true, bus: true, width: 3.5 },
    ];
    const t = createTraffic({ nodes, lanes, out: [[0], [1]] }, { seed: 2, maxVehicles: 60 });
    const layer = createVehicleLayer(THREE, { maxPerType: { moto: 80, auto: 80, camioneta: 20, utilitario: 20, camion: 20, colectivo: 20 } });
    for (let i = 0; i < 600; i++) t.step(1 / 30, 8, { x: 100, y: 0, r: 300 });
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) layer.update(t.vehicles, NOCHE, t.parked);
    const ms = (performance.now() - t0) / 200;
    console.log(`  update con ${t.vehicles.length} vehículos: ${ms.toFixed(3)} ms`);
    const s = layer.stats();
    assert.ok(Object.values(s).reduce((a, b) => a + b, 0) >= t.vehicles.length - 0);
    layer.dispose();
});

test('de lejos, modelo simple: muchos menos triángulos y los mismos vehículos (G fase 5)', () => {
    const layer = createVehicleLayer(THREE, { maxPerType: 40 });
    const vs = [];
    for (let i = 0; i < 30; i++) for (const type of ['moto', 'auto', 'camioneta', 'utilitario', 'camion', 'colectivo']) vs.push(mk(type, i * 20));
    const tris = () => layer.group.children.filter((m) => m.isInstancedMesh && m.visible && m.count > 0)
        .reduce((n, m) => n + (m.geometry.attributes.position.count / 3) * m.count, 0);
    layer.update(vs, NOCHE);
    const full = tris();
    const total = Object.values(layer.stats()).reduce((a, b) => a + b, 0);
    layer.update(vs, NOCHE, null, { x: 0, y: 5, distance: 100 });
    const lodTris = tris();
    assert.equal(Object.values(layer.stats()).reduce((a, b) => a + b, 0), total, 'se dibujan todos');
    assert.equal(layer.farCount(), vs.filter((v) => v.x > 100).length);
    assert.ok(lodTris < full * 0.4, `triángulos: ${lodTris} con modelo simple vs ${full}`);
    // las piezas simples comparten la matriz y la caja de cada uno queda en su lugar (mismo largo que el modelo)
    const far = layer.group.children.find((m) => m.name === 'colectivo-lejos' && m.count > 0);
    far.geometry.computeBoundingBox();
    const bb = far.geometry.boundingBox;
    assert.ok(Math.abs(bb.max.x - bb.min.x - DIMENSIONS.colectivo.length) < 0.5);
    // sin `lod`, ninguno simple
    layer.update(vs, DIA);
    assert.equal(layer.farCount(), 0);
    layer.dispose();
});
