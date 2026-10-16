import { intro, createCityLoader } from './intro.js';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 carga su worker desde un archivo aparte; Vite no lo copia solo, así que se lo indicamos.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle, layerFilters } from './style.js';
import { createHighlights } from './highlights.js';
import { ownerColor } from './owners.js';
import { zoneHint } from './combos.js';
import { hudLines, stateKey, whatsNew, changeAt, propertyNote, zoneFeatures, isSprint } from './events-model.js';
import { money, area, count } from './format.js';
import { getJson, getStatic, ApiError } from './api.js';
import { createGame } from './game.js';
import { connectRealtime } from './realtime.js';
import { createAuctions, isActive, clock } from './auctions.js';
import { createChat } from './chat.js';
import { createVoice } from './voice.js';
import { createSound } from './sound.js';
import { createAudioControls } from './audio-controls.js';
import { sessionSeed } from './music-model.js';
import { matchNote } from './intro-model.js';
import { createEffects } from './effects.js';
import { createGuides } from '../guides/guide.js';
import { createDataTools } from './datos.js';
import { createDrawer } from './drawer.js';
import { gameHours, cityHours, EXPLORE_MINUTES_PER_DAY, phaseAt, hhmm, lightAt, tintHex, rgbCss } from './daytime.js';
import { createWaitingRoom } from './waiting-room.js';
import { resolveEntry, destinationAfter } from './entry-model.js';
import { initUiMin } from './ui-min.js';
import { createFeed } from './feed.js';
import { createOffersUi } from './offers-ui.js';
import { describeOption, blockReason, sellWarning } from './upgrades-model.js';
import { createBankUi } from './bank-ui.js';
import { dayRemainingMs, incomePerMinute, leaderGap, gapText, afterBuy, paybackShare } from './panel-model.js';
import { createResults } from './results.js';
import { matchClock, dayLabel, formatCountdown, spokenCountdown, crossedWarnings, warningLevel, standings as rankStandings, projectCash, paybackText, ordinal } from './partida.js';
import { LIMITS_2D, LIMITS_3D, QUALITY, QUALITY_KEY, parseQualityMode, districtBounds, clampLngLat, clampZoom } from './city-frame.js';

maplibregl.setWorkerUrl(workerUrl);

const cfg = window.__MAP_CONFIG__;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

// Calidad de la vista 3D elegida a mano ('auto' si no se eligió). El suavizado de bordes es del contexto WebGL de
// MapLibre: solo se puede pedir al crear el mapa, así que 'alta' lo prende desde la próxima carga.
let qualityMode = 'auto';
try {
    qualityMode = parseQualityMode(localStorage.getItem(QUALITY_KEY));
} catch { /* sin almacenamiento */ }

const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(cfg.kinds),
    center: [cfg.center.lng, cfg.center.lat],
    zoom: cfg.zoom,
    minZoom: LIMITS_2D.minZoom,
    maxZoom: LIMITS_2D.maxZoom,
    maxPitch: LIMITS_2D.maxPitch,
    canvasContextAttributes: { antialias: qualityMode !== 'auto' && QUALITY[qualityMode].antialias },
    attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}));

// ---------------------------------------------------------------- estado en el navegador
const properties = new Map(); // id -> propiedades fijas (precio, tipo, nombre…)
const owners = new Map();     // id de propiedad -> { ownerId, owner } (dueños en MI partida; vacío si no hay partida)
let selectedId = null;
let is3d = false;
let city = null;             // vista 3D (three.js), se carga la primera vez que se activa
let cityLoading = null;
let roadsData = null;        // GeoJSON de calles (para ubicar árboles y faroles en 3D)
let live = false;
let busy = false;
let ready = false;           // true cuando ya se cargaron propiedades y dueños
let propsData = null;        // el GeoJSON de propiedades tal como se cargó (se corrige en el lugar)
let catalogVersion = 0;      // versión de los datos fijos (rubro, nombre, precio) que tiene este navegador
let needsSync = false;       // llegó una corrección antes de estar listo: al terminar de cargar se relee todo
const queued = [];           // avisos en vivo que llegaron antes de estar listo

const user = cfg.user;               // { id, name } o null si es visitante
const game = user ? createGame({ serverNow: cfg.clock?.serverNow ?? Date.now() }) : null;

const auctions = createAuctions();
const chat = createChat({ user, $, cfg: cfg.chat });
chat.setOnRoomChange(() => rt?.watchChat(null)); // la sala se cerró sola (ya no soy de esa partida)
chat.start();
const myAuctions = new Set();        // subastas en las que participé: para avisar si gané o perdí
const centers = new Map();           // id de propiedad -> [lng, lat] (para ir a una subasta desde la lista)
const geometries = new Map();        // id de propiedad -> geometría (para la capa de resaltes)
const highlights = createHighlights({ map, properties, geometries });
const sound = createSound({ onPlay: (name) => audio.duck(name) });
const audio = createAudioControls({ $, sound });
const effects = createEffects({ map, centers, reduceMotion });
// Dónde está la persona, para saber qué guías ofrecerle: explorando, esperando en la sala, jugando o viendo resultados.
const guidePlace = () => {
    if (cfg.page !== 'partida') return 'explorar';
    if (results?.isOpen()) return 'resultados';
    const status = game?.state.match?.status;
    return status === 'lobby' ? 'sala' : status === 'running' ? 'partida' : 'explorar';
};
const guides = createGuides({ $, cfg, user, reduceMotion, getPlace: guidePlace });
let guidesReady = false;             // las guías automáticas esperan a que termine la cinemática de entrada
const isSmall = () => window.matchMedia('(max-width: 640px)').matches;
let room = null;                     // sala de espera (se crea abajo, necesita funciones de este archivo)
let leaving = false;                 // salí de la sala o abandoné: ya me voy al lobby y no hay que reaccionar a que la partida desaparezca
let results = null;                  // pantalla de resultados
let rt = null;                       // conexión de tiempo real
const voice = createVoice({ user, $, cfg: cfg.voice, getRt: () => rt }); // voz de la sala (micrófono siempre cerrado al entrar)
const drawer = createDrawer({
    $, cfg, user, game, properties,
    onPick: (id) => {
        if (isSmall()) {
            drawer.close(); // en celular el cajón tapa el mapa
        }
        select(id);
        const at = centers.get(id);
        if (at) {
            map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 17), duration: reduceMotion ? 0 : 700 });
        }
    },
});
// Feed de actividad: lo que hacen los demás jugadores. Tocar una tarjeta lleva la cámara a esa propiedad.
const feed = createFeed({
    $, cfg,
    getMeId: () => user?.id ?? null,
    onPick: (id) => {
        select(id);
        const at = centers.get(id);
        if (at) {
            map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 17), duration: reduceMotion ? 0 : 700 });
        }
    },
});
// Ofertas entre jugadores (el dueño fija mínimo y "comprá ya"; los demás ofertan). Solo existe si hay sesión.
const offerUi = game ? createOffersUi({
    $,
    getUser: () => user,
    game,
    money,
    clock,
    propLabel: (id) => propLabel(id),
    notice: (text, isError) => showNotice(text, isError),
    message: (text, isError) => setPanelMessage(text, isError),
    play: (name) => sound.play(name),
    setOwner: (id, ownerId, ownerName) => setOwner(id, ownerId, ownerName),
    pulse: (id, ownerId) => effects.pulse(id, ownerColor(ownerId)),
    explain: (err) => explain(err),
    onChange: () => { if (selectedId != null) showPanel(selectedId); renderAll(); },
    recover: (err) => recoverFromMatchError(err),
}) : null;
// Banco: préstamos con interés por día de juego. Solo existe si hay sesión.
const bankUi = game ? createBankUi({
    $,
    game,
    money,
    explain: (err) => explain(err),
    notice: (text, isError) => showNotice(text, isError),
    play: (name) => sound.play(name),
    onChange: () => renderHud(),
    recover: (err) => recoverFromMatchError(err),
}) : null;
for (const id of ['btn-mine', 'btn-ranking', 'btn-history']) {
    $(id)?.addEventListener('click', () => bankUi?.close()); // comparten lugar en pantalla
}
const dataTools = createDataTools({
    $, cfg, user,
    getProperty: (id) => properties.get(id),
    getSelected: () => selectedId,
    onCorrected: (c) => applyCorrection(c),
});
const queuedAuctions = [];           // avisos de subasta que llegaron antes de estar listo
let paintedAuctions = new Set();     // propiedades marcadas hoy en el mapa como reservadas/en subasta
let bidDirty = false;                // el jugador tocó el campo de puja: no se lo pisamos con el mínimo

// ---------------------------------------------------------------- carga de datos
let noticeTimer = null;
function showNotice(text, isError = false, sticky = false) {
    const el = $('aviso');
    el.textContent = text; // textContent: nunca HTML (los nombres vienen de OpenStreetMap y no son confiables)
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) {
        noticeTimer = setTimeout(() => { el.hidden = true; }, 7000);
    }
}

/**
 * Encuadre inicial: el 1 % más alejado de cada lado se descarta, así una propiedad suelta lejos de la ciudad
 * (un punto de OpenStreetMap en el campo, por ejemplo) no obliga a alejar el mapa hasta que la ciudad se ve diminuta.
 */
function boundsOf(centerList) {
    const lngs = centerList.map((c) => c[0]).sort((a, b) => a - b);
    const lats = centerList.map((c) => c[1]).sort((a, b) => a - b);
    const cut = Math.floor(centerList.length * 0.01);
    const b = new maplibregl.LngLatBounds();
    b.extend([lngs[cut], lats[cut]]);
    b.extend([lngs[lngs.length - 1 - cut], lats[lats.length - 1 - cut]]);
    return b;
}

/**
 * Decide si me quedo en /partida/CÓDIGO (ver entry-model.js). Devuelve `{ stop: true }` si ya mandé al jugador a otra dirección,
 * o `{ finishedId }` si el código es el de una partida que terminó y hay que mostrar sus resultados.
 */
async function enter(failed) {
    if (cfg.page !== 'partida') {
        return {};
    }
    if (failed && user) {
        // Sin saber cuál es mi partida no redirijo: aviso con reintentar y enlace al lobby, y el mapa se ve igual.
        $('entry-error').hidden = false;
        $('entry-retry').addEventListener('click', () => window.location.reload());
        return {};
    }
    const current = game ? { match: game.state.match, last_finished_match_id: game.state.lastFinishedId } : null;
    const decision = resolveEntry({ page: cfg.page, code: cfg.code, user, current });
    if (decision.action === 'redirect') {
        window.location.replace(decision.url);
        return { stop: true };
    }
    if (decision.action === 'check-finished') {
        try {
            const r = await getJson(`/api/partidas/${decision.finishedId}/resultado`);
            if (String(r.match?.code).toUpperCase() === cfg.code) {
                return { finishedId: decision.finishedId };
            }
        } catch { /* no se pudo comprobar: se trata como una sala ajena */ }
        window.location.replace(`/mapa?codigo=${encodeURIComponent(cfg.code)}&aviso=sala`);
        return { stop: true };
    }
    return {};
}

