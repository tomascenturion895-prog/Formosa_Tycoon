// Sala de espera: diálogo con el código, quién está y el botón de iniciar. Se puede cerrar para explorar el mapa mientras tanto.
// Las salas abiertas, crear y unirse por código viven en el lobby (/mapa). Todo el texto va con textContent: nunca como HTML.
import { ApiError } from './api.js';
import { formatCountdown, lobbyExpiry } from './partida.js';
import { ownerColor } from './owners.js';
import { trapFocus } from './focus-trap.js';

export function createWaitingRoom({ $, user, game, onChange, onLeft }) {
    const overlay = $('lobby');
    let open = false;
    let opener = null;
    let busy = false;
    let tick = null;

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };

    const inRoom = () => game?.state.match?.status === 'lobby';

    function sayRoom(text, isError = true) {
        const n = $('room-msg');
        n.textContent = text;
        n.classList.toggle('error', isError && text !== '');
        n.hidden = text === '';
    }

    function setBusy(on) {
        busy = on;
        for (const id of ['room-start', 'room-leave']) {
            const b = $(id);
            if (b) b.disabled = on;
        }
        if (!on) renderRoom();
    }

    function renderRoom() {
        const m = game?.state.match;
        if (!m || m.status !== 'lobby') return;
        const players = game.state.players;
        $('room-code').textContent = m.code;
        $('room-count').textContent = `(${m.players} de ${m.capacity})`;
        const isCreator = user && m.creator_id === user.id;
        $('room-meta').textContent = `${m.name} · ${m.is_public ? 'sala pública' : 'sala privada: se entra con el código'} · cupo ${m.capacity}`;
        $('room-players').replaceChildren(...players.map((p) => {
            const li = el('li', 'player-item');
            const dot = el('span', 'row-dot');
            dot.style.background = ownerColor(p.user_id);
            dot.setAttribute('aria-hidden', 'true');
            const name = el('span', 'player-name', p.user_id === user?.id ? `${p.name} (vos)` : p.name);
            li.append(dot, name);
            if (p.is_creator) li.append(el('span', 'badge', 'Creador'));
            return li;
        }));
        const enough = m.players >= m.min_players;
        const start = $('room-start');
        start.hidden = !isCreator;
        start.disabled = busy || !enough;
        start.textContent = enough ? 'Iniciar partida' : `Iniciar (faltan ${m.min_players - m.players})`;
        const left = lobbyExpiry(m, game.serverNow());
        const expiry = left == null ? '' : ` La sala se cierra en ${formatCountdown(left)} si nadie la inicia.`;
        $('room-wait').textContent = (isCreator
            ? (enough ? 'Cuando estén todos, iniciá la partida.' : `Necesitás al menos ${m.min_players} jugadores para iniciar. Compartí el código o el enlace de esta página.`)
            : 'Esperando que el creador inicie la partida.') + expiry;
    }

    async function act(fn) {
        if (busy) return;
        setBusy(true);
        sayRoom('');
        try {
            await fn();
            await onChange();
        } catch (err) {
            sayRoom(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor. Probá de nuevo.');
        } finally {
            setBusy(false);
        }
    }

    $('room-start')?.addEventListener('click', () => act(() => game.start()));
    $('room-leave')?.addEventListener('click', () => act(async () => {
        await game.leave();
        game.clear();
        onLeft();
    }));
    $('room-copy')?.addEventListener('click', async () => {
        const code = $('room-code').textContent;
        try {
            await navigator.clipboard.writeText(code);
            sayRoom('Código copiado.', false);
        } catch {
            sayRoom(`Código: ${code}`, false);
        }
    });
    $('lobby-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    trapFocus(overlay, close);

    function openDialog(button) {
        if (open || !inRoom()) return;
        opener = button ?? document.activeElement;
        open = true;
        overlay.hidden = false;
        sayRoom('');
        renderRoom();
        tick = setInterval(() => { if (inRoom()) renderRoom(); }, 1000);
        $('room-leave').focus({ preventScroll: true });
    }

    function close() {
        if (!open) return;
        open = false;
        overlay.hidden = true;
        clearInterval(tick);
        if (opener && document.contains(opener) && !opener.hidden) opener.focus({ preventScroll: true });
        else document.body.focus?.();
    }

    $('btn-room')?.addEventListener('click', (e) => openDialog(e.currentTarget));

    return {
        open: openDialog,
        close,
        isOpen: () => open,
        /** Cambió la partida del jugador (alguien entró, empezó…): se redibuja lo que esté a la vista. */
        refresh() {
            if (!open) return;
            if (!inRoom()) {
                close();
            } else {
                renderRoom();
            }
        },
    };
}
