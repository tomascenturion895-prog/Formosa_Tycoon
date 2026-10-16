// Moldes de edificios de la ciudad 3D: casas, comercios, departamentos, hoteles y súper con la pinta de Formosa
// (ciudad baja, calurosa y húmeda del NEA): casas con galería y tanque de agua en la terraza, techos de tejas o de
// chapa, casas antiguas sobre la vereda en el microcentro, locales de esquina con ochava, edificios con balcones.
//
// Puro (sin DOM ni WebGL): solo arma triángulos en los MeshBuilder que le pasan. Todo lo "al azar" sale de
// hash01(id, sal), así cada propiedad se ve igual en todos los navegadores.
//
// Texturas de fachada: cada estilo de FACADE_STYLES tiene su lienzo (city-textures.js). Las paredes llevan uv en
// metros / FACADE_CELLS[estilo]: una unidad de textura = el lienzo entero (repeat 1 × 1, RepeatWrapping).
import { ShapeUtils, Vector2 } from 'three';
import { hash01, hexToRgb, normalizeRing, orientedBox, signedArea } from './city-geometry.js';

// ------------------------------------------------------------------ estilos de fachada

/**
 * Por estilo: `cell` = metros que cubre el lienzo entero [ancho, alto]; `unit` = ancho de una ventana (columna) en
 * metros; `cols`/`rows` = ventanas por lienzo; `floor` = alto de cada fila (piso); `px` = lado del lienzo.
 */
export const FACADE_INFO = {
    casa: { unit: 2.6, floor: 3.25, cols: 2, rows: 2, px: 128 },
    antigua_verde: { unit: 2.6, floor: 6, cols: 2, rows: 1, px: 128 },
    antigua_marron: { unit: 2.6, floor: 6, cols: 2, rows: 1, px: 128 },
    chapa: { unit: 2.8, floor: 4, cols: 2, rows: 1, px: 128 },
    local: { unit: 3, floor: 4.5, cols: 2, rows: 1, px: 128 },
    departamentos: { unit: 3, floor: 2.9, cols: 4, rows: 4, px: 256 },
    hotel: { unit: 2.5, floor: 3, cols: 4, rows: 4, px: 256 },
    torre: { unit: 2.2, floor: 3, cols: 4, rows: 4, px: 256 },
    super: { unit: 4, floor: 7, cols: 2, rows: 1, px: 128 },
};
export const FACADE_STYLES = Object.keys(FACADE_INFO);
/** Metros por unidad de textura (el lienzo entero) para cada estilo. */
export const FACADE_CELLS = Object.fromEntries(FACADE_STYLES.map((s) => {
    const f = FACADE_INFO[s];
    return [s, [f.unit * f.cols, f.floor * f.rows]];
}));

// ------------------------------------------------------------------ paletas

const PAL = {
    c1Walls: ['#f1e2bf', '#f2b89a', '#a9d3e8', '#a8dcc8', '#f4f2ec', '#f3e39a', '#f0c4c8', '#cfe6b8', '#f6cf9c'],
    c2Walls: ['#f3f1ea', '#ecdcb8', '#b5654a', '#e2cfa4', '#f6ead2', '#a85a42'],
    c3Walls: ['#b9bbb6', '#e6d8b5', '#ecd27a', '#a7a8a3', '#d9d2c0', '#e8c96e'],
    c4Walls: ['#d9a55b', '#c98f8a', '#a9a49a', '#e3c27a', '#9fb8c0', '#c9b48e', '#d68f6a'],
    c5Walls: ['#f2f2ee', '#cfd2d4', '#c4704e', '#e4d3b4', '#dfe3e6', '#b9c4c9'],
    c6Walls: ['#f1e2bf', '#f2b89a', '#a9d3e8', '#a8dcc8', '#f4f2ec', '#f3e39a', '#f0c4c8', '#cfd2d4', '#e4d3b4'],
    shopWalls: ['#f4f2ec', '#e9edf2', '#f1e2bf', '#f2b89a', '#a9d3e8', '#d9e8c8', '#f3e39a'],
    centroWalls: ['#ece6dc', '#d8d4cc', '#e3d2b4', '#c9ccd0', '#efe8d8', '#d6c3a5'],
    aptWalls: ['#ece6dc', '#d8d4cc', '#e3d2b4', '#f2efe8', '#c9ccd0', '#d9c2a8', '#b9c4c9'],
    towerWalls: ['#dfe6ea', '#c8d3da', '#e9e4da', '#b8c6d0', '#d4d9de'],
    hotelWalls: ['#efe8d8', '#d8d4cc', '#e0b49a', '#e3d2b4', '#cfd8e0', '#f0dcc0'],
    superWalls: ['#eef0ec', '#e2f0e4', '#f2eee2', '#e6eaf0'],
    tiles: ['#b5462f', '#c4553f', '#a8452f', '#cf6a43', '#9e3c2a', '#b95c3a', '#c97a4f', '#a34a35'],
    chapa: ['#9ea4a8', '#b3b8bb', '#8c9296', '#5e8a63', '#6f9a6c', '#a9aeb1', '#4f7a5a'],
    flat: ['#9a9fa6', '#a3a7ad', '#9196a0', '#a8a69f', '#8f959c', '#b0b3b8'],
    signs: ['#d8342c', '#2a5caa', '#f2c230', '#2f9a55', '#e8742a', '#7b3fa0', '#1f8fb3', '#e05a8a', '#c0262d', '#ffffff'],
    awnings: ['#d8342c', '#2f9a55', '#2a5caa', '#f2a03a', '#e05a8a', '#1f8fb3', '#7a5a3a'],
    doors: ['#6b4a2f', '#4a6b3a', '#5a5f66', '#7a3b2a', '#3d5a73', '#8a6a3e'],
    tanks: ['#2f3136', '#2f3136', '#2f3136', '#e8e2d0', '#5c86b8', '#d7d9d4'], // el Rotoplas negro es el más común
    gardens: ['#7fb35a', '#6fa84f', '#8cbf62', '#77a957'],
    // remate del pretil (visto desde arriba marca el contorno de cada casa): blanco, gris, terracota, verde…
    trims: ['#f7f5ef', '#ffffff', 'pared', '#b5462f', '#6a6f75', '#e9dcc0', 'pared', '#2f6e4a', '#c9c2b2'],
    gates: ['#3a3d42', '#5a5f66', '#2f5d3a', '#6b4a2f', '#e9eaea', '#8a2f2a', '#2a4f7a'],
    precaria: ['#a7a8a3', '#b9bbb6', '#b0603f', '#c27a55', '#9e9f9a'],
    chapaVieja: ['#8c6450', '#9ea4a8', '#7d7f80', '#a26f55', '#8a9094'],
};
const COL = {
    stand: '#5e6166', ac: '#eceff1', shutter: '#a9afb5', shutterBox: '#7d838a', reja: '#33363b', glass: '#3b5568',
    galleryFloor: '#b86a52', column: '#f4f2ec', block: '#9b9b96', marquee: '#e9eaea', marqueeDark: '#4a4f57',
    machine: '#c7c9cc', concrete: '#bfc1c0', balconyGlass: '#cfe3ea', chimney: '#86603c', cornice: '#efe7d6',
};

const rgbCache = new Map();
function rgb(hex) {
    let c = rgbCache.get(hex);
    if (!c) {
        c = hexToRgb(hex);
        rgbCache.set(hex, c);
    }
    return c;
}
const shade = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
const pickOf = (list, id, salt) => list[Math.floor(hash01(id, salt) * list.length) % list.length];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ------------------------------------------------------------------ elección del molde

/** Pesos (en %) de cada molde de casa por zona. */
export const MOLD_WEIGHTS = {
    barrio: { C1: 35, C2: 20, C3: 20, C4: 5, C5: 15, C6: 5 },
    centro: { C1: 15, C2: 10, C3: 5, C4: 35, C5: 25, C6: 10 },
    costanera: { C1: 30, C2: 15, C3: 15, C4: 5, C5: 30, C6: 5 },
};
export const MOLDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'L1', 'L2', 'L3', 'E1', 'E2', 'H1', 'S1'];

function weighted(table, r) {
    let total = 0;
    for (const k in table) total += table[k];
    let x = r * total;
    for (const k in table) {
        x -= table[k];
        if (x < 0) return k;
    }
    return Object.keys(table).at(-1);
}

/** Datos del polígono que usan la elección y el armado (se calculan una sola vez). */
function analyze(b) {
    const raw = normalizeRing(b.ring ?? []);
    const R = [];
    for (const p of raw) {
        const last = R[R.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) R.push(p);
    }
    while (R.length > 3 && Math.hypot(R[0][0] - R.at(-1)[0], R[0][1] - R.at(-1)[1]) <= 0.05) R.pop();
    const area = R.length >= 3 ? Math.abs(signedArea(R)) : 0;
    const box = R.length >= 3 ? orientedBox(R) : { cx: 0, cy: 0, u: [1, 0], v: [0, 1], halfLong: 0, halfShort: 0 };
    const fill = box.halfLong > 0 && box.halfShort > 0 ? area / (4 * box.halfLong * box.halfShort) : 0;
    return {
        R, area, box, fill,
        boxy: fill >= 0.85 || (R.length === 4 && fill >= 0.75),
        long: box.halfLong * 2, short: box.halfShort * 2,
    };
}

/** Distancia desde el centro del rectángulo hasta su borde, en la dirección (x, y). */
function halfExtentToward(box, x, y) {
    return Math.abs(box.u[0] * x + box.u[1] * y) * box.halfLong + Math.abs(box.v[0] * x + box.v[1] * y) * box.halfShort;
}

