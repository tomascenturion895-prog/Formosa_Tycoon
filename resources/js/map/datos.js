// Datos del mapa desactualizados: los jugadores avisan, los moderadores corrigen desde la ficha.
// Todo el texto que viene del servidor se escribe con textContent / value: nunca como HTML.
import { getJson, postJson, ApiError } from './api.js';
import { money } from './format.js';

export function createDataTools({ $, cfg, user, getProperty, getSelected, onCorrected }) {
    const box = $('data-box');
    const reportForm = $('report-form');
    const fixForm = $('fix-form');
    const msg = $('data-msg');
    const isModerator = Boolean(user?.moderator);
    const canReport = Boolean(user && user.verified !== false && !isModerator);
    let busy = false;

    function say(text, isError = false) {
        msg.textContent = text;
        msg.classList.toggle('error', isError);
        msg.hidden = text === '';
    }

    function fill(select, entries, selected) {
        select.replaceChildren(...entries.map(([value, label]) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            o.selected = value === selected;
            return o;
        }));
    }

    if (!user || (!isModerator && !canReport)) {
        return { refresh() {} };
    }

    $('data-summary').textContent = isModerator ? 'Corregir datos' : '¿Datos desactualizados?';
    fill($('report-reason'), Object.entries(cfg.data?.reasons ?? {}), null);
    fill($('fix-kind'), Object.entries(cfg.kinds).map(([k, v]) => [k, v.label]), null);
    reportForm.hidden = isModerator;
    fixForm.hidden = !isModerator;

    async function loadDetails(id) {
        if (!isModerator) {
            return;
        }
        const info = $('fix-info');
        info.textContent = '';
        try {
            const d = await getJson(`/moderacion/propiedades/${id}`);
            if (getSelected() !== id) {
                return;
            }
            const reasons = Object.entries(d.reasons).map(([k, n]) => `${cfg.data.reasons[k] ?? k}: ${n}`).join(', ');
            const parts = [];
            parts.push(d.reports > 0 ? `${d.reports} ${d.reports === 1 ? 'aviso' : 'avisos'} (${reasons})` : 'Sin avisos de jugadores');
            if (d.notes.length) {
                parts.push(`Notas: ${d.notes.map((n) => `“${n}”`).join(' ')}`);
            }
            if (d.edited) {
                parts.push(`Última corrección: ${d.edited.source === 'osm' ? 're-importación' : (d.edited.by ?? 'moderador')}, ${d.edited.at}`);
            }
            info.textContent = parts.join(' · ');
        } catch {
            info.textContent = '';
        }
    }

    box.addEventListener('toggle', () => {
        if (box.open && getSelected() != null) {
            loadDetails(getSelected());
        }
    });

    /** Se llama cada vez que se muestra la ficha de una propiedad. */
    function refresh(id) {
        const p = getProperty(id);
        if (!p) {
            box.hidden = true;
            return;
        }
        const changedSelection = box.dataset.id !== String(id);
        box.dataset.id = String(id);
        box.hidden = false;
        if (changedSelection) {
            box.open = false;
            say('');
            $('report-note').value = '';
            $('fix-reason').value = '';
        }
        if (isModerator && (changedSelection || !fixForm.contains(document.activeElement))) {
            $('fix-kind').value = p.kind;
            $('fix-name').value = p.name ?? '';
        }
    }

    function explain(err) {
        return err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor. Probá de nuevo.';
    }

    reportForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = getSelected();
        if (busy || id == null) {
            return;
        }
        busy = true;
        $('btn-report').disabled = true;
        try {
            await postJson(`/api/propiedades/${id}/avisar-datos`, {}, { motivo: $('report-reason').value, nota: $('report-note').value });
            say('¡Gracias! Un moderador va a revisarlo.');
            $('report-note').value = '';
        } catch (err) {
            say(explain(err), true);
        } finally {
            busy = false;
            $('btn-report').disabled = false;
        }
    });

    async function save(body, button) {
        const id = getSelected();
        if (busy || id == null) {
            return;
        }
        busy = true;
        button.disabled = true;
        say('Guardando…');
        try {
            const r = await postJson(`/moderacion/propiedades/${id}/corregir`, {}, body);
            onCorrected(r.property);
            let text = r.changed ? 'Guardado.' : (r.verified ? 'Marcado como verificado.' : 'Ya estaba así.');
            if (r.paid > 0) {
                text += ` Se le acreditaron ${money(r.paid)} al dueño por lo acumulado.`;
            }
            say(text);
            loadDetails(id);
        } catch (err) {
            say(explain(err), true);
        } finally {
            busy = false;
            button.disabled = false;
        }
    }

    fixForm.addEventListener('submit', (e) => {
        e.preventDefault();
        save({ rubro: $('fix-kind').value, nombre: $('fix-name').value, motivo: $('fix-reason').value }, $('btn-fix'));
    });
    $('btn-closed').addEventListener('click', () => {
        save({ rubro: 'casa', nombre: '', motivo: $('fix-reason').value || 'Cerrado' }, $('btn-closed'));
    });
    $('fix-kind').addEventListener('change', () => {
        const warn = $('fix-warn');
        warn.hidden = false;
        warn.textContent = 'Al cambiar el rubro cambian el precio y el ingreso. Si tiene dueño, se le acredita antes lo acumulado. Las casas no llevan nombre.';
    });

    return { refresh };
}
