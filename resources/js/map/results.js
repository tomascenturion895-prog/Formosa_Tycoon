// Pantalla de resultados al terminar la partida: mi puesto, patrimonio, propiedades, puntos y la tabla completa.
import { getJson, ApiError } from './api.js';
import { money, count } from './format.js';
import { ordinal } from './partida.js';
import { ownerColor } from './owners.js';
import { trapFocus } from './focus-trap.js';
import { podium, medal, mountArt } from './art.js';

export function createResults({ $, user, onAgain, onRanking, onResult = null }) {
    const overlay = $('results');
    let open = false;
    let opener = null;
    let shownId = null;

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };

    function say(text) {
        const n = $('results-msg');
        n.textContent = text;
        n.hidden = text === '';
        n.classList.toggle('error', text !== '');
    }

    function render(d) {
        const rows = d.players;
        $('results-name').textContent = d.match.name;
        const me = user ? rows.find((r) => r.user_id === user.id) : null;
        // Podio ilustrado con los tres primeros (con confeti si ganaste)
        $('results-art').replaceChildren(podium(rows, { meId: user?.id ?? null, confetti: !!me && !me.abandoned && me.rank === 1 }));
        $('results-me').hidden = !me;
        if (me) {
            $('results-place').textContent = me.abandoned ? 'Abandonaste' : ordinal(me.rank);
            $('results-of').textContent = me.abandoned ? '' : `de ${rows.length}`;
            $('results-worth').textContent = money(me.net_worth);
            $('results-props').textContent = count(me.properties);
            $('results-points').textContent = `+${count(me.points)}`;
            $('results-title').textContent = !me.abandoned && me.rank === 1 ? '¡Ganaste la partida!' : 'Partida terminada';
        } else {
            $('results-title').textContent = 'Partida terminada';
        }
        $('results-table').replaceChildren(...rows.map((r) => {
            const li = el('li', `result-row${r.user_id === user?.id ? ' me' : ''}${r.abandoned ? ' out' : ''}`);
            const pos = el('span', 'row-pos');
            if (r.abandoned) {
                pos.textContent = '–';
            } else if (r.rank <= 3) {
                mountArt(pos, medal(r.rank));
                pos.append(el('span', 'sr-only', `${r.rank}.º`));
            } else {
                pos.textContent = `${r.rank}`;
            }
            const dot = el('span', 'row-dot');
            dot.style.background = ownerColor(r.user_id);
            dot.setAttribute('aria-hidden', 'true');
            const main = el('span', 'row-main');
            main.append(
                el('span', 'row-title', r.user_id === user?.id ? `${r.name} (vos)` : r.name),
                el('span', 'row-sub', `${r.abandoned ? 'Abandonó · ' : ''}${count(r.properties)} ${r.properties === 1 ? 'propiedad' : 'propiedades'}`),
            );
            const val = el('span', 'row-value', money(r.net_worth));
            val.append(el('small', '', `+${count(r.points)} pts`));
            li.append(pos, dot, main, val);
            return li;
        }));
    }

    /** Muestra los resultados de una partida terminada. */
    async function show(matchId, button) {
        if (open && shownId === matchId) return;
        say('');
        try {
            const d = await getJson(`/api/partidas/${matchId}/resultado`);
            shownId = matchId;
            render(d);
            onResult?.({ matchId, me: user ? d.players.find((r) => r.user_id === user.id) ?? null : null });
        } catch (err) {
            if (err instanceof ApiError && err.data?.error === 'partida_no_terminada') {
                return false;
            }
            $('results-table').replaceChildren();
            $('results-me').hidden = true;
            say('No se pudieron leer los resultados. Probá de nuevo.');
        }
        if (!open) {
            opener = button ?? document.activeElement;
            open = true;
            overlay.hidden = false;
            $('results-again').focus({ preventScroll: true });
        }
        return true;
    }

    function close() {
        if (!open) return;
        open = false;
        overlay.hidden = true;
        if (opener && document.contains(opener) && !opener.hidden) opener.focus({ preventScroll: true });
    }

    $('results-close').addEventListener('click', close);
    $('results-map').addEventListener('click', close);
    $('results-again').addEventListener('click', () => { close(); onAgain(); });
    $('results-ranking').addEventListener('click', () => { close(); onRanking(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    trapFocus(overlay, close);

    return { show, close, isOpen: () => open, shownId: () => shownId };
}
