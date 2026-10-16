// Ofertas entre jugadores (DOM): en el detalle de la propiedad, el dueño la pone en oferta (mínimo y "comprá ya") y los demás ofertan.
// La lógica de qué mostrar y los textos están en offers-model.js; el estado y los pedidos, en offers.js.

import { ApiError } from './api.js';
import { createOffers } from './offers.js';
import { bidCheck, isDue, phase, roleOf, sellerNet, statusText, suggestPrices, timerText, validatePrices, outcomeNotice, upgradeLine } from './offers-model.js';

/**
 * @param {object} o
 * @param {(id: string) => HTMLElement|null} o.$ getElementById
 * @param {() => ({id: number, name: string}|null)} o.getUser
 * @param {object} o.game estado del jugador (disponible, saldo)
 * @param {(n: number) => string} o.money
 * @param {(ms: number) => string} o.clock
 * @param {(propertyId: number) => string} o.propLabel
 * @param {(text: string, isError?: boolean) => void} o.notice aviso arriba
 * @param {(text: string, isError?: boolean) => void} o.message mensaje dentro del panel
 * @param {(name: string) => void} o.play sonido
 * @param {(propertyId: number, ownerId: number|null, ownerName: string|null) => void} o.setOwner
 * @param {(propertyId: number, ownerId: number) => void} o.pulse resalte en el mapa
 * @param {(err: unknown) => string} o.explain
 * @param {() => void} o.onChange hay que redibujar el panel y los números
 * @param {(err: unknown) => Promise<boolean>} o.recover error de "la partida ya no está en juego"
 */
