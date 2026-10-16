// Texturas de fachada dibujadas en canvas (sin imágenes externas), estilo pixel: rectángulos nítidos.
// Cada estilo tiene un lienzo de día (fondo blanco: el color de la pared lo pone el color por vértice, que multiplica)
// y uno de noche (negro, solo las ventanas encendidas, para usar como emissiveMap). No todas las ventanas se prenden.
//
// Uso: const { day, night, cell } = makeFacadeTextures('casa'); la pared lleva uv = metros / cell (ver city-molds.js),
// así que la textura va con repeat 1 × 1, RepeatWrapping y NearestFilter. Nada se dibuja al importar el módulo.
import { FACADE_INFO, FACADE_STYLES } from './city-molds.js';
import { hash01 } from './city-geometry.js';

export { FACADE_STYLES };

const WARM = '#ffd36b';
const WARM2 = '#ffc04d';
const COOL = '#ffe9a0';
const TV = '#a9c8ff';

/** Dibuja en metros: x desde la izquierda, z desde abajo (el lienzo se da vuelta al subirlo: abajo = suelo). */
function painter(ctx, size, cw, ch) {
    const kx = size / cw, kz = size / ch;
    return (x, z, w, h, color) => {
        // redondeo a píxel entero (bordes nítidos) y recorte al lienzo
        const x0 = Math.max(0, Math.round(x * kx)), x1 = Math.min(size, Math.round((x + w) * kx));
        const y0 = Math.max(0, Math.round(size - (z + h) * kz)), y1 = Math.min(size, Math.round(size - z * kz));
        if (x1 <= x0 || y1 <= y0) return;
        ctx.fillStyle = color;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    };
}

/** Lienzos de día y de noche para un estilo de FACADE_STYLES; `cell` = metros que cubre el lienzo entero. */
export function makeFacadeTextures(style) {
    const info = FACADE_INFO[style] ?? FACADE_INFO.casa;
    const size = info.px;
    const cw = info.unit * info.cols, ch = info.floor * info.rows;
    const day = document.createElement('canvas');
    const night = document.createElement('canvas');
    day.width = day.height = night.width = night.height = size;
    const d = day.getContext('2d');
    const n = night.getContext('2d');
    d.fillStyle = '#ffffff';
    d.fillRect(0, 0, size, size);
    n.fillStyle = '#000000';
    n.fillRect(0, 0, size, size);
    const D = painter(d, size, cw, ch);
    const N = painter(n, size, cw, ch);
    const salt = FACADE_STYLES.indexOf(style) + 1;
    const U = info.unit, F = info.floor;
    for (let r = 0; r < info.rows; r++) {
        for (let c = 0; c < info.cols; c++) {
            const k = r * info.cols + c;
            const rnd = (s) => hash01(k + 1, salt * 31 + s);
            const ox = c * U, oz = r * F;
            const at = (fn) => (x, z, w, h, col) => fn(ox + x, oz + z, w, h, col);
            DRAW[style in DRAW ? style : 'casa'](at(D), at(N), { r, c, k, rnd, U, F });
        }
    }
    return { day, night, cell: [cw, ch] };
}

/** Ventana con marco: cada estilo arma sus celdas con esto. */
function windowRect(D, x, z, w, h, glass, frame, t = 0.07) {
    if (frame) D(x - t, z - t, w + 2 * t, h + 2 * t, frame);
    D(x, z, w, h, glass);
}