map.on('load', async () => {
    intro.step('mapa');
    let entryFailed = false; // no se pudo leer MI partida: la pantalla no puede decidir si el código es mío
    try {
        const [props, roads] = await Promise.all([
            getStatic(cfg.static?.propiedades, '/api/propiedades').then((d) => { intro.step('propiedades'); return d; }),
            getStatic(cfg.static?.calles, '/api/calles').then((d) => { intro.step('calles'); return d; }),
            game?.refresh().catch(() => { entryFailed = true; }).finally(() => {
                intro.step('partida');
                const m = game.state.match;
                const left = m?.status === 'running' ? formatCountdown(matchClock(m, game.serverNow()).remainingMs) : '';
                intro.note(matchNote(m, left), m);
            }),
        ]);

        // ¿Esta pantalla es para mí? /partida/CÓDIGO solo sirve si ese código es mi sala o mi partida (o una que terminé).
        const entry = await enter(entryFailed);
        if (entry.stop) {
            return;
        }

        propsData = props;
        for (const f of props.features) {
            properties.set(f.properties.id, f.properties);
            geometries.set(f.properties.id, f.geometry);
            const ring = f.geometry.coordinates[0];
            centers.set(f.properties.id, [
                ring.reduce((sum, c) => sum + c[0], 0) / ring.length,
                ring.reduce((sum, c) => sum + c[1], 0) / ring.length,
            ]);
        }
        map.getSource('propiedades').setData(props);
        map.getSource('calles').setData(roads);
        // "Dibujando la ciudad": el mapa terminó de pintar lo que acabamos de cargarle (con un tope por si nunca se aquieta)
        map.once('idle', () => intro.step('dibujo'));
        setTimeout(() => intro.step('dibujo'), 12000);
        roadsData = roads;
        highlights.flush();
        renderStats();
        ready = true;
        for (const e of queued.splice(0)) {
            setOwner(e.id, e.owner_id, e.owner);
        }
        await onMatchState({ initial: true }); // dueños, subastas y HUD de MI partida (o modo exploración)
        if (entry.finishedId != null) {
            markResult(entry.finishedId);
            await results.show(entry.finishedId); // volví a /partida/CÓDIGO de una partida que ya terminó
        }
        intro.step('duenos');
        for (const a of queuedAuctions.splice(0)) {
            onAuctionEvent(a);
        }
        if (needsSync) {
            needsSync = false;
            syncCatalog().catch((e) => console.warn('No se pudieron releer las propiedades', e));
        }
        renderAuctionList();
        setInterval(tick, 250); // cuenta regresiva de la partida y de las subastas (con la hora del servidor)
        if (props.features.length === 0) {
            showNotice('Todavía no hay propiedades. Corré "php artisan db:seed" (datos de ejemplo) o "php artisan formosa:importar" (datos reales).', false, true);
        } else {
            // Con la cinemática abierta el encuadre es un salto (no se vería): el zoom de la cinemática hacia el mapa hace de transición.
            map.fitBounds(boundsOf([...centers.values()]), { padding: 60, maxZoom: 17, duration: reduceMotion || intro.isOpen() ? 0 : 700 });
            await intro.whenDone(); // las guías esperan a que el jugador entre (y la música ya tiene su gesto)
            guidesReady = true;
            // /mapa?p=123 abre esa propiedad (lo usa la página de revisión de moderadores).
            const wanted = Number(new URLSearchParams(location.search).get('p'));
            if (wanted && properties.has(wanted)) {
                select(wanted);
                map.flyTo({ center: centers.get(wanted), zoom: 17, duration: reduceMotion ? 0 : 700 });
            } else {
                guides.openAuto();
            }
        }
    } catch (err) {
        console.error(err);
        intro.fail('No se pudo cargar el mapa. Podés entrar igual.');
        $('stats').textContent = 'No se pudo cargar el mapa';
        showNotice(`No se pudieron cargar los datos del mapa. ${err.message}`, true, true);
    }
});

// ---------------------------------------------------------------- dueños (se actualizan en vivo con Echo)
export function setOwner(propertyId, ownerId, ownerName) {
    const target = { source: 'propiedades', id: propertyId };
    if (ownerId == null) {
        owners.delete(propertyId);
        map.setFeatureState(target, { owned: false, color: null });
        highlights.set(propertyId, { mine: false });
    } else {
        owners.set(propertyId, { ownerId, owner: ownerName });
        map.setFeatureState(target, { owned: true, color: ownerColor(ownerId) });
        highlights.set(propertyId, { mine: user?.id === ownerId });
    }
    city?.refresh(propertyId);
    if (selectedId === propertyId) {
        showPanel(propertyId);
    }
    renderStats();
}

function renderStats() {
    const total = properties.size;
    if (total === 0) {
        $('stats').textContent = 'Sin propiedades';
        return;
    }
    if (!game?.isRunning()) {
        $('stats').textContent = `${count(total)} propiedades en el mapa · modo exploración`;
        return;
    }
    $('stats').textContent = `${count(total - owners.size)} libres de ${count(total)} · ${count(owners.size)} con dueño`;
}

// ---------------------------------------------------------------- correcciones de datos (rubro, nombre, precio)
const FIXED = ['kind', 'name', 'price', 'income'];

/** Pasa a la fuente del mapa los datos fijos de una propiedad, sin volver a mandar las ~13.000. */
function pushFeature(id, p) {
    const source = map.getSource('propiedades');
    const changes = FIXED.map((key) => ({ key, value: p[key] ?? null }));
    Promise.resolve(source.updateData({ update: [{ id, addOrUpdateProperties: changes }] })).catch(() => {
        if (propsData) {
            source.setData(propsData); // la propiedad ya está corregida en propsData: recarga completa
        }
    });
}

/** Una moderación cambió el rubro o el nombre de una propiedad: se ve al instante, sin recargar. */
export function applyCorrection(c) {
    const p = properties.get(c.id);
    if (!p) {
        return;
    }
    const kindChanged = p.kind !== c.kind;
    if (!kindChanged && p.name === c.name && p.price === c.price && p.income === c.income) {
        return;
    }
    Object.assign(p, { kind: c.kind, name: c.name, price: c.price, income: c.income });
    pushFeature(c.id, p);
    highlights.set(c.id, {}); // los resaltes llevan una copia del rubro (para los filtros)
    if (kindChanged) {
        effects.pulse(c.id, cfg.kinds[c.kind]?.color ?? '#1f6feb');
        scheduleCityRebuild();
    }
    if (selectedId === c.id) {
        showPanel(c.id);
    }
    if (game?.owns(c.id)) {
        game.refreshSoon(renderHud); // cambió su ingreso por día
    }
}

/** Vuelve a leer los datos fijos y aplica solo lo que cambió (por si se perdió un aviso en vivo). */
async function syncCatalog() {
    const res = await fetch('/api/propiedades', { headers: { Accept: 'application/json' }, cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`Error ${res.status}`);
    }
    const fresh = await res.json();
    let added = false;
    for (const f of fresh.features) {
        const cur = properties.get(f.properties.id);
        if (!cur) {
            added = true;
            properties.set(f.properties.id, f.properties);
            geometries.set(f.properties.id, f.geometry);
            const ring = f.geometry.coordinates[0];
            centers.set(f.properties.id, [ring.reduce((sum, c) => sum + c[0], 0) / ring.length, ring.reduce((sum, c) => sum + c[1], 0) / ring.length]);
        } else if (FIXED.some((k) => (cur[k] ?? null) !== (f.properties[k] ?? null))) {
            applyCorrection({ id: f.properties.id, kind: f.properties.kind, name: f.properties.name, price: f.properties.price, income: f.properties.income });
        }
    }
    if (added) {
        propsData = fresh;
        map.getSource('propiedades').setData(fresh);
        renderStats();
        scheduleCityRebuild();
    }
}

// ---------------------------------------------------------------- selección y detalle
/** Barra de recupero: qué parte de la partida tarda la propiedad en devolver lo que cuesta. Solo con partida en curso. */
function paintRoi(p) {
    const box = $('panel-roi');
    const clk = game?.isRunning() ? matchClock(game.state.match, game.serverNow()) : null;
    const r = clk ? paybackShare(p.price, p.income, clk.daysTotal, clk.daysTotal - clk.gameDay) : null;
    box.hidden = r === null;
    if (r === null) {
        return;
    }
    const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
    $('roi-fill').style.width = `${Math.max(4, r.share * 100).toFixed(0)}%`;
    box.classList.toggle('late', r.late);
    $('roi-of').textContent = r.late
        ? `Tarda ${fmt(r.days)} días y quedan ${fmt(clk.daysTotal - clk.gameDay)}: no llegás a recuperarla.`
        : `Se recupera con ${fmt(r.days)} de los ${clk.daysTotal} días de partida`;
}

/** "Te quedarían $ X": lo que queda de efectivo si se compra. Solo si alcanza (si no, el botón ya dice cuánto falta). */
function paintAfter(price) {
    const el = $('panel-after');
    const a = afterBuy(game?.available() ?? 0, price);
    el.hidden = !a.ok;
    if (a.ok) {
        setText('panel-after', `Te quedarían ${money(a.left)} de efectivo`);
    }
}

