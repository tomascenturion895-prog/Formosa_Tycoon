// Filas de relleno mientras se carga una lista: tienen la misma forma que la fila real, así el contenido no salta al llegar.
// Son decorativas (aria-hidden); quien las muestra marca la lista con aria-busy y la avisa por un texto oculto.
import { skeletonCount } from './lobby-ui-model.js';

const bar = (cls) => {
    const s = document.createElement('span');
    s.className = `sk ${cls}`;

    return s;
};

/** @param {'room'|'row'} kind  room = tarjeta de sala; row = fila de ranking o historial. */
export function skeletonItems(kind, lastSeen) {
    return Array.from({ length: skeletonCount(lastSeen) }, () => {
        const li = document.createElement('li');
        li.className = kind === 'room' ? 'room-item room-card sk-item' : 'sk-item sk-row';
        li.setAttribute('aria-hidden', 'true');
        if (kind === 'room') {
            li.append(bar('sk-title'), bar('sk-dots'), bar('sk-btn'));
        } else {
            li.append(bar('sk-pos'), bar('sk-title'), bar('sk-value'));
        }

        return li;
    });
}

/** Marca una lista como cargando (o no) para los lectores de pantalla. */
export function setBusyList(list, on) {
    list.setAttribute('aria-busy', String(on));
}
