// Eventos de partida (ver app/Economy/MatchEvents.php): lógica pura para mostrarlos. El servidor decide el calendario y el
// ingreso; acá solo se arman textos y se calcula cuándo volver a pedir el estado. Los tiempos son ms con la hora del servidor.

const PLURAL = { casa: 'las casas', comercio: 'los comercios', supermercado: 'los supermercados', hotel: 'los hoteles' };

export const pctText = (pct) => `${pct >= 0 ? '+' : '−'}${Math.round(Math.abs(pct) * 100)} %`;

function daysText(ms, msPerDay) {
    const d = Math.max(0, ms) / msPerDay;
    if (d >= 1.5) {
        return `${Math.ceil(d)} días`;
    }
    if (d > 1) {
        return 'poco más de 1 día';
    }
    return d > 0.05 ? 'menos de 1 día' : 'un instante';
}

export const isSprint = (e) => e?.key === 'sprint';

/** "4:59" para lo que falta del sprint. */
export function minSec(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Cuánto rinde el sprint: "x2" para +100 %, "+50 %" para lo demás. */
export const sprintMult = (pct) => (pct >= 1 && Number.isInteger(pct) ? `x${1 + pct}` : pctText(pct));

/** Qué propiedades toca el evento: "todo", "los comercios" o "los comercios de la zona marcada". */
function scopeText(e) {
    const what = e.kind == null ? 'todo' : (PLURAL[e.kind] ?? e.kind);
    return e.zone ? `${what} de la zona marcada` : what;
}

/** Texto del evento activo: "Feria: los comercios de la zona marcada rinden +30 %. Quedan 3 días." */
export function activeText(e, now, msPerDay) {
    if (isSprint(e)) {
        return `${e.label}: todo rinde ${sprintMult(e.pct)}. Quedan ${minSec(e.end - now)}.`;
    }
    return `${e.label}: ${scopeText(e)} rinde${e.kind == null || !PLURAL[e.kind] ? '' : 'n'} ${pctText(e.pct)}. Quedan ${daysText(e.end - now, msPerDay)}.`;
}

/** Texto del evento anunciado: "Próximo: Temporada turística (los hoteles de la zona marcada +40 %) en menos de 1 día." */
export function nextText(e, now, msPerDay) {
    return `Próximo: ${e.label} (${scopeText(e)} ${pctText(e.pct)}) en ${daysText(e.start - now, msPerDay)}.`;
}

/** ¿Un punto [lng, lat] cae en la zona del evento? Un evento sin zona vale para toda la ciudad. */
export function inZone(e, at) {
    if (!e.zone || !e.bounds) {
        return true;
    }
    if (!at) {
        return false;
    }
    const [w, s, ea, n] = e.bounds;
    return at[0] >= w && at[0] < ea && at[1] >= s && at[1] < n;
}

/** Recuadros para el mapa: uno por evento con zona (activo: verde si sube y rojo si baja; anunciado: azul). */
export function zoneFeatures(events) {
    const out = [];
    const add = (e, color) => {
        if (!e?.zone || !e.bounds) {
            return;
        }
        const [w, s, ea, n] = e.bounds;
        out.push({ type: 'Feature', properties: { key: e.key, color }, geometry: { type: 'Polygon', coordinates: [[[w, s], [ea, s], [ea, n], [w, n], [w, s]]] } });
    };
    (events?.active ?? []).forEach((e) => add(e, e.pct >= 0 ? '#2f9e44' : '#e03131'));
    add(events?.next, '#1c7ed6');
    return { type: 'FeatureCollection', features: out };
}

/** Líneas para el tablero: primero los activos, después el anunciado. */
export function hudLines(events, now, msPerDay) {
    if (!events) {
        return [];
    }
    return [
        ...(events.active ?? []).map((e) => ({ kind: 'active', key: e.key, text: activeText(e, now, msPerDay) })),
        ...(events.next ? [{ kind: 'next', key: events.next.key, text: nextText(events.next, now, msPerDay) }] : []),
    ];
}

/** Claves que identifican el estado visible (para avisar solo cuando cambia): "a:feria|n:turismo". */
export function stateKey(events) {
    return [...(events?.active ?? []).map((e) => `a:${e.key}`), ...(events?.next ? [`n:${events.next.key}`] : [])].join('|');
}

/** Qué cambió entre dos estados: eventos que empezaron y evento recién anunciado (null si no hay novedad). */
export function whatsNew(prev, events) {
    const had = new Set((prev?.active ?? []).map((e) => e.key));
    const hadNext = prev?.next?.key ?? null;
    return {
        started: (events?.active ?? []).filter((e) => !had.has(e.key)),
        announced: events?.next && events.next.key !== hadNext ? events.next : null,
    };
}

/** Próximo instante (ms) en que la vista cambia por sí sola: fin de un activo o inicio del anunciado. null si ninguno. */
export function changeAt(events) {
    const ts = [...(events?.active ?? []).map((e) => e.end), ...(events?.next ? [events.next.start] : [])];
    return ts.length ? Math.min(...ts) : null;
}

/** Aviso para el panel de una propiedad del tipo `kind`: lo que le hace el evento activo o anunciado ('' si no la toca). */
export function propertyNote(events, kind, now, msPerDay, at = null) {
    const touches = (e) => (e.kind == null || e.kind === kind) && inZone(e, at);
    const act = (events?.active ?? []).find((e) => !isSprint(e) && touches(e));
    if (act) {
        return `Evento activo: ${act.label}. Esta propiedad rinde ${pctText(act.pct)} por ahora (quedan ${daysText(act.end - now, msPerDay)}).`;
    }
    if (events?.next && touches(events.next)) {
        return `Se viene: ${events.next.label}. Este tipo va a rendir ${pctText(events.next.pct)} en ${daysText(events.next.start - now, msPerDay)}.`;
    }
    return '';
}