function chooseFrom(b, ctx, A) {
    const zone = ctx?.zone ?? 'barrio';
    const id = b.id | 0;
    const kind = b.kind ?? 'casa';
    const area = b.area ?? A.area;
    if (kind === 'supermercado') return 'S1';
    if (kind === 'hotel') return zone === 'costanera' ? 'E2' : 'H1';
    if (zone === 'costanera' && area > 600) return 'E2';
    if (zone === 'centro' && (area > 350 || (area > 150 && hash01(id, 91) < 0.04))) return 'E1';
    if (kind === 'comercio') {
        if (ctx?.corner && A.boxy && A.short >= 5) return 'L2';
        return zone === 'centro' ? 'L3' : 'L1';
    }
    const table = MOLD_WEIGHTS[zone] ?? MOLD_WEIGHTS.barrio;
    const r = hash01(id, 90);
    if (area < 45) {
        return r * (table.C1 + table.C3) < table.C1 ? 'C1' : 'C3';
    }
    let m = weighted(table, r);
    if (m === 'C6' && (A.long < 10 || !A.boxy)) m = 'C5';
    if (m === 'C2' && !A.boxy) m = 'C1';
    if (m === 'C4' && ctx?.front && ctx.front.dist - halfExtentToward(A.box, ctx.front.dirX, ctx.front.dirY) > 9) {
        m = A.boxy ? 'C2' : 'C1';
    }
    return m;
}

/** Molde que le toca a un edificio: 'C1'..'C6' casas, 'L1'..'L3' comercios, 'E1'/'E2' edificios, 'H1' hotel, 'S1' súper. */
export function chooseMold(b, ctx = {}) {
    return chooseFrom(b, ctx, analyze(b));
}

// ------------------------------------------------------------------ parámetros (deterministas por id)

function params(b, mold, A) {
    const id = b.id | 0;
    const r = (s) => hash01(id, s);
    const j = 0.9 + 0.2 * r(31); // ±10 % de altura
    const p = { mold, j, tank: false, standH: 0.5, top: 0, roofKind: 'plano' };
    switch (mold) {
        case 'C1':
            p.H = 3.2 * j; p.P = p.H + 0.45 + 0.3 * r(32); p.wall = pickOf(PAL.c1Walls, id, 1);
            p.gallery = r(2) < 0.7; p.galRoof = r(33) < 0.35 ? 'teja' : 'losa'; p.galCols = r(34) < 0.5 ? 3 : 4;
            p.tank = r(3) < 0.85; p.ac = r(4) < 0.55;
            p.fence = Math.floor(r(5) * 4); // 0 reja sobre muro bajo, 1 muro, 2 nada, 3 reja alta
            p.gate = r(35) < 0.45; p.trim = pickOf(PAL.trims, id, 36); p.roofRoom = r(37) < 0.3;
            break;
        case 'C2':
            p.H = 3.0 * j; p.wall = pickOf(PAL.c2Walls, id, 1); p.roofKind = 'teja';
            p.roofType = Math.floor(r(6) * 3); // 0 cumbrera paralela al frente, 1 hastial al frente, 2 a cuatro aguas
            p.gallery = r(2) < 0.45; p.chimney = r(7) < 0.4; p.ac = r(4) < 0.4; p.fence = Math.floor(r(5) * 4);
            p.gate = r(35) < 0.45; p.eave = 0.35 + 0.45 * r(38);
            p.rise = 2.1 + 0.8 * r(39); p.P = p.H + p.rise + (p.chimney ? 0.45 : 0);
            break;
        case 'C3':
            p.precaria = r(17) < 0.35; p.roofKind = 'chapa'; p.standH = 1.2;
            if (p.precaria) {
                // casilla precaria: bloque o ladrillo sin revocar, chapa vieja a la vista (sin pretil), más baja
                p.H = 2.7 * j; p.P = p.H + 0.25; p.wall = pickOf(PAL.precaria, id, 1); p.tank = r(3) < 0.3;
                p.ac = false; p.fence = r(5) < 0.5 ? 2 : 4; // 4: alambrado
            } else {
                p.P = 3.8 * j; p.H = p.P - 0.35; p.wall = pickOf(PAL.c3Walls, id, 1);
                p.unfinished = r(8) < 0.45; p.tank = r(3) < 0.5; p.ac = r(4) < 0.3; p.fence = r(5) < 0.4 ? 1 : r(5) < 0.7 ? 0 : 2;
                p.trim = r(36) < 0.5 ? 'pared' : pickOf(PAL.trims, id, 36);
            }
            p.gate = r(35) < 0.3;
            break;
        case 'C4':
            p.P = 4.8 * (0.95 + 0.1 * r(31)); p.H = p.P - 0.5; p.style = r(9) < 0.55 ? 'antigua_verde' : 'antigua_marron';
            p.wall = pickOf(PAL.c4Walls, id, 1); p.tank = r(3) < 0.45; p.ac = r(4) < 0.3; p.cornice = r(10) < 0.5 ? COL.cornice : null;
            p.trim = p.cornice ?? 'pared'; p.roofRoom = r(37) < 0.25;
            break;
        case 'C5':
            p.tile = A.boxy && r(11) < 0.35; p.wall = pickOf(PAL.c5Walls, id, 1);
            if (p.tile) {
                p.H = 5.9 * j; p.rise = 1.6 + 0.8 * r(39); p.P = p.H + p.rise; p.roofKind = 'teja'; p.eave = 0.35 + 0.35 * r(38);
            } else {
                p.H = 6.0 * j; p.P = p.H + 0.6; p.tank = r(3) < 0.8; p.trim = pickOf(PAL.trims, id, 36); p.roofRoom = r(37) < 0.3;
            }
            p.ac = r(4) < 0.6; p.fence = Math.floor(r(5) * 4); p.ironRail = r(12) < 0.5;
            p.garage = pickOf(['#e9eaea', '#a9afb5', '#6b4a2f', '#5a5f66', '#2f5d3a', '#3a3d42'], id, 49);
            break;
        case 'C6':
            p.H = 6.0 * j; p.pitched = r(13) < 0.6; p.roofKind = p.pitched ? 'teja' : 'plano';
            p.rise = 2.2; p.P = p.pitched ? p.H + p.rise : p.H + 0.6; p.ac = r(4) < 0.5;
            break;
        case 'L1':
            p.H = 3.5 * (0.95 + 0.1 * r(31)); p.P = p.H + 0.5; p.wall = pickOf(PAL.shopWalls, id, 1);
            p.sign = pickOf(PAL.signs, id, 20); p.tank = r(3) < 0.7; p.awning = r(21) < 0.4;
            break;
        case 'L2':
            p.floors = r(22) < 0.5 ? 1 : 2; p.H = (p.floors === 1 ? 3.6 : 6.8) * (0.96 + 0.08 * r(31)); p.P = p.H + 0.5;
            p.wall = pickOf(PAL.shopWalls, id, 1); p.sign = pickOf(PAL.signs, id, 20); p.awningCol = pickOf(PAL.awnings, id, 23);
            p.tank = r(3) < 0.6;
            break;
        case 'L3':
            p.floors = r(22) < 0.35 ? 0 : r(22) < 0.75 ? 1 : 2; p.g = 4.2; p.H = p.g + p.floors * 2.9; p.P = p.H + 0.6;
            p.wall = pickOf(PAL.centroWalls, id, 1); p.sign = pickOf(PAL.signs, id, 20); p.tank = r(3) < 0.6;
            p.marquee = r(24) < 0.5 ? COL.marquee : COL.marqueeDark;
            break;
        case 'E1': {
            p.floors = 3 + Math.floor(r(25) * 3); p.shopGround = r(26) < 0.5; p.g = p.shopGround ? 4.2 : 2.9;
            p.H = p.g + (p.floors - 1) * 2.9; p.P = p.H + 0.9; p.wall = pickOf(PAL.aptWalls, id, 1);
            p.balc = pickOf(['#f4f2ec', '#cfd2d4', '#33363b', '#e3d2b4'], id, 27);
            p.machine = 2.6;
            break;
        }
        case 'E2':
            p.floors = 10 + Math.floor(r(25) * 6); p.H = p.floors * 3; p.P = p.H + 1.0; p.wall = pickOf(PAL.towerWalls, id, 1);
            p.balc = pickOf([COL.balconyGlass, '#f4f2ec', '#9fb3c0'], id, 27); p.machine = 3.4;
            break;
        case 'H1':
            p.floors = 7 + Math.floor(r(25) * 5); p.g = 4.5; p.H = p.g + (p.floors - 1) * 3; p.P = p.H + 0.8;
            p.wall = pickOf(PAL.hotelWalls, id, 1); p.sign = pickOf(['#d8342c', '#2a5caa', '#ffffff', '#1f8fb3', '#f2c230'], id, 20);
            p.machine = 2.8;
            break;
        case 'S1':
            p.H = 6 + 2 * r(31); p.P = p.H + 0.4; p.wall = pickOf(PAL.superWalls, id, 1);
            p.sign = pickOf(['#d8342c', '#2a5caa', '#2f9a55', '#e8742a', '#c0262d', '#f2c230'], id, 20);
            break;
        default:
            p.H = 3; p.P = 3.5; p.wall = '#f1e2bf';
    }
    if (mold === 'C6') p.wall = pickOf(PAL.c6Walls, id, 1);
    p.top = Math.max(p.P, p.tank ? p.H + p.standH + 1.15 : 0, p.machine ? p.H + p.machine : 0, p.roofRoom ? p.H + ROOM_H : 0);
    if (mold === 'C3' && p.precaria && p.tank) p.top = Math.max(p.top, p.P + p.standH + 1.15);
    if (mold === 'H1') p.top = Math.max(p.top, p.P + 2.2);
    if (mold === 'S1') p.top = p.P + 0.5;
    if (mold === 'C4') p.top = Math.max(p.top, p.P + 0.12);
    return p;
}

