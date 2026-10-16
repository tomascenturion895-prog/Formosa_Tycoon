// Cuentas de la vista 3D que no necesitan WebGL ni el mapa: proyección a metros locales, posición de la cámara a partir
// de la matriz de MapLibre, pirámide de visión (frustum) para descartar sectores, niebla según el zoom, límites de la
// cámara en 3D y niveles de calidad. Sin imports: lo usan main.js (carga inicial, sin three.js), city3d.js y el worker.
// Se prueba con `npm run test:js`.

// ------------------------------------------------------------------ metros locales (misma cuenta que MercatorCoordinate)

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
const mercX = (lng) => (180 + lng) / 360;
const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

/**
 * Proyección a metros locales alrededor de `origin` ([lng, lat]): x = este, y = norte.
 * `mercator` y `scale` sirven para armar la matriz del modelo (metros -> coordenadas mercator de MapLibre).
 */
export function localProjection([lng0, lat0]) {
    const ox = mercX(lng0);
    const oy = mercY(lat0);
    const scale = (1 / EARTH_CIRCUMFERENCE) / Math.cos((lat0 * Math.PI) / 180); // unidades mercator por metro
    return {
        mercator: { x: ox, y: oy },
        scale,
        toLocal: (lng, lat) => [(mercX(lng) - ox) / scale, -(mercY(lat) - oy) / scale],
    };
}

// ------------------------------------------------------------------ cámara

/**
 * Posición del ojo (en las coordenadas del modelo) a partir de una matriz de proyección × vista (16 números, por
 * columnas, como three.js y MapLibre). El ojo es el único punto con x = y = w = 0 en el espacio de recorte: se
 * resuelve con las filas 0, 1 y 3 (la fila de profundidad no hace falta, así no importa cómo maneja MapLibre el
 * plano lejano). Devuelve null si la matriz no es de perspectiva.
 */
export function eyeFromMatrix(m) {
    const a = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[3], m[7], m[11]]];
    const b = [-m[12], -m[13], -m[15]];
    const det = (q) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1])
        - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])
        + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
    const d = det(a);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-30) return null;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const q = a.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)));
        out[c] = det(q) / d;
    }
    return out;
}

/**
 * Seis planos [nx, ny, nz, d] (normal hacia adentro, normalizada) de la pirámide de visión de una matriz
 * de recorte estilo OpenGL (z entre -w y w), como la que MapLibre le pasa a las capas propias.
 */
export function frustumPlanes(m, out = []) {
    const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const combos = [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]];
    for (let p = 0; p < 6; p++) {
        const [r, s] = combos[p];
        const nx = r3[0] + s * r[0], ny = r3[1] + s * r[1], nz = r3[2] + s * r[2], d = r3[3] + s * r[3];
        const len = Math.hypot(nx, ny, nz) || 1;
        out[p] = [nx / len, ny / len, nz / len, d / len];
    }
    return out;
}

/** ¿La esfera (centro, radio) toca la pirámide de visión? */
export function sphereVisible(planes, x, y, z, r) {
    for (const [nx, ny, nz, d] of planes) {
        if (nx * x + ny * y + nz * z + d < -r) return false;
    }
    return true;
}

/**
 * Distancias de la niebla (en metros, desde el ojo). Escalan con lo lejos que está la cámara del punto que mira; con
 * poco zoom (ciudad entera a la vista) la niebla arranca más cerca en proporción, así el borde lejano se funde con el
 * horizonte del cielo de MapLibre en vez de cortar en seco.
 */
export function fogRange(zoom, camDist) {
    const t = Math.min(1, Math.max(0, (zoom - 14.5) / 4));
    const near = camDist * (0.85 + t * 1.15);
    const far = camDist * (2.1 + t * 2.9);
    return { near, far: Math.max(far, near + 50) };
}

// ------------------------------------------------------------------ sectores (chunks)

export const CHUNK_SIZE = 250;

export function chunkCoord(x, y, size = CHUNK_SIZE) {
    return [Math.floor(x / size), Math.floor(y / size)];
}

export function chunkKey(i, j) {
    return `${i},${j}`;
}

/** Distancia del ojo al borde de la esfera de un sector (0 si el ojo está adentro). */
export function sphereDistance(eye, sphere) {
    return Math.max(0, Math.hypot(eye[0] - sphere[0], eye[1] - sphere[1], eye[2] - sphere[2]) - sphere[3]);
}

// ------------------------------------------------------------------ límites de la cámara en 3D