const DRAW = {
    // casa de barrio: zócalo, ventanas de 1,2 × 1,2 con reja o persiana; arriba (2.ª planta) ventanas o puerta-balcón
    casa(D, N, { r, c, rnd }) {
        if (r === 0) D(0, 0, 2.6, 0.35, '#d2cdc2');
        const upper = r === 1;
        const tall = upper && c === 0;
        const x = tall ? 0.75 : 0.7, w = tall ? 1.1 : 1.2;
        const z = tall ? 0.95 : 0.95, h = tall ? 1.9 : 1.2;
        D(x - 0.1, z - 0.12, w + 0.2, 0.1, '#c9c4b8'); // alféizar
        windowRect(D, x, z, w, h, '#5f7f9f', '#e9e6df', 0.06);
        const blind = c === 0 && !upper ? 0.45 : upper && c === 1 ? 0.3 : 0; // persiana a medio bajar
        if (blind) {
            D(x, z + h * (1 - blind), w, h * blind, '#d8cfb8');
            for (let i = 1; i < 4; i++) D(x, z + h * (1 - blind) + (h * blind * i) / 4, w, 0.03, '#b9ae95');
        }
        if (!blind || c === 1) {
            // reja
            for (let i = 1; i < 4; i++) D(x + (w * i) / 4 - 0.025, z, 0.05, h, '#3a3d42');
            D(x, z + h / 2 - 0.025, w, 0.05, '#3a3d42');
        }
        if (rnd(1) < 0.6 || c === 0) N(x, z, w, h * (1 - blind), rnd(2) < 0.5 ? WARM : WARM2);
    },
    // casa antigua: ventanas altas con postigos (verdes o marrones), molduras y zócalo de piedra
    antigua_verde(D, N, o) { antigua(D, N, o, '#2f8f4a', '#226b37'); },
    antigua_marron(D, N, o) { antigua(D, N, o, '#7a4a2a', '#5a3520'); },
    // casa de chapa: bloque a la vista (líneas suaves) y ventana corrediza de aluminio chica
    chapa(D, N, { c, rnd }) {
        for (let z = 0.4; z < 4; z += 0.4) D(0, z, 2.8, 0.025, '#e9e9e6');
        for (let row = 0; row < 10; row++) D(row % 2 ? 0.7 : 1.4, row * 0.4, 0.025, 0.4, '#ececea');
        const x = 0.9, z = 1.0, w = c === 0 ? 1.0 : 1.2, h = 1.0;
        windowRect(D, x, z, w, h, '#6f8aa3', '#b8bcc0', 0.06);
        D(x + w / 2 - 0.03, z, 0.06, h, '#b8bcc0');
        if (c === 1) for (let i = 1; i < 3; i++) D(x + (w * i) / 3 - 0.025, z, 0.05, h, '#3a3d42');
        if (rnd(1) < 0.7) N(x, z, w, h, WARM2);
    },
    // planta baja comercial: vidriera grande con puerta, zócalo oscuro
    local(D, N, { c }) {
        D(0, 0, 3, 0.4, '#8f969d');
        windowRect(D, 0.18, 0.4, 2.64, 2.6, '#4d6f8c', '#cfd4d9', 0.1);
        if (c === 0) {
            D(1.95, 0.0, 0.85, 2.7, '#cfd4d9');
            D(2.03, 0.0, 0.69, 2.6, '#35506a');
        } else {
            D(1.45, 0.4, 0.08, 2.6, '#cfd4d9');
        }
        D(0, 3.05, 3, 0.1, '#d9d9d9');
        N(0.18, 0.4, 2.64, 2.6, c === 0 ? '#ffe2a0' : '#fff1c8');
        if (c === 0) N(2.03, 0.0, 0.69, 2.6, '#ffe2a0');
    },
    // departamentos: losa marcada en cada piso, ventanas y puertas-balcón con persianas a distintas alturas
    departamentos(D, N, { rnd }) {
        D(0, 0, 3, 0.14, '#d5d5d2');
        const door = rnd(1) < 0.5;
        const x = door ? 0.75 : 0.8, w = door ? 1.5 : 1.4;
        const z = door ? 0.14 : 0.95, h = door ? 2.15 : 1.3;
        windowRect(D, x, z, w, h, '#57779a', '#e6e6e2', 0.06);
        const blind = [0, 0.25, 0.5, 0.85][Math.floor(rnd(2) * 4)];
        if (blind) D(x, z + h * (1 - blind), w, h * blind, '#d9d2c2');
        if (blind) for (let i = 1; i < 4; i++) D(x, z + h * (1 - blind) + (h * blind * i) / 4, w, 0.03, '#bdb4a2');
        D(x + w / 2 - 0.03, z, 0.06, h * (1 - blind), '#e6e6e2');
        if (rnd(3) < 0.55 && blind < 0.85) N(x, z, w, h * (1 - blind), rnd(4) < 0.2 ? TV : rnd(5) < 0.5 ? WARM : WARM2);
    },
    // hotel: fajas horizontales entre pisos y ventanas iguales con cortinas
    hotel(D, N, { rnd }) {
        D(0, 0, 2.5, 0.3, '#cfcfcc');
        windowRect(D, 0.45, 0.9, 1.6, 1.5, '#5d7f99', '#ecebe6', 0.05);
        const curtain = rnd(1);
        if (curtain < 0.4) {
            D(0.45, 0.9, 0.4, 1.5, '#e8dcc0');
            D(1.65, 0.9, 0.4, 1.5, '#e8dcc0');
        }
        if (rnd(2) < 0.6) N(0.45, 0.9, 1.6, 1.5, rnd(3) < 0.5 ? WARM : '#ffdf8a');
    },
    // torre: vidrio casi de piso a techo con parantes, losa clara
    torre(D, N, { rnd }) {
        D(0, 0, 2.2, 0.35, '#e3e7ea');
        D(0.06, 0.35, 2.08, 2.6, '#7fb2cc');
        D(1.07, 0.35, 0.06, 2.6, '#c7d3da');
        D(0.06, 1.25, 2.08, 0.05, '#c7d3da');
        if (rnd(1) < 0.3) D(0.06, 0.35, 2.08, 0.9, '#a9c6d4');
        if (rnd(2) < 0.5) N(0.06, 0.35, 2.08, 2.6, rnd(3) < 0.2 ? TV : COOL);
    },
    // supermercado: chapa con nervios verticales, zócalo alto y una tira de ventanas arriba
    super(D, N, { c }) {
        for (let x = 0.25; x < 4; x += 0.5) D(x, 0.9, 0.05, 6.1, '#e4e6e2');
        D(0, 0, 4, 0.9, '#b9bdb8');
        D(0, 0.9, 4, 0.08, '#9ea39d');
        windowRect(D, 0.5, 4.6, 3.0, 0.8, '#5d7f99', '#cfd4d9', 0.06);
        N(0.5, 4.6, 3.0, 0.8, c === 0 ? '#ffe7b0' : '#fff3d0');
    },
};