const ROOM_H = 2.35; // lavadero / salida de escalera en la terraza

/** Los moldes que necesitan un rectángulo (techos inclinados, ochava, dúplex) se cambian si el polígono no lo es. */
function effectiveMold(mold, A) {
    if (A.boxy || !(mold === 'C2' || mold === 'C6' || mold === 'L2')) return mold;
    return mold === 'C6' ? 'C5' : mold === 'L2' ? 'L1' : 'C1';
}

/** Altura total en metros (encuadre, selección, carteles). */
export function moldHeight(b, mold) {
    const A = analyze(b);
    return params(b, effectiveMold(mold ?? chooseFrom(b, {}, A), A), A).top;
}

/** Color del techo cuando no tiene dueño: tejas, chapa o terraza gris clara. */
export function defaultRoofColor(b, mold) {
    const A = analyze(b);
    return roofHex(b.id | 0, params(b, effectiveMold(mold ?? chooseFrom(b, {}, A), A), A));
}

/**
 * Rasgos que definen cómo se ve un edificio (molde, colores, galería, tanque, cerco, portón, alero, alturas…).
 * Sirve para pruebas y para depurar: es lo mismo que usa addBuildingMold.
 */
export function moldTraits(b, ctx = {}) {
    const A = analyze(b);
    const mold = effectiveMold(ctx.mold ?? chooseFrom(b, ctx, A), A);
    const P = params(b, mold, A);
    return { ...P, roof: roofHex(b.id | 0, P), tankColor: P.tank ? pickOf(PAL.tanks, b.id | 0, 40) : null, height: P.top };
}

function roofHex(id, p) {
    if (p.roofKind === 'teja') return pickOf(PAL.tiles, id, 14);
    if (p.roofKind === 'chapa') return pickOf(p.precaria ? PAL.chapaVieja : PAL.chapa, id, 15);
    return pickOf(PAL.flat, id, 16);
}

// ------------------------------------------------------------------ primitivas

/**
 * Triángulo con normal plana. Escribe directo en los arreglos del MeshBuilder (mismo formato que MeshBuilder.tri,
 * pero sin crear arreglos intermedios: es lo que más tiempo lleva al armar 12.000 edificios). Si el constructor no
 * es el de arreglos comunes, usa su propio método.
 */
const UV0 = [0.02, 0.02];
function T(B, a, b, c, color, id, ua = UV0, ub = UV0, uc = UV0) {
    if (B.fast) { // constructor con arreglos tipados del worker (sin push ni basura): ver FastBuilder en city-build.worker.js
        B.addTri(a, b, c, color, id, ua, ub, uc);
        return;
    }
    if (!Array.isArray(B.pos)) {
        B.tri(a, b, c, color, id, ua === UV0 ? null : [ua, ub, uc]);
        return;
    }
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    B.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    B.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    B.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    B.col.push(color[0], color[1], color[2], color[0], color[1], color[2], color[0], color[1], color[2]);
    B.owner.push(id);
}
function Q(B, a, b, c, d, color, id, uvs = null) {
    if (uvs) {
        T(B, a, b, c, color, id, uvs[0], uvs[1], uvs[2]);
        T(B, a, c, d, color, id, uvs[0], uvs[2], uvs[3]);
    } else {
        T(B, a, b, c, color, id);
        T(B, a, c, d, color, id);
    }
}
/** Caja sin base alineada a u/v (u × v = +z), igual que MeshBuilder.box. */
function BOX(B, cx, cy, ux, uy, vx, vy, hu, hv, z0, z1, color, id, top = true) {
    const ax = ux * hu, ay = uy * hu, bx = vx * hv, by = vy * hv;
    const p0 = [cx - ax - bx, cy - ay - by], p1 = [cx + ax - bx, cy + ay - by], p2 = [cx + ax + bx, cy + ay + by], p3 = [cx - ax + bx, cy - ay + by];
    const r = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) {
        const p = r[i], q = r[(i + 1) % 4];
        Q(B, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], color, id);
    }
    if (top) Q(B, [p0[0], p0[1], z1], [p1[0], p1[1], z1], [p2[0], p2[1], z1], [p3[0], p3[1], z1], color, id);
}

/** Marco local: origen (cx, cy), F = hacia la calle, S = (F.y, −F.x) (S × F = +z). */
function frame(cx, cy, fx, fy) {
    return { cx, cy, Fx: fx, Fy: fy, Sx: fy, Sy: -fx };
}
const W = (fr, s, f, z) => [fr.cx + fr.Sx * s + fr.Fx * f, fr.cy + fr.Sy * s + fr.Fy * f, z];

/** Caja en el marco: s0..s1 × f0..f1 × z0..z1. */
function fbox(B, fr, s0, s1, f0, f1, z0, z1, color, id, top = true) {
    if (s1 - s0 < 1e-3 || f1 - f0 < 1e-3 || z1 - z0 < 1e-3) return;
    const s = (s0 + s1) / 2, f = (f0 + f1) / 2;
    BOX(B, fr.cx + fr.Sx * s + fr.Fx * f, fr.cy + fr.Sy * s + fr.Fy * f, fr.Sx, fr.Sy, fr.Fx, fr.Fy, (s1 - s0) / 2, (f1 - f0) / 2, z0, z1, color, id, top);
}

/** Rectángulo vertical que mira hacia +F, en el plano f. */
function fquad(B, fr, s0, s1, f, z0, z1, color, id) {
    if (s1 - s0 < 1e-3 || z1 - z0 < 1e-3) return;
    Q(B, W(fr, s1, f, z0), W(fr, s0, f, z0), W(fr, s0, f, z1), W(fr, s1, f, z1), color, id);
}

/** Cara plana (3 o 4 puntos) con la normal apuntando lejos de (cx, cy, cz). */
function faceOut(B, pts, color, id, cx, cy, cz) {
    const a = pts[0], b = pts[1], c = pts[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    let mx = 0, my = 0, mz = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; mz += p[2]; }
    const k = pts.length;
    const flip = nx * (mx / k - cx) + ny * (my / k - cy) + nz * (mz / k - cz) < 0;
    if (k === 3) {
        if (flip) T(B, a, c, b, color, id); else T(B, a, b, c, color, id);
    } else if (flip) {
        Q(B, a, pts[3], c, b, color, id);
    } else {
        Q(B, a, b, c, pts[3], color, id);
    }
}
const up = (B, pts, color, id) => faceOut(B, pts, color, id, pts[0][0], pts[0][1], -1e4);

/** Pared con textura: uv en metros / tamaño del lienzo; arriba puede ser inclinada (zp en p, zq en q). */
function texWall(B, p, q, z0, zp, zq, color, id, style, uOff, vBase) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (zp - z0 < 1e-3 && zq - z0 < 1e-3) return len;
    const [cw, ch] = FACADE_CELLS[style];
    const u0 = uOff / cw, u1 = (uOff + len) / cw;
    const v0 = (z0 - vBase) / ch;
    Q(B, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], zq], [p[0], p[1], zp], color, id,
        [[u0, v0], [u1, v0], [u1, (zq - vBase) / ch], [u0, (zp - vBase) / ch]]);
    return len;
}

/** Prisma de n lados (tanque redondeado). */
function prism(B, cx, cy, r, n, z0, z1, color, id, rot) {
    const pts = [];
    for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    for (let k = 0; k < n; k++) {
        const p = pts[k], q = pts[(k + 1) % n];
        Q(B, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], color, id);
    }
    const top = shade(color, 1.12);
    for (let k = 1; k + 1 < n; k++) {
        T(B, [pts[0][0], pts[0][1], z1], [pts[k][0], pts[k][1], z1], [pts[k + 1][0], pts[k + 1][1], z1], top, id);
    }
}

