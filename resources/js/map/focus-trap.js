// Trampa de foco simple para un diálogo modal: Tab no se escapa al fondo y Escape lo cierra.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(overlay, onEscape) {
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            onEscape();
            return;
        }
        if (e.key !== 'Tab') {
            return;
        }
        const items = [...overlay.querySelectorAll(FOCUSABLE)].filter((n) => !n.closest('[hidden]') && n.offsetParent !== null);
        if (items.length === 0) {
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === overlay.firstElementChild)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });
}
