// Vehículos 3D de la ciudad: motos (con conductor y a veces acompañante), autos (sedán y hatchback), camionetas,
// utilitarios, camiones y colectivos. Modelos low-poly a escala real, un InstancedMesh por parte y tipo.
// Recibe la lista de vehículos de city-traffic.js (y opcionalmente los estacionados) y la luz de daytime.js.
//
// Partes de cada tipo (comparten la misma matriz por instancia):
//  - pintura: color por instancia (setColorAt) sobre colores de vértice claros,
//  - detalle: vidrios, ruedas, paragolpes, conductor… (colores fijos por vértice),
//  - faros: quads delanteros que brillan de noche; luces traseras con color por instancia (más fuertes al frenar).
// De noche, además, un "cono" de luz aditivo en el piso delante de cada vehículo en movimiento.
import { DIMENSIONS } from './city-traffic.js';

const Z = 0.03; // asfalto

// ------------------------------------------------------------------ armado de geometría (x = adelante, y = izquierda, z = arriba)

class Parts {
    constructor() {
        this.pos = [];
        this.nor = [];
        this.col = [];
    }

    /** Cuadrilátero plano; se orienta solo para que la normal apunte hacia afuera de `ref`. */
    quad(a, b, c, d, color, ref) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const cx = (a[0] + b[0] + c[0] + d[0]) / 4 - ref[0];
        const cy = (a[1] + b[1] + c[1] + d[1]) / 4 - ref[1];
        const cz = (a[2] + b[2] + c[2] + d[2]) / 4 - ref[2];
        let pts = [a, b, c, a, c, d];
        if (nx * cx + ny * cy + nz * cz < 0) {
            pts = [a, c, b, a, d, c];
            nx = -nx; ny = -ny; nz = -nz;
        }
        for (const p of pts) {
            this.pos.push(p[0], p[1], p[2]);
            this.nor.push(nx, ny, nz);
            this.col.push(color[0], color[1], color[2]);
        }
    }

    /**
     * Tronco de pirámide de base rectangular: abajo [x0,x1]×[y0,y1] en z0, arriba [tx0,tx1]×[ty0,ty1] en z1.
     * Sirve para carrocerías, cabinas con parabrisas inclinado, etc. `bottom` = dibujar la base.
     */
    frustum(x0, x1, y0, y1, z0, tx0, tx1, ty0, ty1, z1, color, bottom = false) {
        const ref = [(x0 + x1 + tx0 + tx1) / 4, (y0 + y1 + ty0 + ty1) / 4, (z0 + z1) / 2];
        const B = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]];
        const T = [[tx0, ty0, z1], [tx1, ty0, z1], [tx1, ty1, z1], [tx0, ty1, z1]];
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            this.quad(B[i], B[j], T[j], T[i], color, ref);
        }
        this.quad(T[0], T[1], T[2], T[3], color, ref);
        if (bottom) this.quad(B[0], B[1], B[2], B[3], color, ref);
    }

    box(x0, x1, y0, y1, z0, z1, color, bottom = false) {
        this.frustum(x0, x1, y0, y1, z0, x0, x1, y0, y1, z1, color, bottom);
    }

    /** Caja centrada en y (ancho w). */
    cbox(x0, x1, w, z0, z1, color, bottom = false) {
        this.box(x0, x1, -w / 2, w / 2, z0, z1, color, bottom);
    }

    /** Rueda: prisma octogonal con eje en y. */
    wheel(cx, cy, r, w, color, hub = null) {
        const S = 8;
        const y0 = cy - w / 2, y1 = cy + w / 2;
        const ref = [cx, cy, r];
        const pt = (k, y) => [cx + Math.cos((k / S) * Math.PI * 2 + Math.PI / 8) * r, y, r + Math.sin((k / S) * Math.PI * 2 + Math.PI / 8) * r];
        for (let k = 0; k < S; k++) {
            this.quad(pt(k, y0), pt(k + 1, y0), pt(k + 1, y1), pt(k, y1), color, ref);
        }
        const capColor = hub ?? color;
        for (const [y, side] of [[y0, -1], [y1, 1]]) {
            const c = [cx, y, r];
            const capRef = [cx, y - side, r];
            for (let k = 0; k < S; k += 2) {
                this.quad(c, pt(k, y), pt(k + 1, y), pt(k + 2, y), capColor, capRef);
            }
        }
    }

    /** Cuadrado vertical mirando hacia ±x (faros). */
    faceX(x, yc, w, zc, h, color, dir) {
        const ref = [x - dir, yc, zc];
        this.quad([x, yc - w / 2, zc - h / 2], [x, yc + w / 2, zc - h / 2], [x, yc + w / 2, zc + h / 2], [x, yc - w / 2, zc + h / 2], color, ref);
    }

    toGeometry(THREE) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
        return g;
    }

    get triangles() {
        return this.pos.length / 9;
    }
}

