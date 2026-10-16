// Qué hace la pantalla de juego al entrar a /partida/CÓDIGO y a dónde va el jugador al salir. Lógica pura (se prueba con `node --test`).
// La verdad sobre "¿es mi partida?" la da el servidor (`GET /api/partidas/actual`, ver game.js): la dirección solo trae el código.

const normalize = (code) => String(code ?? '').trim().toUpperCase();
const toLobby = (code, notice) => `/mapa?codigo=${encodeURIComponent(code)}&aviso=${notice}`;

/**
 * @param {{ page: string, code: string|null, user: object|null, current: object|null }} input
 *   `current` es la respuesta de /api/partidas/actual (o null si no se pudo leer).
 * @returns {{ action: 'stay' } | { action: 'redirect', url: string } | { action: 'check-finished', finishedId: number }}
 *   `check-finished`: no hay partida activa pero sí una terminada; hay que mirar si el código de esa es el de la dirección.
 */
export function resolveEntry({ page, code, user, current }) {
    if (page !== 'partida') {
        return { action: 'stay' };
    }
    const wanted = normalize(code);
    if (!user) {
        return { action: 'redirect', url: toLobby(wanted, 'ingresar') };
    }
    const m = current?.match;
    if (m && ['lobby', 'running'].includes(m.status)) {
        return normalize(m.code) === wanted ? { action: 'stay' } : { action: 'redirect', url: `/partida/${encodeURIComponent(normalize(m.code))}` };
    }
    if (current?.last_finished_match_id != null) {
        return { action: 'check-finished', finishedId: current.last_finished_match_id };
    }
    return { action: 'redirect', url: toLobby(wanted, 'sala') };
}

/** A dónde se va después de salir de la sala, abandonar, "Jugar otra vez" o cuando la sala vence. */
export function destinationAfter(reason) {
    return reason === 'expired' ? '/mapa?aviso=vencida' : '/mapa';
}
