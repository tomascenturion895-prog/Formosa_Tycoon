// Playas de estacionamiento a partir de los pasillos que ya trae OSM (service sin nombre). Puro (sin DOM ni WebGL).
//
// OSM dibuja sólo los pasillos (líneas); lo que queda ENTRE los pasillos (las islas de cajones) es el lote. Acá se
// detectan esas islas (relleno por celdas de 1 m: lo que queda encerrado entre pasillos, sin tocar la calle ni los
// edificios), se las pavimenta, se arman cajones alineados con el pasillo vecino (filas de 5 m de fondo, espalda con
// espalda, nariz hacia el pasillo) y se estacionan autos dentro de los cajones (~60 %). Nada de esto sale de la playa.
import { hash01 } from './city-geometry.js';

const CELL = 1;
const STALL_W = 2.6;
const STALL_D = 5;
const MAX_CELLS = 250000;
const MIN_ISLAND = 25; // m² mínimos de una isla para pavimentarla
const MAX_ISLAND = 20000;

/**
 * @param ways    [{ pts:[[x,y]…], w }]  pasillos (w = semiancho del asfalto, m)
 * @param options { blocked?(x, y) → true donde NO se puede pavimentar (calle de verdad, edificio), occupancy = 0.6 }
 * @returns { fills:[[x0,y0,x1,y1]…] (rectángulos de 1 m de alto, ya unidos por fila), stalls:[{x,y,ux,uy,vx,vy,dir,row}],
 *            lines:[[ax,ay,bx,by]…] (líneas de los cajones), cars:[{x,y,dirX,dirY,key}], boxes:[{minX,minY,maxX,maxY}], area }
 */
export function buildLots(ways, { blocked = null, occupancy = 0.6 } = {}) {
    const out = { fills: [], stalls: [], lines: [], cars: [], boxes: [], area: 0 };
    const list = (ways ?? []).filter((w) => w?.pts?.length >= 2);
    if (!list.length) return out;
    // ---- agrupar los pasillos que se tocan (cajas inflables 3 m)
    const bb = list.map((w) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of w.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        const m = w.w + 3;
        return [x0 - m, y0 - m, x1 + m, y1 + m];
    });
    const par = list.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = bb[i], b = bb[j];
            if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) par[find(j)] = find(i);
        }
    }
    const groups = new Map();
    list.forEach((w, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); });
    for (const g of groups.values()) lotCluster(g, out, blocked, occupancy);
    return out;
}

