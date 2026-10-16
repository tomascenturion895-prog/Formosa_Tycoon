// Retranqueo de huellas: saca los edificios de la calzada y de los cruces. Puro (sin DOM ni WebGL), determinista.
//
// Las propiedades reales vienen de OSM (y los comercios sin polígono, como un cuadrado de 12 × 12 m puesto sobre el
// punto del local): a veces la huella pisa la calle o la esquina. La propiedad no se borra (es comprable: conserva id,
// picking y color); sólo se le corrige la forma antes de armar el molde:
//   1) si ningún punto de la huella cae sobre asfalto (calzada, cruce o pasillo de playa) + margen: queda igual;
//   2) si pisa, se densifican las aristas largas y cada vértice que cae sobre el asfalto se empuja hacia el centro de la
//      huella hasta el borde libre (queda recortada contra la calle);
//   3) si el resultado es degenerado (< 35 % del área, se autointersecta o el centro sigue sobre la calle) la huella se
//      reduce a una caja chica orientada como la original y corrida lejos de la calle hasta que quepa entera fuera.
import { normalizeRing, signedArea, orientedBox } from './city-geometry.js';

const PAD = 0.3; // m extra de aire entre la huella y el asfalto
export const MIN_KEEP = 0.35; // fracción mínima del área original para aceptar el recorte
const DENSIFY = 3; // m: paso máximo de las aristas antes de recortar
const SAMPLE = 2.5; // m: paso de la grilla de control dentro de la huella

function pip(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
}

/** Puntos de control de una huella: vértices, puntos medios de aristas y una grilla interior. */
function controlPoints(ring) {
    const pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        pts.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        if (a[0] < x0) x0 = a[0]; if (a[0] > x1) x1 = a[0];
        if (a[1] < y0) y0 = a[1]; if (a[1] > y1) y1 = a[1];
    }
    const nx = Math.max(1, Math.ceil((x1 - x0) / SAMPLE)), ny = Math.max(1, Math.ceil((y1 - y0) / SAMPLE));
    for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
            const x = x0 + ((x1 - x0) * i) / nx, y = y0 + ((y1 - y0) * j) / ny;
            if (pip(x, y, ring)) pts.push([x, y]);
        }
    }
    return pts;
}

/** Fracción de puntos de control sobre asfalto. */
export function coverage(ring, blocked) {
    const pts = controlPoints(ring);
    let n = 0;
    for (const [x, y] of pts) if (blocked(x, y)) n++;
    return pts.length ? n / pts.length : 0;
}

function densify(ring, step) {
    const out = [];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(L / step));
        for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    return out;
}

function centroid(ring) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const w = a[0] * b[1] - b[0] * a[1];
        A += w; cx += (a[0] + b[0]) * w; cy += (a[1] + b[1]) * w;
    }
    if (Math.abs(A) < 1e-9) {
        let sx = 0, sy = 0;
        for (const [x, y] of ring) { sx += x; sy += y; }
        return [sx / ring.length, sy / ring.length];
    }
    return [cx / (3 * A), cy / (3 * A)];
}

function segCross(a, b, c, d) {
    const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
    const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
    return d1 * d2 < 0 && d3 * d4 < 0;
}

function isSimple(ring) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            if (segCross(a, b, ring[j], ring[(j + 1) % n])) return false;
        }
    }
    return true;
}

/** Saca vértices repetidos o alineados (el recorte deja muchos puntos sobre el borde de la calle). */
function tidy(ring) {
    let out = ring.filter((p, i) => Math.hypot(p[0] - ring[(i + ring.length - 1) % ring.length][0], p[1] - ring[(i + ring.length - 1) % ring.length][1]) > 0.25);
    let changed = true;
    while (changed && out.length > 4) {
        changed = false;
        for (let i = 0; i < out.length && out.length > 4; i++) {
            const p = out[(i + out.length - 1) % out.length], q = out[i], r = out[(i + 1) % out.length];
            const L = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1;
            if (Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / L < 0.12) { out.splice(i, 1); i--; changed = true; }
        }
    }
    return out;
}

/**
 * Corrige una huella que pisa el asfalto.
 * @param ring    anillo [x, y] en metros locales (cualquier orientación)
 * @param query   city-roads query: usa `onAsphalt(x, y, margen)` (si no hay, cae en `onRoad`) y `nearest` (dirección hacia la calle)
 * @param options { overlaps?(corners) → true si esa caja pisa otra propiedad (sólo para elegir dónde correr la caja chica) }
 * @returns { ring, status: 'ok' | 'recortada' | 'caja' | 'sin-cambio', moved: m que se corrió el centro }
 */