function showPanel(id) {
    const p = properties.get(id);
    if (!p) {
        return;
    }
    const owner = owners.get(id);
    const mine = Boolean(user && owner && owner.ownerId === user.id);
    $('panel-kind').textContent = cfg.kinds[p.kind]?.label ?? p.kind;
    const label = cfg.kinds[p.kind]?.label ?? 'Propiedad';
    // Sin nombre (casi todas las casas), el título dice dónde está en vez de repetir el tipo.
    $('panel-title').textContent = p.name ?? (p.street ? `${label} en ${p.street}` : `${label} sin dirección`);
    $('panel-street').textContent = p.name ? (p.street ?? '') : '';
    $('panel-street').hidden = $('panel-street').textContent === '';
    $('panel-payback').textContent = paybackText(p.price, p.income); // el ingreso es por día de juego
    $('panel-price').textContent = money(p.price);
    $('panel-income').textContent = `${money(p.income)} / día`;
    $('panel-area').textContent = area(p.area);
    $('panel').style.setProperty('--kind', cfg.kinds[p.kind]?.color ?? '#8a8f98');
    paintRoi(p);
    {
        // Pista de combo de zona: solo dentro de una partida. Las coordenadas salen del mapa (centers: [lng, lat]).
        const here = centers.get(id);
        const mineAt = [...game.state.props.keys()].map((pid) => [centers.get(pid), game.state.props.get(pid)?.weight ?? 1]).filter(([c]) => c).map(([[lng, lat], weight]) => ({ lat, lng, weight }));
        const hint = user && game?.isRunning() && here ? zoneHint({ lat: here[1], lng: here[0] }, mineAt, mine, cfg.combos) : '';
        $('panel-combo').textContent = hint;
        $('panel-combo').hidden = hint === '';
        const evNote = user && game?.isRunning() ? propertyNote(game.state.match?.events, p.kind, game.serverNow(), game.state.match.minutes_per_day * 60000, centers.get(id)) : '';
        $('panel-event').textContent = evNote;
        $('panel-event').hidden = evNote === '';
    }
    const playing = Boolean(game?.isRunning());
    const auction = owner ? null : auctions.forProperty(id);
    $('panel-owner').textContent = owner ? (mine ? `${owner.owner} (vos)` : owner.owner) : (auction ? (auction.status === 'disputa' ? 'Reservada' : 'En subasta') : 'Libre');

    // Acciones: comprar si está libre, ver lo acumulado si es tuya, invitar a ingresar si sos visitante.
    const buy = $('btn-buy');
    buy.hidden = true;
    const sell = $('btn-sell');
    if (sell.dataset.confirmFor !== String(id)) {
        resetSell();
    }
    sell.hidden = !mine || !playing;
    if (mine) {
        const refund = Math.floor(p.price * (cfg.economy.sellRatio ?? 0.6));
        sell.disabled = busy;
        if (!sell.classList.contains('confirm')) {
            sell.textContent = `Vender al banco por ${money(refund)}`;
        }
    }
    $('link-login').hidden = true;
    $('btn-join-cta').hidden = true;
    const available = game?.available() ?? 0;
    $('panel-after').hidden = true;
    if (!owner || !playing) {
        if (!user) {
            $('link-login').hidden = false;
        } else if (!playing) {
            $('btn-join-cta').hidden = false;
            $('panel-owner').textContent = 'Libre (modo exploración)';
        } else if (!auction) {
            const price = buyPrice(p);
            const missing = price - available;
            buy.hidden = false;
            buy.disabled = busy || missing > 0;
            const verb = cfg.auction.dispute > 0 ? 'Reclamar' : 'Comprar';
            const off = comebackPct() > 0 ? ` (−${comebackPct()} %)` : '';
            buy.textContent = missing > 0 ? `Te faltan ${money(missing)}` : `${verb} por ${money(price)}${off}`;
            paintAfter(price);
        } else if (auction.status === 'disputa' && auction.leader_id !== user.id) {
            const missing = auction.min_next - available;
            buy.hidden = false;
            buy.disabled = busy || missing > 0;
            buy.textContent = missing > 0 ? `Te faltan ${money(missing)} para disputarla` : `Disputarla pujando ${money(auction.min_next)}`;
        }
    }
    renderAuctionBox(auction);
    const offerNow = offerUi?.render({ id, mine, playing, price: p.price });
    if (offerNow?.hideSell) {
        sell.hidden = true; // en oferta: se retira primero, no se vende al banco
    }
    if (offerNow?.offer && owner) {
        $('panel-owner').textContent += ' · en oferta';
    }
    renderUpgrades(id, mine, playing, auction, Boolean(offerNow?.offer));
    const sellNote = mine && playing && !sell.hidden ? sellWarning(game.state.props.get(id)?.level ?? 0) : '';
    $('sell-warn').textContent = sellNote;
    $('sell-warn').hidden = sellNote === '';
    dataTools.refresh(id);
    $('panel').hidden = false;
}

// ---------------------------------------------------------------- mejoras de una propiedad propia
let upConfirm = null; // { id, level, branch }: esperando el segundo toque (el nivel 2 no se deshace)
let upTimer = null;
let upSig = '';

/** Días de juego que quedan de la partida (para avisar si una mejora no llega a recuperarse). */
function daysLeft() {
    const m = game?.state.match;
    return m?.ends_at ? Math.max(0, (m.ends_at - game.serverNow()) / (m.minutes_per_day * 60000)) : 0;
}

function upEl(tag, text, cls) {
    const e = document.createElement(tag);
    if (text !== undefined) {
        e.textContent = text; // textContent: nunca HTML
    }
    if (cls) {
        e.className = cls;
    }
    return e;
}

function renderUpgrades(id, mine, playing, auction, offered) {
    const box = $('panel-upgrades');
    const data = mine && playing ? game.state.props.get(id) : null;
    if (!data || data.upgrade === undefined) {
        box.hidden = true;
        upSig = '';
        return;
    }
    box.hidden = false;
    $('up-level').textContent = data.level > 0 ? `${data.label} (nivel ${data.level})` : 'Sin mejoras todavía.';
    $('up-gross').textContent = `${money(data.gross)} / día`;
    $('up-maint').textContent = data.maintenance > 0 ? `− ${money(data.maintenance)} / día` : 'Sin mantenimiento';
    $('up-net').textContent = `${money(data.net)} / día`;

    const left = daysLeft();
    const available = game?.available() ?? 0;
    const rows = data.upgrade.map((o) => ({
        o, reason: blockReason({ playing, mine, busy, available, cost: o.cost, inAuction: Boolean(auction), inOffer: offered }, money),
    }));
    const confirming = upConfirm && upConfirm.id === id ? `${upConfirm.level}${upConfirm.branch ?? ''}` : '';
    // Sin cambios, no se vuelve a dibujar: así un toque no se pierde porque el panel se refrescó justo en ese momento.
    const sig = JSON.stringify([id, data.level, data.branch, data.net, confirming, Math.floor(left), rows.map((r) => [r.o.cost, r.o.net, r.reason])]);
    if (sig === upSig) {
        return;
    }
    upSig = sig;

    const focusedKey = document.activeElement?.closest?.('#up-options') ? document.activeElement.dataset.upKey : null;
    const list = $('up-options');
    list.replaceChildren();
    if (rows.length === 0) {
        list.append(upEl('li', 'Tiene la mejora máxima. No se puede deshacer.', 'up-done'));
    }
    for (const { o, reason } of rows) {
        const key = `${o.level}${o.branch ?? ''}`;
        const d = describeOption(o, money, left);
        const li = upEl('li', undefined, 'up-option');
        li.append(upEl('strong', d.title), upEl('span', d.costText), upEl('span', d.netText), upEl('span', d.maintText), upEl('span', d.paybackText));
        if (o.branch === 'b') {
            const effect = cfg.upgrades?.kinds?.[data.kind]?.branchBEffect;
            if (effect) {
                li.append(upEl('span', effect, 'up-effect'));
            }
        } else if (o.branch === 'a') {
            li.append(upEl('span', 'Más ingreso, pero también más mantenimiento.', 'up-effect'));
        }
        if (d.warn) {
            li.append(upEl('span', d.warn, 'up-warn'));
        }
        const btn = upEl('button', undefined, key === confirming ? 'up-btn confirm' : 'up-btn');
        btn.type = 'button';
        btn.dataset.upKey = key;
        btn.dataset.level = String(o.level);
        btn.dataset.branch = o.branch ?? '';
        btn.disabled = reason !== '';
        btn.textContent = key === confirming ? '¿Seguro? No se puede deshacer. Tocá de nuevo' : `Mejorar por ${money(o.cost)}`;
        li.append(btn);
        if (reason) {
            const why = upEl('span', reason, 'up-why');
            why.id = `up-why-${key}`;
            btn.setAttribute('aria-describedby', why.id);
            li.append(why);
        }
        list.append(li);
    }
    if (focusedKey !== null) {
        (list.querySelector(`button[data-up-key="${focusedKey}"]:not(:disabled)`) ?? box).focus();
    }
}

/** Descuento de remontada del sprint final que tengo ahora (en %, 0 si no me toca) y lo que pago con él. */
const comebackPct = () => game?.state.me?.comeback_pct ?? 0;
const buyPrice = (p) => (comebackPct() > 0 ? Math.max(1, Math.floor((p.price * (100 - comebackPct())) / 100)) : p.price);

function select(id) {
    if (selectedId === id) {
        return;
    }
    const previous = selectedId;
    if (selectedId != null) {
        highlights.set(selectedId, { selected: false });
    }
    selectedId = id;
    if (city) {
        if (previous != null) city.refresh(previous);
        if (id != null) city.refresh(id);
    }
    bidDirty = false;
    setPanelMessage('');
    if (id == null) {
        $('panel').hidden = true;
        return;
    }
    highlights.set(id, { selected: true });
    showPanel(id);
}

map.on('click', (e) => {
    if (is3d && city) {
        select(city.pick(e.point.x, e.point.y)); // en 3D se toca el edificio (paredes o techo), no la huella en el suelo
        return;
    }
    const hit = map.queryRenderedFeatures(e.point, { layers: ['propiedades-relleno'] })[0];
    select(hit ? hit.properties.id : null);
});
map.on('mousemove', (e) => {
    if (is3d) {
        return; // buscar bajo el puntero en miles de edificios 3D en cada movimiento no vale lo que cuesta
    }
    map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ['propiedades-relleno'] }).length ? 'pointer' : '';
});
$('panel-close').addEventListener('click', () => select(null));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        select(null);
    }
});

// ---------------------------------------------------------------- jugador: efectivo, comprar, vender
function setPanelMessage(text, isError = false) {
    const el = $('panel-msg');
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.hidden = text === '';
    if (isError && text !== '') {
        sound.play('error');
    }
}

const setText = (id, text) => {
    const n = $(id);
    if (n.textContent !== text) {
        n.textContent = text;
    }
};

/** Efectivo en pantalla: los cambios por compra/venta animan; el goteo del ingreso por día se escribe directo. */
function paintCash(animate) {
    const el = $('balance');
    const value = game.cash();
    if (animate) {
        effects.setMoney(el, value, money);
    } else if (!el._tween) {
        el.dataset.value = String(value);
        setText('balance', money(value));
    }
}

/** HUD de la partida: cuenta regresiva, día, efectivo, patrimonio, puesto y posiciones. Se llama seguido (barato). */
let lastRemaining = null;
let bannerTimer = null;
let finishing = false;
let standingsKey = '';

