// Banco (DOM): pedir préstamos con vista previa, ver las cuotas y devolver. La lógica de números y textos está en bank-model.js.
// Todo texto va con textContent. El servidor decide: acá solo se muestra y se piden las acciones.

import { ApiError, getJson, postJson, newKey } from './api.js';
import { preview, nextDue, clampAmount, blockText, progressText, repaidShare, buttonText } from './bank-model.js';

/**
 * @param {object} o
 * @param {(id: string) => HTMLElement|null} o.$
 * @param {object} o.game
 * @param {(n: number) => string} o.money
 * @param {(err: unknown) => string} o.explain
 * @param {(text: string, isError?: boolean) => void} o.notice
 * @param {(name: string) => void} o.play
 * @param {() => void} o.onChange redibujar números del HUD
 * @param {(err: unknown) => Promise<boolean>} o.recover
 */
export function createBankUi({ $, game, money, explain, notice, play, onChange, recover }) {
    const box = $('bank');
    const btn = $('btn-bank');
    let matchId = null;
    let summary = null;
    let busy = false;
    let timer = null;

    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };

    const url = (extra = '') => `/api/partidas/${matchId}/prestamos${extra}`;

    function paintButton() {
        if (!btn) return;
        btn.textContent = buttonText(game.debt(), money);
        btn.classList.toggle('in-debt', game.debt() > 0);
    }

    function accept(data) {
        summary = data;
        game.setBalance(data.cash, data.cash - data.available);
        game.setDebt(data.debt);
        paintButton();
        onChange();
        if (!box.hidden) render();
    }

    async function load() {
        if (!matchId) return;
        try {
            accept(await getJson(url()));
        } catch (e) {
            if (!(await recover(e))) console.warn('No se pudo leer el banco', e);
        }
    }

    // ---------------------------------------------------------------- dibujo
    function render() {
        const s = summary;
        const body = $('bank-body');
        body.replaceChildren();
        if (!s) {
            body.append(el('p', 'bank-note', 'Cargando…'));
            return;
        }
        const r = s.rules;

        const head = el('dl', 'bank-stats');
        for (const [k, v, tone] of [
            ['Deuda', money(s.debt), s.debt > 0 ? 'bad' : ''],
            ['Atrasado', money(s.arrears), s.arrears > 0 ? 'bad' : ''],
            ['Podés pedir hasta', money(s.max_new), ''],
        ]) {
            const d = el('div');
            d.append(el('dt', null, k), el('dd', tone, v));
            head.append(d);
        }
        body.append(head);

        body.append(form(s));

        const list = el('ul', 'bank-loans');
        const open = s.loans.filter((l) => l.status === 'abierto');
        for (const l of open) list.append(loanRow(l, s));
        if (open.length === 0) {
            list.append(el('li', 'bank-empty', 'No tenés préstamos abiertos.'));
        }
        body.append(el('h3', null, 'Tus préstamos'), list);
        body.append(el('p', 'bank-note', `Interés ${r.rate_pct} % por día sobre lo que debés. Cada día se cobra una cuota sola; si no hay plata, se acumula con ${r.late_pct} % de recargo diario. La deuda se resta de tu patrimonio.`));
    }

    function form(s) {
        const r = s.rules;
        const wrap = el('form', 'bank-form');
        wrap.noValidate = true;
        const reason = blockText(s, money);
        const max = s.max_new;

        const lAmount = el('label', null, 'Monto');
        const amount = document.createElement('input');
        amount.type = 'number'; amount.inputMode = 'numeric'; amount.step = '100'; amount.min = String(r.min_amount); amount.max = String(max);
        amount.value = String(clampAmount(Math.min(10000, max), r.min_amount, max) || '');
        amount.id = 'bank-amount';
        lAmount.htmlFor = 'bank-amount';

        const lTerm = el('label', null, 'Plazo');
        const term = document.createElement('select');
        term.id = 'bank-term';
        lTerm.htmlFor = 'bank-term';
        for (const t of r.terms) {
            const o = el('option', null, `${t} días`);
            o.value = String(t);
            term.append(o);
        }

        const prev = el('p', 'bank-preview');
        const submit = el('button', 'primary', 'Pedir préstamo');
        submit.type = 'submit';
        const msg = el('p', 'bank-msg');
        msg.setAttribute('role', 'status');

        const paint = () => {
            const a = clampAmount(amount.value, r.min_amount, max);
            if (reason || a === 0) {
                prev.textContent = reason || 'No te alcanza para el mínimo.';
                submit.disabled = true;
                return;
            }
            const p = preview(a, Number(term.value), r.rate_pct);
            prev.textContent = `Primera cuota ${money(p.firstDue)} · última ${money(p.lastDue)} · devolvés ${money(p.total)} (interés ${money(p.totalInterest)})`;
            submit.disabled = busy;
        };
        amount.addEventListener('input', paint);
        term.addEventListener('change', paint);
        paint();

        wrap.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const a = clampAmount(amount.value, r.min_amount, max);
            if (reason || a === 0 || busy) return;
            busy = true;
            submit.disabled = true;
            msg.textContent = '';
            try {
                const res = await postJson(url(), { 'Idempotency-Key': newKey() }, { monto: a, plazo: Number(term.value) });
                play('compra');
                notice(`Banco: te acreditó ${money(a)}.`);
                busy = false;
                accept(res);
            } catch (e) {
                busy = false;
                msg.textContent = explain(e);
                msg.classList.add('error');
                if (!(await recover(e))) paint();
                load();
            }
        });

        wrap.append(lAmount, amount, lTerm, term, prev, submit, msg);
        return wrap;
    }

    function loanRow(l, s) {
        const li = el('li', l.arrears > 0 ? 'late' : '');
        const top = el('div', 'bank-loan-top');
        top.append(el('strong', null, money(l.debt)), el('span', null, progressText(l)));
        const bar = el('div', 'bank-bar');
        const fill = el('span');
        fill.style.width = `${Math.round(repaidShare(l) * 100)}%`;
        bar.append(fill);
        const info = el('p', 'bank-note', `Próxima cuota ${money(nextDue(l, s.rules.late_pct))}${l.arrears > 0 ? ` · atrasado ${money(l.arrears)}` : ''}`);

        const actions = el('div', 'bank-actions');
        const pay = (label, amount) => {
            const b = el('button', null, label);
            b.type = 'button';
            b.disabled = busy || s.available <= 0;
            b.addEventListener('click', async () => {
                if (busy) return;
                busy = true;
                b.disabled = true;
                try {
                    accept(await postJson(url(`/${l.id}/pagar`), { 'Idempotency-Key': newKey() }, amount ? { monto: amount } : null));
                    play('compra');
                } catch (e) {
                    notice(explain(e), true);
                    await recover(e);
                    load();
                } finally {
                    busy = false;
                }
            });
            return b;
        };
        actions.append(pay('Pagar todo lo posible'));
        li.append(top, bar, info, actions);
        return li;
    }

    // ---------------------------------------------------------------- abrir / cerrar
    function open() {
        box.hidden = false;
        btn?.setAttribute('aria-expanded', 'true');
        render();
        load();
        clearInterval(timer);
        timer = setInterval(load, 30000);
    }
    function close() {
        box.hidden = true;
        btn?.setAttribute('aria-expanded', 'false');
        clearInterval(timer);
    }
    btn?.addEventListener('click', () => (box.hidden ? open() : close()));
    $('bank-close')?.addEventListener('click', close);

    return {
        setMatch(id) {
            if (id !== matchId) {
                matchId = id;
                summary = null;
                if (!id) close();
            }
        },
        load,
        paintButton,
        close,
    };
}
