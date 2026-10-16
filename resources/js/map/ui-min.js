// Minimizar la interfaz: el panel principal se pliega a una barra chica y un botón "Ocultar" (o la tecla H) esconde
// todos los paneles para ver solo el mapa. Se recuerda en localStorage (con try/catch: puede no estar disponible).

const KEY_HUD = 'formosa.hudMin';
const KEY_UI = 'formosa.uiOculta';

const leer = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* sin almacenamiento: no se recuerda */ } };

/** Texto de la barra chica: cuenta regresiva y efectivo si hay partida en curso. */
export function miniText(countdown, balance, running) {
    return running ? `${countdown} · ${balance}` : '';
}

export function initUiMin(doc = document) {
    const $ = (id) => doc.getElementById(id);
    const hud = doc.querySelector('.hud');
    const btnMin = $('hud-min');
    const mini = $('hud-mini');
    const btnUi = $('btn-ui');
    const show = $('ui-show');
    if (!hud || !btnMin) return;

    const refreshMini = () => {
        const mh = $('match-hud');
        const run = !!mh && !mh.hidden;
        const t = miniText($('match-countdown')?.textContent ?? '', $('balance')?.textContent ?? '', run);
        mini.textContent = t;
        mini.hidden = !(hud.classList.contains('hud-min') && t);
    };
    const setHud = (min) => {
        hud.classList.toggle('hud-min', min);
        btnMin.setAttribute('aria-expanded', String(!min));
        btnMin.textContent = min ? '▸' : '▾';
        btnMin.title = btnMin.ariaLabel = min ? 'Expandir el panel' : 'Minimizar el panel';
        guardar(KEY_HUD, min);
        refreshMini();
    };
    const setUi = (hidden) => {
        doc.body.classList.toggle('ui-oculta', hidden);
        show.hidden = !hidden;
        btnUi.setAttribute('aria-pressed', String(hidden));
        guardar(KEY_UI, hidden);
    };

    // Menú de ajustes (calidad, tránsito, sonido, música): se abre con el botón y se cierra al tocar afuera o con Escape.
    const btnSet = $('btn-ajustes');
    const panelSet = $('ajustes-panel');
    if (btnSet && panelSet) {
        const setOpen = (open) => {
            panelSet.hidden = !open;
            btnSet.setAttribute('aria-expanded', String(open));
        };
        btnSet.addEventListener('click', () => setOpen(panelSet.hidden));
        doc.addEventListener('click', (e) => {
            if (!panelSet.hidden && !e.target.closest?.('#settings')) setOpen(false);
        });
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !panelSet.hidden) {
                setOpen(false);
                btnSet.focus();
            }
        });
    }

    // Posiciones: abiertas en pantallas altas, plegadas en las bajas (ahí tapan la leyenda). Se recuerda lo que elija el jugador.
    const standingsBox = $('standings-box');
    if (standingsBox) {
        const KEY_POS = 'formosa.posiciones';
        let pref = null;
        try { pref = localStorage.getItem(KEY_POS); } catch { /* sin almacenamiento */ }
        const win = doc.defaultView;
        standingsBox.open = pref === null ? (win?.innerHeight ?? 900) >= 820 && (win?.innerWidth ?? 1200) > 640 : pref === '1';
        // El estado nuevo es el contrario al actual: el clic todavía no lo cambió.
        standingsBox.querySelector('summary')?.addEventListener('click', () => guardar(KEY_POS, !standingsBox.open));
    }

    btnMin.addEventListener('click', () => setHud(!hud.classList.contains('hud-min')));
    btnUi.addEventListener('click', () => setUi(true));
    show.addEventListener('click', () => setUi(false));
    doc.addEventListener('keydown', (e) => {
        if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) {
            setUi(!doc.body.classList.contains('ui-oculta'));
        }
    });
    setInterval(refreshMini, 500);
    setHud(leer(KEY_HUD));
    setUi(leer(KEY_UI));
}