function banner(text, ms = 7000, level = 'cinco') {
    const el = $('match-banner');
    el.textContent = text;
    el.dataset.nivel = level;
    el.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function renderHud(animate = false) {
    if (!game) {
        return;
    }
    const running = game.isRunning();
    const m = game.state.match;
    if (!running || !game.state.me) {
        return;
    }
    const clk = matchClock(m, game.serverNow());
    const left = clk.remainingMs;
    setText('match-countdown', formatCountdown(left));
    setText('match-day', dayLabel(clk));
    $('match-bar').style.width = `${(clk.progress * 100).toFixed(1)}%`;
    const level = warningLevel(left);
    const hud = $('match-hud');
    if (hud.dataset.nivel !== level) {
        hud.dataset.nivel = level;
    }
    // Anillo del tiempo (lo que queda de la partida) y fin del día en curso.
    hud.style.setProperty('--resta', Math.max(0, 1 - clk.progress).toFixed(4));
    setText('day-left', formatCountdown(dayRemainingMs(clk, m.minutes_per_day)));
    $('day-bar').style.width = `${(clk.dayFraction * 100).toFixed(1)}%`;
    paintCash(animate);
    $('reserved-wrap').hidden = game.reserved() <= 0;
    setText('reserved', money(game.reserved()));
    setText('networth', money(game.netWorth()));
    setText('my-income', money(game.incomePerDay()));
    {
        const bonus = game.state.me?.combos?.bonus ?? 0;
        const perMin = incomePerMinute(game.incomePerDay(), m.minutes_per_day);
        const base = perMin > 0 ? `Ingreso por día de juego (unos ${money(perMin)} por minuto real)` : 'Ingreso por día de juego';
        $('my-income').title = bonus > 0 ? `${base}. Incluye +${money(bonus)} por combos (zona y variedad)` : base;
    }
    setText('my-count', count(game.state.props.size));
    renderStandings();
    if (selectedId != null) {
        syncPanelButtons();
    }
}

/** Posiciones en vivo: el patrimonio de cada uno sigue creciendo con su ingreso por día entre lecturas. */
function renderStandings() {
    const m = game.state.match;
    const now = game.serverNow();
    const rows = rankStandings(game.state.players.map((p) => ({
        ...p,
        net_worth: p.abandoned ? p.net_worth : projectCash(p.net_worth, p.income_per_day, game.state.fetchedServer, now, m),
    })), user.id);
    const mine = rows.find((r) => r.isMe);
    setText('my-rank', mine ? `${mine.position}.º de ${rows.length}` : '–');
    setText('standings-sub', mine ? `· vas ${mine.position}.º de ${rows.length}` : '');
    const gap = gapText(leaderGap(rows), money);
    setText('hud-gap', gap);
    $('hud-gap').hidden = gap === '';
    const key = rows.map((r) => `${r.user_id}:${r.position}:${r.net_worth}:${r.properties}:${r.abandoned ? 1 : 0}`).join('|');
    if (key === standingsKey) {
        return;
    }
    standingsKey = key;
    $('standings').replaceChildren(...rows.map((r) => {
        const li = document.createElement('li');
        li.className = `stand-row${r.isMe ? ' me' : ''}${r.abandoned ? ' out' : ''}`;
        const pos = document.createElement('span');
        pos.className = 'stand-pos';
        pos.textContent = r.abandoned ? '–' : String(r.position);
        const dot = document.createElement('span');
        dot.className = 'row-dot';
        dot.style.background = ownerColor(r.user_id);
        dot.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'stand-name';
        name.textContent = `${r.name}${r.isMe ? ' (vos)' : ''}${r.abandoned ? ' · abandonó' : ''}`;
        const props = document.createElement('span');
        props.className = 'stand-props';
        props.textContent = `${count(r.properties)} prop.`;
        props.setAttribute('aria-label', `${r.properties} propiedades`);
        const worth = document.createElement('span');
        worth.className = 'stand-worth';
        worth.textContent = money(r.net_worth);
        li.append(pos, dot, name, props, worth);
        return li;
    }));
}

/** Habilita/deshabilita comprar y vender según el efectivo disponible (cambia sola con el ingreso). */
function syncPanelButtons() {
    if (selectedId == null || !game?.isRunning()) {
        return;
    }
    const p = properties.get(selectedId);
    const buy = $('btn-buy');
    if (!p || buy.hidden || busy) {
        return;
    }
    const auction = auctions.forProperty(selectedId);
    const need = auction ? auction.min_next : buyPrice(p);
    const missing = need - game.available();
    if (buy.disabled !== (missing > 0)) {
        showPanel(selectedId);
        return;
    }
    if (!auction) {
        paintAfter(buyPrice(p));
    }
}

function renderAll(animate = false) {
    renderHud(animate);
    drawer.refresh();
    renderPlayState();
}

/** Botones y textos del HUD que dependen de si hay partida, sala o nada. */
function renderPlayState() {
    if (!game) {
        return;
    }
    const m = game.state.match;
    const running = game.isRunning();
    const inLobby = m?.status === 'lobby';
    $('match-hud').hidden = !running;
    if (!running) {
        feed.clear(); // sin partida en juego no hay actividad que mostrar
        map.getSource('zonas-evento')?.setData(zoneFeatures(null));
    }
    $('explore-note').hidden = running;
    $('btn-mine').hidden = !running;
    if ($('btn-bank')) {
        $('btn-bank').hidden = !running;
        bankUi?.paintButton();
    }
    $('btn-leave').hidden = !running;
    const roomButton = $('btn-room');
    if (roomButton) {
        roomButton.hidden = !inLobby;
        roomButton.textContent = inLobby ? `Mi sala (${m.code})` : 'Mi sala';
    }
    $('explore-note').textContent = inLobby
        ? `Estás en la sala "${m.name}": esperando que empiece la partida.`
        : `Estás explorando el mapa. Para comprar, sumate a una partida de ${cfg.match.durationMinutes} minutos.`;
    document.body.classList.toggle('en-partida', running);
}

function explain(err) {
    if (err instanceof ApiError && err.status === 429) {
        return 'Vas muy rápido: esperá unos segundos y probá de nuevo.';
    }
    return err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor. Probá de nuevo.';
}

/** Un error que significa "la partida ya no está en juego": se relee el estado y se pasa a resultados o exploración. */
const MATCH_GONE = ['partida_no_en_juego', 'no_estas_en_partida', 'partida_inexistente'];
async function recoverFromMatchError(err) {
    if (err instanceof ApiError && MATCH_GONE.includes(err.data.error)) {
        await game.refresh().catch(() => {});
        await onMatchState();
        return true;
    }
    return false;
}

if (game) {
    // Vender: primer toque pide confirmación (el botón cambia), el segundo vende. Sin diálogos del navegador.
    $('btn-sell').addEventListener('click', async () => {
        const id = selectedId;
        const p = properties.get(id);
        const sellBtn = $('btn-sell');
        if (id == null || !p || busy || !game.owns(id)) {
            return;
        }
        if (!sellBtn.classList.contains('confirm')) {
            sellBtn.classList.add('confirm');
            sellBtn.dataset.confirmFor = String(id);
            sellBtn.textContent = `¿Seguro? Tocá de nuevo para vender por ${money(Math.floor(p.price * (cfg.economy.sellRatio ?? 0.6)))}`;
            clearTimeout(sellTimer);
            sellTimer = setTimeout(() => { resetSell(); if (selectedId === id) showPanel(id); }, 5000);
            return;
        }
        resetSell();
        busy = true;
        sellBtn.disabled = true;
        setPanelMessage('Vendiendo…');
        try {
            const r = await game.sell(id);
            setOwner(id, null);
            sound.play('cobro');
            effects.floatText($('balance'), `+${money(r.refund)}`);
            showNotice(`Vendiste la propiedad por ${money(r.refund)}.`);
            setPanelMessage('');
            game.refreshSoon(() => renderAll());
        } catch (err) {
            setPanelMessage(explain(err), true);
            if (!(await recoverFromMatchError(err))) {
                await refreshAll().catch(() => {});
            }
        } finally {
            busy = false;
            renderAll(true);
            if (selectedId === id) {
                showPanel(id);
            }
        }
    });

    // Mejorar: el nivel 1 va directo; el nivel 2 (elige rama y no se deshace) pide un segundo toque. Sin diálogos del navegador.
    $('up-options').addEventListener('click', async (ev) => {
        const btn = ev.target.closest?.('button[data-level]');
        const id = selectedId;
        if (!btn || btn.disabled || id == null || busy || !game.owns(id)) {
            return;
        }
        const level = Number(btn.dataset.level);
        const branch = btn.dataset.branch || null;
        const sure = upConfirm && upConfirm.id === id && upConfirm.level === level && upConfirm.branch === branch;
        if (level === 2 && !sure) {
            upConfirm = { id, level, branch };
            clearTimeout(upTimer);
            upTimer = setTimeout(() => { upConfirm = null; if (selectedId === id) showPanel(id); }, 6000);
            showPanel(id);
            return;
        }
        upConfirm = null;
        clearTimeout(upTimer);
        busy = true;
        setPanelMessage('Mejorando…');
        try {
            const r = await game.upgrade(id, level, branch);
            sound.play('compra');
            effects.floatText($('balance'), `-${money(r.cost)}`);
            showNotice(`Mejoraste la propiedad. Ahora tu ingreso total es ${money(r.income_per_day)} por día.`);
            setPanelMessage('');
            await game.refresh().catch(() => {});
        } catch (err) {
            setPanelMessage(explain(err), true);
            if (!(await recoverFromMatchError(err))) {
                await refreshAll().catch(() => {});
            }
        } finally {
            busy = false;
            renderAll(true);
            if (selectedId === id) {
                showPanel(id);
            }
        }
    });

    $('btn-buy').addEventListener('click', async () => {
        const id = selectedId;
        const p = properties.get(id);
        if (id == null || !p || busy) {
            return;
        }
        busy = true;
        $('btn-buy').disabled = true;
        setPanelMessage('Comprando…');
        try {
            const r = await game.buy(id);
            if (r.result === 'comprada') {
                setOwner(id, user.id, user.name);
                game.state.props.set(id, { id, kind: p.kind, price: p.price, income_per_day: p.income, price_paid: r.price });
                sound.play('compra');
                effects.pulse(id, ownerColor(user.id));
                effects.floatText($('btn-buy'), `-${money(r.price)}`, 'spend');
                showNotice(`¡Es tuya! Pagaste ${money(r.price)}.`);
            } else {
                // Reservada para vos o disputada: el servidor decide si es tuya (si nadie la disputa) o se subasta.
                if (r.auction) {
                    myAuctions.add(r.auction.id);
                    onAuctionEvent(r.auction);
                    // La respuesta no trae lo reservado: se calcula con las subastas que lidero, sin esperar la próxima lectura.
                    game.setBalance(r.balance, auctions.list().filter((x) => x.leader_id === user.id).reduce((sum, x) => sum + x.current_bid, 0));
                }
                sound.play('puja');
                showNotice(r.result === 'disputada'
                    ? `Disputaste la propiedad con ${money(r.auction.current_bid)}: la subasta dura ${cfg.auction.duration} s.`
                    : r.result === 'reclamada'
                        ? `Reservada. Si nadie la disputa en ${cfg.auction.dispute} s, es tuya.`
                        : 'Ya la tenías reservada.');
            }
            setPanelMessage('');
            game.refreshSoon(() => renderAll());
        } catch (err) {
            setPanelMessage(explain(err), true);
            if (err instanceof ApiError && ['ocupada', 'en_subasta'].includes(err.data.error)) {
                await refreshAll().catch(() => {}); // alguien se adelantó o ya hay subasta: mostrar el estado real
            } else {
                await recoverFromMatchError(err);
            }
        } finally {
            busy = false;
            renderAll(true);
            if (selectedId === id) {
                showPanel(id);
            }
        }
    });

    // Abandonar: primer toque pide confirmación (el botón cambia), el segundo abandona. Pierde la partida: último y sin puntos.
    let leaveTimer = null;
    const leaveBtn = $('btn-leave');
    const resetLeave = () => {
        clearTimeout(leaveTimer);
        leaveBtn.classList.remove('confirm');
        leaveBtn.textContent = 'Abandonar';
    };
    leaveBtn.addEventListener('click', async () => {
        if (!leaveBtn.classList.contains('confirm')) {
            leaveBtn.classList.add('confirm');
            leaveBtn.textContent = '¿Seguro? Perdés la partida';
            leaveTimer = setTimeout(resetLeave, 5000);
            return;
        }
        resetLeave();
        leaveBtn.disabled = true;
        try {
            await game.leave();
            leaving = true;
            trackedRunningId = null; // abandonar no es terminar: no hay resultados para mostrar todavía
            window.location.assign(destinationAfter('abandoned')); // perdés la partida y volvés al lobby
            return;
        } catch (err) {
            showNotice(explain(err), true);
            await recoverFromMatchError(err);
        } finally {
            leaveBtn.disabled = false;
        }
    });
}

let sellTimer = null;
function resetSell() {
    const b = $('btn-sell');
    clearTimeout(sellTimer);
    b.classList.remove('confirm');
    delete b.dataset.confirmFor;
}

// ---------------------------------------------------------------- subastas
const propLabel = (id) => {
    const p = properties.get(id);
    return p?.name ?? [cfg.kinds[p?.kind]?.label ?? 'Propiedad', p?.street].filter(Boolean).join(' ');
};

/** Marca en el mapa las propiedades reservadas/en subasta (borde naranja; rojo si ya hay disputa). */
function paintAuctions() {
    const active = new Set();
    for (const a of auctions.list()) {
        active.add(a.property_id);
        highlights.set(a.property_id, { auction: true, contested: Boolean(a.contested) });
    }
    for (const id of paintedAuctions) {
        if (!active.has(id)) {
            highlights.set(id, { auction: false, contested: false });
        }
    }
    paintedAuctions = active;
}

function updateTimer(a) {
    const left = auctions.remainingMs(a);
    const el = $('auction-timer');
    if (left <= 0) {
        el.textContent = 'Cerrando…';
    } else if (a.status === 'disputa') {
        el.textContent = `Se la queda ${a.leader} en ${clock(left)} si nadie la disputa`;
    } else {
        el.textContent = `Termina en ${clock(left)}`;
    }
    el.classList.toggle('urgent', left > 0 && left <= 10000);
}

function renderAuctionBox(a) {
    const box = $('auction-box');
    if (!a) {
        box.hidden = true;
        $('bid-form').hidden = true;
        return;
    }
    box.hidden = false;
    const lead = Boolean(user) && a.leader_id === user.id;
    $('auction-bid').textContent = money(a.current_bid);
    $('auction-leader').textContent = lead ? `${a.leader} (vos)` : (a.leader ?? 'Nadie todavía');
    $('auction-status').textContent = a.flash && a.leader_id == null
        ? '¡Subasta relámpago! Sale por menos del precio de lista: el primero que puje arranca.'
        : a.status === 'disputa'
        ? (lead ? 'La reservaste. Si nadie la disputa, es tuya.' : `${a.leader} la reservó. Disputala si la querés.`)
        : (lead ? 'Vas ganando. Si te superan, te aviso.' : 'Subasta abierta: se la queda quien puje más.');
    const form = $('bid-form');
    form.hidden = !user || lead;
    if (!form.hidden) {
        const input = $('bid-input');
        input.min = a.min_next;
        if (!bidDirty || Number(input.value) < a.min_next) {
            input.value = a.min_next;
        }
        $('btn-bid').disabled = busy;
        $('btn-bid').textContent = a.status === 'disputa' ? 'Pujar y abrir subasta' : 'Pujar';
        if (a.flash && a.leader_id == null) {
            $('btn-bid').textContent = `Pujar ${money(a.min_next)}`;
        }
    }
    updateTimer(a);
}

// Lista "Subastas en curso" (arriba a la izquierda). Se actualiza sin reconstruirla, para no perder el foco del teclado.
const listNodes = new Map();
let listKey = '';
function renderAuctionList() {
    const all = auctions.list();
    const shown = all.slice(0, 6);
    $('subastas-box').hidden = all.length === 0;
    for (const [id, n] of listNodes) {
        if (!shown.some((a) => a.id === id)) {
            n.li.remove();
            listNodes.delete(id);
        }
    }
    for (const a of shown) {
        let n = listNodes.get(a.id);
        if (!n) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            const what = document.createElement('span');
            const time = document.createElement('span');
            what.className = 'auction-what';
            time.className = 'auction-time';
            btn.append(what, time);
            li.append(btn);
            btn.addEventListener('click', () => {
                const cur = listNodes.get(a.id)?.a ?? a;
                select(cur.property_id);
                const c = centers.get(cur.property_id);
                if (c) {
                    map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 17), duration: reduceMotion ? 0 : 500 });
                }
            });
            n = { li, what, time, a };
            listNodes.set(a.id, n);
        }
        n.a = a;
        n.what.textContent = `${propLabel(a.property_id)} · ${money(a.current_bid)}${a.status === 'disputa' ? ' (reservada)' : ''}${a.flash ? ' ⚡' : ''}`;
    }
    const key = shown.map((a) => a.id).join(',');
    if (key !== listKey) {
        listKey = key;
        $('subastas').append(...shown.map((a) => listNodes.get(a.id).li));
    }
    tickList();
}