export const LIMITS_2D = { minZoom: 12, maxZoom: 19, maxPitch: 60 };
export const LIMITS_3D = { minZoom: 14.5, maxZoom: 19.5, maxPitch: 75, margin: 300 };

/** [oeste, sur, este, norte] de una lista de anillos [[lng, lat], …], agrandado `meters` metros de cada lado. */
export function districtBounds(rings, meters = LIMITS_3D.margin) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const ring of rings) {
        for (const [lng, lat] of ring) {
            if (lng < w) w = lng;
            if (lng > e) e = lng;
            if (lat < s) s = lat;
            if (lat > n) n = lat;
        }
    }
    if (!Number.isFinite(w)) return null;
    const dLat = meters / 111320;
    const dLng = meters / (111320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
    return [w - dLng, s - dLat, e + dLng, n + dLat];
}

export function clampLngLat([lng, lat], b) {
    return [Math.min(b[2], Math.max(b[0], lng)), Math.min(b[3], Math.max(b[1], lat))];
}

export function clampZoom(z, lim = LIMITS_3D) {
    return Math.min(lim.maxZoom, Math.max(lim.minZoom, z));
}

// ------------------------------------------------------------------ calidad

export const QUALITY_KEY = 'formosa.calidad';
export const QUALITY_LEVELS = ['baja', 'media', 'alta'];

/**
 * Niveles de calidad. `antialias` solo se puede elegir al crear el mapa (el contexto WebGL es de MapLibre): se aplica
 * al recargar. `lodDistance`: desde dónde los sectores pasan a cajas simples. `furnitureDistance`: hasta dónde se ven
 * árboles, faroles y demás detalles chicos. `treeDensity`: fracción de árboles que se dibujan.
 */
export const QUALITY = {
    baja: { pixelRatio: 1, lodDistance: 450, furnitureDistance: 320, treeDensity: 0.7, maxTrees: 5000, maxVehicles: 130, contactShadows: true, sunShadows: false, shadowMapSize: 0, antialias: false },
    media: { pixelRatio: 1.5, lodDistance: 700, furnitureDistance: 650, treeDensity: 0.9, maxTrees: 9000, maxVehicles: 180, contactShadows: true, sunShadows: false, shadowMapSize: 0, antialias: true },
    alta: { pixelRatio: 2, lodDistance: 1200, furnitureDistance: 1100, treeDensity: 1, maxTrees: 13000, maxVehicles: 320, contactShadows: true, sunShadows: true, shadowMapSize: 2048, antialias: true },
};

/** 'auto' | 'baja' | 'media' | 'alta' a partir de lo guardado (cualquier otra cosa: automática). */
export function parseQualityMode(stored) {
    return QUALITY_LEVELS.includes(stored) ? stored : 'auto';
}

/** Nivel con el que arranca la automática, según lo que se sabe del equipo antes de medir. */
export function initialAutoQuality({ cores = 4, mobile = false, dpr = 1 } = {}) {
    if (mobile || cores <= 2) return 'baja';
    if (cores >= 8 && dpr <= 2) return 'alta';
    return 'media';
}

/** Mediana de una lista de números. */
export function median(list) {
    if (!list.length) return NaN;
    const s = list.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Con los tiempos de cuadro medidos (ms), ¿hay que bajar la calidad? Solo baja, nunca sube sola.
 * Menos de ~22 cuadros/s: un escalón; menos de ~11: directo a 'baja'.
 */
export function decideQuality(current, frameTimes) {
    const ms = median(frameTimes);
    if (!Number.isFinite(ms)) return current;
    const i = QUALITY_LEVELS.indexOf(current);
    if (ms > 90) return 'baja';
    if (ms > 45 && i > 0) return QUALITY_LEVELS[i - 1];
    return current;
}

/**
 * Acumula tiempos de cuadro mientras se dibuja (los huecos largos son pausas: el mapa quieto no dibuja) y avisa
 * cuando juntó `windowMs` de dibujo continuo.
 */
export function createFrameMeter({ windowMs = 3000, skip = 2, maxGap = 400 } = {}) {
    let last = null;
    let skipped = 0;
    let total = 0;
    const times = [];
    return {
        times,
        /** Registra un cuadro dibujado en el instante `now` (ms). Devuelve true cuando ya alcanza para decidir. */
        frame(now) {
            if (last !== null) {
                const dt = now - last;
                if (dt < maxGap) {
                    if (skipped < skip) skipped++; // los primeros cuadros compilan shaders: no cuentan
                    else {
                        times.push(dt);
                        total += dt;
                    }
                }
            }
            last = now;
            return total >= windowMs && times.length >= 5;
        },
    };
}
