// Lobby (/mapa): salas abiertas, ranking, historial y, más adelante, el manual. No carga el mapa: crear una sala o unirse
// lleva a la pantalla de la partida (/partida/CÓDIGO). Todo el texto del servidor se escribe con textContent.
import { createGame } from '../map/game.js';
import { connectRealtime } from '../map/realtime.js';
import { getJson } from '../map/api.js';
import { mountArt, lobbyHeader, emptyRooms, emptyRanking, emptyHistory } from '../map/art.js';
import { rankingModel, historyModel, rowElement } from '../map/lists.js';
import { createRooms, matchUrl } from './rooms.js';
import { parseLobbyParams } from './params.js';
import { createGuides } from '../guides/guide.js';
import { manualSections } from '../guides/manual-model.js';
import { renderManual } from './manual.js';

const cfg = window.__MAP_CONFIG__;
const $ = (id) => document.getElementById(id);
const user = cfg.user;
const game = user ? createGame({ serverNow: cfg.clock?.serverNow ?? Date.now() }) : null;

mountArt($('lobby-art'), lobbyHeader());
mountArt($('room-empty-art'), emptyRooms());

const rooms = createRooms({ $, user, game });

// ---------------------------------------------------------------- avisos y código de la dirección
const params = parseLobbyParams(window.location.search);
if (params.notice) {
    rooms.say(params.notice, false);
}
if (params.code && $('code-input')) {
    $('code-input').value = params.code;
}
if (params.notice || window.location.search.includes('codigo=')) {
    // La dirección queda limpia: el aviso se muestra una sola vez.
    window.history.replaceState(null, '', window.location.pathname);
}

// ---------------------------------------------------------------- pestañas
const TABS = ['salas', 'ranking', 'historial', 'manual'].filter((name) => $(`tab-${name}`));
const loaded = new Set();
const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

function emptyItem(art, text) {
    const li = el('li', 'drawer-empty');
    const holder = el('span');
    mountArt(holder, art);
    li.append(holder, document.createTextNode(text));
    return li;
}

async function loadRanking() {
    const list = $('lobby-ranking-list');
    const note = $('lobby-ranking-note');
    list.replaceChildren(el('li', 'drawer-empty', 'Cargando…'));
    try {
        const [{ players }, mine] = await Promise.all([getJson('/api/ranking'), user ? getJson('/api/yo').catch(() => null) : null]);
        const model = rankingModel({ players, mine, user });
        note.textContent = model.note;
        list.replaceChildren(...(model.rows.length ? model.rows.map(rowElement) : [emptyItem(emptyRanking(), 'Todavía nadie sumó puntos. Jugá la primera partida.')]));
        loaded.add('ranking');
    } catch {
        list.replaceChildren(el('li', 'drawer-empty', 'No se pudo cargar el ranking. Probá de nuevo.'));
    }
}

async function loadHistory() {
    const list = $('lobby-history-list');
    const note = $('lobby-history-note');
    list.replaceChildren(el('li', 'drawer-empty', 'Cargando…'));
    try {
        const { matches } = await getJson('/api/yo/historial');
        const model = historyModel({ matches });
        note.textContent = model.note;
        list.replaceChildren(...(model.rows.length ? model.rows.map(rowElement) : [emptyItem(emptyHistory(), 'Todavía no terminaste ninguna partida.')]));
        loaded.add('historial');
    } catch {
        list.replaceChildren(el('li', 'drawer-empty', 'No se pudo cargar tu historial. Probá de nuevo.'));
    }
}

function loadManual() {
    renderManual($('lobby-manual'), manualSections({ cfg, user }));
    loaded.add('manual');
}

const loaders = { salas: () => rooms.load(), ranking: loadRanking, historial: loadHistory, manual: loadManual };

function selectTab(name, focus = false) {
    for (const t of TABS) {
        const on = t === name;
        const tab = $(`tab-${t}`);
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        $(`panel-${t}`).hidden = !on;
        if (on && focus) tab.focus();
    }
    if (name !== 'salas' && loaded.has(name)) return; // ranking e historial se leen una vez por visita a la pestaña
    loaders[name]?.();
}

for (const name of TABS) {
    const tab = $(`tab-${name}`);
    tab.addEventListener('click', () => selectTab(name));
    tab.addEventListener('keydown', (e) => {
        const i = TABS.indexOf(name);
        const next = { ArrowRight: TABS[(i + 1) % TABS.length], ArrowLeft: TABS[(i - 1 + TABS.length) % TABS.length], Home: TABS[0], End: TABS[TABS.length - 1] }[e.key];
        if (next) {
            e.preventDefault();
            selectTab(next, true);
        }
    });
}
selectTab('salas');

// ---------------------------------------------------------------- "Volver a tu partida"
async function showResume() {
    if (!game) return;
    try {
        await game.refresh();
    } catch {
        return; // sin la tarjeta el lobby sigue sirviendo
    }
    const m = game.state.match;
    if (!m || !['lobby', 'running'].includes(m.status)) return;
    $('lobby-resume-text').textContent = m.status === 'running' ? `Tu partida "${m.name}" está en juego.` : `Estás en la sala "${m.name}", esperando que empiece.`;
    $('lobby-resume-link').href = matchUrl(m.code);
    $('lobby-resume').hidden = false;
}
showResume();

// ---------------------------------------------------------------- tiempo real
let live = false;
const rt = connectRealtime(cfg.reverb, {
    onStatus: (on) => { live = on; },
    onBack: () => rooms.load(),
    onLobby: (e) => rooms.onLobbyEvent(e),
});
rt?.watchLobby(true);
// Respaldo: sin conexión en vivo la lista se relee cada 10 s (con conexión, una lectura de control cada 30 s).
let tick = 0;
setInterval(() => {
    tick += 1;
    if (document.hidden || $('panel-salas').hidden) return;
    if (!live || tick % 3 === 0) rooms.load();
}, 10000);

// ---------------------------------------------------------------- guías: la de bienvenida se abre sola la primera vez
const guides = createGuides({ $, cfg, user, reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, getPlace: () => 'lobby' });
$('btn-help').addEventListener('click', () => guides.openMenu());
guides.openAuto();
