// Motor de las guías: una tarjeta que señala partes de la pantalla y un menú con las guías del lugar actual.
// No bloquea el mapa (se puede seguir usando mientras la tarjeta está abierta), se cierra con Escape y cada guía
// queda marcada como vista al cerrarla o llegar al final. Todo el texto se escribe con textContent.
//
//   open(id)      abre una guía.            openAuto()  abre en cadena las guías automáticas pendientes del lugar actual
//   openMenu()    abre el menú del lugar.   isOpen()    hay una tarjeta o el menú abiertos
// Un clic en cualquier elemento con `data-guide="ID"` abre esa guía. `?guia=ID` en la dirección la abre al cargar
// (también en navegadores automatizados: así la usan las pruebas).

import { guideById, menuItems } from './guides-model.js';
import { createGuideState } from './guides-state.js';
import { trapFocus } from '../map/focus-trap.js';

const PLACE_LABEL = {
    lobby: 'Lobby', sala: 'Sala de espera', partida: 'Partida', resultados: 'Resultados', explorar: 'Explorar la ciudad',
};
const BADGE = { new: 'Nuevo', updated: 'Actualizada', seen: '✓ Vista' };
const CHAIN_DELAY_MS = 300;

/** Primer elemento de la lista que esté a la vista (existe, no está oculto ni dentro de un panel plegado). */
function pickTarget(selectors = []) {
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !el.hidden && el.getClientRects().length > 0) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                return el;
            }
        }
    }
    return null;
}

const activeElement = () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);