export function setbackFootprint(ring, query, { overlaps = null } = {}) {
    const keepAsIs = { ring, status: 'ok', moved: 0 };
    if (!query || ring.length < 3) return keepAsIs;
    const asphalt = query.onAsphalt ?? ((x, y, m) => query.onRoad(x, y, m));
    const blocked = (x, y) => asphalt(x, y, PAD + 0.2);
    // descarte rápido: si ninguna calle (con su vereda) llega a la circunferencia de la huella, no pisa asfalto
    if (query.onRoad) {
        let sx = 0, sy = 0;
        for (const [x, y] of ring) { sx += x; sy += y; }
        const mx = sx / ring.length, my = sy / ring.length;
        let r = 0;
        for (const [x, y] of ring) r = Math.max(r, Math.hypot(x - mx, y - my));
        if (!query.onRoad(mx, my, r + 1.5)) return keepAsIs;
    }
    const norm = normalizeRing(ring);
    if (coverage(norm, blocked) === 0) return keepAsIs;

    const area0 = Math.abs(signedArea(norm));
    // ---- 2) recorte: cada vértice sobre asfalto se corre hacia el centro hasta quedar libre
    const dense = densify(norm, DENSIFY);
    const c = centroid(norm);
    let degenerate = blocked(c[0], c[1]);
    // 2a) primero: cada vértice sobre el asfalto se empuja, en el sentido que se aleja de la calle vista desde el centro de la
    // huella, hasta el borde del cordón (recorte de lo que queda del otro lado: la huella queda de este lado de la calle)
    const nearC = query.nearest?.(c[0], c[1], true);
    const empujar = (ring2) => {
        if (!nearC) return null;
        let dx = -nearC.dirX, dy = -nearC.dirY;
        if (nearC.dist < 1e-6) { dx = 0; dy = 0; }
        const l = Math.hypot(dx, dy);
        if (l < 1e-6) return null;
        dx /= l; dy /= l;
        const out = [];
        for (const p of ring2) {
            let x = p[0], y = p[1];
            if (blocked(x, y)) {
                let ok = false;
                for (let it = 0; it < 45; it++) {
                    x += dx * 0.4; y += dy * 0.4;
                    if (!blocked(x, y)) { ok = true; x += dx * 0.2; y += dy * 0.2; break; }
                }
                if (!ok) return null;
            }
            out.push([x, y]);
        }
        return out;
    };
    const accept = (list) => {
        const r = tidy(list);
        if (r.length < 3) return null;
        const area = Math.abs(signedArea(r));
        if (area >= area0 * MIN_KEEP && area >= 9 && isSimple(r) && coverage(r, blocked) === 0) {
            const cc = centroid(r);
            return { ring: normalizeRing(r), status: 'recortada', moved: Math.hypot(cc[0] - c[0], cc[1] - c[1]) };
        }
        return null;
    };
    {
        const pushed = empujar(dense);
        const res = pushed && accept(pushed);
        if (res) return res;
    }
    // 2b) si no, hacia el centro de la huella (sirve cuando la calle queda a un costado)
    const clipped = [];
    if (!degenerate) {
        for (const p of dense) {
            if (!blocked(p[0], p[1])) { clipped.push(p); continue; }
            const dx = c[0] - p[0], dy = c[1] - p[1];
            const L = Math.hypot(dx, dy) || 1;
            let d = 0.4, hit = false;
            for (; d <= L; d += 0.4) if (!blocked(p[0] + (dx / L) * d, p[1] + (dy / L) * d)) { hit = true; break; }
            if (!hit) { degenerate = true; break; }
            clipped.push([p[0] + (dx / L) * (d + 0.2), p[1] + (dy / L) * (d + 0.2)]);
        }
    }
    if (!degenerate) {
        const r = tidy(clipped);
        if (r.length >= 3) {
            const area = Math.abs(signedArea(r));
            if (area >= area0 * MIN_KEEP && area >= 9 && isSimple(r) && coverage(r, blocked) === 0) {
                const cc = centroid(r);
                return { ring: normalizeRing(r), status: 'recortada', moved: Math.hypot(cc[0] - c[0], cc[1] - c[1]) };
            }
        }
    }

    // ---- 3) caja chica orientada como la original, corrida lejos de la calle hasta que entre entera
    const box = orientedBox(norm);
    const near = query.nearest?.(c[0], c[1], true);
    const away = near && near.dist > 1e-6 ? [-near.dirX, -near.dirY] : null;
    const dirs = [];
    if (away) dirs.push(away, [away[0] * 0.7071 - away[1] * 0.7071, away[0] * 0.7071 + away[1] * 0.7071], [away[0] * 0.7071 + away[1] * 0.7071, -away[0] * 0.7071 + away[1] * 0.7071]);
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]]) dirs.push(d);
    const mk = (cx, cy, s) => {
        const A = Math.max(1.5, box.halfLong * s), B = Math.max(1.5, box.halfShort * s);
        const at = (su, sv) => [cx + box.u[0] * su * A + box.v[0] * sv * B, cy + box.u[1] * su * A + box.v[1] * sv * B];
        return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
    };
    // primero evitando pisar otras propiedades; si no hay lugar así, sólo evitando la calle
    for (const avoid of overlaps ? [true, false] : [false]) {
        for (const s of [1, 0.8, 0.65, 0.5, 0.4]) {
            if (s * s * box.halfLong * box.halfShort * 4 < 9 && s < 1) break;
            for (const dir of dirs) {
                for (let d = s === 1 && dir === dirs[0] ? 0 : 0.5; d <= 32; d += 0.5) {
                    const cx = box.cx + dir[0] * d, cy = box.cy + dir[1] * d;
                    const r = mk(cx, cy, s);
                    if (coverage(r, blocked) > 0) continue;
                    if (avoid && overlaps(r)) continue;
                    return { ring: normalizeRing(r), status: 'caja', moved: Math.hypot(cx - c[0], cy - c[1]) };
                }
            }
        }
    }
    return { ring, status: 'sin-cambio', moved: 0 };
}
