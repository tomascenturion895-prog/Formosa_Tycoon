// Listas de ranking global e historial de partidas. Las usan el cajón de la pantalla de juego y el lobby.
// Los modelos son lógica pura (se prueban con `node --test`); `rowElement` arma el <li> con textContent: los nombres
// de jugadores y de partidas no son de confianza y nunca entran como HTML.
import { money, count } from './format.js';
import { ordinal, ago } from './partida.js';
import { medal as medalSvg, mountArt } from './art.js';

export const RANKING_NOTE = 'Puntos por partida: 1.º 100, 2.º 60, 3.º 35, el resto 15, más 1 por propiedad (hasta 20). Quien abandona no suma.';

const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

/**
 * Fila del ranking. `players` viene de /api/ranking y `mine` de /api/yo (o null).
 * Si no estoy entre los primeros, mi posición se agrega al final y la nota lo dice.
 */
export function rankingModel({ players, mine, user }) {
    const rows = players.map((r) => ({
        lead: r.position,
        title: r.name,
        sub: `${plural(r.matches, 'partida', 'partidas')} · ${plural(r.wins, 'victoria', 'victorias')}`,
        value: `${count(r.points)}`,
        small: 'puntos',
        me: user?.id === r.id,
    }));
    const rk = mine?.ranking;
    if (user && rk && !players.some((r) => r.id === user.id)) {
        rows.push({
            lead: `${rk.position}`,
            title: `${user.name} (vos)`,
            sub: `${plural(rk.matches, 'partida', 'partidas')} · ${plural(rk.wins, 'victoria', 'victorias')}`,
            value: `${count(rk.points)}`,
            small: 'puntos',
            me: true,
        });
    }
    let note = RANKING_NOTE;
    if (user && rk) {
        note = `Tu posición: ${rk.position}.º con ${count(rk.points)} ${rk.points === 1 ? 'punto' : 'puntos'}. ${note}`;
    }
    return { note, rows };
}

/** Historial de mis partidas (de /api/yo/historial). `nowMs` solo sirve para "hace 2 min". */
export function historyModel({ matches, nowMs = Date.now() }) {
    const wins = matches.filter((m) => m.rank === 1 && !m.abandoned).length;
    const points = matches.reduce((sum, m) => sum + (m.points ?? 0), 0);
    const note = matches.length ? `${plural(matches.length, 'partida', 'partidas')} · ${plural(wins, 'victoria', 'victorias')} · ${count(points)} puntos` : '';
    const rows = matches.map((m) => ({
        lead: m.abandoned ? '–' : ordinal(m.rank),
        title: m.name,
        sub: `${m.abandoned ? 'Abandonada' : `de ${m.players}`} · ${ago(m.finished_at, nowMs)} · ${plural(m.properties, 'propiedad', 'propiedades')}`,
        value: `+${count(m.points)}`,
        small: money(m.net_worth),
        me: m.rank === 1 && !m.abandoned,
    }));
    return { note, rows };
}

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

/** Puesto: medalla (SVG propio) para el 1.º, 2.º y 3.º; para el resto, el texto. */
function leadNode(lead) {
    if (typeof lead === 'number' && lead >= 1 && lead <= 3) {
        const span = el('span');
        mountArt(span, medalSvg(lead));
        span.append(el('span', 'sr-only', `${lead}.º`));
        return span;
    }
    return document.createTextNode(String(lead));
}

/**
 * <li> de una fila. Con `color` lleva el punto del jugador en lugar del puesto; con `onClick` es un botón.
 * Mantiene las clases `row-*` que ya estilizan el cajón y el lobby.
 */
export function rowElement({ lead, color, title, sub, value, small, me = false, onClick }) {
    const li = el('li', me ? 'me' : '');
    const inner = onClick ? el('button') : el('div');
    if (onClick) {
        inner.type = 'button';
        inner.addEventListener('click', onClick);
    }
    if (lead != null) {
        const pos = el('span', 'row-pos');
        pos.append(leadNode(lead));
        inner.append(pos);
    } else {
        const dot = el('span', 'row-dot');
        dot.style.background = color;
        inner.append(dot);
    }
    const main = el('span', 'row-main');
    main.append(el('span', 'row-title', title));
    if (sub) {
        main.append(el('span', 'row-sub', sub));
    }
    const val = el('span', 'row-value', value);
    if (small) {
        val.append(el('small', '', small));
    }
    inner.append(main, val);
    li.append(inner);
    return li;
}
