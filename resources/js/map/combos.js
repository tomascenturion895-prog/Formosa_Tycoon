// Combos de ingreso (copia en el navegador de app/Economy/Combos.php): SOLO para mostrar pistas.
// El ingreso real lo calcula el servidor y llega en `me.income_per_day` / `me.combos`.

export const KINDS4 = ['casa', 'comercio', 'supermercado', 'hotel'];

/** Clave de la celda ("zona") de un punto; igual que Combos::zoneKey (redondeo a 6 decimales incluido). */
export function zoneKey(lat, lng, deg) {
    return `${Math.floor(Math.round((lat / deg) * 1e6) / 1e6)}:${Math.floor(Math.round((lng / deg) * 1e6) / 1e6)}`;
}

/** Porcentaje del escalón más alto alcanzado con `count` propiedades (0 si no llega al primero). */
export function zonePct(count, tiers) {
    let pct = 0;
    for (const [need, p] of Object.entries(tiers ?? {})) {
        if (count >= Number(need) && p > pct) {
            pct = p;
        }
    }
    return pct;
}

/** Siguiente escalón por encima de `count`: { need, pct } o null si ya está en el último. */
export function nextTier(count, tiers) {
    const sorted = Object.entries(tiers ?? {}).map(([n, p]) => ({ need: Number(n), pct: p })).sort((a, b) => a.need - b.need);
    return sorted.find((t) => t.need > count) ?? null;
}

const pctText = (p) => `${Math.round(p * 100)} %`;

/**
 * Pista de zona para una propiedad.
 * @param {{lat:number,lng:number}} at          dónde está la propiedad que se mira
 * @param {Array<{lat:number,lng:number}>} mine las propiedades que YA tengo en la partida
 * @param {boolean} owned                       si la que se mira ya es mía (cuenta una vez)
 * @param {{zoneDeg:number, zoneTiers:object}} rules
 * @returns {string} texto para mostrar ('' si no hay nada que decir)
 */
export function zoneHint(at, mine, owned, rules) {
    if (!rules?.zoneDeg) {
        return '';
    }
    const key = zoneKey(at.lat, at.lng, rules.zoneDeg);
    const here = mine.filter((m) => zoneKey(m.lat, m.lng, rules.zoneDeg) === key).length;
    const count = owned ? here : here + 1; // con la que se mira (si todavía no es mía)
    const cur = zonePct(count, rules.zoneTiers);
    const next = nextTier(count, rules.zoneTiers);
    const first = nextTier(0, rules.zoneTiers);
    if (owned) {
        if (cur > 0) {
            return `Combo de zona: tenés ${count} en esta zona y todas rinden +${pctText(cur)}.${next ? ` Con ${next.need} suben a +${pctText(next.pct)}.` : ''}`;
        }
        return next ? `Tenés ${count} en esta zona. Con ${next.need} todas rinden +${pctText(next.pct)}.` : '';
    }
    if (cur > 0) {
        return `Con esta tendrías ${count} en la zona: todas rendirían +${pctText(cur)}.${next ? ` (Con ${next.need}: +${pctText(next.pct)}.)` : ''}`;
    }
    return first ? `Zona: con ${first.need} propiedades juntas (a unas 2 cuadras) todas rinden +${pctText(first.pct)}. Tenés ${here}.` : '';
}

/**
 * Resumen de combos para "Mis propiedades" a partir de `me.combos` del servidor.
 * @returns {string[]} frases cortas
 */
export function comboLines(combos, ownedKinds, rules, money) {
    if (!combos) {
        return [];
    }
    const lines = [];
    const zones = combos.zones ?? [];
    if (zones.length > 0) {
        const total = zones.reduce((s, z) => s + z.bonus, 0);
        lines.push(`${zones.length === 1 ? '1 zona con combo' : `${zones.length} zonas con combo`}: +${money(total)} por día.`);
    }
    if (combos.variety) {
        lines.push(`Variedad completa (casa, comercio, supermercado y hotel): +${money(combos.variety_bonus)} por día.`);
    } else if (ownedKinds && ownedKinds.size > 0) {
        const faltan = KINDS4.filter((k) => !ownedKinds.has(k));
        if (faltan.length > 0 && faltan.length < 4) {
            lines.push(`Variedad: si sumás ${faltan.length === 1 ? 'un tipo más' : 'los tipos que faltan'} (${faltan.join(', ')}) ganás +${Math.round((rules?.variety ?? 0) * 100)} % de todo tu ingreso.`);
        }
    }
    return lines;
}