function lotCluster(ways, out, blocked, occupancy) {
    // un pasillo solo (que no cierra un anillo) no encierra nada: no hay lote que pavimentar
    if (ways.length === 1) {
        const p = ways[0].pts;
        if (Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) > ways[0].w * 2) return;
    }
    // caja del grupo (+ margen)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, wMax = 0;
    for (const w of ways) {
        wMax = Math.max(wMax, w.w);
        for (const [x, y] of w.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    const pad = wMax + 4;
    x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
    const nx = Math.ceil((x1 - x0) / CELL), ny = Math.ceil((y1 - y0) / CELL);
    if (nx * ny > MAX_CELLS || nx < 8 || ny < 8) return;
    out.boxes.push({ minX: x0, minY: y0, maxX: x1, maxY: y1 });

    // ---- celdas: 1 = asfalto del pasillo (dist < w), 2 = banda de cierre (w … w+1: tapa huequitos de hasta 2 m), 4 = bloqueada
    const cls = new Uint8Array(nx * ny);
    for (const w of ways) {
        const R = w.w + 1;
        for (let i = 0; i + 1 < w.pts.length; i++) {
            const [ax, ay] = w.pts[i], [bx, by] = w.pts[i + 1];
            const sx0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / CELL)), sx1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + R - x0) / CELL));
            const sy0 = Math.max(0, Math.floor((Math.min(ay, by) - R - y0) / CELL)), sy1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + R - y0) / CELL));
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
            for (let iy = sy0; iy <= sy1; iy++) {
                for (let ix = sx0; ix <= sx1; ix++) {
                    const px = x0 + (ix + 0.5) * CELL, py = y0 + (iy + 0.5) * CELL;
                    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
                    const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
                    const k = iy * nx + ix;
                    if (d < w.w) cls[k] |= 1;
                    else if (d < R) cls[k] |= 2;
                }
            }
        }
    }
    if (blocked) {
        // se consulta de a bloques de 3 × 3 celdas (en el centro del bloque): `blocked` es lo más caro y los edificios
        // son de varios metros; el error de borde (≤ 1,5 m) queda debajo del propio edificio
        const B = 3, bx = Math.ceil(nx / B), by = Math.ceil(ny / B);
        const memo = new Int8Array(bx * by).fill(-1);
        for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
                const k = iy * nx + ix;
                if (cls[k] & 3) continue; // el pasillo y su banda ya son sólidos
                const m = ((iy / B) | 0) * bx + ((ix / B) | 0);
                if (memo[m] < 0) memo[m] = blocked(x0 + (((ix / B) | 0) * B + B / 2) * CELL, y0 + (((iy / B) | 0) * B + B / 2) * CELL) ? 1 : 0;
                if (memo[m]) cls[k] |= 4;
            }
        }
    }
    // ---- el "afuera": se llega desde el borde de la caja sin cruzar pasillo, banda ni bloqueo
    const solid = (k) => (cls[k] & 7) !== 0;
    const outside = new Uint8Array(nx * ny);
    const stack = [];
    const push = (ix, iy) => {
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return;
        const k = iy * nx + ix;
        if (outside[k] || solid(k)) return;
        outside[k] = 1;
        stack.push(k);
    };
    for (let ix = 0; ix < nx; ix++) { push(ix, 0); push(ix, ny - 1); }
    for (let iy = 0; iy < ny; iy++) { push(0, iy); push(nx - 1, iy); }
    while (stack.length) {
        const k = stack.pop();
        const ix = k % nx, iy = (k / nx) | 0;
        push(ix + 1, iy); push(ix - 1, iy); push(ix, iy + 1); push(ix, iy - 1);
    }
    // encerradas = libres que no son "afuera"
    const enc = new Uint8Array(nx * ny);
    for (let k = 0; k < enc.length; k++) if (!solid(k) && !outside[k]) enc[k] = 1;
    // crecer 1 celda hacia la banda de cierre y hacia el pasillo (sin pisar bloqueos): las islas llegan justo al borde del asfalto
    const fill = new Uint8Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
            const k = iy * nx + ix;
            if (enc[k]) { fill[k] = 1; continue; }
            if (cls[k] & 4) continue;
            if (cls[k] & 1) { fill[k] = 0; continue; } // el pasillo ya está dibujado
            // banda de cierre: se pavimenta si toca una celda encerrada
            let touch = false;
            for (let dy = -1; dy <= 1 && !touch; dy++) for (let dx = -1; dx <= 1; dx++) {
                const jx = ix + dx, jy = iy + dy;
                if (jx >= 0 && jy >= 0 && jx < nx && jy < ny && enc[jy * nx + jx]) { touch = true; break; }
            }
            if (touch && (cls[k] & 2)) fill[k] = 1;
        }
    }
    // ---- islas (componentes conexas de `fill`)
    const label = new Int32Array(nx * ny).fill(-1);
    const islands = [];
    for (let k0 = 0; k0 < fill.length; k0++) {
        if (!fill[k0] || label[k0] >= 0) continue;
        const id = islands.length;
        const cells = [];
        label[k0] = id;
        stack.push(k0);
        while (stack.length) {
            const k = stack.pop();
            cells.push(k);
            const ix = k % nx, iy = (k / nx) | 0;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const jx = ix + dx, jy = iy + dy;
                if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
                const j = jy * nx + jx;
                if (fill[j] && label[j] < 0) { label[j] = id; stack.push(j); }
            }
        }
        islands.push(cells);
    }
    const keep = islands.map((c) => c.length >= MIN_ISLAND && c.length <= MAX_ISLAND);
    // ---- rectángulos de relleno (corridas por fila)
    for (let iy = 0; iy < ny; iy++) {
        let ix = 0;
        while (ix < nx) {
            const k = iy * nx + ix;
            if (!fill[k] || !keep[label[k]]) { ix++; continue; }
            const s = ix;
            while (ix < nx && fill[iy * nx + ix] && keep[label[iy * nx + ix]]) ix++;
            out.fills.push([x0 + s * CELL, y0 + iy * CELL, x0 + ix * CELL, y0 + (iy + 1) * CELL]);
        }
    }
    const inFill = (x, y) => {
        const ix = Math.floor((x - x0) / CELL), iy = Math.floor((y - y0) / CELL);
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return false;
        const k = iy * nx + ix;
        return !!fill[k] && keep[label[k]];
    };
    // ---- cajones por isla, alineados con el pasillo más largo que la rodea
    islands.forEach((cells, id) => {
        if (!keep[id]) return;
        out.area += cells.length * CELL * CELL;
        let cx = 0, cy = 0, rMax = 0;
        for (const k of cells) { cx += x0 + ((k % nx) + 0.5) * CELL; cy += y0 + (((k / nx) | 0) + 0.5) * CELL; }
        cx /= cells.length; cy /= cells.length;
        for (const k of cells) rMax = Math.max(rMax, Math.hypot(x0 + ((k % nx) + 0.5) * CELL - cx, y0 + (((k / nx) | 0) + 0.5) * CELL - cy));
        let best = null, bl = 0;
        for (const w of ways) {
            for (let i = 0; i + 1 < w.pts.length; i++) {
                const [ax, ay] = w.pts[i], [bx, by] = w.pts[i + 1];
                const L = Math.hypot(bx - ax, by - ay);
                if (L < 4) continue;
                const mx = (ax + bx) / 2, my = (ay + by) / 2;
                if (Math.hypot(mx - cx, my - cy) > rMax + w.w + 3 + L / 2) continue;
                if (L > bl) { bl = L; best = [(bx - ax) / L, (by - ay) / L]; }
            }
        }
        if (!best) return;
        const [ux, uy] = best, vx = -uy, vy = ux;
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const k of cells) {
            const px = x0 + ((k % nx) + 0.5) * CELL, py = y0 + (((k / nx) | 0) + 0.5) * CELL;
            const u = px * ux + py * uy, v = px * vx + py * vy;
            if (u < u0) u0 = u; if (u > u1) u1 = u;
            if (v < v0) v0 = v; if (v > v1) v1 = v;
        }
        const at = (u, v) => [u * ux + v * vx, u * uy + v * vy];
        const okStall = (u, v) => {
            // el cajón entero adentro de la isla (esquinas, bordes y centro)
            for (const [a, b] of [[0.1, 0.1], [STALL_W - 0.1, 0.1], [STALL_W - 0.1, STALL_D - 0.1], [0.1, STALL_D - 0.1], [STALL_W / 2, 0.1], [STALL_W / 2, STALL_D - 0.1], [0.1, STALL_D / 2], [STALL_W - 0.1, STALL_D / 2], [STALL_W / 2, STALL_D / 2]]) {
                const [px, py] = at(u + a, v + b);
                if (!inFill(px, py)) return false;
            }
            return true;
        };
        const rows = [];
        for (let v = v0; v + STALL_D <= v1 + 0.3; v += STALL_D) {
            const r = [];
            for (let u = u0, c = 0; u + STALL_W <= u1 + 0.3; u += STALL_W, c++) if (okStall(u, v)) r.push({ u, v, c });
            rows.push(r);
        }
        const used = rows.map((r, i) => (r.length ? i : -1)).filter((i) => i >= 0);
        if (!used.length) return;
        const half = (used[0] + used.at(-1)) / 2;
        const seen = new Set();
        rows.forEach((r, ri) => {
            const dir = ri <= half ? -1 : 1; // nariz hacia el pasillo más cercano
            for (const s of r) {
                const [px, py] = at(s.u + STALL_W / 2, s.v + STALL_D / 2);
                out.stalls.push({ x: px, y: py, ux, uy, vx, vy, dir, row: ri });
                for (const cc of [s.c, s.c + 1]) {
                    const key = ri * 100003 + cc;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const [ax, ay] = at(s.u + (cc === s.c ? 0 : STALL_W), s.v + 0.2);
                    const [bx, by] = at(s.u + (cc === s.c ? 0 : STALL_W), s.v + STALL_D - 0.2);
                    out.lines.push([ax, ay, bx, by]);
                }
                const key = Math.round(px * 3) * 7919 + Math.round(py * 3);
                if (hash01(key, 161) < occupancy) {
                    const d = (hash01(key, 162) < 0.9 ? 1 : -1) * dir; // la mayoría de nariz, algunos de culata
                    out.cars.push({ x: px, y: py, dirX: vx * d, dirY: vy * d, key });
                }
            }
        });
    });
}

/** ¿Hay una playa (pasillo de playa) a menos de `r` metros de (x, y)? (cajas de los grupos de pasillos) */
export function nearLot(boxes, x, y, r = 0) {
    for (const b of boxes) if (x > b.minX - r && x < b.maxX + r && y > b.minY - r && y < b.maxY + r) return true;
    return false;
}
