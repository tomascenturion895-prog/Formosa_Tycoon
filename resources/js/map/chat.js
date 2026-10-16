import { getJson, postJson, newKey, ApiError } from './api.js';
import { ownerColor } from './owners.js';
import {
    TABS, createFeed, isSystem, isOwn, countsAsUnread, badgeText, tabLabel, toggleLabel, totalUnread, pickTab, stepTab,
    roomTransition, composerText, chatErrorText,
} from './chat-model.js';

const OVERLAP = 20; // cuántos números hacia atrás se vuelve a pedir al ponerse al día
const PAGE = 100;   // tamaño de tanda del servidor (formosa.chat.per_read)
const KEEP_EARLY = 200;

const HINT = {
    sala: 'Solo tu partida. Incluye los avisos del juego.',
    salaLeer: 'Esta sala quedó solo para leer: ya no estás jugando esa partida.',
    global: 'Todos los jugadores. Charla libre.',
    globalSinSala: 'Estás sin partida: solo ves el chat global. Sumate a una partida para chatear con tu sala.',
    globalConSala: 'Todos los jugadores. Charla libre; lo de tu partida va en Sala.',
};

/**
 * Chat del mapa, con DOS canales en pestañas:
 *  - Sala: solo MI partida (jugadores y avisos automáticos del juego). Canal privado en tiempo real; sin partida no existe.
 *  - Global: todos los jugadores, charla libre.
 * El servidor guarda y numera los mensajes; acá se muestran en orden de número, sin repetir (el mismo mensaje puede llegar por
 * el aviso en vivo y por una lectura). Todo texto entra por textContent: nunca HTML.
 */