// sRGB '#hex' → lineal (los colores de vértice van en espacio lineal, como en city3d)
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
}

const C = {
    white: rgb('#ffffff'),
    paintShade: rgb('#d9d9d9'), // parte baja de la carrocería pintada, un poco más oscura
    glass: rgb('#22303d'),
    glassLight: rgb('#3b5266'),
    tire: rgb('#1b1b1d'),
    hub: rgb('#9aa0a6'),
    bumper: rgb('#2e3034'),
    chrome: rgb('#c9ccd1'),
    grey: rgb('#c7c9cc'),
    boxGrey: rgb('#d5d7da'),
    darkGrey: rgb('#55585e'),
    seat: rgb('#222226'),
    jeans: rgb('#2f4a7a'),
    shirt: rgb('#e8d9b5'),
    shirt2: rgb('#b8423c'),
    skin: rgb('#c58c63'),
    helmet: rgb('#202024'),
    helmet2: rgb('#e9e9e9'),
    vanWhite: rgb('#f3f3f0'),
    busWhite: rgb('#f2f3f1'),
    busTeal: rgb('#0e8f8a'),
    door: rgb('#2a3a46'),
    plate: rgb('#f4f4f4'),
    bed: rgb('#3a3a3e'),
    lightOff: rgb('#ffffff'),
};

// Cada modelo arma: paint, detail, head (faros), tail (traseras) y, en la moto, `extra` (acompañante).
function rider(p, x, shirt, helmet) {
    // piernas, torso inclinado, brazos al manubrio, cabeza con casco
    p.frustum(x - 0.18, x + 0.22, -0.2, 0.2, 0.62, x - 0.16, x + 0.2, -0.2, 0.2, 0.82, C.jeans);
    p.box(x + 0.12, x + 0.3, -0.21, -0.13, 0.32, 0.7, C.jeans); // pierna derecha
    p.box(x + 0.12, x + 0.3, 0.13, 0.21, 0.32, 0.7, C.jeans);
    p.frustum(x - 0.2, x + 0.12, -0.19, 0.19, 0.82, x - 0.12, x + 0.16, -0.17, 0.17, 1.32, shirt);
    p.box(x + 0.0, x + 0.45, -0.24, -0.16, 1.08, 1.18, shirt); // brazos
    p.box(x + 0.0, x + 0.45, 0.16, 0.24, 1.08, 1.18, shirt);
    p.box(x - 0.03, x + 0.07, -0.06, 0.06, 1.32, 1.37, C.skin); // cuello
    p.frustum(x - 0.13, x + 0.15, -0.13, 0.13, 1.37, x - 0.1, x + 0.12, -0.11, 0.11, 1.62, helmet);
    p.box(x + 0.12, x + 0.16, -0.09, 0.09, 1.43, 1.53, C.glass); // visera
}

function buildMoto() {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts(), extra = new Parts();
    detail.wheel(0.66, 0, 0.3, 0.11, C.tire, C.hub);
    detail.wheel(-0.64, 0, 0.3, 0.12, C.tire, C.hub);
    detail.box(0.55, 0.66, -0.05, 0.05, 0.3, 0.95, C.chrome); // horquilla
    detail.box(-0.7, -0.15, -0.06, 0.06, 0.26, 0.36, C.darkGrey); // basculante
    detail.box(-0.2, 0.3, -0.1, 0.1, 0.28, 0.5, C.darkGrey); // motor
    detail.box(-0.75, -0.2, -0.19, -0.11, 0.32, 0.42, C.chrome); // escape (derecha)
    paint.frustum(-0.05, 0.5, -0.16, 0.16, 0.5, 0.0, 0.42, -0.14, 0.14, 0.78, C.white); // tanque / cuadro
    paint.frustum(0.5, 0.78, -0.18, 0.18, 0.6, 0.55, 0.72, -0.2, 0.2, 1.02, C.white); // carenado frontal
    paint.frustum(-0.92, -0.35, -0.13, 0.13, 0.62, -0.95, -0.4, -0.11, 0.11, 0.8, C.white); // colín
    paint.box(0.5, 0.85, -0.07, 0.07, 0.6, 0.66, C.white); // guardabarros
    detail.frustum(-0.55, 0.05, -0.15, 0.15, 0.76, -0.5, 0.0, -0.14, 0.14, 0.84, C.seat); // asiento
    detail.box(0.58, 0.64, -0.36, 0.36, 1.0, 1.05, C.bumper); // manubrio
    detail.box(0.55, 0.62, -0.38, -0.3, 1.06, 1.1, C.darkGrey); // espejos
    detail.box(0.55, 0.62, 0.3, 0.38, 1.06, 1.1, C.darkGrey);
    rider(detail, -0.15, C.shirt, C.helmet);
    rider(extra, -0.62, C.shirt2, C.helmet2);
    head.faceX(0.785, 0, 0.16, 0.86, 0.1, C.lightOff, 1);
    tail.faceX(-0.955, 0, 0.14, 0.72, 0.06, C.lightOff, -1);
    return { paint, detail, head, tail, extra, cone: [7, 2.4], front: 0.8 };
}

