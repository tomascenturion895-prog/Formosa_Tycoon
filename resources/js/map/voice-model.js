/**
 * Lógica pura de la voz de la sala (sin navegador): quién llama a quién, qué mensajes de conexión se aceptan, cuándo alguien "está
 * hablando" y qué texto lleva cada botón. El audio va de navegador a navegador (WebRTC); acá no hay nada de red.
 */

export const MAX_SIGNAL_BYTES = 8000;    // Reverb corta los mensajes de más de 10 000 bytes
export const KINDS = ['offer', 'answer', 'ice', 'bye'];
export const SPEAK_ON = 0.035;           // nivel (0–1) a partir del cual se considera que habla
export const SPEAK_OFF = 0.02;           // y por debajo de este deja de hacerlo (evita parpadeo)
export const SPEAK_HOLD_MS = 350;        // se mantiene "hablando" un instante después del último sonido

/** En cada par de jugadores llama (crea la oferta) siempre el de número menor: así nunca se pisan dos llamadas. */
export function shouldOffer(myId, peerId) {
    return Number(myId) < Number(peerId);
}

/** Los demás de la sala que están en la voz, sin mi propio usuario, sin repetidos y hasta el máximo de conexiones. */
export function peersFrom(members, myId, max = 7) {
    const seen = new Set();
    const out = [];
    for (const m of members ?? []) {
        const id = Number(m?.id);
        if (!Number.isFinite(id) || id === Number(myId) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        out.push({ id, name: String(m.name ?? '') });
    }
    out.sort((a, b) => a.id - b.id);

    return out.slice(0, Math.max(0, max));
}

/**
 * Valida un mensaje de conexión recibido por el canal. Devuelve el mensaje limpio o null. Se descarta lo que no es para mí, lo que
 * viene de mí mismo, de quien no está en la voz, de un tipo desconocido, o demasiado grande.
 */
export function cleanSignal(msg, myId, knownIds) {
    if (!msg || typeof msg !== 'object') {
        return null;
    }
    const from = Number(msg.from);
    const to = Number(msg.to);
    if (!Number.isFinite(from) || to !== Number(myId) || from === Number(myId) || !KINDS.includes(msg.kind)) {
        return null;
    }
    if (knownIds && !(knownIds instanceof Set ? knownIds.has(from) : knownIds.includes(from))) {
        return null;
    }
    let size = 0;
    try {
        size = JSON.stringify(msg).length;
    } catch {
        return null;
    }
    if (size > MAX_SIGNAL_BYTES) {
        return null;
    }
    if ((msg.kind === 'offer' || msg.kind === 'answer') && typeof msg.sdp !== 'string') {
        return null;
    }
    if (msg.kind === 'ice' && (msg.candidate !== null && typeof msg.candidate !== 'object')) {
        return null;
    }

    return { from, to, kind: msg.kind, sid: String(msg.sid ?? ''), sdp: msg.sdp, candidate: msg.candidate };
}

/** ¿Habla? Con histéresis y un pequeño sostén, para que el aro no parpadee entre sílabas. `state` = { on, lastLoud }. */
export function speakingStep(state, level, now) {
    const loud = state.on ? level >= SPEAK_OFF : level >= SPEAK_ON;
    const lastLoud = loud ? now : state.lastLoud;
    const on = loud || (state.on && now - lastLoud < SPEAK_HOLD_MS);

    return { on, lastLoud };
}

/** Nivel 0–1 de un bloque de muestras de audio en bytes (0–255, centradas en 128): la raíz del promedio de cuadrados. */
export function rmsLevel(bytes) {
    if (!bytes?.length) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
        const v = (bytes[i] - 128) / 128;
        sum += v * v;
    }

    return Math.sqrt(sum / bytes.length);
}

/** Texto y estado del botón del micrófono. `mic` = 'off' | 'asking' | 'on'. */
export function micButton(mic, { connected = true, peers = 0 } = {}) {
    if (mic === 'asking') {
        return { label: 'Pidiendo permiso…', title: 'Aceptá el permiso del micrófono en tu navegador', pressed: false, disabled: true };
    }
    if (mic === 'on') {
        return { label: 'Micrófono abierto', title: 'Tocá para silenciarte', pressed: true, disabled: false };
    }
    if (!connected) {
        return { label: 'Micrófono apagado', title: 'Sin conexión de voz por ahora: podés abrirlo igual', pressed: false, disabled: false };
    }

    return { label: 'Micrófono apagado', title: peers > 0 ? 'Tocá para hablar' : 'Todavía no hay nadie más en la voz', pressed: false, disabled: false };
}

/** Resumen corto para la barra: "Voz · 3 en la sala" / "Voz · conectando…". */
export function statusText({ live, peers, mic, deaf }) {
    if (!live) {
        return 'Voz · conectando…';
    }
    const n = peers + 1;
    const base = peers === 0 ? 'Voz · solo vos por ahora' : `Voz · ${n} en la sala`;

    return `${base}${mic === 'on' ? ' · hablando' : ''}${deaf ? ' · sin sonido' : ''}`;
}

/** Texto de error al pedir el micrófono, según el tipo que informa el navegador. */
export function micErrorText(err, secure = true) {
    if (!secure) {
        return 'El navegador solo deja usar el micrófono en páginas seguras (https). Entrá por la dirección https del túnel.';
    }
    switch (err?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'No diste permiso al micrófono. Habilitalo en el candado de la barra de direcciones y volvé a tocar el botón.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'No se encontró ningún micrófono conectado.';
        case 'NotReadableError':
        case 'AbortError':
            return 'El micrófono está ocupado por otra aplicación.';
        default:
            return 'No se pudo abrir el micrófono.';
    }
}

/** Lista de servidores de red para RTCPeerConnection, solo con lo que tenga forma válida. */
export function iceServersFrom(list) {
    return (Array.isArray(list) ? list : []).filter((s) => s && (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.length > 0)));
}

/** Espera antes de reintentar una conexión que no se armó o se cayó (crece y se corta en 20 s). */
export function retryDelay(attempt) {
    return Math.min(20000, 2000 * 2 ** Math.max(0, attempt));
}