function insideRing(R, x, y) {
    let inside = false;
    for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
        const [xi, yi] = R[i], [xj, yj] = R[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Techo plano (sirve para polígonos cóncavos). */
function flatRoof(B, R, z, color, id, zAt = null) {
    const Z = (p) => (zAt ? zAt(p) : z);
    if (R.length === 3) {
        up(B, [[R[0][0], R[0][1], Z(R[0])], [R[1][0], R[1][1], Z(R[1])], [R[2][0], R[2][1], Z(R[2])]], color, id);
        return;
    }
    let tris;
    if (R.length === 4 && isConvex(R)) {
        tris = [[0, 1, 2], [0, 2, 3]];
    } else {
        tris = ShapeUtils.triangulateShape(R.map(([x, y]) => new Vector2(x, y)), []);
    }
    for (const [a, b2, c] of tris) {
        up(B, [[R[a][0], R[a][1], Z(R[a])], [R[b2][0], R[b2][1], Z(R[b2])], [R[c][0], R[c][1], Z(R[c])]], color, id);
    }
}

function isConvex(R) {
    for (let i = 0; i < R.length; i++) {
        const a = R[i], b = R[(i + 1) % R.length], c = R[(i + 2) % R.length];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 0) return false;
    }
    return true;
}

/** Cara interior del pretil (mira hacia adentro), de zr (techo) a z1. */
function parapetInner(B, R, zr, z1, color, id) {
    for (let i = 0; i < R.length; i++) {
        const p = R[i], q = R[(i + 1) % R.length];
        Q(B, [q[0], q[1], zr], [p[0], p[1], zr], [p[0], p[1], z1], [q[0], q[1], z1], color, id);
    }
}

/** Pared más parecida al frente (la que mira a la calle); sin calle, la más larga. */
function frontEdge(R, front) {
    let best = 0, bs = -Infinity;
    for (let i = 0; i < R.length; i++) {
        const p = R[i], q = R[(i + 1) % R.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 1e-6) continue;
        const nx = (q[1] - p[1]) / len, ny = -(q[0] - p[0]) / len;
        const sc = front ? (nx * front.dirX + ny * front.dirY) * Math.min(len, 8) + len * 0.01 : len;
        if (sc > bs) { bs = sc; best = i; }
    }
    return best;
}

/** Marco del frente: origen en el medio de la pared de frente, F hacia afuera; la pared va de s = +L/2 a −L/2. */
function edgeFrame(R, i) {
    const p = R[i], q = R[(i + 1) % R.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const dx = (q[0] - p[0]) / L, dy = (q[1] - p[1]) / L;
    const fr = frame((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, dy, -dx);
    fr.L = L;
    // profundidad del edificio detrás del frente
    let depth = 0;
    for (const [x, y] of R) depth = Math.max(depth, -((x - fr.cx) * fr.Fx + (y - fr.cy) * fr.Fy));
    fr.depth = depth;
    return fr;
}

/** Rectángulo orientado con el frente hacia la calle. */
function boxFrame(A, front, longFront = false) {
    const { cx, cy, u, v, halfLong: hl, halfShort: hs } = A.box;
    const c = [[v[0], v[1], hs, hl], [-v[0], -v[1], hs, hl]];
    if (!longFront) c.push([u[0], u[1], hl, hs], [-u[0], -u[1], hl, hs]);
    let best = c[0];
    if (front) {
        let bd = -Infinity;
        for (const k of c) {
            const d = k[0] * front.dirX + k[1] * front.dirY;
            if (d > bd + 1e-9) { bd = d; best = k; }
        }
    }
    const fr = frame(cx, cy, best[0], best[1]);
    fr.hd = best[2];
    fr.hw = best[3];
    return fr;
}
const rectRing = (fr, s0, s1, f0, f1) => [W(fr, s0, f0, 0), W(fr, s1, f0, 0), W(fr, s1, f1, 0), W(fr, s0, f1, 0)].map((p) => [p[0], p[1]]);

/** Lugares (en metros desde el comienzo de la pared de frente) donde termina una ventana y empieza la otra. */
function cellBoundaries(L, unit) {
    const r = (L % unit) / 2;
    const out = [];
    for (let t = r; t <= L + 1e-6; t += unit) out.push(t);
    return out;
}

/** Paredes de un anillo, empezando por el frente (las ventanas quedan centradas en el frente). */
function ringWalls(K, R, fi, segs) {
    const n = R.length;
    let off = 0;
    for (let k = 0; k < n; k++) {
        const i = (fi + k) % n;
        const p = R[i], q = R[(i + 1) % n];
        const list = segs(i, k === 0);
        if (k === 0) {
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const st = list.find((s) => s[0])?.[0] ?? 'casa';
            off = -(len % FACADE_INFO[st].unit) / 2;
        }
        let len = 0;
        for (const [style, z0, z1, vBase, color] of list) {
            if (style) {
                len = texWall(K.walls[style], p, q, z0, z1, z1, color, K.id, style, off, vBase);
            } else {
                len = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (z1 > z0) Q(K.plain, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], color, K.id);
            }
        }
        off += len;
    }
}

// ------------------------------------------------------------------ detalles que se repiten

function tank(K, fr, s, f, z, P) {
    const id = K.id;
    const c = rgb(pickOf(PAL.tanks, id, 40));
    const r = 0.58;
    if (P.standH > 0.8) {
        // torre de caños: patas (caja angosta oscura) y plataforma
        fbox(K.plain, fr, s - 0.35, s + 0.35, f - 0.35, f + 0.35, z, z + P.standH - 0.1, rgb(COL.reja), id);
        fbox(K.plain, fr, s - 0.6, s + 0.6, f - 0.6, f + 0.6, z + P.standH - 0.1, z + P.standH, rgb(COL.stand), id);
    } else {
        fbox(K.plain, fr, s - 0.5, s + 0.5, f - 0.5, f + 0.5, z, z + P.standH, rgb(COL.concrete), id);
    }
    const w = W(fr, s, f, 0);
    if (K.detail) prism(K.plain, w[0], w[1], r, 6, z + P.standH, z + P.standH + 1.1, c, id, hash01(id, 41));
    else fbox(K.plain, fr, s - r, s + r, f - r, f + r, z + P.standH, z + P.standH + 1.1, c, id);
}

/** Tanque sobre el techo, atrás; solo si cae adentro del polígono. */
function roofTank(K, R, fr, z, P, side) {
    const L = fr.L ?? fr.hw * 2;
    const s = clamp(side * (L / 2 - 1.3), -L / 2 + 0.9, L / 2 - 0.9);
    const f = -clamp(fr.depth * 0.62, 1.2, Math.max(1.2, fr.depth - 1.0));
    if (L < 2.4 || fr.depth < 2.6) return;
    const w = W(fr, s, f, 0);
    if (!insideRing(R, w[0], w[1])) return;
    tank(K, fr, s, f, z, P);
}

/** Aire acondicionado split sobre el frente. */
function acUnit(K, fr, s, z) {
    fbox(K.plain, fr, s - 0.42, s + 0.42, 0, 0.28, z, z + 0.32, rgb(COL.ac), K.id);
}

function door(K, fr, s, w, h, color) {
    fquad(K.plain, fr, s - w / 2, s + w / 2, 0.03, 0, h, color, K.id);
}

/** Baranda o reja: pasamanos arriba y barrotes (caras hacia la calle), barato y se lee como reja. */
function railing(B, fr, s0, s1, f, z0, z1, color, id, step) {
    fbox(B, fr, s0, s1, f - 0.06, f, z1 - 0.07, z1, color, id);
    const n = clamp(Math.round((s1 - s0) / step), 2, 14);
    for (let k = 0; k <= n; k++) {
        const s = s0 + 0.04 + ((s1 - s0 - 0.08) * k) / n;
        fquad(B, fr, s - 0.035, s + 0.035, f, z0, z1 - 0.07, color, id);
    }
}

/**
 * Metros libres entre la pared de frente (marco `fr`) y la línea municipal. `ctx.front.dist` se mide desde el centro
 * del polígono hasta el eje de la calle; `ctx.front.edge` (opcional) = eje → línea municipal (media calzada + vereda,
 * 7 m si no viene).
 */
function frontRoom(K, fr, ctx) {
    if (!ctx?.front || !(ctx.front.dist > 0)) return 0;
    const toFront = (fr.cx - K.A.box.cx) * ctx.front.dirX + (fr.cy - K.A.box.cy) * ctx.front.dirY;
    return ctx.front.dist - toFront - (ctx.front.edge ?? 7.0);
}

/**
 * Jardín, cerco y portón delante del frente, si hay lugar hasta la vereda.
 * type: 0 reja sobre muro bajo, 1 muro, 2 nada, 3 reja alta, 4 alambrado. Con `gate` queda un portón de chapa
 * (o solo la entrada de auto de cemento si no hay cerco) en un costado.
 */
function fenceAndGarden(K, fr, ctx, hw, type, wallColor, gate = false) {
    if (!K.detail || (type === 2 && !gate)) return;
    const room = frontRoom(K, fr, ctx);
    if (room < 1.8) return;
    const f = Math.min(room - 0.3, 4.5);
    const id = K.id;
    let a = -hw, b = hw; // tramo con cerco
    if (gate && hw > 2.6) {
        const gw = Math.min(2.8, hw * 0.6);
        const left = hash01(id, 70) < 0.5;
        const g0 = left ? -hw : hw - gw, g1 = g0 + gw;
        up(K.plain, [W(fr, g0, 0, 0.04), W(fr, g1, 0, 0.04), W(fr, g1, f, 0.04), W(fr, g0, f, 0.04)], rgb(COL.concrete), id);
        if (type !== 2) {
            const gc = rgb(pickOf(PAL.gates, id, 71));
            const gh = type === 4 ? 1.4 : 1.6 + 0.4 * hash01(id, 72);
            fbox(K.plain, fr, g0 + 0.05, g1 - 0.05, f - 0.08, f, 0, gh, gc, id);
            fbox(K.plain, fr, (left ? g1 : g0) - 0.15, (left ? g1 : g0) + 0.15, f - 0.3, f, 0, gh + 0.15, wallColor, id); // pilar
        }
        if (left) a = g1 + 0.15; else b = g0 - 0.15;
    }
    up(K.plain, [W(fr, a, 0, 0.02), W(fr, b, 0, 0.02), W(fr, b, f, 0.02), W(fr, a, f, 0.02)], rgb(pickOf(PAL.gardens, id, 42)), id);
    if (type === 0) {
        fbox(K.plain, fr, a, b, f - 0.15, f, 0, 0.5, wallColor, id);
        railing(K.plain, fr, a, b, f - 0.05, 0.5, 1.5, rgb(COL.reja), id, 0.8);
    } else if (type === 1) {
        fbox(K.plain, fr, a, b, f - 0.15, f, 0, 1.5 + 0.4 * hash01(id, 73), wallColor, id);
    } else if (type === 3) {
        railing(K.plain, fr, a, b, f - 0.05, 0, 1.9, rgb(COL.reja), id, 0.6);
    } else if (type === 4) {
        fquad(K.plain, fr, a, b, f, 0.05, 1.2, rgb('#8d9196'), id); // alambrado (se ve como una malla gris)
    }
}

/** Remate del pretil: franja de 18 cm sobre el borde (desde arriba dibuja el contorno de la casa). */
function parapetCap(B, R, z, color, id) {
    const n = R.length;
    for (let i = 0; i < (n === 2 ? 1 : n); i++) {
        const p = R[i], q = R[(i + 1) % n];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.4) continue;
        const nx = (-(q[1] - p[1]) / len) * 0.18, ny = ((q[0] - p[0]) / len) * 0.18; // hacia adentro (anillo antihorario)
        Q(B, [p[0], p[1], z], [q[0], q[1], z], [q[0] + nx, q[1] + ny, z], [p[0] + nx, p[1] + ny, z], color, id);
    }
}

/** Lavadero o salida de escalera en la terraza (caja con puerta), adelante o atrás según el id. */
function roofRoom(K, R, fr, z, wall) {
    const L = fr.L, dep = fr.depth;
    if (L < 5 || dep < 7) return;
    const side = hash01(K.id, 46) < 0.5 ? 1 : -1; // del lado contrario al tanque
    const w = Math.min(2.6, L * 0.35), d = Math.min(2.4, dep * 0.3);
    const s = side * (L / 2 - w / 2 - 0.3), f = -dep * (0.35 + 0.2 * hash01(K.id, 75));
    const c = W(fr, s, f, 0);
    if (!insideRing(R, c[0], c[1])) return;
    fbox(K.plain, fr, s - w / 2, s + w / 2, f - d / 2, f + d / 2, z, z + ROOM_H - 0.12, wall, K.id, false);
    fbox(K.plain, fr, s - w / 2 - 0.1, s + w / 2 + 0.1, f - d / 2 - 0.1, f + d / 2 + 0.1, z + ROOM_H - 0.12, z + ROOM_H, shade(wall, 1.08), K.id);
    fquad(K.plain, fr, s - 0.4, s + 0.4, f + d / 2 + 0.02, z, z + 2.0, rgb(pickOf(PAL.doors, K.id, 76)), K.id);
}

const trimColor = (P, wall) => (P.trim && P.trim !== 'pared' ? rgb(P.trim) : shade(wall, 0.88));

// ------------------------------------------------------------------ techos inclinados

/**
 * Techo a dos aguas o a cuatro aguas sobre un rectángulo (a: eje de la cumbrera, b: transversal).
 * toW(a, b, z) pasa a coordenadas del mundo. Devuelve las caras del techo para emitirlas juntas (rango recoloreable).
 */
function pitchedFaces(toW, ha, hb, H, rise, o, hip) {
    const k = rise / hb;
    const R = H + rise, ze = H - o * k;
    const e1 = toW(-ha - o, -hb - o, ze), e2 = toW(ha + o, -hb - o, ze), e3 = toW(ha + o, hb + o, ze), e4 = toW(-ha - o, hb + o, ze);
    if (hip) {
        const ra = Math.max(0, ha - hb);
        const r1 = toW(-ra, 0, R), r2 = toW(ra, 0, R);
        const faces = [[e1, e2, r2, r1], [e3, e4, r1, r2], [e2, e3, r2], [e4, e1, r1]];
        if (ra < 1e-3) faces.splice(0, 2, [e1, e2, r2], [e3, e4, r1]);
        return { faces, gables: [] };
    }
    const r1 = toW(-ha - o, 0, R), r2 = toW(ha + o, 0, R);
    return {
        faces: [[e1, e2, r2, r1], [e3, e4, r1, r2]],
        gables: [[toW(ha, -hb, H), toW(ha, hb, H), toW(ha, 0, R)], [toW(-ha, hb, H), toW(-ha, -hb, H), toW(-ha, 0, R)]],
    };
}

function emitRoof(K, faces, color, cx, cy, cz) {
    const start = K.plain.vertexCount;
    for (const f of faces) faceOut(K.plain, f, color, K.id, cx, cy, cz);
    return { start, count: K.plain.vertexCount - start };
}

// ------------------------------------------------------------------ casas

function flatHouseBody(K, R, fi, style, P, wall) {
    ringWalls(K, R, fi, () => [[style, 0, P.P, 0, wall]]);
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), K.id);
    if (K.detail) parapetCap(K.plain, R, P.P, trimColor(P, wall), K.id);
}

