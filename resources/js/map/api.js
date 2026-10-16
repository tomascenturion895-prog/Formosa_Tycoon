// Pedidos al servidor. Los de escritura llevan el token CSRF de la sesión (meta tag) y siempre piden JSON.

const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content ?? '';

export class ApiError extends Error {
    constructor(status, data) {
        super(data?.message ?? (status === 419 ? 'Tu sesión venció. Recargá la página.' : `Error ${status}`));
        this.status = status;
        this.data = data ?? {};
    }
}

async function parse(res) {
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        throw new ApiError(res.status, data);
    }
    return data;
}

export async function getJson(url) {
    return parse(await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }));
}

/**
 * Archivo estático versionado (public/data, ver MapSnapshot): la dirección cambia cuando cambian los datos, así que lo que ya se bajó
 * sirve para siempre (`force-cache`). Si el archivo ya no está (se borró), cae a la API de siempre.
 */
export async function getStatic(url, fallback) {
    if (!url) {
        return getJson(fallback);
    }
    try {
        const res = await fetch(url, { cache: 'force-cache', credentials: 'same-origin' });
        if (res.ok) {
            return await res.json();
        }
    } catch {
        // sin red o JSON roto: se prueba con la API
    }
    return getJson(fallback);
}

export async function postJson(url, headers = {}, body = null) {
    return parse(await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            'X-CSRF-TOKEN': csrf(),
            ...(body === null ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
        },
        body: body === null ? undefined : JSON.stringify(body),
    }));
}

/** Clave única por clic de compra: si el pedido se repite (doble toque, red lenta) el servidor no cobra dos veces. */
export function newKey() {
    if (globalThis.crypto?.randomUUID) {
        return crypto.randomUUID();
    }
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