function buildAuto(hatch) {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts();
    const L = 4.3, W = 1.7;
    const xf = L / 2, xr = -L / 2;
    // carrocería baja: capó y baúl con un poco de caída
    paint.frustum(xr, xf, -W / 2, W / 2, 0.3, xr + 0.08, xf - 0.12, -W / 2 + 0.04, W / 2 - 0.04, 0.88, C.white, true);
    detail.cbox(xr - 0.04, xr + 0.12, W + 0.02, 0.28, 0.5, C.bumper); // paragolpes
    detail.cbox(xf - 0.1, xf + 0.05, W + 0.02, 0.28, 0.5, C.bumper);
    detail.cbox(xf - 0.02, xf + 0.055, 0.5, 0.52, 0.66, C.bumper); // parrilla
    detail.box(xf + 0.051, xf + 0.06, -0.2, 0.2, 0.35, 0.45, C.plate); // patente
    detail.box(xr - 0.05, xr - 0.04, -0.2, 0.2, 0.55, 0.65, C.plate);
    // cabina de vidrio con techo pintado
    if (hatch) {
        detail.frustum(-1.95, 0.85, -0.8, 0.8, 0.88, -1.85, 0.2, -0.66, 0.66, 1.4, C.glass);
        paint.frustum(-1.88, 0.24, -0.68, 0.68, 1.39, -1.84, 0.12, -0.64, 0.64, 1.45, C.white);
    } else {
        detail.frustum(-1.25, 0.95, -0.8, 0.8, 0.88, -0.85, 0.35, -0.66, 0.66, 1.4, C.glass);
        paint.frustum(-0.9, 0.39, -0.68, 0.68, 1.39, -0.82, 0.3, -0.64, 0.64, 1.45, C.white);
    }
    // espejos
    detail.box(0.75, 0.9, -0.97, -0.85, 0.9, 1.0, C.bumper);
    detail.box(0.75, 0.9, 0.85, 0.97, 0.9, 1.0, C.bumper);
    for (const x of [1.35, -1.35]) for (const y of [-0.74, 0.74]) detail.wheel(x, y, 0.32, 0.24, C.tire, C.hub);
    for (const y of [-0.58, 0.58]) {
        head.faceX(xf + 0.004, y, 0.34, 0.72, 0.13, C.lightOff, 1);
        tail.faceX(xr - 0.004, y, 0.3, 0.74, 0.12, C.lightOff, -1);
    }
    return { paint, detail, head, tail, cone: [10, 4.5], front: xf };
}

function buildCamioneta() {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts();
    const L = 5.3, W = 1.85, xf = L / 2, xr = -L / 2;
    paint.frustum(xr, xf, -W / 2, W / 2, 0.45, xr, xf - 0.15, -W / 2, W / 2, 1.1, C.white, true);
    // cabina doble
    detail.frustum(-0.55, 1.2, -0.86, 0.86, 1.1, -0.45, 0.6, -0.76, 0.76, 1.74, C.glass);
    paint.frustum(-0.5, 0.64, -0.78, 0.78, 1.73, -0.46, 0.56, -0.75, 0.75, 1.8, C.white);
    paint.box(-0.62, -0.5, -0.88, 0.88, 1.1, 1.74, C.white); // parante trasero
    // caja: barandas pintadas y piso oscuro
    detail.box(xr + 0.06, -0.66, -W / 2 + 0.07, W / 2 - 0.07, 1.1, 1.11, C.bed);
    paint.box(xr, -0.62, -W / 2, -W / 2 + 0.07, 1.1, 1.42, C.white);
    paint.box(xr, -0.62, W / 2 - 0.07, W / 2, 1.1, 1.42, C.white);
    paint.box(xr, xr + 0.07, -W / 2, W / 2, 1.1, 1.42, C.white); // portón
    detail.cbox(xf - 0.12, xf + 0.06, W + 0.02, 0.4, 0.68, C.bumper);
    detail.cbox(xr - 0.08, xr + 0.05, W + 0.02, 0.4, 0.62, C.bumper);
    detail.cbox(xf - 0.05, xf + 0.075, 0.9, 0.72, 0.98, C.chrome); // parrilla
    detail.box(xf + 0.07, xf + 0.08, -0.2, 0.2, 0.45, 0.6, C.plate);
    detail.box(0.85, 1.0, -1.03, -0.9, 1.15, 1.28, C.bumper);
    detail.box(0.85, 1.0, 0.9, 1.03, 1.15, 1.28, C.bumper);
    for (const x of [1.75, -1.6]) for (const y of [-0.8, 0.8]) detail.wheel(x, y, 0.4, 0.28, C.tire, C.hub);
    for (const y of [-0.68, 0.68]) {
        head.faceX(xf + 0.004, y, 0.34, 0.88, 0.16, C.lightOff, 1);
        tail.faceX(xr - 0.004, y, 0.12, 1.15, 0.36, C.lightOff, -1);
    }
    return { paint, detail, head, tail, cone: [11, 4.8], front: xf };
}