export function createGuides({ $, cfg, user, getPlace, reduceMotion = false, storage = null }) {
    const card = $('tour');
    const title = $('tour-title');
    const text = $('tour-text');
    const count = $('tour-count');
    const prev = $('tour-prev');
    const next = $('tour-next');
    const skip = $('tour-skip');
    const menu = $('guide-menu');
    const menuList = $('guide-menu-list');
    const menuPlace = $('guide-menu-place');
    const menuClose = $('guide-menu-close');
    const none = { open() { return false; }, openAuto() { return false; }, openMenu() {}, isOpen() { return false; } };
    if (!card) {
        return none;
    }

    let safeStorage = storage;
    if (safeStorage === null) {
        try {
            safeStorage = window.localStorage;
        } catch {
            safeStorage = null;
        }
    }
    const state = createGuideState(safeStorage);
    const ctx = { cfg, user };

    let current = null;
    let steps = [];
    let index = 0;
    let focused = null;
    let returnFocus = null;
    let queue = []; // guías automáticas que siguen a la actual
    let chainTimer = null;
    let menuReturn = null;

    function clearFocus() {
        focused?.classList.remove('tour-focus');
        focused = null;
    }

    function place(target) {
        card.classList.remove('sheet');
        card.style.left = '';
        card.style.top = '';
        if (window.innerWidth < 640 || !target) {
            // Celular, o paso sin elemento señalado: hoja abajo (celular) o centrado (escritorio), sin calcular nada.
            card.classList.toggle('sheet', window.innerWidth < 640);
            card.classList.toggle('center', window.innerWidth >= 640);
            return;
        }
        card.classList.remove('center');
        const r = target.getBoundingClientRect();
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        const gap = 14;
        // A la derecha del elemento si entra; si no, debajo; si no, arriba.
        let left = r.right + gap;
        let top = r.top;
        if (left + w > window.innerWidth - 12) {
            left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
            top = r.bottom + gap;
            if (top + h > window.innerHeight - 12) {
                top = Math.max(12, r.top - h - gap);
            }
        }
        top = Math.min(Math.max(12, top), window.innerHeight - h - 12);
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
    }

    function show(i) {
        index = i;
        const step = steps[i];
        title.textContent = step.title;
        text.textContent = step.text;
        count.textContent = current.title === step.title ? `${i + 1} de ${steps.length}` : `${current.title} · ${i + 1} de ${steps.length}`;
        prev.hidden = i === 0;
        next.textContent = i === steps.length - 1 ? 'Listo' : 'Siguiente';
        clearFocus();
        const target = pickTarget(step.targets);
        if (target) {
            focused = target;
            target.classList.add('tour-focus');
        }
        card.hidden = false;
        place(focused);
        card.focus({ preventScroll: true }); // el lector de pantalla lee título y texto (aria-labelledby/describedby)
    }

    function close() {
        if (current) {
            state.mark(current);
        }
        clearFocus();
        card.hidden = true;
        current = null;
        // Las guías en cola son de un lugar: si la persona ya cambió de lugar, ya no corresponden.
        queue = queue.filter((g) => g.place === getPlace());
        if (queue.length > 0) {
            // Encadena la siguiente guía automática del lugar.
            const following = queue.shift();
            clearTimeout(chainTimer);
            chainTimer = setTimeout(() => start(following, returnFocus), reduceMotion ? 0 : CHAIN_DELAY_MS);
            return;
        }
        if (returnFocus && document.contains(returnFocus)) {
            returnFocus.focus({ preventScroll: true });
        }
        returnFocus = null;
    }

    function start(guide, back) {
        const list = guide.steps(ctx);
        if (list.length === 0) {
            return false;
        }
        steps = list;
        current = guide;
        returnFocus = back ?? activeElement();
        show(0);
        return true;
    }

    next.addEventListener('click', () => (index >= steps.length - 1 ? close() : show(index + 1)));
    prev.addEventListener('click', () => show(Math.max(0, index - 1)));
    skip.addEventListener('click', () => {
        queue = []; // saltar cancela también las guías que venían después
        close();
    });
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation(); // no cierra además el panel de la propiedad
            queue = [];
            close();
        }
    });
    window.addEventListener('resize', () => {
        if (!card.hidden) {
            place(focused);
        }
    });

    // ---------------------------------------------------------------- menú
    function closeMenu(restoreFocus = true) {
        if (!menu || menu.hidden) {
            return;
        }
        menu.hidden = true;
        if (restoreFocus && menuReturn && document.contains(menuReturn)) {
            menuReturn.focus({ preventScroll: true });
        }
        if (restoreFocus) {
            menuReturn = null;
        }
    }

    function open(id, back) {
        const guide = guideById(id);
        if (!guide || (guide.available && !guide.available(ctx))) {
            return false;
        }
        queue = [];
        clearTimeout(chainTimer);
        return start(guide, back);
    }

    function openMenu() {
        if (!menu) {
            return;
        }
        menuReturn = activeElement();
        const where = getPlace();
        menuPlace.textContent = PLACE_LABEL[where] ?? '';
        menuList.replaceChildren();
        const items = menuItems(where, state, ctx);
        if (items.length === 0) {
            const li = document.createElement('li');
            li.className = 'guide-menu-empty';
            li.textContent = 'No hay guías para esta pantalla.';
            menuList.append(li);
        }
        for (const item of items) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'guide-menu-item';
            btn.dataset.status = item.status;
            const head = document.createElement('span');
            head.className = 'guide-menu-head';
            const name = document.createElement('strong');
            name.textContent = item.title;
            const badge = document.createElement('span');
            badge.className = `guide-badge ${item.status}`;
            badge.textContent = BADGE[item.status];
            head.append(name, badge);
            const sum = document.createElement('span');
            sum.className = 'guide-menu-summary';
            sum.textContent = item.summary;
            btn.append(head, sum);
            btn.addEventListener('click', () => {
                const back = menuReturn;
                closeMenu(false);
                menuReturn = null;
                open(item.id, back);
            });
            li.append(btn);
            menuList.append(li);
        }
        menu.hidden = false;
        (menuList.querySelector('button') ?? menuClose).focus({ preventScroll: true });
    }

    if (menu) {
        trapFocus(menu, () => closeMenu());
        menuClose.addEventListener('click', () => closeMenu());
        menu.addEventListener('click', (e) => {
            if (e.target === menu) {
                closeMenu();
            }
        });
    }

    // Botones "?" de cada panel: abren la guía del tema.
    document.addEventListener('click', (e) => {
        const trigger = e.target instanceof Element ? e.target.closest('[data-guide]') : null;
        if (trigger) {
            e.preventDefault(); // dentro de un <summary> no debe plegar ni desplegar el bloque
            open(trigger.getAttribute('data-guide'), trigger);
        }
    });

    let forcedDone = false;
    return {
        open,
        openMenu,
        isOpen: () => !card.hidden || Boolean(menu && !menu.hidden),
        /**
         * Abre en cadena las guías automáticas del lugar que todavía no se vieron. Solo en un navegador de una persona:
         * las pruebas automáticas (navigator.webdriver) las saltean, salvo que la dirección traiga ?guia=ID.
         */
        openAuto() {
            if (!forcedDone) {
                forcedDone = true;
                const forced = new URLSearchParams(window.location.search).get('guia');
                if (forced && open(forced)) {
                    return true;
                }
            }
            if (navigator.webdriver || !card.hidden || (menu && !menu.hidden)) {
                return false;
            }
            const pending = state.pendingAuto(getPlace(), ctx);
            if (pending.length === 0) {
                return false;
            }
            queue = pending.slice(1);
            const first = pending[0];
            clearTimeout(chainTimer);
            chainTimer = setTimeout(() => start(first, null), reduceMotion ? 0 : 600);
            return true;
        },
    };
}