export function createOffersUi({ $, getUser, game, money, clock, propLabel, notice, message, play, setOwner, pulse, explain, onChange, recover }) {
    const store = createOffers();
    const box = $('offer-box');
    const newBox = $('offer-new');
    let pending = false;
    let shownFor = null;       // propiedad cuyo formulario de "ofrecer" ya se rellenó
    let bidDirty = false;
    let current = null;        // oferta de la propiedad abierta en el panel
    const closing = new Map(); // id -> última vez que se pidió cerrar

    const me = () => getUser()?.id ?? null;

    // ---------------------------------------------------------------- dibujo
    /**
     * Dibuja las cajas de ofertas para la propiedad abierta. Devuelve `{ offer, hideSell }`: si es mía y está en oferta, no se
     * puede vender al banco.
     */
    function render({ id, mine, playing, price }) {
        const user = getUser();
        const o = playing ? store.forProperty(id) : null;
        current = o;
        const now = store.now();

        box.hidden = !o;
        newBox.hidden = !(user && playing && mine && !o);

        if (newBox.hidden) {
            shownFor = null;
        } else if (shownFor !== id) {
            shownFor = id;
            const s = suggestPrices(price, store.floor);
            $('offer-min-input').value = s.min;
            $('offer-max-input').value = s.max;
            newBox.open = false;
            paintHint();
        }
        if (!o) {
            return { offer: null, hideSell: false };
        }

        const role = roleOf(o, me());
        $('offer-status').textContent = statusText(o, me(), now, money);
        $('offer-min').textContent = money(o.min_price);
        $('offer-buynow').textContent = money(o.buy_now_price);
        const upgrade = upgradeLine(o);
        $('offer-upgrade').textContent = upgrade;
        $('offer-upgrade-row').hidden = upgrade === '';
        $('offer-best').textContent = o.current_bid == null ? 'Sin ofertas' : `${money(o.current_bid)} · ${role === 'leader' ? 'vos' : o.leader}`;
        updateTimer();

        // Ofertar: visitante o quien va ganando (puede mejorar su propia oferta), solo mientras se puede ofertar.
        const check = bidCheck(o, { meId: me(), available: game?.available() ?? 0, now });
        const bidding = (role === 'visitor' || role === 'leader') && phase(o, now) === 'ofertando';
        const form = $('offer-bid-form');
        form.hidden = !bidding;
        if (bidding) {
            const input = $('offer-bid-input');
            input.min = o.min_next;
            if (!bidDirty || Number(input.value) < o.min_next) {
                input.value = o.min_next;
            }
            $('btn-offer-bid').disabled = pending || !check.can;
            $('btn-offer-bid').textContent = check.can ? 'Ofertar' : `Te faltan ${money(check.missing)}`;
            const buyNow = $('btn-offer-buynow');
            const own = role === 'leader' ? o.current_bid ?? 0 : 0;
            const canBuyNow = (game?.available() ?? 0) + own >= o.buy_now_price;
            buyNow.disabled = pending || !canBuyNow;
            buyNow.textContent = canBuyNow ? `Comprar ya por ${money(o.buy_now_price)}` : `Comprar ya: te faltan ${money(o.buy_now_price - (game?.available() ?? 0) - own)}`;
        }

        // Dueño: aceptar la mejor oferta o retirar la oferta.
        const ownerBar = $('offer-owner-actions');
        ownerBar.hidden = role !== 'owner';
        if (role === 'owner') {
            const accept = $('btn-offer-accept');
            accept.hidden = o.leader_id == null;
            if (o.leader_id != null) {
                accept.textContent = `Aceptar ${money(o.current_bid)} (cobrás ${money(sellerNet(o.current_bid, store.feePct).net)})`;
            }
            accept.disabled = pending;
            $('btn-offer-cancel').disabled = pending;
        }
        return { offer: o, hideSell: role === 'owner' };
    }

    function updateTimer() {
        const o = current;
        const el = $('offer-timer');
        if (!o) {
            return;
        }
        const now = store.now();
        el.textContent = timerText(o, now, clock);
        const left = (phase(o, now) === 'ofertando' ? o.ends_at : o.decide_until) - now;
        el.classList.toggle('urgent', left > 0 && left <= 10000);
    }

    function paintHint() {
        const min = Number($('offer-min-input').value);
        const max = Number($('offer-max-input').value);
        const ok = validatePrices(min, max, store.floor) === '';
        $('offer-hint').textContent = ok
            ? `Si cierran en el mínimo cobrás ${money(sellerNet(min, store.feePct).net)}; con "comprá ya", ${money(sellerNet(max, store.feePct).net)}. El banco se queda el ${store.feePct} %.`
            : `El banco se queda el ${store.feePct} % de la venta.`;
    }

    // ---------------------------------------------------------------- avisos en vivo
    /** Llega una oferta nueva o cambiada (aviso en vivo o respuesta del servidor). */
    function onEvent(e) {
        const user = getUser();
        const prev = store.apply(e);
        if (user) {
            const n = outcomeNotice(prev, e, user.id, { money, label: propLabel(e.property_id), feePct: store.feePct });
            if (n) {
                notice(n.text, n.warn);
                if (e.status === 'vendida' && e.leader_id === user.id) {
                    play('ganaste');
                } else if (n.warn && prev?.leader_id === user.id) {
                    play('superado');
                }
            }
        }
        if (e.status === 'vendida') {
            setOwner(e.property_id, e.leader_id, e.leader);
            pulse(e.property_id, e.leader_id);
        }
        if (user && (e.seller_id === user.id || prev?.leader_id === user.id || e.leader_id === user.id)) {
            game?.refreshSoon(() => onChange());
        }
        onChange();
    }

    // ---------------------------------------------------------------- reloj
    function requestClose(id) {
        if (Date.now() - (closing.get(id) ?? 0) < 2500) {
            return;
        }
        closing.set(id, Date.now());
        setTimeout(async () => {
            try {
                onEvent((await store.close(id)).offer);
            } catch {
                closing.set(id, Date.now() + 10000); // si falló, se espera: el reloj del servidor la cierra igual
            }
        }, Math.random() * 400);
    }

    function tick() {
        updateTimer();
        const now = store.now();
        for (const o of store.list()) {
            if (isDue(o, now)) {
                requestClose(o.id);
            }
        }
        // El estado del panel depende de la fase (ofertando -> decidiendo): se redibuja al cruzar el plazo.
        if (current && phaseKey(current) !== lastPhase) {
            onChange();
        }
    }
    let lastPhase = '';
    const phaseKey = (o) => `${o.id}:${phase(o, store.now())}`;
    const rememberPhase = () => { lastPhase = current ? phaseKey(current) : ''; };

    // ---------------------------------------------------------------- acciones
    async function run(label, fn, { onOk, errorCodes = [] } = {}) {
        if (pending) {
            return;
        }
        pending = true;
        message(label);
        onChange();
        try {
            const r = await fn();
            message('');
            onOk?.(r);
        } catch (err) {
            message(explain(err), true);
            if (err instanceof ApiError && err.data.minimo) {
                $('offer-bid-input').value = err.data.minimo;
            }
            if (err instanceof ApiError && ['oferta_terminada', 'oferta_cerrada', 'oferta_inexistente', ...errorCodes].includes(err.data.error)) {
                await store.load().catch(() => {});
            } else {
                await recover(err);
            }
        } finally {
            pending = false;
            onChange();
        }
    }

    $('offer-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const id = shownFor;
        const min = Number($('offer-min-input').value);
        const max = Number($('offer-max-input').value);
        const bad = validatePrices(min, max, store.floor);
        if (id == null || bad) {
            message(bad || 'Elegí una propiedad tuya.', true);
            return;
        }
        run('Publicando la oferta…', () => store.open(id, min, max), {
            onOk: (r) => { onEvent(r.offer); notice(`Pusiste ${propLabel(id)} en oferta: entre ${money(min)} y ${money(max)}.`); play('puja'); },
            errorCodes: ['ya_en_oferta'],
        });
    });
    $('offer-min-input').addEventListener('input', paintHint);
    $('offer-max-input').addEventListener('input', paintHint);

    $('offer-bid-input').addEventListener('input', () => { bidDirty = true; });
    $('offer-bid-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const o = current;
        const amount = Number($('offer-bid-input').value);
        if (!o) {
            return;
        }
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            message('Poné un monto en pesos, sin decimales.', true);
            return;
        }
        bid(o, amount);
    });
    $('btn-offer-buynow').addEventListener('click', () => current && bid(current, current.buy_now_price));

    function bid(o, amount) {
        run('Enviando la oferta…', () => store.bid(o.id, amount), {
            onOk: (r) => {
                bidDirty = false;
                game.setBalance(r.balance, r.reserved);
                onEvent(r.offer);
                if (!r.sold) {
                    notice(`Vas ganando con ${money(amount)}.`);
                    play('puja');
                }
            },
        });
    }

    $('btn-offer-accept').addEventListener('click', () => {
        const o = current;
        if (o) {
            run('Aceptando…', () => store.accept(o.id), { onOk: (r) => onEvent(r.offer) });
        }
    });
    $('btn-offer-cancel').addEventListener('click', () => {
        const o = current;
        if (o) {
            run('Retirando la oferta…', () => store.cancel(o.id), { onOk: (r) => { onEvent(r.offer); notice('Retiraste la oferta.'); } });
        }
    });

    return {
        render: (ctx) => { const r = render(ctx); rememberPhase(); return r; },
        tick,
        onEvent,
        setMatch: (id) => store.setMatch(id),
        load: () => store.load(),
        forProperty: (id) => store.forProperty(id),
        isBusy: () => pending,
    };
}