function buildUtilitario() {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts();
    const L = 4.4, W = 1.8, xf = L / 2, xr = -L / 2;
    detail.frustum(xr, xf, -W / 2, W / 2, 0.32, xr, xf - 0.05, -W / 2, W / 2, 1.05, C.vanWhite, true);
    detail.frustum(xr, xf - 0.5, -W / 2, W / 2, 1.05, xr, 1.2, -W / 2 + 0.03, W / 2 - 0.03, 1.9, C.vanWhite);
    // parabrisas sobre la cara inclinada y ventanillas de la cabina
    const k = 0.04;
    detail.quad([xf - 0.5 + k, -0.78, 1.12], [xf - 0.5 + k, 0.78, 1.12], [1.27 + k, 0.76, 1.82], [1.27 + k, -0.76, 1.82], C.glass, [0, 0, 1.4]);
    detail.box(0.55, 1.45, -W / 2 - 0.012, W / 2 + 0.012, 1.12, 1.62, C.glass);
    // franja lateral pintada (color de la empresa)
    paint.box(xr + 0.02, 1.62, -W / 2 - 0.01, W / 2 + 0.01, 0.78, 0.94, C.white);
    detail.box(-1.1, -0.95, -W / 2 - 0.015, -W / 2, 0.4, 1.75, C.darkGrey); // riel de puerta corrediza (derecha)
    detail.cbox(xf - 0.08, xf + 0.06, W + 0.02, 0.32, 0.55, C.bumper);
    detail.cbox(xr - 0.06, xr + 0.04, W + 0.02, 0.32, 0.52, C.bumper);
    detail.cbox(xr - 0.012, xr, 1.5, 1.15, 1.6, C.glassLight); // ventanas traseras
    detail.box(xf + 0.06, xf + 0.07, -0.2, 0.2, 0.36, 0.5, C.plate);
    detail.box(1.15, 1.3, -1.02, -0.9, 1.2, 1.35, C.bumper);
    detail.box(1.15, 1.3, 0.9, 1.02, 1.2, 1.35, C.bumper);
    for (const x of [1.4, -1.35]) for (const y of [-0.78, 0.78]) detail.wheel(x, y, 0.33, 0.24, C.tire, C.hub);
    for (const y of [-0.62, 0.62]) {
        head.faceX(xf + 0.004, y, 0.32, 0.72, 0.15, C.lightOff, 1);
        tail.faceX(xr - 0.004, y, 0.14, 0.9, 0.34, C.lightOff, -1);
    }
    return { paint, detail, head, tail, cone: [10, 4.6], front: xf };
}

function buildCamion() {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts();
    const L = 7.5, W = 2.4, xf = L / 2, xr = -L / 2;
    detail.cbox(xr + 0.2, xf - 0.2, 1.0, 0.55, 0.95, C.bumper); // chasis
    // cabina pintada con parabrisas
    paint.frustum(1.95, xf, -1.15, 1.15, 0.85, 1.95, xf - 0.18, -1.12, 1.12, 2.75, C.white, true);
    detail.quad([xf - 0.012, -0.98, 1.75], [xf - 0.012, 0.98, 1.75], [xf - 0.165, 0.98, 2.5], [xf - 0.165, -0.98, 2.5], C.glass, [0, 0, 1.9]);
    detail.box(2.4, 3.2, -1.165, 1.165, 1.75, 2.35, C.glass); // ventanillas
    detail.cbox(xf - 0.05, xf + 0.06, 2.3, 0.6, 0.9, C.bumper);
    detail.cbox(xf - 0.01, xf + 0.02, 1.4, 1.0, 1.5, C.darkGrey); // parrilla
    detail.box(2.05, 2.3, -1.3, -1.15, 1.9, 2.4, C.bumper); // espejos
    detail.box(2.05, 2.3, 1.15, 1.3, 1.9, 2.4, C.bumper);
    // furgón gris
    detail.cbox(xr, 1.85, W, 1.0, 3.2, C.boxGrey, true);
    detail.cbox(xr - 0.01, xr, W - 0.2, 1.1, 3.1, C.grey); // puertas traseras
    detail.box(xr - 0.02, xr - 0.01, -0.02, 0.02, 1.1, 3.1, C.darkGrey);
    detail.cbox(xr - 0.08, xr + 0.1, W, 0.6, 0.8, C.bumper); // paragolpes trasero
    for (const x of [2.7, -1.7, -2.75]) for (const y of [-0.95, 0.95]) detail.wheel(x, y, 0.5, 0.35, C.tire, C.hub);
    for (const y of [-0.9, 0.9]) {
        head.faceX(xf + 0.065, y, 0.32, 0.78, 0.18, C.lightOff, 1);
        tail.faceX(xr - 0.085, y, 0.28, 0.7, 0.14, C.lightOff, -1);
    }
    return { paint, detail, head, tail, cone: [13, 5.5], front: xf };
}

