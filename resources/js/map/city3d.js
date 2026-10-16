// Vista 3D de la ciudad con three.js, dibujada como capa propia dentro de MapLibre (comparte la cámara del mapa).
// Casas con techo a dos aguas, comercios con toldo, supermercados y hoteles en torre, árboles y faroles.
// De noche se prenden ventanas y faroles. El techo lleva el color del dueño (dorado si es tuyo).
//
// Este archivo se carga recién la primera vez que alguien activa el 3D: three.js no pesa en la carga inicial del mapa.
//
// Cómo está armado (marco para sumar módulos nuevos):
//  - Los triángulos de los edificios se arman en un Web Worker (city-build.worker.js; si no hay worker, en este hilo)
//    y llegan repartidos en SECTORES de ~250 m. Cada sector tiene sus mallas de detalle (paredes por estilo + 'plain'),
//    una versión simple (cajas, para lejos) y la sombra de contacto. Por cuadro se descartan los sectores fuera de
//    la vista y los lejanos pasan a la versión simple (según la calidad).
//  - CAPAS (`layers`): grupos de three.js en orden de dibujo: ground (suelo/entorno), roads (calles), shadows,
//    buildings, landmarks (plaza, catedral…), trees, furniture (faroles, carteles…), vehicles.
//    Para sumar algo: `city.add('trees', objeto)` (le pone la niebla a sus materiales) y, si son InstancedMesh repartidos
//    por la ciudad, `city.registerInstanced(malla)` para que se recorten por sector, distancia y densidad.
//  - GANCHOS por cuadro y por luz: `city.onFrame(fn)` (vehículos, animaciones) y `city.onLight(fn)` (árboles en flor…).
//  - NIEBLA: `city.fogMaterial(material)` para cualquier material nuevo (lo hace `add` solo). Hay dos: la de distancia
//    al ojo y la del BORDE (todo lo que está a más de ~0,5–1,6 km afuera del barrio se funde con el horizonte, así la
//    ciudad nunca termina en un corte: los alrededores se pierden en la bruma).
//  - SUELO: la capa `ground` (pasto, tierra, agua, alrededores de city-env) se dibuja en una capa de MapLibre aparte
//    (`groundLayer`, 'ciudad-3d-suelo') que va DEBAJO de las calles 2D; el resto va en `layer`, arriba de todo.
import * as THREE from 'three';
import { hexToRgb, MeshBuilder } from './city-geometry.js';
import {
    localProjection, eyeFromMatrix, frustumPlanes, sphereVisible, sphereDistance, fogRange, chunkCoord, chunkKey,
    CHUNK_SIZE, QUALITY, decideQuality, createFrameMeter, initialAutoQuality, parseQualityMode,
} from './city-frame.js';
import { buildCityData, KINDS, TREE_CONTEXTS, CAR_COLORS } from './city-build.worker.js';
import { createTreeLayer, SPECIES_KEYS } from './city-trees.js';
import { makeFacadeTextures } from './city-textures.js';
import { createTraffic } from './city-traffic.js';
import { createVehicleLayer } from './city-vehicles.js';

/** Vehículos en circulación como máximo, por calidad (se recortan además alrededor de la cámara, ~800 m). */
export const TRAFFIC_MAX = { baja: 130, media: 180, alta: 320 };

const LAYERS = ['ground', 'roads', 'shadows', 'buildings', 'landmarks', 'trees', 'furniture', 'vehicles'];

/**
 * Texturas de fachada por estilo (city-textures.js): de día ventanas en blanco (el color del vértice las tiñe) y de
 * noche solo las ventanas prendidas. El uv de las paredes ya viene en metros / lienzo: repeat 1 × 1.
 */
function facadeTextures(style) {
    const t = makeFacadeTextures(style);
    const make = (canvas) => {
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.NearestFilter; // bordes nítidos, estilo pixel
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        return tex;
    };
    return { map: make(t.day), emissiveMap: make(t.night) };
}

/** three.js trabaja los colores por vértice en espacio lineal; la paleta está en sRGB (como en CSS). */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function geometryFrom(a) {
    const g = new THREE.BufferGeometry();
    const n = a.pos.length / 3;
    g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
    if (a.nor) g.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3));
    if (a.uv) g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(a.col, n ? a.col.length / n : 3));
    g.computeBoundingSphere();
    return g;
}

// ------------------------------------------------------------------ niebla propia
// La cámara de three.js es la matriz cruda de MapLibre (vista = identidad, posiciones en metros locales), así que la
// niebla de three (que usa la profundidad de la vista) no sirve. Esta mide la distancia real al ojo, que sale de la
// matriz en cada cuadro. Se mezcla después de pasar a sRGB, así el color es el mismo `horizon` del cielo de MapLibre.
const fogUniforms = {
    cityFogColor: { value: new THREE.Color(0.85, 0.92, 0.98) },
    cityFogNear: { value: 1e7 },
    cityFogFar: { value: 2e7 },
    cityEye: { value: new THREE.Vector3() },
    // niebla del borde: caja del barrio (metros locales) y a qué distancia afuera empieza y termina
    cityEdgeMin: { value: new THREE.Vector2(-1e7, -1e7) },
    cityEdgeMax: { value: new THREE.Vector2(1e7, 1e7) },
    cityEdgeFog: { value: new THREE.Vector2(1e7, 2e7) },
    cityCamDist: { value: 1000 },
};
/** Niebla del borde: empieza a esta distancia afuera del barrio y a la segunda ya es todo horizonte. */
export const EDGE_FOG = [380, 1400];

/**
 * Le agrega la niebla de la ciudad a un material de three.js (Lambert, Basic, Standard, Shadow…; también instanciados).
 * Si el material ya tiene su propio onBeforeCompile, llamar a esta función DESPUÉS de ponérselo.
 * `fade`: en materiales transparentes (sombras, charcos de luz) la niebla los desvanece en vez de teñirlos.
 */
