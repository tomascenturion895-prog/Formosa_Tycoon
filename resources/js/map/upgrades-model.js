// Textos del panel de mejoras. Puro (sin DOM): el servidor decide costos, ingresos y recupero (`me.properties[].upgrade`);
// acá solo se arman las frases y los motivos por los que un botón está bloqueado.

const days1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/**
 * Frases de una opción de mejora.
 * @param {{level:number,label:string,cost:number,maintenance:number,net:number,payback_days:number|null}} option
 * @param {(n:number)=>string} money
 * @param {number} daysLeft días de juego que quedan
 */
export function describeOption(option, money, daysLeft) {
    const payback = option.payback_days;
    return {
        title: `${option.label} (nivel ${option.level})`,
        costText: `Cuesta ${money(option.cost)}`,
        netText: `Ingreso neto: ${money(option.net)} por día`,
        maintText: option.maintenance > 0 ? `Mantenimiento: ${money(option.maintenance)} por día` : 'Sin mantenimiento',
        paybackText: payback === null ? 'No se recupera con el ingreso actual' : `Se recupera en ${days1.format(payback)} días`,
        warn: payback !== null && payback > daysLeft ? 'Puede que no llegues a recuperarla antes de terminar la partida.' : '',
    };
}

/** Por qué no se puede mejorar ahora ('' si se puede). El orden es el de importancia para quien mira. */
export function blockReason({ playing, mine, busy, available, cost, inAuction, inOffer }, money) {
    if (!playing) {
        return 'La partida no está en juego.';
    }
    if (!mine) {
        return 'Solo podés mejorar propiedades tuyas.';
    }
    if (inAuction) {
        return 'Está en subasta: no se puede mejorar ahora.';
    }
    if (inOffer) {
        return 'Está en oferta: retirala antes de mejorarla.';
    }
    if (busy) {
        return 'Esperá un momento…';
    }
    if (available < cost) {
        return `Te faltan ${money(cost - available)}.`;
    }
    return '';
}

/** Aviso para el botón de vender al banco. */
export function sellWarning(level) {
    return level > 0 ? 'Si la vendés al banco perdés la mejora: solo se devuelve una parte del precio de lista.' : '';
}