function buildColectivo() {
    const paint = new Parts(), detail = new Parts(), head = new Parts(), tail = new Parts();
    const L = 12, W = 2.55, xf = L / 2, xr = -L / 2;
    detail.cbox(xr, xf, W, 0.35, 3.0, C.busWhite, true);
    // banda de ventanillas y parabrisas
    detail.box(-5.5, 4.6, -W / 2 - 0.012, W / 2 + 0.012, 1.45, 2.55, C.glass);
    detail.cbox(xf, xf + 0.012, W - 0.2, 1.05, 2.75, C.glass);
    detail.cbox(xr - 0.012, xr, W - 0.5, 1.7, 2.6, C.glassLight);
    // franja de la librea (color por instancia) y parte baja verde azulada
    paint.box(xr - 0.004, xf + 0.004, -W / 2 - 0.016, W / 2 + 0.016, 1.12, 1.36, C.white);
    detail.box(xr - 0.002, xf + 0.002, -W / 2 - 0.006, W / 2 + 0.006, 0.36, 0.6, C.busTeal);
    // puertas sobre la derecha (y negativa): delantera y central
    for (const [x0, x1] of [[4.65, 5.75], [-0.6, 0.6]]) detail.box(x0, x1, -W / 2 - 0.02, -W / 2 - 0.005, 0.38, 2.6, C.door);
    // equipo de aire acondicionado en el techo
    detail.frustum(-1.6, 1.4, -0.85, 0.85, 3.0, -1.5, 1.3, -0.78, 0.78, 3.12, C.grey);
    detail.cbox(xf - 0.05, xf + 0.08, W + 0.02, 0.3, 0.6, C.bumper);
    detail.cbox(xr - 0.08, xr + 0.05, W + 0.02, 0.3, 0.6, C.bumper);
    detail.cbox(xf + 0.01, xf + 0.02, 1.6, 2.78, 2.95, C.seat); // cartel de recorrido
    detail.box(4.6, 4.8, -1.45, -1.27, 2.2, 2.6, C.bumper); // espejos
    detail.box(4.6, 4.8, 1.27, 1.45, 2.2, 2.6, C.bumper);
    for (const x of [3.8, -3.3]) for (const y of [-0.98, 0.98]) detail.wheel(x, y, 0.5, 0.32, C.tire, C.hub);
    for (const y of [-0.95, 0.95]) {
        head.faceX(xf + 0.085, y, 0.36, 0.75, 0.2, C.lightOff, 1);
        tail.faceX(xr - 0.085, y, 0.2, 1.0, 0.5, C.lightOff, -1);
    }
    return { paint, detail, head, tail, cone: [14, 5.5], front: xf };
}

/** Formas de cada clase que se dibuja (el auto tiene dos carrocerías). */
const KINDS = ['moto', 'auto0', 'auto1', 'camioneta', 'utilitario', 'camion', 'colectivo'];
const kindOf = (v) => (v.type === 'auto' ? (v.variant ? 'auto1' : 'auto0') : v.type);

/**
 * Versión simple (de lejos, G fase 5): una caja pintada (color por instancia) + cabina/vidrios y "ruedas" oscuras
 * en una pieza de color fijo. ~20–30 triángulos en vez de 240–370. Los faros y las luces traseras son los mismos
 * quads del modelo completo (de noche se siguen viendo los puntitos de luz).
 */