function buildC1(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const bf = A.boxy ? boxFrame(A, ctx.front) : null;
    let R, fi, galDepth = 0;
    if (bf && P.gallery && bf.hd * 2 >= 7.5 && bf.hw * 2 >= 4) {
        galDepth = 2.2 + 0.5 * hash01(id, 43);
        R = rectRing(bf, -bf.hw, bf.hw, -bf.hd, bf.hd - galDepth);
        fi = 2;
    } else {
        R = A.R;
        fi = frontEdge(R, ctx.front);
    }
    const fr = edgeFrame(R, fi);
    flatHouseBody(K, R, fi, 'casa', P, wall);
    const L = fr.L;
    const cuts = cellBoundaries(L, 2.6);
    const t = cuts[Math.min(cuts.length - 1, Math.floor(cuts.length * (0.25 + 0.5 * hash01(id, 44))))] ?? L / 2;
    const ds = clamp(L / 2 - t, -L / 2 + 0.5, L / 2 - 0.5);
    const room = galDepth > 0 ? frontRoom(K, fr, ctx) - galDepth : frontRoom(K, fr, ctx);
    // sin jardín adelante, el portón del garaje va en la fachada misma
    const garageOnFacade = P.gate && room < 1.8 && galDepth === 0 && L >= 6.5;
    if (garageOnFacade) {
        const gs = ds > 0 ? -L / 2 + 0.3 : L / 2 - 2.8;
        fquad(K.plain, fr, gs, gs + 2.5, 0.03, 0, 2.2, rgb(pickOf(PAL.gates, id, 71)), id);
    }
    door(K, fr, ds, 0.9, 2.1, rgb(pickOf(PAL.doors, id, 45)));
    if (K.detail && P.ac && L > 4) acUnit(K, fr, ds > 0 ? ds - 1.4 : ds + 1.4, 2.25);
    if (P.tank) roofTank(K, R, fr, P.H, P, hash01(id, 46) < 0.5 ? -1 : 1);
    if (P.roofRoom && K.detail) roofRoom(K, R, fr, P.H, wall);
    if (galDepth > 0) {
        // galería: piso de cerámica roja, columnas y techo propio (losa con pretil bajo o tejas a un agua)
        const g = frame(fr.cx, fr.cy, fr.Fx, fr.Fy);
        const hw = bf.hw;
        if (P.galRoof === 'teja') {
            up(K.plain, [W(g, -hw - 0.2, 0, 3.0), W(g, hw + 0.2, 0, 3.0), W(g, hw + 0.2, galDepth + 0.4, 2.45), W(g, -hw - 0.2, galDepth + 0.4, 2.45)], shade(rgb(pickOf(PAL.tiles, id, 14)), 0.95), id);
            fbox(K.plain, g, -hw, hw, galDepth - 0.3, galDepth - 0.05, 2.3, 2.5, shade(wall, 1.05), id); // viga
        } else {
            fbox(K.plain, g, -hw, hw, 0, galDepth + 0.1, 2.65, 3.05, shade(wall, 1.06), id);
        }
        if (K.detail) {
            up(K.plain, [W(g, -hw, 0, 0.06), W(g, hw, 0, 0.06), W(g, hw, galDepth, 0.06), W(g, -hw, galDepth, 0.06)], rgb(COL.galleryFloor), id);
            const n = hw * 2 < 7 ? 2 : P.galCols;
            const col = rgb(hash01(id, 77) < 0.7 ? COL.column : pickOf(['#b5654a', '#d2cdc2', '#5a5f66'], id, 78));
            for (let k = 0; k < n; k++) {
                const s = -hw + 0.2 + ((hw * 2 - 0.4) * k) / (n - 1);
                fbox(K.plain, g, s - 0.12, s + 0.12, galDepth - 0.3, galDepth - 0.06, 0, 2.65, col, id, false);
            }
        }
        const lot = frame(fr.cx + fr.Fx * galDepth, fr.cy + fr.Fy * galDepth, fr.Fx, fr.Fy);
        fenceAndGarden(K, lot, ctx, hw, P.fence, wall, P.gate);
    } else {
        if (K.detail && L > 3) fbox(K.plain, fr, ds - 0.8, ds + 0.8, 0, 0.8, 2.3, 2.42, shade(wall, 0.95), id); // alerito sobre la puerta
        fenceAndGarden(K, fr, ctx, L / 2, P.fence, wall, P.gate && !garageOnFacade);
    }
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildC2(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const bf = boxFrame(A, ctx.front);
    const hw = Math.max(1.5, bf.hw), hd = Math.max(1.5, bf.hd);
    const gal = P.gallery && hd * 2 >= 8.5 ? 2.4 : 0;
    const f0 = -hd, f1 = hd - gal;
    const R = rectRing(bf, -hw, hw, f0, f1);
    ringWalls(K, R, 2, () => [['casa', 0, P.H, 0, wall]]);
    const fr = edgeFrame(R, 2);
    const cuts = cellBoundaries(fr.L, 2.6);
    const t = cuts[Math.floor(cuts.length * (0.3 + 0.4 * hash01(id, 44)))] ?? fr.L / 2;
    const ds = clamp(fr.L / 2 - t, -fr.L / 2 + 0.5, fr.L / 2 - 0.5);
    door(K, fr, ds, 0.9, 2.1, rgb(pickOf(PAL.doors, id, 45)));
    if (K.detail && P.ac && fr.L > 4) acUnit(K, fr, ds > 0 ? ds - 1.4 : ds + 1.4, 2.1);
    // techo
    const fc = (f0 + f1) / 2, hdb = (f1 - f0) / 2;
    const o = P.eave;
    let pf;
    let alongS = P.roofType === 0 || (P.roofType === 2 && hw >= hdb);
    if (P.roofType === 1) alongS = false;
    const hip = P.roofType === 2;
    if (alongS) {
        const rise = Math.min(P.rise, hdb * 0.85);
        pf = pitchedFaces((a, b, z) => W(bf, a, fc + b, z), hw, hdb, P.H, rise, o, hip);
    } else {
        const rise = Math.min(P.rise, hw * 0.85);
        pf = pitchedFaces((a, b, z) => W(bf, b, fc + a, z), hdb, hw, P.H, rise, o, hip);
    }
    const cz = P.H * 0.5;
    for (const g of pf.gables) faceOut(K.plain, g, wall, id, bf.cx + bf.Fx * fc, bf.cy + bf.Fy * fc, cz);
    if (P.chimney && K.detail) {
        const s = hw * 0.45 * (hash01(id, 47) < 0.5 ? -1 : 1), f = fc - hdb * 0.4;
        fbox(K.plain, bf, s - 0.28, s + 0.28, f - 0.28, f + 0.28, P.H, P.H + P.rise + 0.45, rgb(COL.chimney), id);
    }
    if (gal > 0) {
        // galería con techito de tejas a un agua y columnas
        const g = frame(fr.cx, fr.cy, fr.Fx, fr.Fy);
        const tc = shade(roof, 0.92);
        const zA = P.H - 0.25, zB = 2.45;
        up(K.plain, [W(g, -hw - 0.3, 0, zA), W(g, hw + 0.3, 0, zA), W(g, hw + 0.3, gal + 0.35, zB), W(g, -hw - 0.3, gal + 0.35, zB)], tc, id);
        if (K.detail) {
            up(K.plain, [W(g, -hw, 0, 0.06), W(g, hw, 0, 0.06), W(g, hw, gal, 0.06), W(g, -hw, gal, 0.06)], rgb(COL.galleryFloor), id);
            const n = hw * 2 > 8 ? 3 : 2;
            for (let k = 0; k < n; k++) {
                const s = -hw + 0.25 + ((hw * 2 - 0.5) * k) / (n - 1);
                fbox(K.plain, g, s - 0.13, s + 0.13, gal - 0.3, gal - 0.04, 0, 2.5, rgb(COL.column), id, false);
            }
        }
        fenceAndGarden(K, frame(fr.cx + fr.Fx * gal, fr.cy + fr.Fy * gal, fr.Fx, fr.Fy), ctx, hw, P.fence, wall, P.gate);
    } else {
        fenceAndGarden(K, fr, ctx, hw, P.fence, wall, P.gate);
    }
    return emitRoof(K, pf.faces, roof, bf.cx + bf.Fx * fc, bf.cy + bf.Fy * fc, cz);
}

function buildC3(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    // chapa a un agua que cae hacia el fondo; en la común queda escondida tras un pretil recto, en la casilla
    // precaria se ve desde la calle (la pared sigue la pendiente y no hay pretil)
    const Zf = P.precaria ? P.P : P.H;
    const slope = P.precaria ? Math.min(0.1, 0.5 / Math.max(1, fr.depth)) : Math.min(0.14, (Zf - 2.55) / Math.max(1, fr.depth));
    const zr = (p) => Zf - slope * Math.max(0, -((p[0] - fr.cx) * fr.Fx + (p[1] - fr.cy) * fr.Fy));
    const n = R.length;
    let off = -(fr.L % FACADE_INFO.chapa.unit) / 2;
    const band = rgb(COL.block);
    for (let k = 0; k < n; k++) {
        const i = (fi + k) % n;
        const p = R[i], q = R[(i + 1) % n];
        let len;
        if (k === 0 && !P.precaria) {
            const zb = P.unfinished ? 3.0 : P.P;
            len = texWall(K.walls.chapa, p, q, 0, zb, zb, wall, id, 'chapa', off, 0);
            if (P.unfinished) Q(K.plain, [p[0], p[1], zb], [q[0], q[1], zb], [q[0], q[1], P.P], [p[0], p[1], P.P], band, id);
            // cara interior del pretil y remate
            Q(K.plain, [q[0], q[1], zr(q)], [p[0], p[1], zr(p)], [p[0], p[1], P.P], [q[0], q[1], P.P], shade(wall, 0.8), id);
            if (K.detail) parapetCap(K.plain, [p, q], P.P, trimColor(P, wall), id);
        } else {
            len = texWall(K.walls.chapa, p, q, 0, zr(p), zr(q), wall, id, 'chapa', off, 0);
        }
        off += len;
    }
    const cuts = cellBoundaries(fr.L, 2.8);
    const t = cuts[Math.floor(cuts.length * (0.2 + 0.6 * hash01(id, 44)))] ?? fr.L / 2;
    const ds = clamp(fr.L / 2 - t, -fr.L / 2 + 0.5, fr.L / 2 - 0.5);
    door(K, fr, ds, 0.85, 2.05, rgb(pickOf(['#5a5f66', '#3d5a73', '#6b4a2f', '#8a8f94', '#7a3b2a'], id, 45)));
    if (K.detail && P.ac && fr.L > 4) acUnit(K, fr, ds > 0 ? ds - 1.3 : ds + 1.3, 2.1);
    if (P.tank) {
        const L = fr.L, s = clamp((hash01(id, 46) < 0.5 ? -1 : 1) * (L / 2 - 1.2), -L / 2 + 0.9, L / 2 - 0.9);
        const f = -clamp(fr.depth * 0.7, 1.2, Math.max(1.2, fr.depth - 1));
        const w = W(fr, s, f, 0);
        if (L >= 2.4 && fr.depth >= 2.6 && insideRing(R, w[0], w[1])) tank(K, fr, s, f, zr([w[0], w[1]]), P);
    }
    fenceAndGarden(K, fr, ctx, fr.L / 2, P.fence, wall, P.gate);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, 0, roof, id, zr);
    if (P.precaria) {
        // alero de chapa sobre el frente (parte del techo: se pinta con el color del dueño)
        const ext = 0.45, ze = Zf - 0.06;
        const p = R[fi], q = R[(fi + 1) % n];
        up(K.plain, [[p[0], p[1], Zf], [q[0], q[1], Zf], [q[0] + fr.Fx * ext, q[1] + fr.Fy * ext, ze], [p[0] + fr.Fx * ext, p[1] + fr.Fy * ext, ze]], roof, id);
    }
    return { start, count: K.plain.vertexCount - start };
}