function tickList() {
    for (const n of listNodes.values()) {
        const left = auctions.remainingMs(n.a);
        n.time.textContent = left > 0 ? clock(left) : '…';
        n.time.classList.toggle('urgent', left > 0 && left <= 10000);
    }
}

const closing = new Map(); // id -> última vez que se pidió cerrar
function requestClose(id) {
    if (Date.now() - (closing.get(id) ?? 0) < 2500) {
        return;
    }
    closing.set(id, Date.now());
    // Un pequeño desfase al azar: si hay muchos navegadores abiertos, no piden todos en el mismo instante.
    setTimeout(async () => {
        try {
            const r = await auctions.close(id);
            onAuctionEvent(r.auction);
        } catch {
            // Si falló (límite de pedidos, servidor ocupado), se espera bastante antes de insistir. El reloj del servidor
            // o el próximo intento lo cierran.
            closing.set(id, Date.now() + 10000);
        }
    }, Math.random() * 400);
}

function tick() {
    if (game?.isRunning()) {
        tickMatch();
    } else if (eventStateKey !== '' || eventState !== null) {
        eventState = null;
        eventStateKey = '';
        $('match-events')?.replaceChildren();
        $('match-events')?.setAttribute('hidden', '');
        $('match-events-help')?.setAttribute('hidden', '');
    }
    const list = auctions.list();
    if (selectedId != null) {
        const a = auctions.forProperty(selectedId);
        if (a) {
            updateTimer(a);
        }
    }
    tickList();
    offerUi?.tick();
    for (const a of list) {
        if (auctions.remainingMs(a) <= 0) {
            requestClose(a.id);
        }
    }
}

/** Llega una subasta nueva o cambiada (aviso en vivo o respuesta del servidor). */
function onAuctionEvent(a) {
    const prev = auctions.apply(a);
    paintAuctions();
    renderAuctionList();

    const label = propLabel(a.property_id);
    if (a.flash && !prev && isActive(a) && game?.isRunning()) {
        sound.play('aviso');
        banner(`¡Subasta relámpago! ${label} desde ${money(a.current_bid)}`, 7000, 'cinco');
        const c = centers.get(a.property_id);
        if (c) {
            effects.pulse(a.property_id, '#ffb703');
        }
    }
    if (user) {
        const wasLeader = prev?.leader_id === user.id;
        if (wasLeader) {
            myAuctions.add(a.id);
        }
        if (isActive(a)) {
            if (wasLeader && a.leader_id !== user.id) {
                sound.play('superado');
                showNotice(`Te superaron en ${label}: ${money(a.current_bid)} de ${a.leader ?? 'otro jugador'}.`, true);
            }
        } else {
            if (a.status === 'cerrada' && a.leader_id === user.id) {
                sound.play('ganaste');
                effects.pulse(a.property_id, ownerColor(user.id));
                showNotice(`¡Ganaste ${label}! Pagaste ${money(a.current_bid)}.`);
            } else if (myAuctions.has(a.id)) {
                if (a.status === 'cerrada') {
                    sound.play('perdiste');
                }
                showNotice(a.status === 'cerrada' ? `${a.leader ?? 'Otro jugador'} se quedó con ${label} por ${money(a.current_bid)}.` : 'La subasta se canceló.', a.status !== 'cerrada');
            }
            myAuctions.delete(a.id);
        }
        if (wasLeader || a.leader_id === user.id || myAuctions.has(a.id)) {
            game.refreshSoon(() => renderAll());
        }
    }
    if (selectedId === a.property_id) {
        showPanel(selectedId);
    }
}

if (game) {
    $('bid-input').addEventListener('input', () => { bidDirty = true; });
    $('bid-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = selectedId;
        const a = id == null ? null : auctions.forProperty(id);
        if (!a || busy) {
            return;
        }
        const amount = Number($('bid-input').value);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            setPanelMessage('Poné un monto en pesos, sin decimales.', true);
            return;
        }
        busy = true;
        $('btn-bid').disabled = true;
        setPanelMessage('Enviando puja…');
        try {
            const r = await auctions.bid(a.id, amount);
            myAuctions.add(a.id);
            bidDirty = false;
            game.setBalance(r.balance, r.reserved);
            onAuctionEvent(r.auction);
            setPanelMessage('');
            sound.play('puja');
            showNotice(`Vas ganando con ${money(amount)}.`);
        } catch (err) {
            if (err instanceof ApiError && err.data.minimo) {
                setPanelMessage(`Tenés que pujar al menos ${money(err.data.minimo)}.`, true);
                $('bid-input').value = err.data.minimo;
            } else {
                setPanelMessage(explain(err), true);
            }
            if (err instanceof ApiError && ['subasta_terminada', 'subasta_cerrada', 'subasta_inexistente'].includes(err.data.error)) {
                await refreshAll().catch(() => {});
            } else {
                await recoverFromMatchError(err);
            }
        } finally {
            busy = false;
            renderAll(true);
            if (selectedId === id) {
                showPanel(id);
            }
        }
    });
}