function antigua(D, N, { c, rnd }, shutter, slat) {
    D(0, 0, 2.6, 0.6, '#c2b9a8'); // zócalo
    D(0, 0, 0.14, 6, '#efe9df'); // pilastras
    D(2.46, 0, 0.14, 6, '#efe9df');
    D(0, 3.85, 2.6, 0.08, '#e2dacb');
    const x = 0.8, z = 0.75, w = 1.0, h = 2.5;
    D(x - 0.15, z + h + 0.05, w + 0.3, 0.22, '#e8e0d0'); // moldura arriba de la ventana
    D(x - 0.1, z - 0.1, w + 0.2, 0.1, '#d8d0c0');
    if (c === 0) {
        // postigos abiertos a los costados, vidrio con reja
        windowRect(D, x, z, w, h, '#4f6f8a', '#ece6da', 0.05);
        D(x + w / 2 - 0.03, z, 0.06, h, '#ece6da');
        for (const sx of [x - 0.48, x + w + 0.05]) {
            D(sx, z, 0.43, h, shutter);
            for (let i = 1; i < 10; i++) D(sx, z + (h * i) / 10, 0.43, 0.04, slat);
        }
        if (rnd(1) < 0.8) N(x, z, w, h, WARM);
    } else {
        // postigos cerrados
        D(x, z, w, h, shutter);
        for (let i = 1; i < 12; i++) D(x, z + (h * i) / 12, w, 0.04, slat);
        D(x + w / 2 - 0.025, z, 0.05, h, slat);
        if (rnd(1) < 0.3) {
            N(x, z, 0.04, h, WARM2); // luz que se escapa por las hendijas
            N(x, z + h * 0.5, w, 0.04, WARM2);
        }
    }
}
