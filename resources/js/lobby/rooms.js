// Salas del lobby: lista de salas abiertas (en vivo), crear una sala y unirse con un código.
// Al crear o unirse el jugador pasa a la pantalla de la partida (/partida/CÓDIGO). Todo el texto va con textContent.
import { getJson, ApiError } from '../map/api.js';
import { seats, seatLabel } from './lobby-ui-model.js';
import { skeletonItems, setBusyList } from './skeleton.js';

export const matchUrl = (code) => `/partida/${encodeURIComponent(String(code).toUpperCase())}`;

export function createRooms({ $, user, game, onNavigate = (url) => window.location.assign(url) }) {
    const list = $('room-list');
    let rooms = [];
    let busy = false;
    let loadedOnce = false;
    let spinning = null; // botón que disparó la acción en curso (muestra el spinner)

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };

    function say(text, isError = true) {
        const n = $('lobby-msg');
        n.textContent = text;
        n.classList.toggle('error', isError && text !== '');
        n.hidden = text === '';
    }

    function setBusy(on) {
        busy = on;
        if (spinning) {
            spinning.toggleAttribute('data-loading', on);
            spinning.setAttribute('aria-busy', String(on));
            if (!on) spinning = null;
        }
        for (const id of ['room-create', 'code-join']) {
            const b = $(id);
            if (b) b.disabled = on;
        }
        for (const b of list.querySelectorAll('button')) {
            b.disabled = on || b.dataset.full === '1';
        }
    }

    function render() {
        list.replaceChildren(...rooms.map((m) => {
            const li = el('li', 'room-item room-card');
            const main = el('div', 'room-main');
            main.append(el('span', 'room-name', m.name), el('span', 'room-sub', `${m.creator ? `Creada por ${m.creator} · ` : ''}código ${m.code}`));
            const full = m.players >= m.capacity;
            const count = el('span', 'room-seats');
            count.setAttribute('role', 'img');
            count.setAttribute('aria-label', seatLabel(m.players, m.capacity));
            for (const taken of seats(m.players, m.capacity)) {
                count.append(el('i', taken ? 'seat on' : 'seat'));
            }
            count.append(el('span', 'room-count', `${m.players}/${m.capacity}`));
            const btn = el('button', 'primary', full ? 'Llena' : 'Unirme');
            btn.type = 'button';
            btn.dataset.full = full ? '1' : '0';
            btn.disabled = full || busy || !user;
            if (!user) btn.title = 'Ingresá para unirte';
            btn.setAttribute('aria-label', `${full ? 'Sala llena' : 'Unirme a'} ${m.name}`);
            btn.addEventListener('click', () => join(m.code, btn));
            li.append(main, count, btn);
            return li;
        }));
        setBusyList(list, false);
        $('room-empty').hidden = !loadedOnce || rooms.length > 0;
    }

    /** Relleno mientras llega el listado la primera vez (después se queda lo que ya había y se actualiza en silencio). */
    function showSkeleton() {
        list.replaceChildren(...skeletonItems('room'));
        setBusyList(list, true);
        $('room-empty').hidden = true;
    }

    async function load() {
        try {
            const d = await getJson('/api/partidas');
            game?.syncClock(d.server_now);
            rooms = d.matches;
            loadedOnce = true;
            render();
        } catch {
            loadedOnce = true;
            render();
            say('No se pudo leer el listado de salas.');
        }
    }

    /** Aviso en vivo del canal "lobby": una sala se abrió, cambió o se cerró. */
    function onLobbyEvent(e) {
        const m = e.match;
        if (!m) return;
        const at = rooms.findIndex((r) => r.id === m.id);
        if (e.open && m.status === 'lobby') {
            if (at >= 0) rooms[at] = { ...rooms[at], ...m };
            else rooms.push(m);
        } else if (at >= 0) {
            rooms.splice(at, 1);
        }
        render();
    }

    async function act(fn, button = null) {
        if (busy) return;
        spinning = button;
        setBusy(true);
        say('');
        try {
            const r = await fn();
            onNavigate(matchUrl(r?.match?.code ?? game.state.match.code));
            return;
        } catch (err) {
            if (err instanceof ApiError && err.data?.error === 'ya_estas_en_partida') {
                // Ya estabas en una sala o partida: se te lleva a ella.
                try {
                    await game.refresh();
                    if (game.state.match?.code) {
                        onNavigate(matchUrl(game.state.match.code));
                        return;
                    }
                } catch { /* cae al mensaje de abajo */ }
            }
            say(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor. Probá de nuevo.');
        }
        setBusy(false);
    }

    const join = (code, button = null) => act(() => game.join(code), button);

    $('room-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const nombre = $('room-name').value.trim() || `Sala de ${user.name}`;
        act(() => game.create({ nombre, cupo: Number($('room-cap').value), publica: $('room-public').checked }), $('room-create'));
    });
    $('code-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const code = $('code-input').value.trim();
        if (!/^[A-Za-z0-9]{4,12}$/.test(code)) {
            say('El código tiene entre 4 y 12 letras y números.');
            return;
        }
        join(code, $('code-join'));
    });

    if (loadedOnce === false) showSkeleton();

    return { load, render, onLobbyEvent, say };
}