// ---------------------------------------------------------------- la partida: estados, reloj y avisos
const SEEN_KEY = 'formosa.resultado.visto';
const markResult = (id) => { try { localStorage.setItem(SEEN_KEY, String(id)); } catch { /* sin almacenamiento */ } };

let trackedKey = 'none';      // `${id}:${status}` de la última partida procesada
let trackedRunningId = null;  // id de la partida que estaba en juego (para detectar su final)

/** Carga los dueños de la partida (o vacía el mapa si no hay una en juego). */
async function loadOwners(matchId) {
    if (matchId == null) {
        for (const id of [...owners.keys()]) {
            setOwner(id, null);
        }
        return;
    }
    const state = await getJson(`/api/partidas/${matchId}/propiedades/estado`);
    if (game.matchId() !== matchId) {
        return; // mientras tanto se cambió de partida
    }
    if ((state.catalog ?? 0) !== catalogVersion) {
        const first = catalogVersion === 0;
        catalogVersion = state.catalog ?? 0;
        if (!first) {
            await syncCatalog();
        }
    }
    const fresh = new Map(state.owned.map((o) => [o.id, o]));
    for (const id of [...owners.keys()]) {
        if (!fresh.has(id)) {
            setOwner(id, null);
        }
    }
    for (const o of fresh.values()) {
        const cur = owners.get(o.id);
        if (!cur || cur.ownerId !== o.owner_id) {
            setOwner(o.id, o.owner_id, o.owner);
        }
    }
}

/**
 * Se llama cada vez que cambia lo que el servidor dice de MI partida (carga, evento, acción): decide si hay sala,
 * partida en juego, resultados o modo exploración, y deja el mapa, las subastas, el HUD y los canales en consecuencia.
 */
async function onMatchState({ initial = false } = {}) {
    if (!game) {
        renderStats();
        return;
    }
    const m = game.state.match;
    const key = m ? `${m.id}:${m.status}` : 'none';
    const changed = key !== trackedKey;
    const prevKey = trackedKey;
    trackedKey = key;
    const running = m?.status === 'running';

    rt?.watchMatch(m && (m.status === 'lobby' || m.status === 'running') ? m.id : null);
    voice.sync(m && (m.status === 'lobby' || m.status === 'running') ? m.id : null); // la voz solo vive mientras la partida está en espera o en juego
    rt?.watchChat(chat.syncRoom(m)); // el chat de la sala acompaña a mi partida (en solo lectura al terminar o abandonar)
    auctions.setMatch(running ? m.id : null);
    offerUi?.setMatch(running ? m.id : null);
    bankUi?.setMatch(running ? m.id : null);

    if (changed || initial) {
        if (running) {
            room.close();
            results.close();
            finishing = false;
            lastRemaining = null;
            await Promise.all([
                loadOwners(m.id).catch((e) => console.warn('No se pudieron leer los dueños', e)),
                auctions.load().catch((e) => console.warn('No se pudieron leer las subastas', e)),
                offerUi?.load().catch((e) => console.warn('No se pudieron leer las ofertas', e)),
                bankUi?.load(),
            ]);
            trackedRunningId = m.id;
            if (!initial && prevKey.endsWith(':lobby')) {
                sound.play('ganaste');
                showNotice(`¡Empezó la partida! Tenés ${money(game.state.me?.cash ?? 0)} y ${cfg.match.durationMinutes} minutos.`);
            }
        } else {
            await loadOwners(null);
            auctions.load().catch(() => {});
            offerUi?.load().catch(() => {});
            if (!m && prevKey.endsWith(':lobby') && !leaving && cfg.page === 'partida') {
                // La sala que esperaba ya no existe (venció, la cerró un moderador o salí desde otra pestaña): vuelvo al lobby.
                leaving = true;
                showNotice('La sala se cerró o venció porque nadie inició la partida.', true, true);
                setTimeout(() => window.location.assign(destinationAfter('expired')), 2500);
            }
        }
        paintAuctions();
        renderAuctionList();
        renderStats();
        if (selectedId != null) {
            showPanel(selectedId);
        }
    }

    // ¿Terminó la partida? (el servidor la cerró, o ya no devuelve ninguna y hay una terminada)
    const endedId = m?.status === 'finished' ? m.id : (!m && trackedRunningId != null ? trackedRunningId : null);
    if (endedId != null) {
        trackedRunningId = null;
        finishing = false;
        if (await results.show(endedId) !== false) {   // false = todavía no terminó (por ejemplo, abandoné y siguen jugando)
            sound.play('fin');
            markResult(endedId);
        }
    }

    if (m?.status === 'lobby' && changed && !room.isOpen() && !results.isOpen()) {
        room.open(); // volvés a tu sala al entrar
    }
    room.refresh();
    renderAll(true);
    if (guidesReady && (changed || endedId != null)) {
        guides.openAuto(); // la guía automática del lugar nuevo (sala de espera, partida o resultados)
    }
}

/** Lo que pasa cada 250 ms durante una partida: cuenta regresiva, avisos de los últimos minutos y cierre. */
// Eventos de partida: el tablero muestra el activo y el anunciado; se avisa cuando cambia y se pide el estado cuando termina uno.
let eventState = null;     // estado de eventos de la última vez que se pintó (para detectar novedades)
let eventStateKey = '';
let eventRefreshFor = 0;   // instante (ms) por el que ya se pidió una lectura
function renderEvents(m) {
    const box = $('match-events');
    const now = game.serverNow();
    const msPerDay = m.minutes_per_day * 60000;
    const lines = hudLines(m.events, now, msPerDay);
    const key = stateKey(m.events);
    if (key !== eventStateKey) {
        const news = whatsNew(eventState, m.events);
        if (eventState !== null || (m.events?.active ?? []).length > 0) {
            const first = news.started[0];
            if (first) {
                sound.play('aviso');
                banner(`${first.label}: ${lines.find((l) => l.key === first.key && l.kind === 'active')?.text.split(': ')[1] ?? ''}`, 8000, 'cinco');
            } else if (news.announced) {
                banner(`Se viene: ${news.announced.label}`, 6000, 'cinco');
            }
        }
        eventState = m.events ?? null;
        eventStateKey = key;
        map.getSource('zonas-evento')?.setData(zoneFeatures(m.events));
        if (selectedId != null) {
            showPanel(selectedId);
        }
    }
    box.replaceChildren(...lines.map((l) => {
        const e = (l.kind === 'active' ? m.events.active : [m.events.next]).find((x) => x.key === l.key);
        const p = document.createElement('p');
        p.className = `match-event ${l.kind === 'next' ? 'next' : (e.pct >= 0 ? 'up' : 'down')}${isSprint(e) ? ' sprint' : ''}`;
        p.textContent = l.text;
        return p;
    }));
    box.hidden = lines.length === 0;
    $('match-events-help')?.toggleAttribute('hidden', lines.length === 0);
    // Cuando termina uno (o empieza el anunciado) el ingreso por día cambia: se pide el estado para tener el número exacto.
    const at = changeAt(m.events);
    if (at !== null && now >= at && eventRefreshFor !== at) {
        eventRefreshFor = at;
        game.refreshSoon(() => renderAll());
    }
}

function tickMatch() {
    const m = game.state.match;
    const clk = matchClock(m, game.serverNow());
    renderHud();
    renderEvents(m);
    for (const w of crossedWarnings(lastRemaining, clk.remainingMs)) {
        sound.play('aviso');
        banner(w === 'cinco' ? 'Quedan 5 minutos' : '¡Último minuto!', w === 'cinco' ? 6000 : 9000, w);
        $('match-sr').textContent = w === 'cinco' ? 'Quedan 5 minutos de partida.' : 'Queda un minuto de partida.';
    }
    lastRemaining = clk.remainingMs;
    if (clk.over && !finishing) {
        finishing = true;
        closeAfterEnd();
    }
}

/** Se acabó el tiempo: se pide el estado hasta que el servidor confirme el cierre (lo cierra la primera lectura). */
async function closeAfterEnd(tries = 0) {
    try {
        await game.refresh();
    } catch { /* se reintenta */ }
    if (game.state.match?.status === 'running' && tries < 8) {
        setTimeout(() => closeAfterEnd(tries + 1), 1500 + tries * 500);
        return;
    }
    await onMatchState();
}

// ---------------------------------------------------------------- tiempo real
/** Vuelve a leer MI partida, quién es dueño de qué y las subastas (al reconectar, o cada tanto si no hay conexión en vivo). */
async function refreshAll() {
    if (!ready) {
        return;
    }
    if (game) {
        await game.refresh();
        await onMatchState();
        if (game.isRunning()) {
            await loadOwners(game.matchId());
            await auctions.load();
            await offerUi?.load().catch(() => {});
            paintAuctions();
            renderAuctionList();
        }
    }
    if (selectedId != null) {
        showPanel(selectedId);
    }
}

function setLive(isLive) {
    live = isLive;
    const el = $('live');
    el.hidden = false;
    el.classList.toggle('on', isLive);
    el.textContent = isLive ? '● en vivo' : '○ sin conexión en vivo';
}

const sameMatch = (e) => game && game.matchId() != null && Number(e.match_id) === game.matchId();