function buildC4(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    flatHouseBody(K, R, fi, P.style, P, wall);
    // cornisa y moldura sobre la vereda
    const cc = P.cornice ? rgb(P.cornice) : shade(wall, 1.12);
    const L = fr.L;
    fbox(K.plain, fr, -L / 2, L / 2, 0, 0.28, P.P - 1.0, P.P - 0.75, cc, id);
    if (K.detail) fbox(K.plain, fr, -L / 2, L / 2, 0, 0.14, P.P - 0.02, P.P + 0.12, cc, id);
    // puertón alto de madera entre dos ventanas
    const cuts = cellBoundaries(L, 2.6);
    const t = cuts[Math.floor(cuts.length * (0.3 + 0.4 * hash01(id, 44)))] ?? L / 2;
    const ds = clamp(L / 2 - t, -L / 2 + 0.7, L / 2 - 0.7);
    const dc = rgb(P.style === 'antigua_verde' ? pickOf(['#2f5d3a', '#3e6b45'], id, 45) : pickOf(['#5a3a24', '#6b4a2f'], id, 45));
    door(K, fr, ds, 1.25, 3.0, dc);
    if (K.detail) fquad(K.plain, fr, ds - 0.75, ds + 0.75, 0.025, 3.0, 3.25, shade(wall, 0.75), id); // dintel
    if (K.detail && P.ac && L > 5) acUnit(K, fr, ds > 0 ? ds - 1.3 : ds + 1.3, 3.5);
    if (P.tank) roofTank(K, R, fr, P.H, P, hash01(id, 46) < 0.5 ? -1 : 1);
    if (P.roofRoom && K.detail) roofRoom(K, R, fr, P.H, wall);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildC5(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    let R, fi, bf = null;
    if (P.tile) {
        bf = boxFrame(A, ctx.front);
        R = rectRing(bf, -bf.hw, bf.hw, -bf.hd, bf.hd);
        fi = 2;
        ringWalls(K, R, fi, () => [['casa', 0, P.H, 0, wall]]);
    } else {
        R = A.R;
        fi = frontEdge(R, ctx.front);
        flatHouseBody(K, R, fi, 'casa', P, wall);
    }
    const fr = edgeFrame(R, fi);
    const L = fr.L;
    // portón del garaje en una columna de ventanas, balcón arriba
    const cuts = cellBoundaries(L, 2.6);
    const okCells = cuts.filter((t) => t >= 0.15 && t + 2.6 <= L - 0.15);
    if (okCells.length) {
        const t = okCells[Math.floor(hash01(id, 48) * okCells.length)];
        const s0 = L / 2 - t - 2.6, s1 = L / 2 - t;
        fquad(K.plain, fr, s0 + 0.15, s1 - 0.15, 0.03, 0, 2.3, rgb(P.garage), id);
        fbox(K.plain, fr, s0, s1, 0, 1.1, 3.05, 3.25, shade(wall, 0.95), id);
        if (K.detail) {
            if (P.ironRail) railing(K.plain, fr, s0, s1, 1.1, 3.25, 4.2, rgb(COL.reja), id, 0.45);
            else fbox(K.plain, fr, s0, s1, 1.0, 1.1, 3.25, 4.15, shade(wall, 1.05), id);
            if (P.ac) acUnit(K, fr, s1 + 0.6 < L / 2 ? s1 + 0.6 : s0 - 0.6, 5.2);
        }
        const other = cuts.filter((c) => c < t - 0.6 || c > t + 3.2).filter((c) => c > 0.5 && c < L - 0.5);
        if (other.length) door(K, fr, L / 2 - other[0], 0.9, 2.1, rgb(pickOf(PAL.doors, id, 45)));
    } else {
        door(K, fr, 0, 0.9, 2.1, rgb(pickOf(PAL.doors, id, 45)));
    }
    fenceAndGarden(K, fr, ctx, L / 2, P.fence, wall);
    if (P.tile) {
        const hip = hash01(id, 6) < 0.6;
        const alongS = bf.hw >= bf.hd;
        const pf = alongS
            ? pitchedFaces((a, b, z) => W(bf, a, b, z), bf.hw, bf.hd, P.H, Math.min(P.rise, bf.hd * 0.8), P.eave, hip)
            : pitchedFaces((a, b, z) => W(bf, b, a, z), bf.hd, bf.hw, P.H, Math.min(P.rise, bf.hw * 0.8), P.eave, hip);
        for (const g of pf.gables) faceOut(K.plain, g, wall, id, bf.cx, bf.cy, P.H * 0.5);
        return emitRoof(K, pf.faces, roof, bf.cx, bf.cy, P.H * 0.5);
    }
    if (P.tank) roofTank(K, R, fr, P.H, P, hash01(id, 46) < 0.5 ? -1 : 1);
    if (P.roofRoom && K.detail) roofRoom(K, R, fr, P.H, wall);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildC6(K, A, P, ctx) {
    const { id } = K;
    const roof = K.roof;
    const bf = boxFrame(A, ctx.front, true);
    const hw = bf.hw, hd = bf.hd;
    const n = hw * 2 >= 15 ? 3 : 2;
    const w = (hw * 2) / n;
    const pal = PAL.c6Walls;
    let ci = Math.floor(hash01(id, 1) * pal.length);
    const colors = [];
    for (let k = 0; k < n; k++) {
        colors.push(rgb(pal[ci % pal.length]));
        ci += 1 + Math.floor(hash01(id, 60 + k) * (pal.length - 2)); // nunca dos iguales al lado
    }
    const H = P.H, PP = P.P;
    const wallTop = P.pitched ? H : PP;
    const faces = [];
    const dc = rgb(pickOf(PAL.doors, id, 45));
    const canopy = rgb(pickOf(['#f4f2ec', '#5a5f66', '#b5462f'], id, 62));
    for (let k = 0; k < n; k++) {
        const s0 = -hw + k * w, s1 = s0 + w, c = colors[k];
        const st = K.walls.casa;
        texWall(st, W(bf, s1, hd, 0), W(bf, s0, hd, 0), 0, wallTop, wallTop, c, id, 'casa', k * w - (w % 2.6) / 2, 0);
        texWall(st, W(bf, s0, -hd, 0), W(bf, s1, -hd, 0), 0, wallTop, wallTop, c, id, 'casa', k * w, 0);
        if (k === n - 1) texWall(st, W(bf, hw, -hd, 0), W(bf, hw, hd, 0), 0, wallTop, wallTop, c, id, 'casa', 0, 0);
        if (k === 0) texWall(st, W(bf, -hw, hd, 0), W(bf, -hw, -hd, 0), 0, wallTop, wallTop, c, id, 'casa', 0, 0);
        const sc = (s0 + s1) / 2;
        // puerta en un costado de la unidad, con techito
        const sd = s0 + 0.75 + (hash01(id, 63) < 0.5 ? 0 : Math.max(0, w - 1.5));
        fquad(K.plain, bf, sd - 0.45, sd + 0.45, hd + 0.03, 0, 2.1, dc, id);
        if (K.detail) {
            fbox(K.plain, bf, sd - 0.7, sd + 0.7, hd, hd + 0.9, 2.3, 2.45, canopy, id);
            if (P.ac && hash01(id, 64 + k) < 0.6) fbox(K.plain, bf, sc - 0.4, sc + 0.44, hd, hd + 0.28, 4.6, 4.92, rgb(COL.ac), id);
        }
        if (P.pitched) {
            const rise = Math.min(P.rise, (w / 2) * 0.85);
            const pf = pitchedFaces((a, b, z) => W(bf, sc + b, a, z), hd, w / 2, H, rise, 0, false);
            // aleros solo adelante y atrás: se estiran las caras en a
            const ext = (pt, dir) => [pt[0] + bf.Fx * 0.5 * dir, pt[1] + bf.Fy * 0.5 * dir, pt[2]];
            const [f1, f2] = pf.faces;
            faces.push([ext(f1[0], -1), ext(f1[1], 1), ext(f1[2], 1), ext(f1[3], -1)], [ext(f2[0], 1), ext(f2[1], -1), ext(f2[2], -1), ext(f2[3], 1)]);
            for (const g of pf.gables) faceOut(K.plain, g, c, id, bf.cx + bf.Sx * sc, bf.cy + bf.Sy * sc, H * 0.5);
        } else {
            const ur = rectRing(bf, s0, s1, -hd, hd);
            parapetInner(K.plain, ur, H, PP, shade(c, 0.8), id);
            faces.push(ur.map((p) => [p[0], p[1], H]));
        }
    }
    return emitRoof(K, faces, roof, bf.cx, bf.cy, H * 0.5);
}

// ------------------------------------------------------------------ comercios

function buildL1(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    flatHouseBody(K, R, fi, 'casa', P, wall);
    const L = fr.L;
    const sign = rgb(P.sign);
    // cartel pintado en el frente, persiana metálica y una puertita al costado
    fquad(K.plain, fr, -L / 2 + 0.1, L / 2 - 0.1, 0.04, 2.75, Math.min(P.P - 0.05, 3.5), sign, id);
    const sw = Math.min(3.0, L * 0.55);
    const s0 = -L / 2 + 0.3 + (L - sw - 0.6) * (hash01(id, 50) < 0.5 ? 0.15 : 0.6);
    fquad(K.plain, fr, s0, s0 + sw, 0.04, 0, 2.45, rgb(COL.shutter), id);
    fbox(K.plain, fr, s0 - 0.05, s0 + sw + 0.05, 0, 0.22, 2.45, 2.7, rgb(COL.shutterBox), id);
    if (P.awning && K.detail) {
        up(K.plain, [W(fr, s0 - 0.2, 0, 2.7), W(fr, s0 + sw + 0.2, 0, 2.7), W(fr, s0 + sw + 0.2, 1.1, 2.35), W(fr, s0 - 0.2, 1.1, 2.35)], rgb(pickOf(PAL.awnings, id, 23)), id);
    }
    const free = s0 > -L / 2 + 1.4 ? (s0 - L / 2) / 2 : s0 + sw + 1.4 < L / 2 ? (s0 + sw + L / 2) / 2 : null;
    if (free !== null) door(K, fr, free, 0.85, 2.1, rgb(pickOf(PAL.doors, id, 45)));
    if (P.tank) roofTank(K, R, fr, P.H, P, hash01(id, 46) < 0.5 ? -1 : 1);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildL2(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const bf = boxFrame(A, ctx.front);
    const hw = bf.hw, hd = bf.hd;
    const c = Math.min(2.8, hw * 0.45, hd * 0.45);
    // ochava del lado del cruce: ctx.cornerDir (opcional, vector hacia la esquina); si no viene, por hash
    const cd = ctx.cornerDir;
    const right = cd ? bf.Sx * cd.dirX + bf.Sy * cd.dirY > 0 : hash01(id, 51) < 0.5;
    // ochava: se corta la esquina del frente que da al cruce
    let R, fi, ci, si;
    const at = (s, f) => { const p = W(bf, s, f, 0); return [p[0], p[1]]; };
    if (right) {
        R = [at(-hw, -hd), at(hw, -hd), at(hw, hd - c), at(hw - c, hd), at(-hw, hd)];
        fi = 3; ci = 2; si = 1;
    } else {
        R = [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw + c, hd), at(-hw, hd - c)];
        fi = 2; ci = 3; si = 4;
    }
    const street = new Set([fi, ci, si]);
    const g = 3.6;
    ringWalls(K, R, fi, (i) => {
        const segs = [];
        if (street.has(i)) segs.push(['local', 0, Math.min(g, P.P), 0, wall]);
        else segs.push(['casa', 0, Math.min(g, P.P), 0, wall]);
        if (P.P > g) segs.push(['casa', g, P.P, 0, wall]);
        return segs;
    });
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), id);
    const sign = rgb(P.sign), aw = rgb(P.awningCol);
    for (const i of [fi, si]) {
        const fr = edgeFrame(R, i);
        const L = fr.L;
        if (L < 1.5) continue;
        // en el frente, todo el largo; en el costado, solo los primeros metros desde la ochava
        let a = -L / 2 + 0.2, b = L / 2 - 0.2;
        if (i === si) {
            const len = Math.min(L - 0.4, 6.5);
            if (right) b = a + len; else a = b - len;
        }
        up(K.plain, [W(fr, a, 0, 3.0), W(fr, b, 0, 3.0), W(fr, b, 1.3, 2.5), W(fr, a, 1.3, 2.5)], aw, id);
        if (i === fi) fquad(K.plain, fr, -L / 2 + 0.1, L / 2 - 0.1, 0.05, 3.05, 3.55, sign, id);
    }
    const cf = edgeFrame(R, ci);
    fquad(K.plain, cf, -cf.L / 2 + 0.05, cf.L / 2 - 0.05, 0.05, 2.75, 3.55, sign, id);
    fquad(K.plain, cf, -0.65, 0.65, 0.03, 0, 2.5, rgb(COL.glass), id);
    const fr = edgeFrame(R, fi);
    if (P.tank) roofTank(K, R, fr, P.H, P, right ? -1 : 1);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildL3(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    ringWalls(K, R, fi, (i, isFront) => {
        const segs = [[isFront ? 'local' : 'casa', 0, Math.min(P.g, P.P), 0, wall]];
        if (P.P > P.g) segs.push(['departamentos', P.g, P.P, P.g, wall]);
        return segs;
    });
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), id);
    const L = fr.L;
    fbox(K.plain, fr, -L / 2 + 0.05, L / 2 - 0.05, 0, 1.6, 3.15, 3.38, rgb(P.marquee), id);
    const top = P.floors === 0 ? P.P + 0.6 : 4.15;
    fquad(K.plain, fr, -L / 2 + 0.15, L / 2 - 0.15, 0.06, 3.45, top, rgb(P.sign), id);
    // persiana metálica: un local cerrado (una vidriera entera) o a medio bajar sobre todo el frente
    const sh = hash01(id, 80);
    if (sh < 0.3 && L >= 6) {
        const s0 = hash01(id, 81) < 0.5 ? -L / 2 + 0.2 : L / 2 - 3.2;
        fquad(K.plain, fr, s0, s0 + 3.0, 0.045, 0, 3.05, rgb(COL.shutter), id);
    } else if (sh < 0.55) {
        fquad(K.plain, fr, -L / 2 + 0.2, L / 2 - 0.2, 0.045, 2.1 + 0.4 * hash01(id, 81), 3.05, rgb(COL.shutter), id);
    }
    if (P.tank) roofTank(K, R, fr, P.H, P, hash01(id, 46) < 0.5 ? -1 : 1);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

