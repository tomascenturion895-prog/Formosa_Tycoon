// Feed de actividad (DOM): tarjetas arriba al centro con lo que hacen los demás jugadores. Tocar una lleva la cámara a la propiedad.
// Se puede apagar desde Ajustes y se recuerda. La lógica de qué mostrar y cómo escribirlo está en feed-model.js.

import { ownerColor } from './owners.js';
import { money } from './format.js';
import { SHOW_MS, MAX_VISIBLE, feedText, cardStyle, shouldShow, pushVisible, rememberKey } from './feed-model.js';

const KEY = 'formosa.feed';

const readPref = () => {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
};
const savePref = (on) => {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* sin almacenamiento: no se recuerda */ }
};

/**
 * @param {object} o
 * @param {(id: string) => HTMLElement|null} o.$ getElementById
 * @param {object} o.cfg configuración del mapa (para el color de cada rubro)
 * @param {() => (number|null)} o.getMeId id del jugador (null = visitante)
 * @param {(propertyId: number) => void} o.onPick qué hacer al tocar una tarjeta
 */
export function createFeed({ $, cfg, getMeId, onPick }) {
    const box = $('feed');
    const toggle = $('btn-feed');
    const seen = new Set();
    let visible = [];
    let on = readPref();
    const timers = new Map(); // key -> id del temporizador

    const sync = () => {
        if (toggle) {
            toggle.setAttribute('aria-pressed', String(on));
        }
    };
    sync();
    toggle?.addEventListener('click', () => {
        on = !on;
        savePref(on);
        sync();
        if (!on) {
            clear();
        }
    });

    function remove(key) {
        clearTimeout(timers.get(key));
        timers.delete(key);
        visible = visible.filter((v) => v.key !== key);
        box?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
    }

    function arm(key) {
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => remove(key), SHOW_MS));
    }

    function card(item) {
        const style = cardStyle(item.type);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `feed-card tone-${style.tone}`;
        el.dataset.key = item.key;
        el.title = 'Tocá para ir a la propiedad';

        const who = document.createElement('span');
        who.className = 'feed-who';
        who.style.background = item.actor_id != null ? ownerColor(item.actor_id) : '#8a8f98';
        who.textContent = String(item.actor ?? '?').trim().charAt(0).toUpperCase();
        who.setAttribute('aria-hidden', 'true');

        const tag = document.createElement('span');
        tag.className = 'feed-tag';
        tag.textContent = style.tag;

        const text = document.createElement('span');
        text.className = 'feed-text';
        text.textContent = feedText(item, money);

        const kind = document.createElement('span');
        kind.className = 'feed-kind';
        kind.style.background = cfg.kinds?.[item.kind]?.color ?? '#8a8f98';
        kind.setAttribute('aria-hidden', 'true');

        el.append(who, tag, text, kind);
        el.addEventListener('click', () => {
            remove(item.key);
            onPick(item.property_id);
        });
        // Mientras se lee o se apunta, no se va sola.
        el.addEventListener('pointerenter', () => clearTimeout(timers.get(item.key)));
        el.addEventListener('pointerleave', () => arm(item.key));
        el.addEventListener('focus', () => clearTimeout(timers.get(item.key)));
        el.addEventListener('blur', () => arm(item.key));
        return el;
    }

    function push(item) {
        if (!on || !box || !shouldShow(item, getMeId(), seen)) {
            return;
        }
        rememberKey(seen, item.key);
        const r = pushVisible(visible, item, MAX_VISIBLE);
        visible = r.visible;
        r.dropped.forEach((d) => remove(d.key));
        box.append(card(item));
        arm(item.key);
    }

    function clear() {
        if (visible.length === 0 && seen.size === 0) {
            return;
        }
        timers.forEach((t) => clearTimeout(t));
        timers.clear();
        visible = [];
        box?.replaceChildren();
        seen.clear();
    }

    return { push, clear, isOn: () => on };
}
