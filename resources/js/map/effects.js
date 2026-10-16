// Animaciones del mapa y del HUD. Todas se apagan con "reducir movimiento" del sistema (prefers-reduced-motion).
import * as maplibregl from 'maplibre-gl';

const MAX_PULSES = 10;      // a la vez: una avalancha de compras no llena la pantalla de marcadores
const PULSE_MS = 1400;
const DEDUPE_MS = 1500;     // la compra propia se anima al comprar y otra vez cuando llega el aviso en vivo: una sola vez

export function createEffects({ map, centers, reduceMotion }) {
    const recent = new Map(); // id de propiedad -> cuándo se animó
    let live = 0;

    /** Anillo que se expande sobre la propiedad que cambió de dueño (solo si está a la vista). */
    function pulse(propertyId, color) {
        if (reduceMotion || live >= MAX_PULSES) {
            return;
        }
        const at = centers.get(propertyId);
        const now = performance.now();
        if (!at || now - (recent.get(propertyId) ?? -Infinity) < DEDUPE_MS || !map.getBounds().contains(at)) {
            return;
        }
        recent.set(propertyId, now);
        if (recent.size > 200) {
            for (const [id, t] of recent) {
                if (now - t > DEDUPE_MS) {
                    recent.delete(id);
                }
            }
        }
        // El marcador lo posiciona MapLibre con transform; el dibujo animado va en un hijo para no pisarle ese transform.
        const el = document.createElement('div');
        el.className = 'pulse';
        el.setAttribute('aria-hidden', 'true');
        const ring = document.createElement('span');
        ring.className = 'pulse-ring';
        ring.style.setProperty('--c', color);
        el.append(ring);
        const marker = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map);
        live += 1;
        setTimeout(() => {
            marker.remove();
            live -= 1;
        }, PULSE_MS);
    }

    /** Texto que sube y se desvanece desde un elemento (por ejemplo "+$ 1.200" sobre el botón Cobrar). */
    function floatText(anchor, text, kind = 'gain') {
        if (reduceMotion || !anchor) {
            return;
        }
        const r = anchor.getBoundingClientRect();
        const el = document.createElement('span');
        el.className = `float-text float-${kind}`;
        el.setAttribute('aria-hidden', 'true'); // el aviso de texto ya lo anuncia
        el.textContent = text;
        el.style.left = `${r.left + r.width / 2}px`;
        el.style.top = `${r.top}px`;
        document.body.append(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 2000); // por si el navegador no emite animationend
    }

    /**
     * Escribe un monto en un elemento. Si cambió respecto de lo que mostraba, el número "corre" hasta el nuevo
     * valor y destella (verde si subió, rojo si bajó). Todas las escrituras del saldo pasan por acá, así un
     * refresco del HUD no pisa la animación a mitad de camino.
     */
    function setMoney(el, value, format) {
        const from = el.dataset.value === undefined ? null : Number(el.dataset.value);
        el.dataset.value = String(value);
        if (el._tween) {
            cancelAnimationFrame(el._tween.raf);
            el._tween = null;
        }
        if (from === null || from === value || reduceMotion) {
            el.textContent = format(value);
            return;
        }
        el.classList.remove('bump-up', 'bump-down');
        void el.offsetWidth; // reinicia la animación CSS si venía una en curso
        el.classList.add(value > from ? 'bump-up' : 'bump-down');
        const start = performance.now();
        const span = 450;
        const step = (now) => {
            const k = Math.min(1, (now - start) / span);
            const eased = 1 - (1 - k) ** 3;
            el.textContent = format(Math.round(from + (value - from) * eased));
            if (k < 1) {
                el._tween = { raf: requestAnimationFrame(step) };
            } else {
                el._tween = null;
                el.textContent = format(value);
            }
        };
        el._tween = { raf: requestAnimationFrame(step) };
    }

    return { pulse, floatText, setMoney };
}