rt = connectRealtime(cfg.reverb, {
    onOwner: (e) => {
        if (!sameMatch(e)) {
            return;
        }
        if (!ready) {
            queued.push(e);
            return;
        }
        setOwner(e.id, e.owner_id, e.owner);
        if (e.owner_id != null) {
            effects.pulse(e.id, ownerColor(e.owner_id)); // las compras ajenas también se ven pasar, si están a la vista
        }
        // Cambia el patrimonio de alguien: se actualizan las posiciones (juntando varios avisos en una sola lectura).
        game.refreshSoon(() => renderAll());
    },
    onCorrected: (e) => {
        if (!ready) {
            needsSync = true; // se relee todo al terminar de cargar
            return;
        }
        applyCorrection(e);
        if (catalogVersion === 0 || e.catalog === catalogVersion + 1) {
            catalogVersion = e.catalog;
        } else if (e.catalog !== catalogVersion) {
            catalogVersion = e.catalog;
            syncCatalog().catch(() => {}); // se perdió algún aviso: se relee
        }
    },
    onAuction: (e) => {
        if (!sameMatch(e)) {
            return;
        }
        if (!ready) {
            queuedAuctions.push(e);
            return;
        }
        onAuctionEvent(e);
    },
    onOffer: (e) => {
        if (sameMatch(e) && ready) {
            offerUi?.onEvent(e);
        }
    },
    onActivity: (e) => {
        if (sameMatch(e) && ready) {
            feed.push(e);
        }
    },
    onPlayers: (e) => {
        if (!sameMatch(e)) {
            return;
        }
        game.refreshSoon(() => { onMatchState(); });
    },
    onStarted: (e) => {
        if (!sameMatch(e)) {
            return;
        }
        game.refresh().then(() => onMatchState()).catch(() => {});
    },
    onFinished: (e) => {
        if (!sameMatch(e)) {
            return;
        }
        finishing = true;
        feed.clear();
        closeAfterEnd();
    },
    onChat: (m) => {
        chat.onMessage(m);
        if (m.kind !== 'sistema' && !(user && m.user_id === user.id)) {
            sound.play('chat'); // los avisos del juego no suenan; los mensajes de otros jugadores (sala o global) sí
        }
    },
    onChatHidden: (id, matchId) => chat.onHidden(id, matchId),
    onChatRoomLive: (on) => chat.setRoomLive(on),
    onStatus: setLive,
    onBack: () => {
        refreshAll().catch(() => {});
        chat.resync().catch(() => {}); // pudimos perder mensajes mientras no había conexión
    },
});
// Respaldo: sin conexión en vivo (o sin Reverb configurado), se relee el estado cada 10 s mientras la pestaña está visible
// (sala o partida); con conexión, una lectura de control cada 30 s por si se perdió algún aviso.
let pollTick = 0;
setInterval(() => {
    pollTick += 1;
    if (document.hidden || !game || !game.state.match) {
        return;
    }
    if (!live || pollTick % 3 === 0) {
        refreshAll().catch(() => {});
    }
}, 10000);
// El chat se relee más seguido sin conexión en vivo (solo lo nuevo, una consulta liviana). La sala también si su canal
// privado no entró (autorización rechazada o caído) aunque el resto esté en vivo.
setInterval(() => {
    if (!document.hidden) {
        chat.poll(live).catch(() => {});
    }
}, 10000);

// ---------------------------------------------------------------- salas y resultados
if (game) {
    room = createWaitingRoom({
        $, user, game,
        onChange: () => onMatchState(),
        onLeft: () => {
            leaving = true;
            window.location.assign(destinationAfter('left'));
        },
    });
    results = createResults({
        $, user,
        onAgain: () => window.location.assign(destinationAfter('again')),
        onRanking: () => drawer.open('ranking', $('btn-ranking')),
        // Termina la partida: suena el sting de victoria o de derrota (una sola vez por partida)
        onResult: ({ matchId, me }) => audio.result(me && !me.abandoned ? (me.rank === 1 ? 'victoria' : 'derrota') : null, matchId, sessionSeed(matchId, user?.id ?? 0)),
    });
} else {
    // Visitante: puede recorrer el mapa y ver el ranking, pero no jugar (las salas se ven en el lobby).
    room = { open() {}, close() {}, isOpen: () => false, refresh() {} };
    results = { show: async () => false, close() {}, isOpen: () => false };
}

// ---------------------------------------------------------------- leyenda, filtros y 3D
const visibleKinds = new Set(Object.keys(cfg.kinds));

function applyKindFilter() {
    for (const [layer, filter] of Object.entries(layerFilters([...visibleKinds]))) {
        map.setFilter(layer, filter);
    }
    scheduleCityRebuild();
}

for (const [key, kind] of Object.entries(cfg.kinds)) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', () => {
        input.checked ? visibleKinds.add(key) : visibleKinds.delete(key);
        applyKindFilter();
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = kind.color;
    label.append(input, swatch, document.createTextNode(kind.label));
    li.append(label);
    $('legend-list').append(li);
}

// Leyenda: abierta en escritorio, plegada en celular (ahí ocupa mucho mapa). Se recuerda lo último que eligió el jugador.
const legendButton = $('btn-legend');
function setLegend(open) {
    $('legend').hidden = !open;
    legendButton.setAttribute('aria-expanded', String(open));
}
let legendPref = null;
try {
    legendPref = localStorage.getItem('formosa.leyenda');
} catch { /* sin almacenamiento */ }
setLegend(legendPref === null ? !isSmall() : legendPref === '1');
legendButton.addEventListener('click', () => {
    const open = $('legend').hidden;
    setLegend(open);
    try {
        localStorage.setItem('formosa.leyenda', open ? '1' : '0');
    } catch { /* sin almacenamiento */ }
});

const soundButton = $('btn-sound');
soundButton.setAttribute('aria-pressed', String(sound.isOn()));
soundButton.addEventListener('click', () => soundButton.setAttribute('aria-pressed', String(sound.toggle())));
$('btn-help').addEventListener('click', () => guides.openMenu());

// ---------------------------------------------------------------- música: qué pista suena según el estado del juego
const isNight = () => ['noche', 'madrugada'].includes(phaseAt(currentHours()).key);
function audioTick() {
    const m = game?.state.match;
    const running = !!game?.isRunning();
    const clk = running ? matchClock(m, game.serverNow()) : null;
    audio.update(
        { enPartida: running && !clk.over, restanteMs: clk?.remainingMs ?? null, noche: isNight(), es3d: is3d },
        sessionSeed(running ? m.id : null, user?.id ?? 0),
    );
}
setInterval(audioTick, 500);

// ---------------------------------------------------------------- vista 3D (ciudad) y hora del día
const GRASS = '#6fbf5f';
const BACKGROUND_2D = '#ebe8e0';
const ROADS = {
    '2d': { casing: '#d3cdbd', fill: '#ffffff' },
    '3d': { casing: '#c8cfda', fill: '#3a3f4e' }, // veredas grises y asfalto oscuro, como la ciudad pixel
};
const ROOF_MINE = '#ffb703';
let roadWidths2d = null;
/** Multiplica las salidas de un ['interpolate', …, ['zoom'], z1, v1, z2, v2…] (MapLibre no deja envolver el zoom en otra cuenta). */
function scaleStops(expr, k) {
    if (!Array.isArray(expr) || expr[0] !== 'interpolate') return typeof expr === 'number' ? expr * k : expr;
    return expr.map((v, i) => (i > 3 && i % 2 === 0 && typeof v === 'number' ? v * k : v));
}
const ROOF_SELECTED = '#fff3a8';

/** Color del techo en 3D: seleccionada, tuya (dorado), de otro (su color) o null (el de siempre). */
function roofOf(id) {
    if (id === selectedId) return ROOF_SELECTED;
    const o = owners.get(id);
    if (!o) return null;
    return user && o.ownerId === user.id ? ROOF_MINE : ownerColor(o.ownerId);
}

let rebuildTimer = null;
function scheduleCityRebuild() {
    if (!city) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => city?.rebuild(), 400);
}

async function ensureCity(loader = null) {
    if (city) return city;
    if (!cityLoading) {
        // Entorno (agua, plazas, parques…): si el servidor es viejo (404) o no tiene datos, la ciudad se arma sin él.
        const environment = getJson('/api/entorno')
            .then((fc) => (Array.isArray(fc?.features) ? fc.features : []))
            .catch((e) => { console.info('Ciudad 3D sin entorno:', e?.status ?? e?.message ?? e); return []; })
            .finally(() => loader?.step('entorno'));
        cityLoading = import('./city3d.js').then(async ({ createCity3D }) => {
            loader?.step('modulo');
            // el armado pesado corre en un worker: el mapa sigue respondiendo mientras tanto
            const built = await createCity3D({ map, properties, geometries, roads: roadsData, roofOf, isVisible: (kind) => visibleKinds.has(kind), quality: qualityMode, environment: await environment, traffic: trafficOn });
            loader?.step('armado');
            map.addLayer(built.layer);
            // el suelo va debajo de las calles 2D (si no, el pasto las taparía)
            if (built.groundLayer) map.addLayer(built.groundLayer, map.getLayer('calles-menores-borde') ? 'calles-menores-borde' : undefined);
            // shaders y texturas se preparan antes del primer cuadro del 3D, de a poco (ninguna tarea larga en el hilo principal)
            await built.warmUp?.().catch(() => null);
            loader?.step('luces');
            city = built;
            return city;
        }).catch((err) => {
            cityLoading = null;
            throw err;
        });
    }
    return cityLoading;
}

function styleFor3d(on) {
    for (const id of ['propiedades-relleno', 'propiedades-borde']) {
        map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
    }
    map.setLayoutProperty('propiedades-3d', 'visibility', 'none');
    // Con calles 3D (asfalto, veredas, cordón, marcas de city-roads) las líneas 2D de MapLibre sobran en 3D.
    const roads3d = on && !!city?.hasRoads;
    for (const id of ['calles-menores', 'calles-menores-borde', 'calles-principales', 'calles-principales-borde']) {
        map.setLayoutProperty(id, 'visibility', roads3d ? 'none' : 'visible');
    }
    map.setLayoutProperty('calles-centro', 'visibility', on && !roads3d ? 'visible' : 'none');
    // En 3D las calles llevan veredas anchas a los costados (el borde de la línea) y asfalto al medio.
    if (!roadWidths2d) {
        roadWidths2d = Object.fromEntries(['calles-menores', 'calles-principales'].flatMap((id) => [
            [id, map.getPaintProperty(id, 'line-width')], [`${id}-borde`, map.getPaintProperty(`${id}-borde`, 'line-width')],
        ]));
    }
    for (const [id, width] of Object.entries(roadWidths2d)) {
        map.setPaintProperty(id, 'line-width', on && id.endsWith('-borde') ? scaleStops(width, 1.7) : width);
    }
    for (const id of ['ciudad-3d', 'ciudad-3d-suelo']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    lastLight = null; // repintar colores del suelo y las calles con la hora actual
    applyLight(true);
}

$('btn3d').addEventListener('click', async () => {
    const next = !is3d;
    const button = $('btn3d');
    if (next && !city) {
        button.disabled = true;
        const loader = createCityLoader(); // barra chica con los pasos reales (entorno, motor, edificios, luces)
        try {
            await ensureCity(loader);
            loader.close();
        } catch (err) {
            console.error(err);
            loader.close();
            showNotice('No se pudo armar la vista 3D en este navegador.', true);
            button.disabled = false;
            return;
        }
        button.disabled = false;
    }
    is3d = next;
    button.setAttribute('aria-pressed', String(is3d));
    document.body.classList.toggle('modo-3d', is3d);
    styleFor3d(is3d);
    city?.setActive(is3d);
    cameraFor3d(is3d);
});

// Límites de la cámara: en 3D no se sale del barrio (+300 m), zoom 14,5–19,5 e inclinación hasta 75°; en 2D, como siempre.
// Primero se lleva la cámara suavemente adentro de lo permitido y recién después se fijan los límites (sin saltos).
let limitsToken = 0;
function cameraFor3d(on) {
    const token = ++limitsToken;
    const duration = reduceMotion ? 0 : 700;
    const after = (fn) => {
        const run = () => { if (token === limitsToken) fn(); };
        if (duration === 0) run();
        else map.once('moveend', run);
    };
    if (on) {
        const bounds = districtBounds([...geometries.values()].map((g) => g.coordinates[0]));
        map.setMaxPitch(LIMITS_3D.maxPitch); // solo agranda el rango: no mueve nada
        const c = map.getCenter();
        const center = bounds ? clampLngLat([c.lng, c.lat], bounds) : [c.lng, c.lat];
        map.easeTo({ center, pitch: 58, bearing: -20, zoom: clampZoom(Math.max(map.getZoom(), 16.2)), duration });
        after(() => {
            map.setMinZoom(LIMITS_3D.minZoom);
            map.setMaxZoom(LIMITS_3D.maxZoom);
            if (bounds) {
                // Se limita el centro (no toda la pantalla, que es lo que haría maxBounds solo y obligaría a acercarse).
                map.setTransformConstrain((lngLat, zoom) => {
                    const [lng, lat] = clampLngLat([lngLat.lng, lngLat.lat], bounds);
                    return { center: new maplibregl.LngLat(lng, lat), zoom: clampZoom(zoom) };
                });
                map.setMaxBounds(bounds);
            }
        });
    } else {
        map.setTransformConstrain(null);
        map.setMaxBounds(null);
        map.setMinZoom(LIMITS_2D.minZoom);
        map.easeTo({ pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), LIMITS_2D.maxZoom), duration });
        after(() => {
            map.setMaxZoom(LIMITS_2D.maxZoom);
            map.setMaxPitch(LIMITS_2D.maxPitch);
        });
    }
}