function buildLodModel(kind) {
    const type = kind.startsWith('auto') ? 'auto' : kind;
    const { length: L, width: W, height: H } = DIMENSIONS[type];
    const paint = new Parts(), dark = new Parts();
    const x0 = -L / 2, x1 = L / 2;
    if (type === 'moto') {
        paint.cbox(-0.75, 0.75, 0.32, 0.28, 0.72, C.white);
        dark.cbox(-0.95, 0.95, 0.12, 0, 0.6, C.tire);
        dark.cbox(-0.38, 0.12, 0.44, 0.72, 1.62, C.bumper); // conductor
        return { paint, dark };
    }
    dark.cbox(x0 + 0.35, x1 - 0.35, W * 0.92, 0, 0.32, C.tire); // ruedas / bajo
    if (type === 'auto') {
        paint.cbox(x0, x1, W, 0.3, 0.82, C.white);
        dark.frustum(x0 + 0.85, x1 - 1.25, -W * 0.44, W * 0.44, 0.82, x0 + 1.15, x1 - 1.85, -W * 0.38, W * 0.38, H, C.glass);
    } else if (type === 'camioneta') {
        paint.cbox(x0, x1, W, 0.4, 1.05, C.white);
        dark.frustum(x1 - 2.9, x1 - 1.35, -W * 0.44, W * 0.44, 1.05, x1 - 2.75, x1 - 1.75, -W * 0.4, W * 0.4, H, C.glass);
    } else if (type === 'utilitario') {
        paint.cbox(x0, x1, W * 1.01, 0.75, 0.95, C.white); // franja de color
        dark.cbox(x0, x1, W, 0.3, H, C.boxGrey);
    } else if (type === 'camion') {
        paint.cbox(x1 - 2.0, x1, W, 0.45, H * 0.82, C.white); // cabina
        dark.cbox(x0, x1 - 2.2, W, 0.6, H, C.boxGrey); // caja
    } else {
        paint.cbox(x0, x1, W, 0.35, H, C.white); // colectivo
        dark.cbox(x0 + 0.4, x1 - 0.2, W * 1.02, H * 0.55, H * 0.85, C.glass);
    }
    return { paint, dark };
}

/** Para pruebas y la página de muestra: triángulos de cada modelo. */
export function vehicleModelStats() {
    const models = buildModels();
    return Object.fromEntries(KINDS.map((k) => {
        const m = models[k];
        return [k, ['paint', 'detail', 'head', 'tail', 'extra'].reduce((n, p) => n + (m[p]?.triangles ?? 0), 0)];
    }));
}

function buildModels() {
    return {
        moto: buildMoto(),
        auto0: buildAuto(false),
        auto1: buildAuto(true),
        camioneta: buildCamioneta(),
        utilitario: buildUtilitario(),
        camion: buildCamion(),
        colectivo: buildColectivo(),
    };
}

/** Textura del cono de luz (u = adelante, v = a lo ancho), hecha a mano sin DOM. */
function coneTexture(THREE) {
    const W = 64, H = 32;
    const data = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const u = i / (W - 1), v = (j / (H - 1)) * 2 - 1;
            const spread = 0.28 + 0.72 * u;
            const across = Math.max(0, 1 - Math.abs(v) / spread);
            const along = Math.min(1, u * 6) * (1 - u) ** 1.4;
            const a = Math.round(255 * Math.min(1, across ** 1.5 * along * 1.6));
            const k = (j * W + i) * 4;
            data[k] = data[k + 1] = data[k + 2] = 255;
            data[k + 3] = a;
        }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    return tex;
}

/**
 * Capa de vehículos para la escena de three.
 * @param maxPerType número (para todos) u objeto { moto: n, auto: n, … } — máximo de instancias de cada tipo.
 * @returns { group, update(vehicles, light, parked?), dispose(), stats() }
 *   `parked` (opcional) = traffic.parked: se dibujan con los mismos modelos, sin luces de noche.
 */
