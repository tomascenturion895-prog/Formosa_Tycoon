// Cajón de listas: "Mis propiedades" (de la partida), "Ranking" global por puntos y "Mis partidas" (historial). En escritorio es un panel al lado del HUD; en celular, una hoja inferior.
// Todo el texto (apodos, nombres de OpenStreetMap) se escribe con textContent: nunca como HTML.
import { getJson } from './api.js';
import { money } from './format.js';
import { paybackText } from './partida.js';
import { ownerColor } from './owners.js';
import { comboLines } from './combos.js';
import { emptyRanking, emptyProperties, emptyHistory, mountArt } from './art.js';
import { rankingModel, historyModel, rowElement as row, RANKING_NOTE } from './lists.js';

export function createDrawer({ $, cfg, user, game, properties, onPick }) {
    const box = $('drawer');
    const list = $('drawer-list');
    const note = $('drawer-note');
    let current = null; // 'mine' | 'ranking' | 'history' | null
    let opener = null;

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) {
            e.className = cls;
        }
        if (text != null) {
            e.textContent = text;
        }
        return e;
    };

    /** Estado vacío con una ilustración (SVG propio, sin datos del servidor) y el texto con textContent. */
    function empty(art, text) {
        const li = el('li', 'drawer-empty');
        const holder = el('span');
        mountArt(holder, art);
        li.append(holder, document.createTextNode(text));
        return li;
    }

    function setButtons() {
        for (const [id, kind] of [['btn-mine', 'mine'], ['btn-ranking', 'ranking'], ['btn-history', 'history']]) {
            $(id)?.setAttribute('aria-expanded', String(current === kind));
        }
    }

    function close() {
        if (current === null) {
            return;
        }
        current = null;
        box.hidden = true;
        setButtons();
        opener?.focus({ preventScroll: true });
    }

    function title(p) {
        const label = cfg.kinds[p.kind]?.label ?? p.kind;
        return p.name ?? (p.street ? `${label} en ${p.street}` : label);
    }

    function renderMine() {
        $('drawer-title').textContent = 'Mis propiedades';
        const mine = [...game.state.props.values()].map((s) => ({ s, p: properties.get(s.id) })).filter((x) => x.p);
        mine.sort((a, b) => b.s.income_per_day - a.s.income_per_day);
        const combos = game.state.me?.combos;
        const zonePctById = new Map((combos?.zones ?? []).flatMap((z) => z.ids.map((id) => [id, z.pct])));
        const lines = comboLines(combos, new Set(mine.map((x) => x.p.kind)), cfg.combos, money);
        note.textContent = mine.length ? `${mine.length} ${mine.length === 1 ? 'propiedad' : 'propiedades'} · ${money(game.incomePerDay())} por día de juego. ${lines.join(' ')} Tocá una para verla en el mapa.` : '';
        list.replaceChildren(...(mine.length ? mine.map(({ s, p }) => row({
            color: cfg.kinds[p.kind]?.color ?? '#ccc',
            title: title(p),
            sub: `${cfg.kinds[p.kind]?.label ?? p.kind} · se recupera en ${paybackText(s.price, s.income_per_day).replace(' de juego', '')}${zonePctById.has(s.id) ? ` · combo de zona +${Math.round(zonePctById.get(s.id) * 100)} %` : ''}`,
            value: `${money(s.income_per_day)}`,
            small: 'por día',
            onClick: () => onPick(s.id),
        })) : [empty(emptyProperties(), game.isRunning() ? 'Todavía no tenés propiedades. Tocá un edificio libre del mapa para reclamarlo.' : 'Cuando estés en una partida, tus propiedades aparecen acá.')]));
    }

    async function renderRanking() {
        $('drawer-title').textContent = 'Ranking global';
        note.textContent = RANKING_NOTE;
        list.replaceChildren(el('li', 'drawer-empty', 'Cargando…'));
        try {
            const [{ players }, mine] = await Promise.all([
                getJson('/api/ranking'),
                user ? getJson('/api/yo').catch(() => null) : null,
            ]);
            if (current !== 'ranking') {
                return;
            }
            const model = rankingModel({ players, mine, user });
            note.textContent = model.note;
            list.replaceChildren(...(model.rows.length ? model.rows.map(row) : [empty(emptyRanking(), 'Todavía nadie sumó puntos. Jugá la primera partida.')]));
        } catch {
            list.replaceChildren(el('li', 'drawer-empty', 'No se pudo cargar el ranking. Probá de nuevo.'));
        }
    }

    async function renderHistory() {
        $('drawer-title').textContent = 'Mis partidas';
        note.textContent = '';
        if (!user) {
            list.replaceChildren(el('li', 'drawer-empty', 'Ingresá para ver tu historial.'));
            return;
        }
        list.replaceChildren(el('li', 'drawer-empty', 'Cargando…'));
        try {
            const { matches } = await getJson('/api/yo/historial');
            if (current !== 'history') {
                return;
            }
            const model = historyModel({ matches });
            note.textContent = model.note;
            list.replaceChildren(...(model.rows.length ? model.rows.map(row) : [empty(emptyHistory(), 'Todavía no terminaste ninguna partida.')]));
        } catch {
            list.replaceChildren(el('li', 'drawer-empty', 'No se pudo cargar tu historial. Probá de nuevo.'));
        }
    }

    function open(kind, button) {
        if (current === kind) {
            close();
            return;
        }
        opener = button ?? null;
        current = kind;
        box.hidden = false;
        setButtons();
        if (kind === 'mine') {
            renderMine();
        } else if (kind === 'history') {
            renderHistory();
        } else {
            renderRanking();
        }
        $('drawer-close').focus({ preventScroll: true });
    }

    $('btn-mine')?.addEventListener('click', (e) => open('mine', e.currentTarget));
    $('btn-ranking')?.addEventListener('click', (e) => open('ranking', e.currentTarget));
    $('btn-history')?.addEventListener('click', (e) => open('history', e.currentTarget));
    $('drawer-close').addEventListener('click', close);
    box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    });

    return {
        close,
        open: (kind, button) => { if (current !== kind) open(kind, button); },
        isOpen: () => current !== null,
        /** Vuelve a dibujar la lista abierta si depende del estado del jugador (después de comprar o vender). */
        refresh() {
            if (current === 'mine') {
                renderMine();
            }
        },
    };
}