// ------------------------------------------------------------------ edificios en altura y súper

function machineRoom(K, R, fr, z, h, big) {
    const L = fr.L, dep = fr.depth;
    if (L < 5 || dep < 5) return;
    const s = 0, f = -dep * 0.5;
    const w = W(fr, s, f, 0);
    if (!insideRing(R, w[0], w[1])) return;
    const hs = Math.min(big ? 2.4 : 1.6, L * 0.2), hf = Math.min(big ? 2 : 1.4, dep * 0.2);
    fbox(K.plain, fr, s - hs, s + hs, f - hf, f + hf, z, z + h, rgb(COL.machine), K.id);
    fbox(K.plain, fr, s - hs, s + hs * 0.2, f - hf, f + hf * 0.4, z + h, z + h + 0.01, rgb(COL.machine), K.id);
}

function buildE1(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    ringWalls(K, R, fi, (i, isFront) => (P.shopGround
        ? [[isFront ? 'local' : 'departamentos', 0, P.g, 0, wall], ['departamentos', P.g, P.P, P.g, wall]]
        : [['departamentos', 0, P.P, 0, wall]]));
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), id);
    const L = fr.L;
    const bc = rgb(P.balc);
    const m = clamp(Math.floor(L / 6), 1, 3);
    const unit = 3;
    const cuts = cellBoundaries(L, unit).filter((t) => t + unit <= L + 1e-6);
    for (let fl = 1; fl < P.floors; fl++) {
        const z = P.g + (fl - 1) * 2.9;
        for (let k = 0; k < m && k < cuts.length; k++) {
            const t = cuts[Math.floor(((k + 0.5) / m) * cuts.length)];
            const s1 = L / 2 - t, s0 = s1 - unit;
            fbox(K.plain, fr, s0 + 0.1, s1 - 0.1, 0, 1.15, z, z + (K.detail ? 1.05 : 0.15), bc, id);
        }
    }
    if (P.shopGround) fbox(K.plain, fr, -L / 2 + 0.05, L / 2 - 0.05, 0, 1.4, 3.3, 3.5, rgb(COL.marquee), id);
    machineRoom(K, R, fr, P.H, P.machine, false);
    if (K.detail) roofTank(K, R, fr, P.H, P, 1);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildE2(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    ringWalls(K, R, fi, () => [['torre', 0, P.P, 0, wall]]);
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), id);
    const L = fr.L;
    const bc = rgb(P.balc);
    for (let fl = 1; fl < P.floors; fl++) {
        const z = fl * 3;
        fbox(K.plain, fr, -L / 2 + 0.3, L / 2 - 0.3, 0, 1.3, z, z + (K.detail ? 1.0 : 0.15), bc, id);
    }
    fbox(K.plain, fr, -Math.min(4, L * 0.3), Math.min(4, L * 0.3), 0, 2.5, 3.0, 3.3, rgb(COL.marqueeDark), id);
    machineRoom(K, R, fr, P.H, P.machine, true);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildH1(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    ringWalls(K, R, fi, (i, isFront) => (isFront
        ? [['local', 0, P.g, 0, wall], ['hotel', P.g, P.P, P.g, wall]]
        : [['hotel', 0, P.P, 0, wall]]));
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.8), id);
    const L = fr.L;
    // franja entre el lobby y los pisos, marquesina de entrada y cartel en la azotea
    fquad(K.plain, fr, -L / 2, L / 2, 0.04, P.g - 0.5, P.g, shade(wall, 0.7), id);
    const cw = Math.min(4, L * 0.3);
    fbox(K.plain, fr, -cw, cw, 0, 3.2, 3.6, 3.9, rgb(COL.marqueeDark), id);
    if (K.detail) {
        fbox(K.plain, fr, -cw + 0.1, -cw + 0.3, 2.9, 3.1, 0, 3.6, rgb(COL.marqueeDark), id);
        fbox(K.plain, fr, cw - 0.3, cw - 0.1, 2.9, 3.1, 0, 3.6, rgb(COL.marqueeDark), id);
    }
    const sw = Math.min(5, L * 0.35);
    if (fr.depth > 3) fbox(K.plain, fr, -sw, sw, -1.2, -0.7, P.P, P.P + 2.2, rgb(P.sign), id);
    machineRoom(K, R, fr, P.H, P.machine, true);
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