export function createVehicleLayer(THREE, { maxPerType = 200 } = {}) {
    const group = new THREE.Group();
    group.name = 'vehiculos';
    const models = buildModels();
    const capOf = (type) => (typeof maxPerType === 'number' ? maxPerType : maxPerType?.[type] ?? 200);

    const paintMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const detailMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const coneTex = coneTexture(THREE);
    const coneMat = new THREE.MeshBasicMaterial({
        color: 0xffe2a8, map: coneTex, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const geometries = [coneTex];
    const tmpColor = new THREE.Color();

    const kinds = {};
    let coneCap = 0;
    for (const k of KINDS) {
        const type = k.startsWith('auto') ? 'auto' : k;
        const cap = Math.max(1, capOf(type));
        const m = models[k];
        const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
        matrix.setUsage(THREE.DynamicDrawUsage);
        const make = (parts, mat, colorAttr) => {
            if (!parts || parts.triangles === 0) return null;
            const geo = parts.toGeometry(THREE);
            geometries.push(geo);
            const mesh = new THREE.InstancedMesh(geo, mat, cap);
            mesh.instanceMatrix = matrix; // todas las partes comparten la matriz (se sube una vez)
            if (colorAttr) mesh.instanceColor = colorAttr;
            mesh.count = 0;
            mesh.frustumCulled = false; // la cámara la arma MapLibre
            mesh.name = `${k}`;
            group.add(mesh);
            return mesh;
        };
        const paintColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        paintColor.setUsage(THREE.DynamicDrawUsage);
        const tailColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        tailColor.setUsage(THREE.DynamicDrawUsage);
        const entry = {
            cap, matrix, paintColor, tailColor,
            paint: make(m.paint, paintMat, paintColor),
            detail: make(m.detail, detailMat, null),
            head: make(m.head, headMat, null),
            tail: make(m.tail, tailMat, tailColor),
            extra: null, extraMatrix: null,
            cone: m.cone, front: m.front, n: 0, nx: 0,
        };
        if (m.extra) {
            entry.extraMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
            entry.extraMatrix.setUsage(THREE.DynamicDrawUsage);
            const geo = m.extra.toGeometry(THREE);
            geometries.push(geo);
            const mesh = new THREE.InstancedMesh(geo, detailMat, cap);
            mesh.instanceMatrix = entry.extraMatrix;
            mesh.count = 0;
            mesh.frustumCulled = false;
            group.add(mesh);
            entry.extra = mesh;
        }
        {
            const lm = buildLodModel(k);
            const lodMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
            lodMatrix.setUsage(THREE.DynamicDrawUsage);
            const lodPaint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            lodPaint.setUsage(THREE.DynamicDrawUsage);
            const lodTail = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            lodTail.setUsage(THREE.DynamicDrawUsage);
            const inst = (geo, mat, colorAttr) => {
                const mesh = new THREE.InstancedMesh(geo, mat, cap);
                mesh.instanceMatrix = lodMatrix;
                if (colorAttr) mesh.instanceColor = colorAttr;
                mesh.count = 0;
                mesh.visible = false;
                mesh.frustumCulled = false;
                mesh.name = `${k}-lejos`;
                group.add(mesh);
                return mesh;
            };
            const paintGeo = lm.paint.toGeometry(THREE), darkGeo = lm.dark.toGeometry(THREE);
            geometries.push(paintGeo, darkGeo);
            entry.lod = {
                n: 0, matrix: lodMatrix, paintColor: lodPaint, tailColor: lodTail,
                meshes: [inst(paintGeo, paintMat, lodPaint), inst(darkGeo, detailMat, null),
                    entry.head && inst(entry.head.geometry, headMat, null), entry.tail && inst(entry.tail.geometry, tailMat, lodTail)].filter(Boolean),
            };
        }
        kinds[k] = entry;
        coneCap += cap;
    }
    const coneGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
    geometries.push(coneGeo);
    const coneMatrix = new THREE.InstancedBufferAttribute(new Float32Array(coneCap * 16), 16);
    coneMatrix.setUsage(THREE.DynamicDrawUsage);
    const cones = new THREE.InstancedMesh(coneGeo, coneMat, coneCap);
    cones.instanceMatrix = coneMatrix;
    cones.count = 0;
    cones.frustumCulled = false;
    cones.renderOrder = 2;
    group.add(cones);

    // caché de colores '#hex' → lineal
    const colorCache = new Map();
    function linColor(hex) {
        let c = colorCache.get(hex);
        if (!c) {
            tmpColor.set(hex);
            c = [tmpColor.r, tmpColor.g, tmpColor.b];
            colorCache.set(hex, c);
        }
        return c;
    }

    function writeMatrix(arr, i, c, s, x, y, z) {
        const o = i * 16;
        arr[o] = c; arr[o + 1] = s; arr[o + 2] = 0; arr[o + 3] = 0;
        arr[o + 4] = -s; arr[o + 5] = c; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = 1; arr[o + 11] = 0;
        arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
    }

    let lastNight = -1;
    /**
     * `lod` = { x, y, distance }: los que están a más de `distance` metros de (x, y) (el ojo) van con el modelo simple.
     */
    function update(vehicles, light, parked = null, lod = null) {
        const lights = light?.lights ?? 0;
        const night = lights > 0.3;
        for (const k of KINDS) { kinds[k].n = 0; kinds[k].nx = 0; kinds[k].lod.n = 0; }
        let nc = 0;
        const coneArr = coneMatrix.array;
        const lodD2 = lod ? lod.distance * lod.distance : Infinity;
        const add = (v, isParked) => {
            if (!v || v.visible === false) return;
            const e0 = kinds[kindOf(v)];
            if (!e0) return;
            const far = lod !== null && (v.x - lod.x) ** 2 + (v.y - lod.y) ** 2 > lodD2;
            const e = far ? e0.lod : e0;
            if (e.n >= e0.cap) return;
            const i = e.n++;
            const c = Math.cos(v.heading || 0), s = Math.sin(v.heading || 0);
            writeMatrix(e.matrix.array, i, c, s, v.x, v.y, Z);
            const col = linColor(v.color || '#ffffff');
            const pc = e.paintColor.array;
            pc[i * 3] = col[0]; pc[i * 3 + 1] = col[1]; pc[i * 3 + 2] = col[2];
            // luces traseras: apagadas (estacionado), de posición (noche), freno
            const tc = e.tailColor.array;
            let tr = 0.32, tg = 0.04, tb = 0.035;
            if (!isParked) {
                if (v.braking) { tr = night ? 2.2 : 1.0; tg = night ? 0.18 : 0.08; tb = night ? 0.12 : 0.06; }
                else if (night) { tr = 0.95; tg = 0.07; tb = 0.05; }
            }
            tc[i * 3] = tr; tc[i * 3 + 1] = tg; tc[i * 3 + 2] = tb;
            if (!far && e.extra && v.passenger) writeMatrix(e.extraMatrix.array, e.nx++, c, s, v.x, v.y, Z);
            if (night && !isParked && nc < coneCap) {
                const Lc = e0.cone[0], Wc = e0.cone[1], h = e0.front;
                const o = nc++ * 16;
                coneArr[o] = c * Lc; coneArr[o + 1] = s * Lc; coneArr[o + 2] = 0; coneArr[o + 3] = 0;
                coneArr[o + 4] = -s * Wc; coneArr[o + 5] = c * Wc; coneArr[o + 6] = 0; coneArr[o + 7] = 0;
                coneArr[o + 8] = 0; coneArr[o + 9] = 0; coneArr[o + 10] = 1; coneArr[o + 11] = 0;
                coneArr[o + 12] = v.x + c * h; coneArr[o + 13] = v.y + s * h; coneArr[o + 14] = 0.07; coneArr[o + 15] = 1;
            }
        };
        if (vehicles) for (let k = 0; k < vehicles.length; k++) add(vehicles[k], false);
        if (parked) for (let k = 0; k < parked.length; k++) add(parked[k], true);
        const upload = (attr, n, size) => {
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, n * size);
            attr.needsUpdate = true;
        };
        for (const k of KINDS) {
            const e = kinds[k];
            const L = e.lod;
            for (const m of L.meshes) { m.count = L.n; m.visible = L.n > 0; }
            if (L.n > 0) { upload(L.matrix, L.n, 16); upload(L.paintColor, L.n, 3); upload(L.tailColor, L.n, 3); }
            for (const m of [e.paint, e.detail, e.head, e.tail]) if (m) { m.count = e.n; m.visible = e.n > 0; }
            if (e.n > 0) {
                e.matrix.clearUpdateRanges();
                e.matrix.addUpdateRange(0, e.n * 16);
                e.matrix.needsUpdate = true;
                e.paintColor.clearUpdateRanges();
                e.paintColor.addUpdateRange(0, e.n * 3);
                e.paintColor.needsUpdate = true;
                e.tailColor.clearUpdateRanges();
                e.tailColor.addUpdateRange(0, e.n * 3);
                e.tailColor.needsUpdate = true;
            }
            if (e.extra) {
                e.extra.count = e.nx;
                if (e.nx > 0) {
                    e.extraMatrix.clearUpdateRanges();
                    e.extraMatrix.addUpdateRange(0, e.nx * 16);
                    e.extraMatrix.needsUpdate = true;
                }
            }
        }
        cones.count = nc;
        cones.visible = nc > 0;
        if (nc > 0) {
            coneMatrix.clearUpdateRanges();
            coneMatrix.addUpdateRange(0, nc * 16);
            coneMatrix.needsUpdate = true;
        }
        if (lights !== lastNight) {
            lastNight = lights;
            // faros: gris claro de día, blanco cálido intenso de noche
            const k = Math.min(1, Math.max(0, (lights - 0.3) / 0.4));
            headMat.color.setRGB(0.78 + 0.6 * k, 0.8 + 0.55 * k, 0.76 + 0.35 * k);
            coneMat.opacity = night ? 0.25 + 0.4 * k : 0;
        }
    }

    function dispose() {
        for (const g of geometries) g.dispose();
        for (const m of [paintMat, detailMat, headMat, tailMat, coneMat]) m.dispose();
        group.clear();
    }

    return {
        group,
        update,
        dispose,
        stats: () => Object.fromEntries(KINDS.map((k) => [k, kinds[k].n + kinds[k].lod.n])),
        /** Cuántos van con el modelo simple (de lejos). */
        farCount: () => KINDS.reduce((n, k) => n + kinds[k].lod.n, 0),
    };
}

export { DIMENSIONS };
