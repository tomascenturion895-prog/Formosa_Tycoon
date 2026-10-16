// Parámetros de la dirección del lobby. Lógica pura (se prueba con `node --test`).
//   ?codigo=ABC123  -> deja el código cargado para unirse (viene de un enlace a una sala)
//   ?aviso=sala     -> el motivo por el que la pantalla de juego devolvió al lobby

export const NOTICES = {
    sala: 'Esa sala no existe o no es tuya. Si te invitaron, el código ya está cargado.',
    vencida: 'La sala se cerró o venció porque nadie inició la partida.',
    ingresar: 'Ingresá o creá una cuenta para entrar a una partida.',
};

/** @returns {{ code: string|null, notice: string|null }} */
export function parseLobbyParams(search) {
    const q = new URLSearchParams(search);
    const raw = (q.get('codigo') ?? '').trim();
    const code = /^[A-Za-z0-9]{4,12}$/.test(raw) ? raw.toUpperCase() : null;
    const key = q.get('aviso');
    const notice = key !== null && Object.hasOwn(NOTICES, key) ? NOTICES[key] : null;
    return { code, notice };
}