function buildS1(K, A, P, ctx) {
    const { id } = K;
    const wall = rgb(P.wall), roof = K.roof;
    const R = A.R;
    const fi = frontEdge(R, ctx.front);
    const fr = edgeFrame(R, fi);
    ringWalls(K, R, fi, () => [['super', 0, P.P, 0, wall]]);
    parapetInner(K.plain, R, P.H, P.P, shade(wall, 0.85), id);
    const L = fr.L;
    const sign = rgb(P.sign);
    fbox(K.plain, fr, -L * 0.45, L * 0.45, 0, 0.3, P.H - 1.6, P.P + 0.5, sign, id);
    const ew = Math.min(5, L * 0.2);
    fquad(K.plain, fr, -ew, ew, 0.03, 0, 3.0, rgb(COL.glass), id);
    fbox(K.plain, fr, -ew - 1, ew + 1, 0, 3.5, 3.2, 3.55, rgb(COL.marquee), id);
    if (K.detail) {
        for (let k = 0; k < 3; k++) {
            const s = (k - 1) * L * 0.25, f = -fr.depth * (0.3 + 0.2 * k);
            const w = W(fr, s, f, 0);
            if (fr.depth > 8 && insideRing(R, w[0], w[1])) fbox(K.plain, fr, s - 0.8, s + 0.8, f - 0.6, f + 0.6, P.H, P.H + 0.9, rgb(COL.machine), id);
        }
    }
    const start = K.plain.vertexCount;
    flatRoof(K.plain, R, P.H, roof, id);
    return { start, count: K.plain.vertexCount - start };
}

const BUILDERS = { C1: buildC1, C2: buildC2, C3: buildC3, C4: buildC4, C5: buildC5, C6: buildC6, L1: buildL1, L2: buildL2, L3: buildL3, E1: buildE1, E2: buildE2, H1: buildH1, S1: buildS1 };

/**
 * Agrega el edificio a los constructores (paredes con textura por estilo en `walls`, todo lo demás en `plain`).
 * Devuelve el rango contiguo de vértices de `plain` que es solo el techo principal (se pinta con el color del dueño).
 * `ctx.mold` (opcional) fuerza un molde.
 */
export function addBuildingMold(b, builders, ctx = {}) {
    const A = analyze(b);
    if (A.R.length < 3 || A.area < 1) return null;
    const mold = effectiveMold(ctx.mold ?? chooseFrom(b, ctx, A), A);
    const P = params(b, mold, A);
    const K = {
        walls: builders.walls, plain: builders.plain, id: b.id, A,
        detail: ctx.quality !== 'baja',
        roof: rgb(b.roofColor ?? roofHex(b.id | 0, P)),
    };
    return BUILDERS[mold](K, A, P, ctx);
}
