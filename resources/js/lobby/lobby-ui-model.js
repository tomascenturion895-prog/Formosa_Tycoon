// Reglas puras de la presentación del lobby (sin DOM): iniciales del avatar, puntos de cupo y cantidad de skeletons.

/** Iniciales para el avatar: primera letra de las dos primeras palabras; con una sola palabra, sus dos primeras letras. */
export function initials(name) {
    const words = String(name ?? '').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
    if (words.length === 0) {
        return '?';
    }
    const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[1]][0]];

    return letters.join('').toLocaleUpperCase('es');
}

/** Un lugar por jugador del cupo: true = ocupado. Nunca devuelve más lugares que el cupo. */
export function seats(players, capacity) {
    const cap = Math.max(0, Math.floor(Number(capacity) || 0));
    const taken = Math.min(cap, Math.max(0, Math.floor(Number(players) || 0)));

    return Array.from({ length: cap }, (_, i) => i < taken);
}

export function seatLabel(players, capacity) {
    const left = Math.max(0, capacity - players);
    const base = `${players} de ${capacity} jugadores`;
    if (left === 0) {
        return `${base}, sala llena`;
    }

    return `${base}, ${left === 1 ? 'falta 1' : `faltan ${left}`}`;
}

/** Cuántas filas de relleno mostrar mientras se carga: lo último que se vio, entre 1 y 6 (3 la primera vez). */
export function skeletonCount(lastSeen) {
    if (lastSeen === undefined || lastSeen === null) {
        return 3;
    }

    return Math.min(6, Math.max(1, Math.floor(Number(lastSeen)) || 1));
}
