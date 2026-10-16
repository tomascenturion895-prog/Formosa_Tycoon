import { getJson, postJson, newKey, ApiError } from './api.js';
import { projectCash } from './partida.js';

const MIN_GAP_MS = 3000; // el servidor limita a 30 pedidos por minuto y jugador: las lecturas del estado se espacian

/**
 * Estado del jugador y de su partida en el navegador. El servidor es la verdad (`GET /api/partidas/actual`): acá se
 * guarda lo último que dijo, se corrige el reloj local con `server_now` y se "anima" el efectivo entre lecturas con el
 * ingreso por día de juego (que el servidor liquida de forma continua y automática: no hay botón de cobrar).
 */
export function createGame({ serverNow: initialServerNow = Date.now() } = {}) {
    const state = {
        match: null,          // objeto `match` del servidor o null (sin sala)
        me: null,             // mi dinero y propiedades (null en la sala: todavía no hay dinero)
        players: [],          // jugadores: en la sala {user_id, name, is_creator}; en juego, con patrimonio y propiedades
        props: new Map(),     // id de propiedad -> { id, kind, price, income_per_day, price_paid, bought_at }
        lastFinishedId: null, // última partida terminada (para ir a /resultado)
        ownersVersion: null,
        fetchedAt: Date.now(),  // hora local de la última lectura
        fetchedServer: initialServerNow, // hora del servidor en esa lectura
    };
    let offset = initialServerNow - Date.now(); // hora del servidor - hora local, en ms
    let inflight = null;
    let lastStart = 0;
    let timer = null;

    const serverNow = () => Date.now() + offset;

    function syncClock(ms) {
        if (Number.isFinite(ms)) {
            offset = ms - Date.now();
        }
    }

    /** Aplica una respuesta con `match` (actual, crear, unirse, iniciar). */
    function apply(d) {
        syncClock(d.match?.server_now ?? d.server_now);
        state.match = d.match ?? null;
        state.me = d.me ?? null;
        state.players = d.players ?? [];
        state.props = new Map((d.me?.properties ?? []).map((p) => [p.id, p]));
        if ('last_finished_match_id' in d) {
            state.lastFinishedId = d.last_finished_match_id;
        }
        state.ownersVersion = d.owners_version ?? state.ownersVersion;
        state.fetchedAt = Date.now();
        state.fetchedServer = serverNow();
    }

    async function refresh() {
        if (inflight) {
            return inflight;
        }
        lastStart = Date.now();
        inflight = getJson('/api/partidas/actual').then((d) => { apply(d); return d; }).finally(() => { inflight = null; });
        return inflight;
    }

    /** Pide una lectura pronto, juntando varios pedidos seguidos en uno y respetando el espaciado mínimo. */
    function refreshSoon(onDone) {
        if (timer !== null) {
            return;
        }
        const wait = Math.max(300, MIN_GAP_MS - (Date.now() - lastStart));
        timer = setTimeout(async () => {
            timer = null;
            try {
                const d = await refresh();
                onDone?.(d);
            } catch (e) {
                if (!(e instanceof ApiError && e.status === 429)) {
                    console.warn('No se pudo leer la partida', e);
                }
            }
        }, wait);
    }

    const matchId = () => state.match?.id ?? null;
    const isRunning = () => state.match?.status === 'running';

    /** Efectivo con el ingreso proyectado desde la última lectura. */
    function cash() {
        if (!state.me) {
            return 0;
        }
        if (!isRunning()) {
            return state.me.cash;
        }
        return projectCash(state.me.cash, state.me.income_per_day, state.fetchedServer, serverNow(), state.match);
    }
    const reserved = () => state.me?.reserved ?? 0;
    const available = () => Math.max(0, cash() - reserved());
    const incomePerDay = () => state.me?.income_per_day ?? 0;
    const assets = () => state.me?.assets ?? 0;
    const debt = () => state.me?.debt ?? 0;
    const netWorth = () => cash() + assets() - debt();

    /** El banco informa la deuda exacta tras pedir o pagar un préstamo. */
    function setDebt(value) {
        if (state.me && Number.isFinite(value)) {
            state.me.debt = value;
        }
    }

    /** Después de una compra/venta/puja el servidor informa el saldo exacto: se toma como nueva base. */
    function setBalance(balance, reservedNow) {
        if (!state.me || !Number.isFinite(balance)) {
            return;
        }
        state.me.cash = balance;
        if (Number.isFinite(reservedNow)) {
            state.me.reserved = reservedNow;
        }
        state.fetchedServer = serverNow();
        state.fetchedAt = Date.now();
    }

    const base = () => `/api/partidas/${matchId()}`;

    async function buy(propertyId) {
        const r = await postJson(`${base()}/propiedades/${propertyId}/comprar`, { 'Idempotency-Key': newKey() });
        setBalance(r.balance);
        return r;
    }

    async function sell(propertyId) {
        const r = await postJson(`${base()}/propiedades/${propertyId}/vender`, { 'Idempotency-Key': newKey() });
        setBalance(r.balance);
        state.props.delete(propertyId);
        return r;
    }

    /** Sube una propiedad propia al nivel siguiente. `branch` ('a'|'b') solo para el nivel 2. */
    async function upgrade(propertyId, level, branch = null) {
        const body = branch ? { nivel: level, rama: branch } : { nivel: level };
        const r = await postJson(`${base()}/propiedades/${propertyId}/mejorar`, { 'Idempotency-Key': newKey() }, body);
        setBalance(r.balance);
        return r;
    }

    // ---- Salas
    async function create({ nombre, cupo, publica }) {
        const r = await postJson('/api/partidas', {}, { nombre, cupo, publica });
        apply(r);
        return r;
    }
    async function join(code) {
        const r = await postJson(`/api/partidas/${encodeURIComponent(code.trim().toUpperCase())}/unirse`);
        apply(r);
        return r;
    }
    async function start() {
        const r = await postJson(`${base()}/iniciar`);
        apply(r);
        return r;
    }
    /** Sale de la sala o abandona la partida en curso. */
    async function leave() {
        const id = matchId();
        const r = await postJson(`/api/partidas/${id}/salir`);
        return { ...r, id };
    }

    function clear() {
        state.match = null;
        state.me = null;
        state.players = [];
        state.props = new Map();
    }

    return {
        state, refresh, refreshSoon, apply, clear, serverNow, syncClock,
        get offset() { return offset; },
        matchId, isRunning, cash, reserved, available, incomePerDay, assets, debt, netWorth, setBalance, setDebt,
        buy, sell, upgrade, create, join, start, leave,
        owns: (id) => state.props.has(id),
    };
}
