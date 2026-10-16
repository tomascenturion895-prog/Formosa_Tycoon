// Salas del lobby: lista de salas abiertas (en vivo), crear una sala y unirse con un código.
// Al crear o unirse el jugador pasa a la pantalla de la partida (/partida/CÓDIGO). Todo el texto va con textContent.
import { getJson, ApiError } from '../map/api.js';

export const matchUrl = (code) => `/partida/${encodeURIComponent(String(code).toUpperCase())}`;

export function createRooms({ $, user, game, onNavigate = (url) => window.location.assign(url) }) {
    const list = $('room-list');
    let rooms = [];
    let busy = false;

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
            const li = el('li', 'room-item');
            const main = el('div', 'room-main');
            main.append(el('span', 'room-name', m.name), el('span', 'room-sub', `${m.creator ? `Creada por ${m.creator} · ` : ''}código ${m.code}`));
            const full = m.players >= m.capacity;
            const count = el('span', 'room-count', `${m.players}/${m.capacity}`);
            count.setAttribute('aria-label', `${m.players} de ${m.capacity} jugadores`);
            const btn = el('button', null, full ? 'Llena' : 'Unirme');
            btn.type = 'button';
            btn.dataset.full = full ? '1' : '0';
            btn.disabled = full || busy || !user;
            if (!user) btn.title = 'Ingresá para unirte';
            btn.setAttribute('aria-label', `${full ? 'Sala llena' : 'Unirme a'} ${m.name}`);
            btn.addEventListener('click', () => join(m.code));
            li.append(main, count, btn);
            return li;
        }));
        $('room-empty').hidden = rooms.length > 0;
    }

    async function load() {
        try {
            const d = await getJson('/api/partidas');
            game?.syncClock(d.server_now);
            rooms = d.matches;
            render();
        } catch {
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

    async function act(fn) {
        if (busy) return;
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

    const join = (code) => act(() => game.join(code));

    $('room-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const nombre = $('room-name').value.trim() || `Sala de ${user.name}`;
        act(() => game.create({ nombre, cupo: Number($('room-cap').value), publica: $('room-public').checked }));
    });
    $('code-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const code = $('code-input').value.trim();
        if (!/^[A-Za-z0-9]{4,12}$/.test(code)) {
            say('El código tiene entre 4 y 12 letras y números.');
            return;
        }
        join(code);
    });

    return { load, render, onLobbyEvent, say };
}
