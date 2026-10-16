// Banco (lado del navegador): lógica pura, sin DOM ni red. bank-ui.js dibuja y habla con el servidor.
// El servidor manda la verdad (cuotas, mora, tope); acá solo se calcula la vista previa y se arman los textos.

/** Interés de un día (redondeado hacia arriba, mínimo 1 si hay capital): igual que el servidor. */
export const interestOf = (balance, ratePct) => (balance <= 0 ? 0 : Math.max(1, Math.ceil((balance * ratePct) / 100)));

/** Capital que se devuelve cada día. */
export const dailyPrincipal = (principal, termDays) => Math.max(1, Math.ceil(principal / Math.max(1, termDays)));

/**
 * Vista previa de un préstamo pagado en término: cuánto es la primera y la última cuota, el interés total y lo que se devuelve.
 * @returns {{ dailyPrincipal: number, firstDue: number, lastDue: number, totalInterest: number, total: number }}
 */
export function preview(amount, termDays, ratePct) {
    const dp = dailyPrincipal(amount, termDays);
    let balance = amount;
    let totalInterest = 0;
    let firstDue = 0;
    let lastDue = 0;
    for (let day = 1; day <= termDays && balance > 0; day++) {
        const interest = interestOf(balance, ratePct);
        const principal = day >= termDays ? balance : Math.min(balance, dp);
        if (day === 1) {
            firstDue = interest + principal;
        }
        lastDue = interest + principal;
        totalInterest += interest;
        balance -= principal;
    }
    return { dailyPrincipal: dp, firstDue, lastDue, totalInterest, total: amount + totalInterest };
}

/** Lo que cobraría la próxima cuota de un préstamo (lo atrasado con su recargo + interés + capital del día). */
export function nextDue(loan, latePct = 2) {
    const day = loan.days_charged + 1;
    const principal = day >= loan.term_days ? loan.balance : Math.min(loan.balance, loan.daily_principal);
    const arrears = loan.arrears + Math.floor((loan.arrears * latePct) / 100);
    return arrears + interestOf(loan.balance, loan.rate_pct) + principal;
}

/** Deja el monto dentro de [min, max] (enteros). Si no entra ni el mínimo, devuelve 0. */
export function clampAmount(value, min, max) {
    if (max < min) {
        return 0;
    }
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) {
        return min;
    }
    return Math.min(max, Math.max(min, n));
}

/** Motivo por el que no se puede pedir ahora (texto), o '' si se puede. `s` = resumen del servidor. */
export function blockText(s, money) {
    switch (s.blocked) {
        case 'sprint': return 'En el sprint final ya no se piden préstamos.';
        case 'con_mora': return 'Tenés cuotas atrasadas: ponete al día para pedir otro préstamo.';
        case 'tope': return `Ya tenés ${s.rules.max_loans} préstamos abiertos. Devolvé alguno para pedir otro.`;
        case 'sin_cupo': return `Tu patrimonio no alcanza para el mínimo (${money(s.rules.min_amount)}).`;
        default: return '';
    }
}

/** Texto de avance de un préstamo: "día 2 de 5". */
export const progressText = (loan) => `día ${Math.min(loan.days_charged, loan.term_days)} de ${loan.term_days}`;

/** Parte del capital ya devuelta (0..1), para la barra. */
export const repaidShare = (loan) => (loan.principal <= 0 ? 1 : Math.min(1, Math.max(0, 1 - loan.balance / loan.principal)));

/** Texto corto para el botón del HUD. */
export const buttonText = (debt, money) => (debt > 0 ? `Banco · debés ${money(debt)}` : 'Banco');
