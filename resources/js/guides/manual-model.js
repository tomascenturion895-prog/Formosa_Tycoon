// "Cómo se juega": todo el catálogo de guías, agrupado por lugar, como texto para leer de corrido (sin señalar la pantalla).
// Es de solo lectura: no toca el estado de "visto" de las guías.

import { GUIDES, PLACES } from './guides-model.js';

const LABELS = {
    lobby: 'Lobby',
    sala: 'Sala de espera',
    partida: 'Partida',
    resultados: 'Resultados',
    explorar: 'Explorar la ciudad',
};

/** @returns {{ place: string, label: string, guides: { id: string, title: string, summary: string, steps: { title: string, text: string }[] }[] }[]} */
export function manualSections(ctx) {
    return PLACES.map((place) => ({
        place,
        label: LABELS[place],
        guides: GUIDES
            .filter((g) => g.place === place && (!g.available || g.available(ctx)))
            .map((g) => ({
                id: g.id,
                title: g.title,
                summary: g.summary,
                steps: g.steps(ctx).map(({ title, text }) => ({ title, text })),
            })),
    }));
}