export function createChat({ user, $, cfg = {}, canNotify = () => true }) {
    let open = false;
    let sending = false;
    let openMenu = null; // el menú de opciones abierto (uno a la vez)
    let roomLive = false; // ¿el canal privado de la sala está suscripto? (si no, se lee cada tanto)

    const newPane = (name) => ({
        name,
        feed: createFeed(),
        log: $(`chat-log-${name}`),
        tab: $(`chat-tab-${name}`),
        panel: $(`chat-panel-${name}`),
        badge: $(`chat-badge-${name}`),
        hint: $(`chat-hint-${name}`),
        unread: 0,
        loaded: false,
        early: [],       // avisos en vivo que llegaron antes de la primera lectura
        draft: '',       // lo que se estaba escribiendo en este canal al cambiar de pestaña
        pending: null,   // { text, key }: un envío que falló por red; reintentarlo con la misma clave no duplica nada
        matchId: null,   // solo la sala
        status: null,
        readonly: false,
    });
    const panes = { sala: newPane('sala'), global: newPane('global') };
    let active = 'global';
    let saved = null;
    try {
        saved = localStorage.getItem('formosa.chat.pestana');
    } catch { /* sin almacenamiento */ }

    const body = $('chat-body');
    const toggle = $('chat-toggle');
    const badge = $('chat-unread');
    const form = $('chat-form');
    const input = $('chat-input');
    const inputLabel = $('chat-input-label');
    const sendBtn = $('chat-send');
    const note = $('chat-msg');
    const tablist = $('chat-tabs');

    const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const hasRoom = () => panes.sala.matchId != null;
    const counts = () => ({ sala: panes.sala.unread, global: panes.global.unread });

    function setNote(text, isError = true) {
        if (!note) {
            return;
        }
        note.textContent = text;
        note.classList.toggle('error', isError);
        note.hidden = text === '';
    }

    // ------------------------------------------------------------------ dibujo de mensajes

    function nodeFor(pane, m) {
        const li = document.createElement('li');
        li.dataset.id = String(m.id);
        if (isSystem(m)) {
            // Aviso automático del juego: sin autor, sin opciones (no se reporta ni se silencia).
            li.className = 'chat-item system';
            const time = document.createElement('time');
            time.className = 'chat-time';
            time.dateTime = new Date(m.at).toISOString();
            time.textContent = hhmm(m.at);
            const text = document.createElement('p');
            text.className = 'chat-text';
            const sr = document.createElement('span');
            sr.className = 'sr-only';
            sr.textContent = 'Aviso del juego: ';
            text.append(sr, document.createTextNode(m.body)); // texto, nunca HTML
            li.append(time, text);
            return li;
        }
        li.className = isOwn(m, user?.id) ? 'chat-item mine' : 'chat-item';
        const head = document.createElement('div');
        head.className = 'chat-head';
        const dot = document.createElement('span');
        dot.className = 'chat-dot';
        dot.style.background = ownerColor(m.user_id);
        dot.setAttribute('aria-hidden', 'true');
        const who = document.createElement('span');
        who.className = 'chat-who';
        who.textContent = m.user;
        const time = document.createElement('time');
        time.className = 'chat-time';
        time.dateTime = new Date(m.at).toISOString();
        time.textContent = hhmm(m.at);
        head.append(dot, who, time);
        if (user && !isOwn(m, user.id)) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'chat-more';
            more.textContent = '⋯';
            more.setAttribute('aria-label', `Opciones del mensaje de ${m.user}`);
            more.setAttribute('aria-expanded', 'false');
            more.addEventListener('click', () => toggleMenu(pane, m, li, more));
            head.append(more);
        }
        const text = document.createElement('p');
        text.className = 'chat-text';
        text.textContent = m.body; // textContent: el texto de otros jugadores nunca se interpreta como HTML
        li.append(head, text);
        return li;
    }

    const nearBottom = (log) => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const toBottom = (pane) => { pane.log.scrollTop = pane.log.scrollHeight; };

    function renderAll(pane) {
        pane.log.replaceChildren(...pane.feed.sorted().map((m) => nodeFor(pane, m)));
        toBottom(pane);
    }

    /** Saca un mensaje de la pantalla (lo ocultó un moderador o los reportes). */
    function removeFrom(pane, id) {
        if (pane.feed.remove(id)) {
            pane.log.querySelector(`[data-id="${id}"]`)?.remove();
        }
    }

    // ------------------------------------------------------------------ menú de un mensaje (reportar / moderar)

    const durationLabel = (m) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} d`);

    function button(text, onClick, cls = '') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chat-act ${cls}`.trim();
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    /** Menú de opciones de un mensaje: reportar (cualquier jugador) y, si sos moderador, ocultar o silenciar al autor. */
    function buildMenu(pane, m) {
        const menu = document.createElement('div');
        menu.className = 'chat-menu';
        menu.setAttribute('role', 'group');
        menu.setAttribute('aria-label', `Opciones del mensaje de ${m.user}`);

        const rep = document.createElement('div');
        rep.className = 'chat-menu-row';
        const lab = document.createElement('span');
        lab.textContent = 'Reportar:';
        rep.append(lab);
        for (const [key, text] of Object.entries(cfg.reasons ?? {})) {
            rep.append(button(text, () => act(pane, menu, `/api/chat/${m.id}/reportar`, { motivo: key }, 'Gracias, lo vamos a revisar.', m.id)));
        }
        menu.append(rep);

        if (user?.moderator) {
            const mod = document.createElement('div');
            mod.className = 'chat-menu-row';
            const l2 = document.createElement('span');
            l2.textContent = 'Moderar:';
            mod.append(l2, button('Ocultar', () => act(pane, menu, `/moderacion/mensajes/${m.id}/ocultar`, null, 'Mensaje oculto.', m.id, true), 'danger'));
            for (const mins of cfg.mute_minutes ?? []) {
                mod.append(button(`Silenciar ${durationLabel(mins)}`, () => act(pane, menu, `/moderacion/usuarios/${m.user_id}/silenciar`, { minutos: mins }, `${m.user} silenciado ${durationLabel(mins)} (sala y global).`), 'danger'));
            }
            menu.append(mod);
        }

        return menu;
    }

    async function act(pane, menu, url, payload, done, messageId, removeAfter = false) {
        setNote('');
        menu.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            const r = await postJson(url, {}, payload ?? {});
            closeMenu();
            if (r.hidden || removeAfter) {
                removeFrom(pane, messageId); // los reportes ocultaron el mensaje
            }
            setNote(done, false);
        } catch (err) {
            menu.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            setNote(explain(err));
        }
    }

    function closeMenu() {
        if (openMenu) {
            openMenu.menu.remove();
            openMenu.btn.setAttribute('aria-expanded', 'false');
            openMenu = null;
        }
    }

    function toggleMenu(pane, m, li, btn) {
        const wasOpen = openMenu?.btn === btn;
        closeMenu();
        if (wasOpen) {
            return;
        }
        const menu = buildMenu(pane, m);
        li.append(menu);
        btn.setAttribute('aria-expanded', 'true');
        openMenu = { menu, btn };
    }

    // ------------------------------------------------------------------ pestañas, insignias y campo de escribir

    function renderBadges() {
        for (const pane of Object.values(panes)) {
            if (!pane.badge) {
                continue;
            }
            const t = badgeText(pane.unread);
            pane.badge.hidden = t === '';
            pane.badge.textContent = t;
            pane.tab?.setAttribute('aria-label', tabLabel(pane.name, pane.unread));
        }
        const total = badgeText(totalUnread(counts()));
        badge.hidden = total === '';
        badge.textContent = total;
        toggle.setAttribute('aria-label', toggleLabel(counts()));
    }

    function renderHints() {
        const sala = panes.sala;
        if (sala.hint) {
            sala.hint.textContent = sala.readonly ? HINT.salaLeer : HINT.sala;
        }
        if (panes.global.hint) {
            panes.global.hint.textContent = !user ? HINT.global : hasRoom() ? HINT.globalConSala : HINT.globalSinSala;
        }
    }

    function applyComposer() {
        if (!form) {
            return;
        }
        const pane = panes[active];
        const c = composerText(active, { writable: !pane.readonly, loggedIn: !!user });
        input.placeholder = c.placeholder;
        input.disabled = c.disabled;
        sendBtn.disabled = c.disabled || sending;
        if (inputLabel) {
            inputLabel.textContent = c.label;
        }
    }

    /** Pasa a otro canal: cada uno conserva lo que se estaba escribiendo. */
    function moveActive(name) {
        if (input && name !== active) {
            panes[active].draft = input.value;
            input.value = panes[name].draft;
        }
        active = name;
    }

    function renderTabs() {
        const available = TABS.filter((t) => t === 'global' || hasRoom());
        if (!available.includes(active)) {
            moveActive(pickTab({ saved, hasRoom: hasRoom() }));
        }
        panes.sala.tab.hidden = !hasRoom();
        for (const pane of Object.values(panes)) {
            const on = pane.name === active;
            pane.tab.setAttribute('aria-selected', String(on));
            pane.tab.tabIndex = on ? 0 : -1;
            pane.tab.classList.toggle('on', on);
            pane.panel.hidden = !on;
        }
        // Con una sola pestaña (sin partida) no hace falta mostrar la tira: el título y la nota alcanzan.
        tablist.classList.toggle('single', available.length === 1);
        renderHints();
        renderBadges();
        applyComposer();
    }

    /** Cambia de pestaña. `focus` mueve el foco a la pestaña (teclado). */
    function setTab(name, { focus = false, remember = true } = {}) {
        if (name === 'sala' && !hasRoom()) {
            name = 'global';
        }
        closeMenu();
        setNote('');
        moveActive(name);
        if (remember) {
            saved = name;
            try {
                localStorage.setItem('formosa.chat.pestana', name);
            } catch { /* idem */ }
        }
        if (open) {
            panes[name].unread = 0;
        }
        renderTabs();
        if (focus) {
            panes[name].tab.focus();
        }
        if (open) {
            toBottom(panes[name]);
        }
        if (name === 'sala' && panes.sala.readonly) {
            resyncPane(panes.sala).catch(() => {}); // por si el aviso de cierre llegó después de soltar el canal
        }
    }

    // ------------------------------------------------------------------ cargar y sumar mensajes

    function urlFor(pane, after = 0) {
        const base = pane.name === 'sala' ? `/api/partidas/${pane.matchId}/chat` : '/api/chat/global';
        return after > 0 ? `${base}?despues=${after}` : base;
    }

    /** Suma un mensaje si no estaba. Devuelve true si era nuevo. */
    function add(pane, m, { announce = true } = {}) {
        const r = pane.feed.add(m);
        if (r === 'repetido' || r === 'invalido') {
            return false;
        }
        if (r === 'nuevo') {
            const stick = nearBottom(pane.log) || isOwn(m, user?.id);
            pane.log.append(nodeFor(pane, m));
            if (stick) {
                toBottom(pane);
            }
        } else {
            renderAll(pane); // llegó fuera de orden (raro): se reordena
        }
        for (const id of pane.feed.trim()) {
            pane.log.querySelector(`[data-id="${id}"]`)?.remove();
        }
        if (announce && canNotify() && countsAsUnread(m, { userId: user?.id ?? null, open, tabActive: active === pane.name, hidden: document.hidden })) {
            pane.unread += 1;
            renderBadges();
        }
        return true;
    }

    async function loadPane(pane) {
        const id = pane.matchId;
        const d = await getJson(urlFor(pane));
        if (pane.name === 'sala' && pane.matchId !== id) {
            return d; // mientras tanto cambió la sala: esta respuesta es de la anterior
        }
        for (const m of d.messages) {
            add(pane, m, { announce: false });
        }
        pane.loaded = true;
        if (pane.name === 'sala' && d.writable === false && !pane.readonly) {
            pane.readonly = true;
            renderTabs();
        }
        for (const m of pane.early.splice(0)) {
            add(pane, m);
        }
        return d;
    }

    /** Primera lectura del global; si falla (servidor ocupado), reintenta sola cada 5 s. */
    function start() {
        loadPane(panes.global).catch((e) => {
            console.warn('No se pudo leer el chat', e);
            setTimeout(start, 5000);
        });
    }

    /** Lectura de la sala; si la partida no es mía (403/404) la sala se cierra; otro error reintenta. */
    function loadRoom() {
        const id = panes.sala.matchId;
        if (id == null) {
            return;
        }
        loadPane(panes.sala).catch((e) => {
            if (panes.sala.matchId !== id) {
                return;
            }
            if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
                dropRoom();
                return;
            }
            console.warn('No se pudo leer el chat de la sala', e);
            setTimeout(loadRoom, 5000);
        });
    }

    /**
     * Se pone al día con lo que pasó mientras no había conexión (de a tandas, con tope).
     * Pide desde un poco ANTES del último número conocido: dos mensajes guardados casi a la vez pueden hacerse visibles
     * en orden inverso, y sin ese solape el de número menor se perdería. Los repetidos se descartan por número.
     */
    async function resyncPane(pane) {
        if (pane.name === 'sala' && pane.matchId == null) {
            return;
        }
        if (!pane.loaded) {
            await loadPane(pane);
            return;
        }
        let cursor = Math.max(0, pane.feed.lastId() - OVERLAP);
        const id = pane.matchId;
        for (let i = 0; i < 5; i++) {
            const d = await getJson(urlFor(pane, cursor));
            if (pane.name === 'sala' && pane.matchId !== id) {
                return;
            }
            for (const m of d.messages) {
                add(pane, m);
            }
            if (d.messages.length < PAGE) {
                break;
            }
            cursor = Math.max(...d.messages.map((m) => m.id));
        }
    }

    /** Pone al día ambos canales (al reconectar). */
    async function resync() {
        const jobs = [resyncPane(panes.global)];
        if (hasRoom()) {
            jobs.push(resyncPane(panes.sala));
        }
        const r = await Promise.allSettled(jobs);
        const bad = r.find((x) => x.status === 'rejected');
        if (bad) {
            throw bad.reason;
        }
    }

    /** Lectura periódica de respaldo: el global si no hay conexión en vivo; la sala si no hay conexión o su canal privado no entró. */
    async function poll(live) {
        const jobs = [];
        if (!live) {
            jobs.push(resyncPane(panes.global));
        }
        if (hasRoom() && !panes.sala.readonly && (!live || !roomLive)) {
            jobs.push(resyncPane(panes.sala));
        }
        await Promise.allSettled(jobs);
    }

    /** Aviso en vivo (de cualquiera de los dos canales). */
    function onMessage(m) {
        const pane = m?.match_id == null ? panes.global : (m.match_id === panes.sala.matchId ? panes.sala : null);
        if (!pane) {
            return; // de una sala que ya no es la mía
        }
        if (!pane.loaded) {
            if (pane.early.length < KEEP_EARLY) {
                pane.early.push(m);
            }
            return;
        }
        add(pane, m);
    }

    function onHidden(id, matchId = null) {
        const pane = matchId == null ? panes.global : (matchId === panes.sala.matchId ? panes.sala : null);
        if (pane) {
            removeFrom(pane, id);
        }
    }

    // ------------------------------------------------------------------ la sala acompaña a mi partida

    function resetRoom() {
        const p = panes.sala;
        p.feed.clear();
        p.log.replaceChildren();
        p.loaded = false;
        p.early = [];
        p.unread = 0;
        p.draft = '';
        p.pending = null;
        p.matchId = null;
        p.status = null;
        p.readonly = false;
        roomLive = false;
    }

    /** La sala deja de existir para este jugador (salió de la espera, venció, o ya no es de esa partida). */
    function dropRoom() {
        resetRoom();
        renderTabs();
        onRoomChange?.(null);
    }

    let onRoomChange = null;

    /**
     * Le avisa al chat cuál es MI partida (la llama main.js cada vez que cambia el estado). Abre la sala al entrar a una
     * partida, la deja en solo lectura al terminar o abandonar una en juego, y la cierra si salí de la sala de espera.
     * Devuelve el número de la sala en la que hay que escuchar en vivo (o null).
     */
    function syncRoom(match) {
        const sala = panes.sala;
        const t = roomTransition(
            match ? { id: match.id, status: match.status } : null,
            sala.matchId == null ? null : { id: sala.matchId, status: sala.status, readonly: sala.readonly },
        );
        if (t.action === 'abrir' || t.action === 'cambiar') {
            resetRoom();
            sala.matchId = t.id;
            sala.status = t.status;
            moveActive(pickTab({ saved, hasRoom: true }));
            renderTabs();
            loadRoom();
        } else if (t.action === 'solo-lectura') {
            sala.readonly = true;
            sala.status = 'finished';
            sala.draft = '';
            sala.pending = null;
            if (active === 'sala' && input) {
                input.value = ''; // ya no se puede escribir: el borrador no tiene a dónde ir
            }
            roomLive = false;
            renderTabs();
            // El aviso de cierre ("Ganó Ana...") sale justo después de terminar: se relee la sala un par de veces.
            for (const ms of [1200, 4000]) {
                setTimeout(() => { if (panes.sala.matchId === t.id) { resyncPane(panes.sala).catch(() => {}); } }, ms);
            }
        } else if (t.action === 'cerrar') {
            dropRoom();
        } else if (match && sala.matchId === match.id) {
            sala.status = match.status;
        }
        return hasRoom() && !sala.readonly ? sala.matchId : null;
    }

    // ------------------------------------------------------------------ abrir, cerrar y escribir

    function setOpen(next) {
        open = next;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        $('chat').classList.toggle('open', open);
        if (open) {
            panes[active].unread = 0;
            renderBadges();
            toBottom(panes[active]);
            input?.focus({ preventScroll: true });
        }
        try {
            localStorage.setItem('formosa.chat.abierto', open ? '1' : '0');
        } catch { /* sin almacenamiento (ventana privada): no pasa nada */ }
    }

    $('chat-close')?.addEventListener('click', () => {
        setOpen(false);
        toggle.focus();
    });

    function explain(err) {
        return chatErrorText(err instanceof ApiError ? { status: err.status, data: err.data } : null, hhmm);
    }

    async function submit(e) {
        e.preventDefault();
        const pane = panes[active];
        const text = input.value;
        if (sending || text.trim() === '' || input.disabled) {
            return;
        }
        if (pane.name === 'sala' && pane.matchId == null) {
            return;
        }
        sending = true;
        sendBtn.disabled = true;
        setNote('');
        const key = pane.pending && pane.pending.text === text ? pane.pending.key : newKey();
        try {
            const url = pane.name === 'sala' ? `/api/partidas/${pane.matchId}/chat` : '/api/chat/global';
            const r = await postJson(url, {}, { mensaje: text, clave: key });
            pane.pending = null;
            input.value = '';
            add(pane, r.message, { announce: false });
            toBottom(pane);
        } catch (err) {
            // Si el servidor contestó, el envío quedó resuelto (aceptado o rechazado). Si no hubo respuesta, puede haberse
            // guardado igual: se reintenta con la MISMA clave y el servidor no lo duplica.
            pane.pending = err instanceof ApiError ? null : { text, key };
            if (err instanceof ApiError && err.data.error === 'sala_solo_lectura' && pane.name === 'sala') {
                pane.readonly = true;
                renderTabs();
            }
            setNote(explain(err));
        } finally {
            sending = false;
            applyComposer();
            if (!input.disabled) {
                input.focus({ preventScroll: true });
            }
        }
    }

    toggle.addEventListener('click', () => setOpen(!open));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && open) {
            panes[active].unread = 0;
            renderBadges();
        }
    });
    for (const pane of Object.values(panes)) {
        pane.tab.addEventListener('click', () => setTab(pane.name));
    }
    tablist.addEventListener('keydown', (e) => {
        const available = TABS.filter((t) => t === 'global' || hasRoom());
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            next = stepTab(active, 1, available);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            next = stepTab(active, -1, available);
        } else if (e.key === 'Home') {
            next = available[0];
        } else if (e.key === 'End') {
            next = available[available.length - 1];
        }
        if (next) {
            e.preventDefault();
            setTab(next, { focus: true });
        }
    });
    $('chat').addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openMenu) {
            e.stopPropagation();
            openMenu.btn.focus();
            closeMenu();
            return;
        }
        if (e.key === 'Escape' && open) {
            e.stopPropagation(); // no deseleccionar la propiedad del mapa
            setOpen(false);
            toggle.focus();
        }
    });
    form?.addEventListener('submit', submit);
    input?.addEventListener('input', () => {
        const p = panes[active];
        if (p.pending && p.pending.text !== input.value) {
            p.pending = null; // editó el texto: ya es otro mensaje
        }
    });

    renderTabs();
    let remembered = false;
    try {
        remembered = localStorage.getItem('formosa.chat.abierto') === '1';
    } catch { /* idem */ }
    if (remembered) {
        setOpen(true);
    }

    return {
        start, resync, poll, onMessage, onHidden, syncRoom,
        /** El canal privado de la sala entró (true) o fue rechazado / se cayó (false). */
        setRoomLive: (v) => { roomLive = !!v; },
        setOnRoomChange: (fn) => { onRoomChange = fn; },
        roomId: () => panes.sala.matchId,
        isRoomLive: () => roomLive,
        isRoomReadonly: () => panes.sala.readonly,
        activeTab: () => active,
        setTab,
        lastId: (name = 'global') => panes[name].feed.lastId(),
        unread: counts,
    };
}