export function fogMaterial(material, { fade = material.transparent } = {}) {
    if (!material || material.userData.cityFog) return material;
    const prevCompile = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey();
    material.onBeforeCompile = function (shader, renderer) {
        prevCompile?.call(this, shader, renderer);
        if (!shader.fragmentShader.includes('#include <fog_fragment>') || !shader.vertexShader.includes('#include <project_vertex>')) return;
        Object.assign(shader.uniforms, fogUniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCityPos;')
            .replace('#include <project_vertex>', `#include <project_vertex>
    vec4 cityP = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
        cityP = instanceMatrix * cityP;
    #endif
    vCityPos = ( modelMatrix * cityP ).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCityPos;\nuniform vec3 cityFogColor;\nuniform float cityFogNear;\nuniform float cityFogFar;\nuniform vec3 cityEye;\nuniform vec2 cityEdgeMin;\nuniform vec2 cityEdgeMax;\nuniform vec2 cityEdgeFog;\nuniform float cityCamDist;')
            .replace('#include <fog_fragment>', `#include <fog_fragment>
    vec2 cityOut = max( max( cityEdgeMin - vCityPos.xy, vCityPos.xy - cityEdgeMax ), 0.0 );
    float cityEyeD = distance( vCityPos, cityEye );
    // la bruma del borde no se aplica a lo que está mucho más cerca del ojo que el centro de la vista
    // (con la cámara lejos y alta, el suelo de abajo de la pantalla queda afuera del barrio pero se ve nítido)
    float cityFog = max( smoothstep( cityFogNear, cityFogFar, cityEyeD ),
        smoothstep( cityEdgeFog.x, cityEdgeFog.y, length( cityOut ) ) * smoothstep( 0.3 * cityCamDist, 0.65 * cityCamDist, cityEyeD ) );
    ${fade ? 'gl_FragColor.a *= 1.0 - cityFog;' : 'gl_FragColor.rgb = mix( gl_FragColor.rgb, cityFogColor, cityFog );'}`);
    };
    material.customProgramCacheKey = () => `${prevKey}|niebla2${fade ? '-a' : ''}`;
    material.userData.cityFog = true;
    material.needsUpdate = true;
    return material;
}

/**
 * @param map         mapa de MapLibre
 * @param properties  id -> { kind, area, … } (datos públicos de /api/propiedades)
 * @param geometries  id -> GeoJSON Polygon (lng/lat)
 * @param roads       GeoJSON de calles
 * @param roofOf      (id) -> color del techo o null (dueño, tuyo, seleccionada)
 * @param quality     'auto' | 'baja' | 'media' | 'alta'
 * @param environment features de /api/entorno (agua, plazas, parques…); [] o null en servidores viejos
 * @returns Promise de la ciudad (el armado pesado corre en un worker)
 */
export async function createCity3D({ map, properties, geometries, roads, roofOf, isVisible = () => true, quality: qualityMode = 'auto', environment = null, traffic: trafficWanted = true }) {
    // Origen local: el centro de la ciudad. Todo se dibuja en metros alrededor de este punto.
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const g of geometries.values()) {
        for (const [lng, lat] of g.coordinates[0]) {
            minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
    }
    const origin = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    const proj = localProjection(origin);
    const s = proj.scale;
    const modelMatrix = new THREE.Matrix4().makeTranslation(proj.mercator.x, proj.mercator.y, 0).scale(new THREE.Vector3(s, -s, s));
    const [x0, y0] = proj.toLocal(minLng, minLat);
    const [x1, y1] = proj.toLocal(maxLng, maxLat);
    fogUniforms.cityEdgeMin.value.set(x0, y0);
    fogUniforms.cityEdgeMax.value.set(x1, y1);
    fogUniforms.cityEdgeFog.value.set(EDGE_FOG[0], EDGE_FOG[1]);

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const hemi = new THREE.HemisphereLight(0xffffff, 0x6fbf5f, 0.9);
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    const sunDir = new THREE.Vector3(0, -0.5, 0.85).normalize();
    const ambient = new THREE.AmbientLight(0xffffff, 0.45); // las paredes a la sombra no quedan negras (estilo caricatura)
    scene.add(hemi, ambient, sun, sun.target);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6; // en metros locales
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 4000;

    const layers = Object.fromEntries(LAYERS.map((name) => {
        const g = new THREE.Group();
        g.name = name;
        scene.add(g);
        return [name, g];
    }));

    // ---------------------------------------------------------------- calidad
    let mode = parseQualityMode(qualityMode);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    let level = mode === 'auto' ? initialAutoQuality({ cores: navigator.hardwareConcurrency ?? 4, mobile: coarse, dpr: devicePixelRatio }) : mode;
    let preset = QUALITY[level];
    let meter = null; // midiendo cuadros (calidad automática)
    let autoRounds = 0;
    let lastFrameMs = null;
    let active = false;
    const slowRenders = []; // ms de los primeros cuadros (compilación de shaders)
    const mainMs = {}; // ms del hilo principal por paso del primer armado (diagnóstico)
    const timed = (name, fn) => {
        const t = performance.now();
        const r = fn();
        if (r && typeof r.then === 'function') return r.then((v) => { mainMs[name] = Math.round(performance.now() - t); return v; });
        mainMs[name] = Math.round(performance.now() - t);
        return r;
    };
    const yieldTask = () => new Promise((r) => setTimeout(r, 0));

    // ---------------------------------------------------------------- materiales
    const allMaterials = new Set();
    const track = (m) => {
        allMaterials.add(fogMaterial(m));
        return m;
    };
    const wallMaterials = new Map();
    function wallMaterial(style) {
        if (!wallMaterials.has(style)) {
            const tex = facadeTextures(style);
            wallMaterials.set(style, track(new THREE.MeshLambertMaterial({
                vertexColors: true, map: tex.map, emissiveMap: tex.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0,
            })));
        }
        return wallMaterials.get(style);
    }
    const plainMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const lodMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    // carteles de hotel: sin sombreado (se ven "prendidos"); de día un poco apagados
    const signMaterial = track(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xb8b8b8 }));
    const parkingMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    const defaultRoofs = new Map(); // id -> '#hex' del techo sin dueño (lo decide el molde en el worker)
    const contactMaterial = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    // Recibe la sombra del sol en calidad alta. PUNTO DE INTEGRACIÓN (city-env): cuando el suelo sea una malla propia,
    // ese suelo puede recibir la sombra directamente (receiveShadow) y esta lámina se apaga con setShadowCatcher(false).
    const catcherMaterial = track(new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false }));
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 2000, y1 - y0 + 2000), catcherMaterial);
    catcher.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.16);
    catcher.receiveShadow = true;
    catcher.renderOrder = 1;
    catcher.frustumCulled = false;
    let catcherWanted = true;
    layers.shadows.add(catcher);

    // ---------------------------------------------------------------- sectores de edificios
    let chunks = []; // { sphere, detail: Mesh[], lod, contact, lodOn, seen }
    let pickables = [];
    const roofRanges = new Map(); // id -> { mesh, start, count, lodMesh, lodStart, lodCount }
    let buildingCount = 0;
    let lastBuildMs = 0;

    function disposeChunks() {
        for (const ch of chunks) {
            for (const m of [...ch.detail, ch.lod, ch.contact]) {
                if (!m) continue;
                layers.buildings.remove(m);
                layers.shadows.remove(m);
                m.geometry.dispose();
            }
        }
        chunks = [];
        pickables = [];
        roofRanges.clear();
    }

    /**
     * Arma las mallas de los sectores en tandas (cediendo el hilo cada ~40 ms) y recién al final reemplaza las viejas:
     * con 13.000 edificios no hay un bloque largo en el hilo principal y en un rearmado no se ven huecos.
     */
    async function adoptChunks(data) {
        const next = [], nextPick = [], nextRoofs = new Map(), add = [];
        let t0 = performance.now();
        for (const c of data.chunks) {
            if (performance.now() - t0 > 40) { await yieldTask(); t0 = performance.now(); }
            const ch = { sphere: c.sphere, detail: [], lod: null, contact: null, lodOn: false, seen: true, up: false, lodUp: false, tris: 0, lodTris: 0 };
            const byKind = {};
            for (const m of c.meshes) {
                const tris = m.arrays.pos.length / 9;
                if (m.kind === 'lod') ch.lodTris += tris; else ch.tris += tris;
                const material = m.kind === 'walls' ? wallMaterial(m.style) : m.kind === 'plain' ? plainMaterial : m.kind === 'lod' ? lodMaterial
                    : m.kind === 'signs' ? signMaterial : m.kind === 'parking' ? parkingMaterial : contactMaterial;
                const mesh = new THREE.Mesh(geometryFrom(m.arrays), material);
                mesh.matrixAutoUpdate = false;
                mesh.frustumCulled = true; // three también recorta con la matriz de MapLibre (y en la pasada de sombras, con la del sol)
                if (m.arrays.owner) mesh.userData.owner = m.arrays.owner;
                if (m.kind === 'contact') {
                    mesh.renderOrder = 2;
                    ch.contact = mesh;
                    add.push([layers.shadows, mesh]);
                } else if (m.kind === 'lod') {
                    mesh.visible = false;
                    ch.lod = mesh;
                    add.push([layers.buildings, mesh]);
                } else {
                    ch.detail.push(mesh);
                    if (m.kind !== 'signs' && m.kind !== 'parking') nextPick.push(mesh);
                    add.push([layers.buildings, mesh]);
                }
                byKind[m.kind] = mesh;
            }
            for (let k = 0; k < c.roofs.length; k += 3) {
                nextRoofs.set(c.roofs[k], {
                    mesh: byKind.plain, start: c.roofs[k + 1], count: c.roofs[k + 2],
                    lodMesh: byKind.lod ?? null, lodStart: c.lodRoofs[k + 1], lodCount: c.lodRoofs[k + 2],
                });
            }
            next.push(ch);
        }
        // cambio de una vez
        disposeChunks();
        for (const [g, m] of add) g.add(m);
        chunks = next;
        pickables = nextPick;
        for (const [k, v] of nextRoofs) roofRanges.set(k, v);
        buildingCount = data.buildings;
        lastBuildMs = data.ms;
        for (const [id, hex] of data.defaults ?? []) defaultRoofs.set(id, hex);
        adoptCars(data.cars);
        applyShadowFlags();
        invalidateShadows();
    }

    // ---------------------------------------------------------------- armado (worker, con plan B en este hilo)
    // Dos workers: cada uno arma la mitad de los sectores (en damero), así el armado de ~13.000 edificios tarda la
    // mitad en equipos con varios núcleos. Los dos arman las calles (el contexto de los moldes); solo el primero
    // devuelve suelo, calles, árboles y mobiliario. Si alguno falla, todo se arma en este hilo (plan B).
    const workers = [];
    let workerBroken = false;
    const pending = new Map(); // `${seq}:${parte}` -> entrada
    let seq = 0;
    // Solo con muchos núcleos: en una VM de 2 núcleos dos workers no ganaron nada (medido: 2,55 s con uno, 2,5 s con dos).
    const PARTS = (navigator.hardwareConcurrency ?? 2) >= 6 ? 2 : 1;
    try {
        for (let w = 0; w < PARTS; w++) {
            const worker = new Worker(new URL('./city-build.worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = (e) => {
                const key = `${e.data.seq}:${e.data.part ?? 0}`;
                const p = pending.get(key);
                if (!p) return;
                pending.delete(key);
                clearTimeout(p.timer);
                if (e.data.error) p.fail(new Error(e.data.error));
                else p.resolve(e.data);
            };
            worker.onerror = (e) => {
                e.preventDefault?.();
                workerBroken = true;
                for (const p of pending.values()) p.fail(new Error(e.message || 'worker'));
                pending.clear();
            };
            workers.push(worker);
        }
    } catch {
        workers.length = 0;
    }

    function runSync(input) {
        return buildCityData({ ...input, part: 0, parts: 1 }).result;
    }

    function postPart(worker, input, part) {
        return new Promise((resolve, reject) => {
            const key = `${input.seq}:${part}`;
            const entry = { resolve, fail: reject, timer: setTimeout(() => { pending.delete(key); reject(new Error('el worker no respondió')); }, 30000) };
            pending.set(key, entry);
            // se copia (no se transfiere): si el worker falla, el plan B usa los mismos datos
            worker.postMessage({ ...input, part, parts: workers.length, layersWanted: part === 0 });
        });
    }

    /** Une los resultados de las partes (sectores, techos por defecto, autos; capas solo de la parte 0). */
    function mergeParts(results) {
        if (results.length === 1) return results[0];
        const [a, ...rest] = results;
        const out = { ...a, chunks: [...a.chunks], defaults: [...(a.defaults ?? [])], ms: Math.max(...results.map((r) => r.ms)) };
        const cars = [a.cars];
        for (const r of rest) {
            out.chunks.push(...r.chunks);
            out.defaults.push(...(r.defaults ?? []));
            out.buildings += r.buildings;
            cars.push(r.cars);
        }
        const n = cars.reduce((t, c) => t + (c?.length ?? 0), 0);
        out.cars = new Float32Array(n);
        let o = 0;
        for (const c of cars) if (c?.length) { out.cars.set(c, o); o += c.length; }
        return out;
    }

    async function runBuild(input) {
        if (!workers.length || workerBroken) return runSync(input);
        try {
            return mergeParts(await Promise.all(workers.map((w, part) => postPart(w, input, part))));
        } catch (err) {
            console.warn('Ciudad 3D: se arma sin worker', err?.message ?? err);
            workerBroken = true;
            return runSync(input);
        }
    }

    let sentRoofs = new Map();
    function buildInput(withFurniture) {
        const ids = [], kinds = [], areas = [], offsets = [0], coords = [], visible = [], roofs = [];
        sentRoofs = new Map();
        for (const [id, p] of properties) {
            const g = geometries.get(id);
            if (!g) continue;
            const ring = g.coordinates[0];
            for (const [lng, lat] of ring) coords.push(lng, lat);
            offsets.push(offsets.at(-1) + ring.length);
            ids.push(id);
            kinds.push(Math.max(0, KINDS.indexOf(p.kind)));
            areas.push(p.area ?? 0);
            visible.push(isVisible(p.kind) ? 1 : 0); // los tipos ocultos en la leyenda tampoco se dibujan en 3D
            const roof = roofOf(id);
            if (roof) {
                roofs.push([id, roof]);
                sentRoofs.set(id, roof);
            }
        }
        const input = {
            seq: ++seq, origin, chunkSize: CHUNK_SIZE, quality: level, furniture: withFurniture,
            environment: withFurniture ? (Array.isArray(environment) ? environment : []) : null,
            buildings: { ids: Float64Array.from(ids), kinds: Uint8Array.from(kinds), areas: Float64Array.from(areas), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), visible: Uint8Array.from(visible), roofs },
            roads: null,
        };
        if (withFurniture) {
            const rOff = [0], rCoords = [], highway = [];
            for (const f of roads?.features ?? []) {
                if (f.geometry?.type !== 'LineString') continue;
                for (const [lng, lat] of f.geometry.coordinates) rCoords.push(lng, lat);
                rOff.push(rOff.at(-1) + f.geometry.coordinates.length);
                highway.push(f.properties?.highway ?? '');
            }
            input.roads = { offsets: Uint32Array.from(rOff), coords: Float64Array.from(rCoords), highway };
            // calles completas (ancho, mano, carriles, superficie…) para la red 3D de city-roads
            input.roadFeatures = (roads?.features ?? []).filter((f) => /LineString/.test(f.geometry?.type ?? ''));
        }
        return input;
    }

    /** Después de cambiar las mallas: los techos que cambiaron mientras el worker trabajaba se repintan. */
    function catchUpRoofs() {
        for (const id of roofRanges.keys()) {
            if ((roofOf(id) ?? null) !== (sentRoofs.get(id) ?? null)) paintRoof(id);
        }
    }

    // ---------------------------------------------------------------- árboles y faroles (una sola vez)
    const lampHeadMaterial = track(new THREE.MeshLambertMaterial({ color: 0x3a3f4e, emissive: 0xfff0b0, emissiveIntensity: 0 }));
    // Charco de luz bajo cada farol: degradé radial (centro brillante, borde que se desvanece).
    const glow = document.createElement('canvas');
    glow.width = glow.height = 64;
    const gctx = glow.getContext('2d');
    const grad = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 64, 64);
    const glowTexture = new THREE.CanvasTexture(glow);
    const poolMaterial = track(new THREE.MeshBasicMaterial({ color: 0xffc56b, map: glowTexture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));

    /** PUNTO DE INTEGRACIÓN (city-trees / city-roads furniture): reemplazar por createTreeLayer + faroles nuevos. */
    function buildFurniture(f) {
        const nTrees = f.trees.length / 4, nLamps = f.lamps.length / 2;
        const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2, 6).rotateX(Math.PI / 2).translate(0, 0, 1);
        const crownGeo = new THREE.IcosahedronGeometry(1.7, 0).translate(0, 0, 3.1);
        const trunks = new THREE.InstancedMesh(trunkGeo, track(new THREE.MeshLambertMaterial({ color: 0x86603c })), nTrees);
        const crowns = new THREE.InstancedMesh(crownGeo, track(new THREE.MeshLambertMaterial({ color: 0xffffff })), nTrees);
        const greens = ['#58b45a', '#4c9a4f', '#3f8a46', '#7fd57a', '#1f7a3e'].map((h) => new THREE.Color(h));
        const mat = new THREE.Matrix4();
        for (let i = 0; i < nTrees; i++) {
            const [x, y, sc, c] = f.trees.subarray(i * 4, i * 4 + 4);
            mat.makeScale(sc, sc, sc).setPosition(x, y, 0);
            trunks.setMatrixAt(i, mat);
            crowns.setMatrixAt(i, mat);
            crowns.setColorAt(i, greens[Math.floor(c * greens.length) % greens.length]);
        }
        const poleGeo = new THREE.BoxGeometry(0.16, 0.16, 4.4).translate(0, 0, 2.2);
        const headGeo = new THREE.BoxGeometry(0.7, 0.4, 0.22).translate(0, 0, 4.4);
        const poolGeo = new THREE.PlaneGeometry(11, 11).translate(0, 0, 0.08);
        const poles = new THREE.InstancedMesh(poleGeo, track(new THREE.MeshLambertMaterial({ color: 0x3a3f4e })), nLamps);
        const heads = new THREE.InstancedMesh(headGeo, lampHeadMaterial, nLamps);
        const pools = new THREE.InstancedMesh(poolGeo, poolMaterial, nLamps);
        for (let i = 0; i < nLamps; i++) {
            mat.makeTranslation(f.lamps[i * 2], f.lamps[i * 2 + 1], 0);
            poles.setMatrixAt(i, mat);
            heads.setMatrixAt(i, mat);
            pools.setMatrixAt(i, mat);
        }
        pools.renderOrder = 3;
        trunks.castShadow = crowns.castShadow = poles.castShadow = true;
        layers.trees.add(trunks, crowns);
        layers.furniture.add(pools, poles, heads);
        registerInstanced(trunks, { density: true });
        registerInstanced(crowns, { density: true });
        for (const m of [poles, heads, pools]) registerInstanced(m);
        return { trees: nTrees, lamps: nLamps };
    }

    // ---------------------------------------------------------------- suelo y alrededores (city-env, una sola vez)
    // Suelo: se corre un poco hacia atrás en profundidad (las calles a 3 cm no titilan de lejos) y de noche pierde
    // saturación (el pasto no queda verde fluorescente bajo la luna).
    const groundDesat = { value: 0 };
    const groundMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    groundMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.groundDesat = groundDesat;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float groundDesat;')
            .replace('#include <color_fragment>', `#include <color_fragment>
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), groundDesat );`);
    };
    groundMaterial.customProgramCacheKey = () => 'suelo-desat';
    track(groundMaterial);
    const roadNight = { value: 0 };
    /** De noche: menos saturación y menos brillo (las veredas claras no quedan lilas bajo la luz azul de la luna). */
    function nightDim(material, key, desat = 0.7, dim = 0.58) {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.roadNight = roadNight;
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nuniform float roadNight;')
                .replace('#include <color_fragment>', `#include <color_fragment>
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), ${desat.toFixed(2)} * roadNight );
    diffuseColor.rgb *= 1.0 - ${dim.toFixed(2)} * roadNight;`);
        };
        material.customProgramCacheKey = () => key;
        return track(material);
    }
    const roadMaterial = nightDim(new THREE.MeshLambertMaterial({ vertexColors: true }), 'calles-noche');
    const markingMaterial = nightDim(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 'marcas-noche', 0.3, 0.35);
    // Agua: color propio + un reflejo suave del cielo de la hora (emisivo: celeste de día, naranja al atardecer, azul de noche).
    const waterMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 }));
    const ringHouseMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    let envInfo = { ground: false, water: false, ring: false, roads: false, campo: 0, ms: null, error: null };
    let roadCounts = null;
    const treeLayers = [];
    let campoTrees = null;

    // autos estacionados en las playas de los supermercados (cambian si se rearma: leyenda, datos)
    let carMeshes = [];
    let carBody = null, carGlass = null; // se arman al primer uso (después de los prototipos de mobiliario)
    const carMaterial = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    function adoptCars(arr) {
        for (const m of carMeshes) { m.parent?.remove(m); m.dispose?.(); }
        carMeshes = [];
        if (!arr?.length) return;
        if (!carBody) {
            carBody = protoGeometry((b) => {
                b.box(0, 0, X, Y, 2.1, 0.88, 0.32, 1.05, [1, 1, 1], 0);
                b.box(-0.25, 0, X, Y, 1.15, 0.8, 1.05, 1.5, [1, 1, 1], 0);
            });
            carGlass = protoGeometry((b) => {
                b.box(0.92, 0, X, Y, 0.02, 0.72, 1.08, 1.45, C('#2d3a46'), 0);
                b.box(-1.42, 0, X, Y, 0.02, 0.72, 1.08, 1.45, C('#2d3a46'), 0);
                for (const sx of [-1.35, 1.3]) for (const sy of [-0.9, 0.9]) b.box(sx, sy, X, Y, 0.33, 0.04, 0, 0.62, C('#1d1f22'), 0);
            });
        }
        const n = arr.length / 5;
        const body = new THREE.InstancedMesh(carBody, carMaterial, n);
        const glass = new THREE.InstancedMesh(carGlass, furnitureMaterial, n);
        const m4 = new THREE.Matrix4(), rot = new THREE.Matrix4(), col = new THREE.Color();
        for (let i = 0; i < n; i++) {
            const o = i * 5;
            m4.makeTranslation(arr[o], arr[o + 1], 0.05).multiply(rot.makeRotationZ(Math.atan2(arr[o + 3], arr[o + 2])));
            body.setMatrixAt(i, m4);
            glass.setMatrixAt(i, m4);
            body.setColorAt(i, col.set(CAR_COLORS[arr[o + 4]] ?? '#cccccc'));
        }
        for (const m of [body, glass]) {
            m.castShadow = true;
            m.frustumCulled = false;
            layers.vehicles.add(m);
            carMeshes.push(m);
        }
    }

    async function adoptEnvironment(L) {
        if (!L) return;
        if (L.error) {
            envInfo.error = L.error;
            console.warn('Ciudad 3D: no se pudo armar el entorno', L.error);
        }
        const mesh = (arrays, material, group, order = 0) => {
            const m = new THREE.Mesh(geometryFrom(arrays), material);
            m.matrixAutoUpdate = false;
            m.renderOrder = order;
            layers[group].add(m);
            return m;
        };
        if (L.ground) envInfo.ground = !!mesh(L.ground, groundMaterial, 'ground', 0);
        if (L.water) envInfo.water = !!mesh(L.water, waterMaterial, 'ground', 0);
        if (L.ringGround) envInfo.ring = !!mesh(L.ringGround, groundMaterial, 'ground', 1);
        if (L.ringBuildings) mesh(L.ringBuildings, ringHouseMaterial, 'landmarks').castShadow = true;
        if (L.periBuildings) mesh(L.periBuildings, ringHouseMaterial, 'landmarks').castShadow = true;
        if (L.infillBuildings) mesh(L.infillBuildings, ringHouseMaterial, 'landmarks').castShadow = true;
        if (L.roadsGround) envInfo.roads = !!mesh(L.roadsGround, roadMaterial, 'roads', 2);
        if (L.roadsMarkings) mesh(L.roadsMarkings, markingMaterial, 'roads', 3);
        envInfo.info = L.info ?? null;
        for (const P of L.plazas ?? []) {
            if (P.ground) mesh(P.ground, roadMaterial, 'roads', 2);
            if (P.water) mesh(P.water, waterMaterial, 'roads', 2);
            if (P.plain) mesh(P.plain, plainMaterial, 'landmarks').castShadow = true;
        }
        envInfo.plazas = (L.plazas ?? []).map((p) => p.kind);
        if (L.landmarks) mesh(L.landmarks, plainMaterial, 'landmarks').castShadow = true;
        envInfo.landmarks = (L.landmarkList ?? []).filter((l) => !l.covered).length;
        await yieldTask();
        if (L.lamps) roadCounts = await buildRoadFurniture(L);
        envInfo.ms = L.ms ?? null;
        // árboles del campo (quintas, cortinas de los caminos): se ven de lejos, se recortan por sector a 4 km
        await yieldTask();
        if (L.campo?.length) {
            const list = [];
            for (let i = 0; i < L.campo.length; i += 2) list.push({ x: L.campo[i], y: L.campo[i + 1], context: 'campo' });
            campoTrees = createTreeLayer(THREE, list, { month: new Date().getMonth() + 1, quality: level === 'alta' ? 'media' : 'baja' });
            layers.trees.add(campoTrees.group);
            campoTrees.group.traverse((o) => { for (const m of [].concat(o.material ?? [])) track(m); });
            for (const m of [...campoTrees.group.children]) {
                m.castShadow = true;
                registerInstanced(m, { maxDistance: 4000, density: true });
            }
            envInfo.campo = campoTrees.count;
        }
    }

    // ---------------------------------------------------------------- mobiliario de city-roads (una sola vez)
    /** Malla prototipo (MeshBuilder, +x = hacia la calle) → BufferGeometry con colores lineales. */
    function protoGeometry(draw) {
        const mb = new MeshBuilder();
        draw(mb);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(mb.pos), 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(Float32Array.from(mb.nor), 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(Float32Array.from(mb.col, toLinear), 3));
        g.computeBoundingSphere();
        return g;
    }
    const X = [1, 0], Y = [0, 1];
    const C = (hex) => hexToRgb(hex);
    const furnitureMaterial = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const signalLightMaterial = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
    /** InstancedMesh con una instancia por (x, y, dirX, dirY) del arreglo plano (`stride` valores por elemento). */
    function instances(geo, material, arr, stride, filter = null, { shadow = true } = {}) {
        const idx = [];
        for (let i = 0; i + stride <= arr.length; i += stride) if (!filter || filter(arr, i)) idx.push(i);
        if (!idx.length) return null;
        const m = new THREE.InstancedMesh(geo, material, idx.length);
        const m4 = new THREE.Matrix4(), rot = new THREE.Matrix4();
        idx.forEach((i, n) => {
            const a = stride >= 4 ? Math.atan2(arr[i + 3], arr[i + 2]) : 0;
            m4.makeTranslation(arr[i], arr[i + 1], 0).multiply(rot.makeRotationZ(a));
            m.setMatrixAt(n, m4);
        });
        m.castShadow = shadow;
        layers.furniture.add(m);
        registerInstanced(m);
        return m;
    }

    /** Faroles (con su charco de luz donde cae la luz), semáforos, refugios de colectivo, bancos y carteles. */
    async function buildRoadFurniture(L) {
        const POLE = C('#3a3f4e');
        const lampKinds = [{ h: 6.2, arm: 1.4, pool: 12 }, { h: 8.2, arm: 2.3, pool: 16 }, { h: 4.2, arm: 0.2, pool: 10 }];
        lampKinds.forEach((k, kind) => {
            const only = (a, i) => a[i + 4] === kind;
            const body = protoGeometry((b) => {
                b.box(0, 0, X, Y, 0.08, 0.08, 0, k.h, POLE, 0);
                if (k.arm > 0.3) b.box(k.arm / 2, 0, X, Y, k.arm / 2, 0.045, k.h - 0.12, k.h, POLE, 0);
            });
            const head = new THREE.BoxGeometry(0.62, 0.3, 0.16).translate(k.arm, 0, k.h - 0.22);
            const pool = new THREE.PlaneGeometry(k.pool, k.pool).translate(k.arm + 0.5, 0, 0.2);
            instances(body, furnitureMaterial, L.lamps, 5, only);
            instances(head, lampHeadMaterial, L.lamps, 5, only, { shadow: false });
            const p = instances(pool, poolMaterial, L.lamps, 5, only, { shadow: false });
            if (p) p.renderOrder = 3;
        });
        // semáforos: un eje de calles en rojo y el otro en verde (según hacia dónde miran)
        const sigBody = protoGeometry((b) => {
            b.box(0, 0, X, Y, 0.06, 0.06, 0, 3.3, C('#2c3034'), 0);
            b.box(0.05, 0, X, Y, 0.13, 0.15, 2.45, 3.35, C('#1d2124'), 0);
            b.box(0.19, 0, X, Y, 0.02, 0.17, 3.33, 3.38, C('#1d2124'), 0); // visera
        });
        const lights = (on) => protoGeometry((b) => {
            const cols = on === 'rojo' ? ['#ff3b2f', '#4a3a14', '#163020'] : ['#3a1614', '#4a3a14', '#3dff7a'];
            [3.17, 2.9, 2.63].forEach((z, i) => b.box(0.19, 0, X, Y, 0.012, 0.075, z - 0.075, z + 0.075, C(cols[i]), 0));
        });
        const ns = (L.signals?.length ?? 0) / 4;
        if (ns) {
            instances(sigBody, furnitureMaterial, L.signals, 4);
            instances(lights('rojo'), signalLightMaterial, L.signals, 4, (a, i) => Math.abs(a[i + 2]) >= Math.abs(a[i + 3]), { shadow: false });
            instances(lights('verde'), signalLightMaterial, L.signals, 4, (a, i) => Math.abs(a[i + 2]) < Math.abs(a[i + 3]), { shadow: false });
        }
        // refugio de colectivo: techo, vidrio atrás, banco y cartel (+x = hacia la calle)
        const shelter = protoGeometry((b) => {
            const post = C('#5b6166');
            for (const [x, y] of [[-0.85, -1.6], [-0.85, 1.6], [0.75, -1.6], [0.75, 1.6]]) b.box(x, y, X, Y, 0.04, 0.04, 0, 2.3, post, 0);
            b.box(-0.05, 0, X, Y, 0.95, 1.75, 2.3, 2.42, C('#dfe3e6'), 0);
            b.box(-0.85, 0, X, Y, 0.03, 1.55, 0.25, 2.25, C('#8fb7c9'), 0);
            b.box(-0.55, 0, X, Y, 0.2, 1.1, 0.42, 0.5, C('#8a5a35'), 0);
            b.box(0.85, 2.0, X, Y, 0.03, 0.03, 0, 2.6, post, 0);
            b.box(0.85, 2.0, X, Y, 0.02, 0.22, 2.25, 2.6, C('#2f6fbf'), 0);
        });
        if (L.busStops?.length) instances(shelter, furnitureMaterial, L.busStops, 4);
        const bench = protoGeometry((b) => {
            b.box(0, 0, X, Y, 0.22, 0.8, 0.42, 0.5, C('#8a5a35'), 0);
            b.box(-0.2, 0, X, Y, 0.04, 0.8, 0.5, 0.9, C('#8a5a35'), 0);
            for (const y of [-0.65, 0.65]) b.box(0, y, X, Y, 0.2, 0.04, 0, 0.42, C('#3e4a46'), 0);
        });
        if (L.benches?.length) instances(bench, furnitureMaterial, L.benches, 4);
        const sign = protoGeometry((b) => {
            b.box(0, 0, X, Y, 0.035, 0.035, 0, 2.7, C('#5b6166'), 0);
            b.box(0, 0, X, Y, 0.42, 0.02, 2.45, 2.68, C('#1f6f43'), 0);
            b.box(0, 0, X, Y, 0.02, 0.42, 2.2, 2.43, C('#1f6f43'), 0);
        });
        if (L.signs?.length) instances(sign, furnitureMaterial, L.signs, 2);
        const planter = protoGeometry((b) => {
            b.box(0, 0, X, Y, 0.65, 0.65, 0, 0.55, C('#b9b2a2'), 0);
            b.box(0, 0, X, Y, 0.55, 0.55, 0.55, 0.6, C('#5a4632'), 0);
        });
        if (L.planters?.length) instances(planter, furnitureMaterial, L.planters, 4);
        const bin = protoGeometry((b) => {
            b.box(0, 0, X, Y, 0.04, 0.04, 0, 0.9, C('#3e4a46'), 0);
            b.box(0.12, 0, X, Y, 0.16, 0.16, 0.35, 0.95, C('#2f6b4a'), 0);
        });
        if (L.bins?.length) instances(bin, furnitureMaterial, L.bins, 4);
        await yieldTask();

        // árboles de vereda, cantero, peatonal y patio (city-trees)
        let nTrees = 0;
        if (L.trees?.length) {
            // dos capas: las plazas (pocas, todas se ven) y el resto (vereda, cantero, peatonal, patio: con tope por calidad)
            const city = [], plaza = [];
            for (let i = 0; i < L.trees.length; i += 4) {
                const t = { x: L.trees[i], y: L.trees[i + 1], context: TREE_CONTEXTS[L.trees[i + 2]] ?? 'vereda' };
                if (L.trees[i + 3] >= 0) t.species = SPECIES_KEYS[L.trees[i + 3]];
                (t.context === 'plaza' ? plaza : city).push(t);
            }
            for (const list of [city, plaza]) {
                if (!list.length) continue;
                await yieldTask();
                const layer = timed(list === city ? 'arboles' : 'arboles-plaza', () => createTreeLayer(THREE, list, { month: new Date().getMonth() + 1, quality: level }));
                treeLayers.push(layer);
                layers.trees.add(layer.group);
                layer.group.traverse((o) => { for (const m of [].concat(o.material ?? [])) track(m); });
                const t0 = performance.now();
                for (const m of [...layer.group.children]) {
                    m.castShadow = true;
                    // los de las plazas se ven de lejos (la plaza sin árboles parece un dibujo); el resto, hasta la distancia de detalle
                    registerInstanced(m, list === city ? { density: true } : { maxDistance: 1800 });
                    if (performance.now() - t0 > 60) await yieldTask();
                }
                nTrees += layer.count;
            }
        }
        return { trees: nTrees, lamps: L.lamps.length / 5, signals: ns, busStops: (L.busStops?.length ?? 0) / 4, benches: (L.benches?.length ?? 0) / 4, signs: (L.signs?.length ?? 0) / 2 };
    }

    // ---------------------------------------------------------------- tránsito (city-traffic + city-vehicles)
    // Se simula solo con el 3D prendido, la pestaña visible y el tránsito activado; alrededor de lo que mira la cámara.
    let traffic = null, vehicleLayer = null, laneGraph = null, trafficOn = !!trafficWanted, lastLight = null;
    let trafficMax = 0, lastStep = null, animating = false, parkedAll = [];
    const parkedNear = [], movingNear = [];
    const UPLOAD_BUDGET = 45000; // triángulos nuevos por cuadro
    const WARM_WAIT_MS = 1200; // sin compilación en paralelo: cuánto se deja trabajar al proceso de la GPU antes de enlazar
    const FAR_TREES = 2, FAR_TREES_EXTRA = 400; // los árboles se ralean desde 0,7 × la distancia de detalles hasta el doble (+400 m como mucho)
    const VEHICLE_DIST = 650, PARKED_CAP = 160;
    const VEHICLE_LOD = { baja: 150, media: 220, alta: 300 }; // m del ojo (en planta) hasta donde va el modelo completo
    function setupTraffic(lg) {
        if (!lg?.lanes?.length) return;
        laneGraph = lg;
        vehicleLayer = createVehicleLayer(THREE, { maxPerType: { moto: 240, auto: 220, camioneta: 70, utilitario: 30, camion: 20, colectivo: 20 } });
        vehicleLayer.group.traverse((o) => { for (const m of [].concat(o.material ?? [])) track(m); });
        layers.vehicles.add(vehicleLayer.group);
        vehicleLayer.group.visible = trafficOn;
        resetTraffic();
    }
    function resetTraffic() {
        if (!laneGraph) return;
        trafficMax = TRAFFIC_MAX[level] ?? 150;
        traffic = createTraffic(laneGraph, { seed: 7, maxVehicles: trafficMax });
        // estacionados: solo en algunas cuadras del barrio (no en toda la franja), ~1 de cada 3 lugares de city-traffic
        parkedAll = traffic.parked.filter((p) => p.x > x0 - 20 && p.x < x1 + 20 && p.y > y0 - 20 && p.y < y1 + 20
            && ((Math.imul(Math.round(p.x * 2), 73856093) ^ Math.imul(Math.round(p.y * 2), 19349663)) >>> 0) % 100 < 33);
        lastStep = null;
    }
    function trafficFrame(v) {
        if (!traffic || !trafficOn || !active || document.hidden) { lastStep = null; return; }
        if ((TRAFFIC_MAX[level] ?? 150) !== trafficMax) resetTraffic();
        const now = performance.now();
        const dt = lastStep === null ? 0 : Math.min(0.25, (now - lastStep) / 1000);
        lastStep = now;
        const c = map.getCenter();
        const [cx, cy] = proj.toLocal(c.lng, c.lat);
        // Recorte (vehículos = la capa más cara en triángulos): solo los que están en la vista y cerca del ojo; de lejos
        // (zoom < 15,5) no se dibuja ninguno (serían puntitos). Los estacionados, más cerca todavía y con tope.
        const [ex, ey, ez] = v.eye;
        const maxD = v.zoom < 15.5 ? 0 : Math.min(VEHICLE_DIST, 260 + ez * 1.2);
        // Foco de la simulación (horas del juego = las de la luz: respeta ?hora=; el tiempo es real), centrado en el ojo
        // igual que el recorte del dibujo. Clave para que no haya "pop": el radio es bastante mayor que la distancia de
        // dibujo (maxD), así el anillo donde aparecen y se reciclan los vehículos (0,6·r … r en city-traffic) queda MÁS
        // ALLÁ de maxD y nunca se ve a un auto nacer o desaparecer dentro de cuadro. La densidad se mantiene realista
        // porque el cupo de city-traffic ahora escala con el área del foco (no con el zoom). Con poco zoom no se dibuja
        // ninguno: alcanza un radio modesto. maxD/0,55 ≈ 1,8·maxD deja el anillo de aparición fuera del dibujo.
        const camDist = Math.hypot(ex - cx, ey - cy, ez);
        const r = maxD > 0
            ? Math.min(760, Math.max(camDist * 1.1, maxD / 0.55))
            : Math.min(600, Math.max(250, camDist * 1.1));
        traffic.step(dt, lastLight?.hours ?? 12, { x: ex, y: ey, r });
        movingNear.length = 0;
        parkedNear.length = 0;
        if (maxD > 0) {
            for (const w of traffic.vehicles) {
                if (w.visible === false || Math.abs(w.x - ex) > maxD || Math.abs(w.y - ey) > maxD) continue;
                if (Math.hypot(w.x - ex, w.y - ey) < maxD && v.visible(w.x, w.y, 1, 6)) movingNear.push(w);
            }
            const pd = maxD * 0.7;
            for (const p of parkedAll) {
                if (parkedNear.length >= PARKED_CAP) break;
                if (Math.abs(p.x - ex) < pd && Math.abs(p.y - ey) < pd && v.visible(p.x, p.y, 1, 4)) parkedNear.push(p);
            }
        }
        // de lejos (auto de menos de ~20 px) va el modelo simple: ~25 triángulos en vez de 240–370
        vehicleLayer.update(movingNear, lastLight, parkedNear, { x: ex, y: ey, distance: Math.max(VEHICLE_LOD[level] ?? 220, ez * 0.9) });
        if (!animating) {
            animating = true;
            requestAnimationFrame(() => { animating = false; if (trafficOn && active && !document.hidden) map.triggerRepaint(); });
        }
    }
    // ---------------------------------------------------------------- detalles instanciados por sector
    const cells = new Map(); // clave de sector -> { sphere, items: [{ mesh, total, density, maxDistance }] }

    /**
     * Reparte un InstancedMesh por sectores (una malla instanciada por sector, misma geometría y material) para que
     * se recorte fuera de la vista y más allá de `maxDistance` (por defecto, la de detalles de la calidad), y que con
     * `density: true` muestre solo una parte (árboles en calidad baja). Devuelve las mallas nuevas.
     */
    function registerInstanced(mesh, { maxDistance = null, density = false, height = 12 } = {}) {
        const parent = mesh.parent ?? layers.furniture;
        parent.remove(mesh);
        const groups = new Map();
        const m4 = new THREE.Matrix4();
        for (let k = 0; k < mesh.count; k++) {
            mesh.getMatrixAt(k, m4);
            const [i, j] = chunkCoord(m4.elements[12], m4.elements[13]);
            const key = chunkKey(i, j);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(k);
        }
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const pad = mesh.geometry.boundingSphere.radius * 2;
        const out = [];
        const color = new THREE.Color();
        for (const [key, list] of groups) {
            // orden estable "mezclado": con menos densidad se ve una parte pareja, no un rincón
            list.sort((a, b) => ((a * 2654435761) >>> 0) - ((b * 2654435761) >>> 0));
            const sub = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            list.forEach((k, n) => {
                mesh.getMatrixAt(k, m4);
                sub.setMatrixAt(n, m4);
                if (mesh.instanceColor) {
                    mesh.getColorAt(k, color);
                    sub.setColorAt(n, color);
                }
                minX = Math.min(minX, m4.elements[12]); maxX = Math.max(maxX, m4.elements[12]);
                minY = Math.min(minY, m4.elements[13]); maxY = Math.max(maxY, m4.elements[13]);
            });
            sub.castShadow = mesh.castShadow;
            sub.receiveShadow = mesh.receiveShadow;
            sub.renderOrder = mesh.renderOrder;
            sub.frustumCulled = false; // lo recorta el sector
            sub.matrixAutoUpdate = false;
            parent.add(sub);
            if (!cells.has(key)) cells.set(key, { sphere: [0, 0, 0, 0], box: [Infinity, Infinity, -Infinity, -Infinity], items: [] });
            const cell = cells.get(key);
            cell.box = [Math.min(cell.box[0], minX), Math.min(cell.box[1], minY), Math.max(cell.box[2], maxX), Math.max(cell.box[3], maxY)];
            cell.sphere = [(cell.box[0] + cell.box[2]) / 2, (cell.box[1] + cell.box[3]) / 2, height / 2,
                Math.hypot(cell.box[2] - cell.box[0], cell.box[3] - cell.box[1], height) / 2 + pad];
            cell.items.push({ mesh: sub, total: list.length, density, maxDistance });
            out.push(sub);
        }
        mesh.dispose?.();
        return out;
    }

    // ---------------------------------------------------------------- sombras
    let shadowsDirty = true;
    const shadowTarget = new THREE.Vector3(Infinity, Infinity, 0);
    let shadowRadius = 0;
    function invalidateShadows() {
        shadowsDirty = true;
    }
    function applyShadowFlags() {
        const on = preset.sunShadows;
        for (const ch of chunks) {
            for (const m of ch.detail) {
                m.castShadow = on;
                m.receiveShadow = on;
            }
            if (ch.lod) ch.lod.castShadow = on;
        }
        sun.castShadow = on;
        catcher.visible = on && catcherWanted;
    }

    function fitShadow(tx, ty, camDist) {
        const radius = Math.min(600, Math.max(160, camDist * 0.9));
        const texel = (2 * radius) / (preset.shadowMapSize || 2048);
        // centro "pegado" a la grilla de texeles: la sombra no tiembla al mover el mapa
        const sx = Math.round(tx / (texel * 8)) * texel * 8, sy = Math.round(ty / (texel * 8)) * texel * 8;
        if (Math.abs(radius - shadowRadius) > shadowRadius * 0.1 || Math.hypot(sx - shadowTarget.x, sy - shadowTarget.y) > radius * 0.08) {
            shadowRadius = radius;
            shadowTarget.set(sx, sy, 0);
            const c = sun.shadow.camera;
            c.left = c.bottom = -radius;
            c.right = c.top = radius;
            c.updateProjectionMatrix();
            invalidateShadows();
        }
        sun.position.copy(sunDir).multiplyScalar(1500).add(shadowTarget);
        sun.target.position.copy(shadowTarget);
    }

    // ---------------------------------------------------------------- cuadro a cuadro: recorte, versión simple, niebla
    const planes = [];
    const frameHooks = new Set();
    const lightHooks = new Set();
    let eye = [0, 0, 1000];
    let lastVisibleKey = '';
    const view = { eye, zoom: 0, planes, preset, visible: (x, y, z, r) => sphereVisible(planes, x, y, z, r) };
    let frameInfo = { visible: 0, lod: 0, total: 0 };

    /** Ojo, planos de la vista y niebla (lo necesitan las dos pasadas: suelo y ciudad). */
    function updateCamera(m) {
        eye = eyeFromMatrix(m) ?? eye;
        frustumPlanes(m, planes);
        const c = map.getCenter();
        const [tx, ty] = proj.toLocal(c.lng, c.lat);
        const camDist = Math.max(10, Math.hypot(eye[0] - tx, eye[1] - ty, eye[2]));
        const zoom = map.getZoom();
        const { near, far } = fogRange(zoom, camDist);
        fogUniforms.cityEye.value.set(eye[0], eye[1], eye[2]);
        fogUniforms.cityFogNear.value = near;
        fogUniforms.cityFogFar.value = far;
        fogUniforms.cityCamDist.value = camDist;
        return { tx, ty, camDist, zoom };
    }

    function updateFrame(m) {
        const { tx, ty, camDist, zoom } = updateCamera(m);

        if (preset.sunShadows) fitShadow(tx, ty, camDist);
        const reach = preset.sunShadows ? 60 : 0; // lo que está apenas afuera de la vista igual tira sombra adentro
        const lodD = preset.lodDistance;
        let visible = 0, lod = 0, key = '';
        // Subida a la GPU de a poco: un sector que se ve por primera vez entra solo si queda presupuesto en este cuadro
        // (si no, se muestra su versión simple, o nada, y se pide otro cuadro). Así no hay un primer cuadro de ~1 s.
        let budget = UPLOAD_BUDGET, pendingUpload = false;
        for (const ch of chunks) {
            const [x, y, z, r] = ch.sphere;
            const inView = sphereVisible(planes, x, y, z, r + reach);
            const d = sphereDistance(eye, ch.sphere);
            const far2 = ch.lodOn ? d > lodD * 0.95 : d > lodD * 1.05; // un poco de histéresis: no parpadea en el borde
            ch.lodOn = far2;
            let showDetail = inView && !far2;
            let showLod = inView && far2;
            if (showDetail && !ch.up) {
                if (budget > 0) { budget -= ch.tris; ch.up = true; } else { showDetail = false; showLod = !!ch.lodUp; pendingUpload = true; }
            }
            if (showLod && !ch.lodUp) {
                if (budget > 0) { budget -= ch.lodTris; ch.lodUp = true; } else { showLod = false; pendingUpload = true; }
            }
            for (const mesh of ch.detail) mesh.visible = showDetail;
            if (ch.lod) ch.lod.visible = showLod;
            if (ch.contact) ch.contact.visible = showDetail && preset.contactShadows;
            if (inView) {
                visible++;
                if (far2) lod++;
            }
            if (preset.sunShadows) key += showDetail ? '1' : inView ? '2' : '0';
        }
        if (pendingUpload) map.triggerRepaint();
        for (const cell of cells.values()) {
            const [x, y, z, r] = cell.sphere;
            const inView = sphereVisible(planes, x, y, z, r);
            const d = inView ? sphereDistance(eye, cell.sphere) : Infinity;
            for (const it of cell.items) {
                const maxD = it.maxDistance ?? preset.furnitureDistance;
                if (!it.density) {
                    it.mesh.visible = d < maxD;
                    continue;
                }
                // Árboles: en vez de cortarse de golpe en `maxD` (de lejos las manzanas quedaban peladas detrás de una
                // línea), desde 0,7 × maxD se van raleando hasta FAR_TREES × maxD (o maxD + FAR_TREES_EXTRA) (los del campo, con su propia
                // distancia, se cortan como antes: ahí ya hay niebla). El orden "mezclado" del sector hace que
                // los que quedan estén repartidos.
                const near = maxD * 0.7, far = it.maxDistance ? maxD : Math.min(maxD * FAR_TREES, maxD + FAR_TREES_EXTRA);
                const fade = it.maxDistance ? (d < maxD ? 1 : 0) : d < near ? 1 : d < far ? 1 - (d - near) / (far - near) : 0;
                it.mesh.visible = fade > 0;
                it.mesh.count = Math.ceil(it.total * preset.treeDensity * fade);
            }
        }
        if (preset.sunShadows && key !== lastVisibleKey) {
            lastVisibleKey = key;
            invalidateShadows();
        }
        frameInfo = { visible, lod, total: chunks.length };
        view.eye = eye;
        view.zoom = zoom;
        view.preset = preset;
        for (const fn of frameHooks) fn(view);
    }

    // ---------------------------------------------------------------- capa de MapLibre
    let renderer = null;
    let warming = false; // precalentando shaders: no se dibuja (si no, el primer cuadro los compila todos juntos)
    let renderers = 0; // capas de MapLibre que usan el renderer (suelo + ciudad)
    const mvp = new THREE.Matrix4();
    function ensureRenderer(m, gl) {
        renderers++;
        if (renderer) return;
        renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        renderer.autoClear = false;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.shadowMap.autoUpdate = false; // los edificios no se mueven: el mapa de sombras se rehace solo si cambia algo
        renderer.shadowMap.enabled = preset.sunShadows;
        // sin la verificación de errores de cada shader (getProgramInfoLog bloquea ~1 s en el primer cuadro)
        renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
    }
    function releaseRenderer() {
        if (--renderers > 0) return;
        renderer?.dispose();
        renderer = null;
    }
    function setCameraFrom(args) {
        const main = args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix;
        mvp.fromArray(main).multiply(modelMatrix);
        camera.projectionMatrix.copy(mvp);
        camera.projectionMatrixInverse.copy(mvp).invert();
    }
    /** Muestra solo la capa `ground` (pasada del suelo) o todo menos ella (pasada de la ciudad). */
    const GROUND_PASS = new Set(['ground', 'roads']);
    function groundOnly(on) {
        for (const name of LAYERS) layers[name].visible = on === GROUND_PASS.has(name);
    }

    // Pasada del suelo: va debajo de las calles 2D de MapLibre. Después se borra la profundidad: así las calles
    // (que MapLibre dibuja planas) no quedan tapadas por el pasto, y los edificios igual se dibujan sobre ellas.
    const groundLayer = {
        id: 'ciudad-3d-suelo',
        type: 'custom',
        renderingMode: '3d',
        onAdd(m, gl) { ensureRenderer(m, gl); },
        render(gl, args) {
            if (!renderer || warming || (!layers.ground.children.length && !layers.roads.children.length)) return;
            setCameraFrom(args);
            updateCamera(mvp.elements);
            renderer.resetState();
            renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            const shadowUpdate = renderer.shadowMap.needsUpdate;
            renderer.shadowMap.needsUpdate = false;
            groundOnly(true);
            renderer.render(scene, camera);
            groundOnly(false);
            renderer.shadowMap.needsUpdate = shadowUpdate;
            renderer.state.buffers.depth.setMask(true);
            renderer.clearDepth();
            renderer.resetState();
        },
        onRemove() { releaseRenderer(); },
    };

    const layer = {
        id: 'ciudad-3d',
        type: 'custom',
        renderingMode: '3d',
        onAdd(m, gl) { ensureRenderer(m, gl); },
        render(gl, args) {
            if (warming) return;
            setCameraFrom(args);
            groundOnly(false);
            updateFrame(mvp.elements);
            renderer.resetState();
            renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            if (renderer.shadowMap.enabled !== preset.sunShadows) {
                renderer.shadowMap.enabled = preset.sunShadows;
                for (const mat of allMaterials) mat.needsUpdate = true;
                invalidateShadows();
            }
            if (preset.sunShadows && shadowsDirty) {
                renderer.shadowMap.needsUpdate = true;
                shadowsDirty = false;
            }
            const tr = performance.now();
            renderer.render(scene, camera);
            if (slowRenders.length < 8) slowRenders.push(Math.round(performance.now() - tr));
            measureFrame();
        },
        onRemove() { releaseRenderer(); },
    };

    // ---------------------------------------------------------------- calidad automática
    function measureFrame() {
        const now = performance.now();
        if (lastFrameMs !== null && now - lastFrameMs < 400) frameStats.push(now - lastFrameMs);
        if (frameStats.length > 120) frameStats.shift();
        lastFrameMs = now;
        if (!meter || document.hidden) return;
        if (meter.frame(now)) {
            const next = decideQuality(level, meter.times);
            meter = null;
            autoRounds++;
            if (next !== level) {
                level = next;
                // fuera del cuadro: cambiar la resolución redimensiona el lienzo de MapLibre, no se hace en medio del dibujo
                setTimeout(applyQuality, 0);
                if (autoRounds < 2 && level !== 'baja') meter = createFrameMeter();
            }
        } else {
            map.triggerRepaint(); // mientras mide, dibuja seguido
        }
    }
    const frameStats = [];

    function applyQuality() {
        preset = QUALITY[level];
        applyShadowFlags();
        if (preset.sunShadows && sun.shadow.mapSize.x !== preset.shadowMapSize) {
            sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
            sun.shadow.map?.dispose();
            sun.shadow.map = null;
        }
        shadowRadius = 0;
        invalidateShadows();
        applyPixelRatio();
        map.triggerRepaint();
    }

    function applyPixelRatio() {
        const want = active ? Math.min(devicePixelRatio || 1, preset.pixelRatio) : null;
        if ((want ?? devicePixelRatio) !== map.getPixelRatio()) map.setPixelRatio(want);
    }

    // ---------------------------------------------------------------- dueños, selección y clic
    function setRange(mesh, start, count, rgb) {
        const attr = mesh.geometry.getAttribute('color');
        const k = attr.itemSize;
        for (let v = start; v < start + count; v++) attr.setXYZ(v, rgb[0], rgb[1], rgb[2]);
        attr.addUpdateRange(start * k, count * k);
        attr.needsUpdate = true;
    }

    function paintRoof(id) {
        const r = roofRanges.get(id);
        if (!r?.mesh) return;
        const rgb = hexToRgb(roofOf(id) ?? defaultRoofs.get(id) ?? '#b9b6ad').map(toLinear);
        setRange(r.mesh, r.start, r.count, rgb);
        if (r.lodMesh) setRange(r.lodMesh, r.lodStart, r.lodCount, rgb);
        invalidateShadows();
        map.triggerRepaint();
    }

    const raycaster = new THREE.Raycaster();
    /** Propiedad bajo un punto de la pantalla (px CSS), o null. Siempre contra el detalle (aunque se vea la versión simple). */
    function pick(x, y) {
        const canvas = map.getCanvas();
        const nx = (x / canvas.clientWidth) * 2 - 1;
        const ny = 1 - (y / canvas.clientHeight) * 2;
        const near = new THREE.Vector3(nx, ny, -1).applyMatrix4(camera.projectionMatrixInverse);
        const far = new THREE.Vector3(nx, ny, 1).applyMatrix4(camera.projectionMatrixInverse);
        raycaster.set(near, far.sub(near).normalize());
        const hit = raycaster.intersectObjects(pickables, false)[0];
        return hit ? hit.object.userData.owner?.[hit.faceIndex] || null : null;
    }

    // ---------------------------------------------------------------- luz del momento del día
    function setLight(l) {
        const el = Math.max(l.sun.elevation, 0.08);
        sunDir.set(Math.sin(l.sun.azimuth) * Math.cos(el), Math.cos(l.sun.azimuth) * Math.cos(el), Math.sin(el));
        if (l.night > 0.5) {
            sunDir.set(-0.4, -0.5, 0.75).normalize(); // luna
        }
        sun.position.copy(sunDir).multiplyScalar(1500).add(shadowTarget.x === Infinity ? new THREE.Vector3() : shadowTarget);
        if (shadowTarget.x === Infinity) sun.target.position.set(0, 0, 0);
        sun.color.setRGB(...(l.night > 0.5 ? [0.55, 0.65, 1] : l.sunColor), THREE.SRGBColorSpace);
        sun.intensity = l.night > 0.5 ? 0.35 : 0.25 + l.sunIntensity * 1.15;
        sun.shadow.intensity = l.night > 0.5 ? 0.35 : 0.55 + 0.35 * l.sunIntensity;
        hemi.color.setRGB(...l.ambientColor, THREE.SRGBColorSpace);
        hemi.groundColor.setRGB(0.75 * l.tint[0], 0.85 * l.tint[1], 0.7 * l.tint[2], THREE.SRGBColorSpace);
        hemi.intensity = l.ambient * 0.9;
        ambient.color.setRGB(...l.ambientColor, THREE.SRGBColorSpace);
        ambient.intensity = 0.25 + l.ambient * 0.35;
        for (const m of wallMaterials.values()) {
            m.emissiveIntensity = l.lights * 1.1;
        }
        lampHeadMaterial.emissiveIntensity = l.lights * 2;
        poolMaterial.opacity = l.lights * 0.55;
        // reflejo del cielo en el agua: suave, más claro mirando al horizonte de la hora (naranja al atardecer)
        const refl = 0.16 + 0.1 * (1 - l.night);
        waterMaterial.emissive.setRGB(
            (l.sky[0] * 0.6 + l.horizon[0] * 0.4) * refl, (l.sky[1] * 0.6 + l.horizon[1] * 0.4) * refl,
            (l.sky[2] * 0.6 + l.horizon[2] * 0.4) * refl, THREE.SRGBColorSpace);
        campoTrees?.setLight(l);
        for (const t of treeLayers) t.setLight(l);
        lastLight = l;
        groundDesat.value = 0.5 * l.night;
        // veredas, peatonal y paseos claros: de noche oscuros como todo (solo los alumbra el charco del farol)
        roadNight.value = l.night;
        signMaterial.color.setScalar(0.72 + 0.28 * l.lights);
        // `horizon` está en sRGB y la niebla se mezcla después de pasar a sRGB: mismo color que el horizonte de MapLibre
        fogUniforms.cityFogColor.value.setRGB(l.horizon[0], l.horizon[1], l.horizon[2]);
        invalidateShadows();
        for (const fn of lightHooks) fn(l);
        map.triggerRepaint();
    }

    // ---------------------------------------------------------------- primer armado
    // Cada paso en el hilo principal es corto y entre paso y paso se cede el control (el mapa sigue respondiendo):
    // ningún bloque largo de >200 ms aunque la ciudad tenga ~13.000 edificios. `mainMs` guarda cuánto tardó cada uno.
    const first = await timed('input+worker', () => runBuild(timed('input', () => buildInput(true))));
    await yieldTask();
    await timed('sectores', () => adoptChunks(first));
    await yieldTask();
    const legacy = first.furniture ? buildFurniture(first.furniture) : null;
    await adoptEnvironment(first.layers);
    timed('transito', () => setupTraffic(first.layers?.laneGraph));
    frameHooks.add(trafficFrame);
    const counts = roadCounts ?? legacy ?? { trees: 0, lamps: 0 };
    counts.trees += envInfo.campo;
    catchUpRoofs();
    applyQuality();

    let rebuildSeq = 0;
    async function rebuild() {
        const mine = ++rebuildSeq;
        const data = await runBuild(buildInput(false));
        if (mine !== rebuildSeq) return; // llegó uno más nuevo
        await adoptChunks(data);
        if (mine !== rebuildSeq) return;
        catchUpRoofs();
        map.triggerRepaint();
    }

    return {
        layer,
        /**
         * Precalienta (después de map.addLayer): compila los shaders y sube las texturas de a una capa por tarea, así el
         * primer cuadro del 3D no es un bloque de casi un segundo en el hilo principal. Devuelve ms por capa.
         */
        async warmUp() {
            if (!renderer) return null;
            warming = true;
            const out = {};
            const t0 = performance.now();
            try {
                const parallelCompile = renderer.extensions.has('KHR_parallel_shader_compile');
                // texturas de fachada: una por tarea
                for (const tex of new Set([...wallMaterials.values()].flatMap((m) => [m.map, m.emissiveMap]).filter(Boolean))) {
                    renderer.initTexture(tex);
                    await yieldTask();
                }
                out.texturas = Math.round(performance.now() - t0);
                // Un programa por tarea: se compila solo un objeto representativo de cada combinación material + tipo
                // de malla (con las luces de la escena) y se fuerza el enlace pidiendo sus uniformes. Sin
                // KHR_parallel_shader_compile (SwiftShader) cada enlace bloquea el hilo: así son varias tareas cortas
                // en vez de un primer cuadro de ~1 s. Con la extensión, compileAsync no bloquea.
                const reps = new Map();
                scene.traverse((o) => {
                    if (!(o.isMesh || o.isPoints || o.isLine)) return;
                    for (const m of [].concat(o.material ?? [])) {
                        const g = o.geometry?.attributes ?? {};
                        const key = `${m.uuid}|${o.isInstancedMesh ? 1 : 0}${o.instanceColor ? 1 : 0}${g.color ? 1 : 0}${g.uv ? 1 : 0}${o.receiveShadow ? 1 : 0}`;
                        if (!reps.has(key)) reps.set(key, o);
                    }
                });
                let longest = 0, n = 0;
                const t1 = performance.now();
                const objs = [...new Set(reps.values())];
                if (parallelCompile) {
                    for (const o of objs) {
                        const wasVisible = o.visible;
                        o.visible = true;
                        await renderer.compileAsync(o, camera, scene);
                        o.visible = wasVisible;
                        n++;
                    }
                } else {
                    // 1) se piden todas las compilaciones (no bloquea: el proceso de la GPU las va haciendo), de a
                    //    tandas cortas; 2) se espera cediendo el hilo; 3) se fuerza el enlace de a un programa por tarea
                    //    (si ya terminó, no espera nada)
                    let tb = performance.now();
                    for (const o of objs) {
                        const wasVisible = o.visible;
                        o.visible = true;
                        renderer.compile(o, camera, scene);
                        o.visible = wasVisible;
                        if (performance.now() - tb > 30) { renderer.getContext().flush(); await yieldTask(); tb = performance.now(); }
                    }
                    // Sombras del sol (alta): los programas de profundidad del mapa de sombras se compilarían en el primer
                    // cuadro con sombras (~1 s). Se piden igual, con un material de profundidad equivalente al que usa
                    // three (misma clave de programa: misma cara invertida, textura, instancias) y el destino de
                    // dibujo puesto en una textura (como en la pasada de sombras).
                    if (preset.sunShadows && renderer.shadowMap.enabled) {
                        const target = new THREE.WebGLRenderTarget(4, 4);
                        const prevTarget = renderer.getRenderTarget();
                        renderer.setRenderTarget(target);
                        const flip = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
                        const depthReps = new Map();
                        scene.traverse((o) => {
                            if (!o.isMesh || !o.castShadow || Array.isArray(o.material) || !o.material) return;
                            const m = o.material;
                            const side = m.shadowSide ?? flip[m.side];
                            const key = `${o.isInstancedMesh ? 1 : 0}${o.instanceColor ? 1 : 0}${o.receiveShadow ? 1 : 0}|${side}|${m.map ? m.map.uuid : ''}|${m.alphaTest}`;
                            if (!depthReps.has(key)) depthReps.set(key, [o, side]);
                        });
                        const standIns = [];
                        for (const [o, side] of depthReps.values()) {
                            const m = o.material;
                            const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side, map: m.map, alphaMap: m.alphaMap, alphaTest: m.alphaTest });
                            standIns.push(d);
                            const wasVisible = o.visible;
                            o.material = d;
                            o.visible = true;
                            renderer.compile(o, camera, scene);
                            o.material = m;
                            o.visible = wasVisible;
                            objs.push({ material: d, name: 'sombra', isStandIn: true });
                        }
                        renderer.setRenderTarget(prevTarget);
                        out.sombras = depthReps.size;
                        // los programas quedan en el caché de three (por clave); los materiales sustitutos se liberan después
                        setTimeout(() => { for (const d of standIns) d.dispose(); target.dispose(); }, 30000);
                    }
                    renderer.getContext().flush();
                    out.pedidoMs = Math.round(performance.now() - t1);
                    const waitUntil = performance.now() + WARM_WAIT_MS;
                    while (performance.now() < waitUntil) await new Promise((r) => setTimeout(r, 50));
                    for (const o of objs) {
                        const tp = performance.now();
                        for (const m of [].concat(o.material ?? [])) {
                            for (const prog of renderer.properties.get(m)?.programs?.values?.() ?? []) prog.getUniforms?.();
                        }
                        n++;
                        const dtp = performance.now() - tp;
                        if (dtp > 150) (out.lentos ??= []).push(`${[].concat(o.material)[0]?.type}:${o.name || o.parent?.name || ''}:${Math.round(dtp)}`);
                        longest = Math.max(longest, dtp);
                        await yieldTask();
                    }
                }
                out.programas = n;
                out.compilarMs = Math.round(performance.now() - t1);
                out.programaMasLargoMs = Math.round(longest);
            } finally {
                warming = false;
            }
            mainMs.precalentado = out;
            map.triggerRepaint();
            return out;
        },
        /** Capa del suelo (va debajo de las calles 2D: map.addLayer(groundLayer, 'calles-menores-borde')). */
        groundLayer,
        /** Hay suelo propio (pasto, agua, alrededores): el fondo de MapLibre puede ir del color del horizonte. */
        get hasGround() { return envInfo.ground; },
        /** Hay calles 3D (city-roads): las líneas de calles 2D de MapLibre se ocultan en 3D. */
        get hasRoads() { return envInfo.roads; },
        counts,
        pick,
        setLight,
        /** El dueño o la selección cambiaron: se recolorea solo ese techo (detalle y versión simple). */
        refresh: paintRoof,
        /** Cambió el tipo de alguna propiedad (corrección de datos) o la leyenda: se rearma todo (en el worker). */
        rebuild,
        /** 3D prendido/apagado (main.js): ajusta la resolución y arranca la medición de la calidad automática. */
        setActive(on) {
            active = on;
            applyPixelRatio();
            if (on && mode === 'auto' && autoRounds === 0 && !meter) meter = createFrameMeter();
            map.triggerRepaint();
        },
        /** 'auto' | 'baja' | 'media' | 'alta' */
        setQuality(next) {
            mode = parseQualityMode(next);
            if (mode === 'auto') {
                autoRounds = 0;
                level = initialAutoQuality({ cores: navigator.hardwareConcurrency ?? 4, mobile: coarse, dpr: devicePixelRatio });
                meter = active ? createFrameMeter() : null;
            } else {
                meter = null;
                level = mode;
            }
            applyQuality();
        },
        get quality() { return level; },
        /** Tránsito animado prendido/apagado (botón "Tránsito"). Apagado: no se simula ni se dibuja nada. */
        setTraffic(on) {
            trafficOn = !!on;
            if (vehicleLayer) vehicleLayer.group.visible = trafficOn;
            lastStep = null;
            map.triggerRepaint();
        },
        get trafficOn() { return trafficOn; },
        /** Diagnóstico: triángulos visibles por capa (después del recorte del último cuadro). */
        layerTriangles() {
            const out = {};
            for (const name of LAYERS) {
                let n = 0;
                const walk = GROUND_PASS.has(name) ? 'traverse' : 'traverseVisible'; // el suelo se oculta en la pasada principal
                layers[name][walk]((o) => {
                    if (!o.isMesh || !o.geometry) return;
                    const g = o.geometry;
                    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
                    n += o.isInstancedMesh ? t * o.count : t;
                });
                out[name] = Math.round(n);
            }
            return out;
        },
        /** Pruebas: vehículos en circulación ahora (metros locales). */
        trafficSnapshot: () => (traffic && trafficOn ? traffic.vehicles.filter((v) => v.visible !== false).map((v) => ({ type: v.type, x: v.x, y: v.y, heading: v.heading, speed: v.speed })) : []),
        get qualityMode() { return mode; },
        // ---- integración de otros módulos
        layers,
        toLocal: proj.toLocal,
        origin,
        add(name, object, { fog = true } = {}) {
            if (fog) object.traverse((o) => { for (const m of [].concat(o.material ?? [])) track(m); });
            (layers[name] ?? layers.landmarks).add(object);
            invalidateShadows();
            map.triggerRepaint();
            return object;
        },
        fogMaterial: track,
        registerInstanced,
        onFrame(fn) { frameHooks.add(fn); return () => frameHooks.delete(fn); },
        onLight(fn) { lightHooks.add(fn); return () => lightHooks.delete(fn); },
        invalidateShadows,
        setShadowCatcher(on) { catcherWanted = on; applyShadowFlags(); },
        // ---- pruebas
        /** Color actual del techo de una propiedad (lineal, 0–1). */
        roofRgb(id) {
            const r = roofRanges.get(id);
            if (!r?.mesh) return null;
            const a = r.mesh.geometry.getAttribute('color');
            return [a.getX(r.start), a.getY(r.start), a.getZ(r.start)];
        },
        stats: () => {
            const ft = frameStats.length ? frameStats.slice().sort((a, b) => a - b)[frameStats.length >> 1] : null;
            return {
                buildings: buildingCount,
                triangles: pickables.reduce((n, m) => n + m.geometry.getAttribute('position').count / 3, 0),
                drawnTriangles: renderer?.info.render.triangles ?? 0,
                drawCalls: renderer?.info.render.calls ?? 0,
                chunks: frameInfo,
                quality: level,
                qualityMode: mode,
                frameMs: ft && Math.round(ft),
                buildMs: Math.round(lastBuildMs),
                worker: workers.length > 0 && !workerBroken,
                workers: workerBroken ? 0 : workers.length,
                eye: eye.map((v) => Math.round(v)),
                env: { ...envInfo },
                mainMs: { ...mainMs, primerosCuadros: slowRenders.slice() },
                vehicles: trafficOn && traffic ? traffic.vehicles.filter((v) => v.visible !== false).length : 0,
                vehiclesDrawn: trafficOn ? movingNear.length : 0,
                vehiclesFar: vehicleLayer && trafficOn ? vehicleLayer.farCount() : 0,
                parked: trafficOn && traffic ? parkedNear.length : 0,
                vehicleTypes: vehicleLayer && trafficOn ? vehicleLayer.stats() : null,
                ...counts,
            };
        },
    };
}