// Calidad de la vista 3D: automática (mide los primeros segundos y baja si va lento) o elegida a mano.
const qualitySelect = $('calidad');
if (qualitySelect) {
    qualitySelect.value = qualityMode;
    qualitySelect.addEventListener('change', () => {
        qualityMode = parseQualityMode(qualitySelect.value);
        try {
            localStorage.setItem(QUALITY_KEY, qualityMode);
        } catch { /* sin almacenamiento */ }
        city?.setQuality(qualityMode);
        const labels = { auto: 'automática', baja: 'baja', media: 'media', alta: 'alta' };
        showNotice(`Calidad 3D: ${labels[qualityMode]}.`);
    });
}

// Tránsito animado en 3D (autos, motos, colectivos): prendido por defecto, se recuerda en este navegador.
const TRAFFIC_KEY = 'formosa.transito';
let trafficOn = true;
try {
    trafficOn = localStorage.getItem(TRAFFIC_KEY) !== '0';
} catch { /* sin almacenamiento */ }
const trafficButton = $('btn-transito');
if (trafficButton) {
    trafficButton.setAttribute('aria-pressed', String(trafficOn));
    trafficButton.addEventListener('click', () => {
        trafficOn = !trafficOn;
        trafficButton.setAttribute('aria-pressed', String(trafficOn));
        try {
            localStorage.setItem(TRAFFIC_KEY, trafficOn ? '1' : '0');
        } catch { /* sin almacenamiento */ }
        city?.setTraffic(trafficOn);
        showNotice(trafficOn ? 'Tránsito activado.' : 'Tránsito desactivado.');
    });
}

// Hora de la ciudad, con la hora del servidor (todos ven lo mismo). En una partida sale de su `started_at` (un día de juego
// = `minutes_per_day` minutos reales); sin partida, ciclo lento de exploración de 24 minutos por día (`EXPLORE_MINUTES_PER_DAY`).
const clockCfg = cfg.clock ?? { minutesPerDay: 24, serverNow: Date.now() };
const clockOffset = clockCfg.serverNow - Date.now();
const serverNow = () => (game ? game.serverNow() : Date.now() + clockOffset);
/** La partida que marca la hora: solo si está en juego (en la sala o terminada la ciudad vuelve al ciclo lento). */
const clockMatch = () => (game?.isRunning() ? game.state.match : null);
const currentHours = () => forcedHour ?? cityHours(serverNow(), clockMatch(), EXPLORE_MINUTES_PER_DAY);
let cycleOn = true;
try {
    cycleOn = localStorage.getItem('formosa.ciclo') !== '0';
} catch { /* sin almacenamiento */ }
let lastLight = null;
let lastPhase = null;

function lightChanged(a, b) {
    if (!a || !b) return true;
    return Math.abs(a.tint[0] - b.tint[0]) + Math.abs(a.tint[1] - b.tint[1]) + Math.abs(a.tint[2] - b.tint[2]) > 0.006
        || Math.abs(a.lights - b.lights) > 0.01 || Math.abs(a.sun.elevation - b.sun.elevation) > 0.02;
}

// /mapa?hora=21.5 fija la hora (para ver cómo queda la ciudad de noche sin esperar). Solo cambia lo que ve ese navegador.
const forcedHour = (() => {
    const h = Number.parseFloat(new URLSearchParams(location.search).get('hora') ?? '');
    return Number.isFinite(h) && h >= 0 && h < 24 ? h : null;
})();

function applyLight(force = false) {
    const hours = currentHours();
    const phase = phaseAt(hours);
    const hm = hhmm(hours);
    if ($('clock-time').textContent !== hm) {
        $('clock-time').textContent = hm;
    }
    if (phase.key !== lastPhase) {
        $('clock-phase').textContent = `${phase.icon} ${phase.label}`;
    }
    if (phase.key !== lastPhase) {
        lastPhase = phase.key;
        document.body.dataset.fase = phase.key;
    }
    const light = lightAt(cycleOn ? hours : 13);
    if (!force && !lightChanged(light, lastLight)) return;
    lastLight = light;

    const overlay = $('noche');
    if (is3d) {
        overlay.hidden = true;
        const roads = ROADS['3d'];
        // Con suelo propio (que se funde en la bruma del borde), el fondo de MapLibre es el mismo horizonte: no hay
        // "césped infinito" más allá de los alrededores. Sin suelo (servidor viejo, error), el pasto de siempre.
        map.setPaintProperty('fondo', 'background-color', city?.hasGround ? rgbCss(light.horizon) : tintHex(GRASS, light.tint));
        for (const id of ['calles-menores', 'calles-principales']) {
            map.setPaintProperty(`${id}-borde`, 'line-color', tintHex(roads.casing, light.tint));
            map.setPaintProperty(id, 'line-color', tintHex(roads.fill, light.tint));
        }
        map.setPaintProperty('calles-centro', 'line-color', tintHex('#ffd36b', light.tint.map((t) => Math.max(t, light.lights * 0.9))));
        city?.setLight(light);
    } else {
        // En 2D, una capa que multiplica los colores (como un filtro): de noche todo se ve azulado y más oscuro, pero legible.
        const soft = light.tint.map((t) => 1 - (1 - t) * 0.75);
        overlay.hidden = soft.every((v) => v > 0.995);
        overlay.style.backgroundColor = rgbCss(soft);
        map.setPaintProperty('fondo', 'background-color', BACKGROUND_2D);
        for (const id of ['calles-menores', 'calles-principales']) {
            map.setPaintProperty(`${id}-borde`, 'line-color', ROADS['2d'].casing);
            map.setPaintProperty(id, 'line-color', ROADS['2d'].fill);
        }
    }
    map.setSky({
        'sky-color': rgbCss(light.sky), 'horizon-color': rgbCss(light.horizon), 'fog-color': rgbCss(light.horizon),
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0,
    });
}

const clockButton = $('clock');
clockButton.setAttribute('aria-pressed', String(cycleOn));
clockButton.addEventListener('click', () => {
    cycleOn = !cycleOn;
    clockButton.setAttribute('aria-pressed', String(cycleOn));
    try {
        localStorage.setItem('formosa.ciclo', cycleOn ? '1' : '0');
    } catch { /* sin almacenamiento */ }
    showNotice(cycleOn ? 'Ciclo de día y noche activado.' : 'Luz de día fija (la hora sigue corriendo).');
    applyLight(true);
});
map.once('load', () => {
    applyLight(true);
    setInterval(() => applyLight(), 250); // en partida 1 segundo real = 12 minutos de la ciudad: se repinta seguido (solo si cambió la luz)
});

// Medidor de fluidez para probar con muchos edificios: abrí /mapa?debug=1 y mové el mapa (solo cuenta cuadros mientras hay movimiento).
if (new URLSearchParams(location.search).has('debug')) {
    const meter = document.createElement('div');
    meter.className = 'debug-fps';
    meter.setAttribute('aria-hidden', 'true');
    document.body.append(meter);
    let frames = 0;
    let since = performance.now();
    let longest = 0; // tarea larga más larga del hilo principal (ms), si el navegador la informa
    try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); }).observe({ type: 'longtask', buffered: true });
    } catch { /* sin longtask */ }
    map.on('render', () => { frames += 1; });
    setInterval(() => {
        const now = performance.now();
        const c3 = is3d && city ? city.stats() : null;
        const extra = c3 ? ` · calidad ${c3.quality} · ${c3.drawCalls} dibujos · ${Math.round(c3.drawnTriangles / 1000)} k triángulos · sectores ${c3.chunks.visible}/${c3.chunks.total} (${c3.chunks.lod} simples)`
            + ` · vehículos ${c3.vehiclesDrawn ?? 0}/${c3.vehicles ?? 0} (${c3.vehiclesFar ?? 0} simples, +${c3.parked ?? 0} est.) · armado ${c3.buildMs} ms${c3.workers > 1 ? ` (${c3.workers} workers)` : c3.worker ? '' : ' (sin worker)'}` : '';
        meter.textContent = `${Math.round((frames * 1000) / (now - since))} cuadros/s · ${properties.size} propiedades · zoom ${map.getZoom().toFixed(1)}${extra}${longest ? ` · tarea más larga ${Math.round(longest)} ms` : ''}`;
        frames = 0;
        since = now;
    }, 1000);
}

// Para pruebas desde la consola del navegador.
window.formosa = { map, intro, audio, setOwner, select, refreshAll, applyCorrection, syncCatalog, drawer, game, room, results, onMatchState, owners, city: () => city, gameHours: () => currentHours(), setCycle: (on) => { cycleOn = on; applyLight(true); }, auctions, chat, highlights, sound, effects, guides };


initUiMin();
