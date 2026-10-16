// Ilustraciones del juego dibujadas con código (SVG): nada de archivos de imagen. Todo el color va en atributos del SVG y la
// animación en clases de map.css (la política CSP no deja estilos en línea). Cada función devuelve un SVG como texto o lo arma
// con el DOM: los nombres de jugadores (que no son de confianza) siempre entran con textContent, nunca como HTML.
import { hashSeed, mulberry32 } from './rng.js';

const NS = 'http://www.w3.org/2000/svg';
const f = (n) => Math.round(n * 10) / 10;

/** Texto SVG -> elemento (el texto lo escribe este archivo, nunca viene del servidor ni del jugador). */
export function svgFromString(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
}

function el(tag, attrs = {}, text = null) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
}

// ================================================================ marca

/** Marca: un sol saliendo detrás de un edificio y una palmera, dentro de un escudo redondeado. Se usa en la cinemática y en el favicon. */
export function logoMark(size = 56) {
    return `<svg class="logo-mark" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="lm-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9e5e"/><stop offset="1" stop-color="#e0507a"/></linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lm-bg)"/>
  <circle cx="40" cy="30" r="12" fill="#fff2b0"/>
  <path d="M2 46h60v1c0 8-7 15-15 15H17C9 62 2 55 2 47z" fill="#1d4f7a"/>
  <path d="M2 46h60" stroke="#6fb6ee" stroke-width="2"/>
  <rect x="14" y="26" width="11" height="22" fill="#1f2a44"/><rect x="26" y="33" width="9" height="15" fill="#2c3a5e"/>
  <path d="M16 30h2v2h-2zM20 30h2v2h-2zM16 35h2v2h-2zM20 35h2v2h-2zM16 40h2v2h-2zM20 40h2v2h-2zM28 38h2v2h-2zM28 43h2v2h-2z" fill="#ffd36b"/>
  <path d="M51 48c0-8 1-15 2-20" stroke="#5b3a29" stroke-width="2" fill="none" stroke-linecap="round"/>
  <path d="M53 28c-5-1-8 1-10 4M53 28c4-3 8-3 11-1M53 28c-3-4-3-7-1-10M53 28c3-4 6-5 9-4" stroke="#2f7a3f" stroke-width="2.2" fill="none" stroke-linecap="round"/>
</svg>`;
}

// ================================================================ escena de la cinemática de carga

/** Edificios bajos de una ciudad del litoral: lista de rectángulos con detalles de azotea. Reproducible por semilla. */
function skyline(rng, { from, to, base, minH, maxH, fill, windows = false, gap = 2 }) {
    let x = from;
    let body = '';
    let wins = '';
    while (x < to) {
        const w = 34 + Math.floor(rng() * 56);
        const tall = rng() < 0.12;
        const h = (tall ? maxH * 1.35 : minH + rng() * (maxH - minH));
        const y = base - h;
        body += `<rect x="${f(x)}" y="${f(y)}" width="${w}" height="${f(h)}" fill="${fill}"/>`;
        const roof = rng();
        if (roof < 0.25) body += `<rect x="${f(x + 3)}" y="${f(y - 5)}" width="${w - 6}" height="5" fill="${fill}"/>`;
        else if (roof < 0.4) body += `<path d="M${f(x - 2)} ${f(y)}l${f(w / 2 + 2)} -14 ${f(w / 2 + 2)} 14z" fill="${fill}"/>`;
        else if (roof < 0.5) body += `<rect x="${f(x + w * 0.3)}" y="${f(y - 12)}" width="9" height="12" fill="${fill}"/><rect x="${f(x + w * 0.3 - 1)}" y="${f(y - 14)}" width="11" height="3" fill="${fill}"/>`;
        if (windows) {
            const cols = Math.max(2, Math.floor((w - 8) / 9));
            const rows = Math.max(2, Math.floor((h - 10) / 14));
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    if (rng() < 0.62) wins += `M${f(x + 5 + c * 9)} ${f(y + 7 + r * 14)}h4v6h-4z`;
                }
            }
        }
        x += w + gap + Math.floor(rng() * 6);
    }
    return { body, wins };
}

function palm(x, baseY, h, k, cls) {
    const topY = baseY - h;
    const lean = (x % 2 === 0 ? 1 : -1) * 10;
    let fronds = '';
    // Hojas de karanday: arcos largos que caen hacia afuera, cada una una hoja afilada con su nervadura
    const angles = [-172, -150, -122, -95, -68, -40, -12, 12, -190];
    angles.forEach((a, i) => {
        const r = (62 + (i % 3) * 10) * k;
        const rad = (a * Math.PI) / 180;
        const ex = Math.cos(rad) * r;
        const ey = Math.sin(rad) * r * 0.5 + r * 0.42;
        const cx = Math.cos(rad) * r * 0.55;
        const cy = Math.sin(rad) * r * 0.75 - 10 * k;
        const len = Math.hypot(ex, ey) || 1;
        const nx = (-ey / len) * 7 * k;
        const ny = (ex / len) * 7 * k;
        fronds += `<path d="M0 0Q${f(cx + nx)} ${f(cy + ny)} ${f(ex)} ${f(ey)}Q${f(cx - nx)} ${f(cy - ny)} 0 0z" fill="${i % 2 ? '#3f8f48' : '#357f40'}"/>`
            + `<path d="M0 0Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}" stroke="#256233" stroke-width="${f(1.4 * k)}" fill="none"/>`;
    });
    return `<g class="palm ${cls}"><path d="M${x} ${baseY}Q${x + lean} ${f(baseY - h * 0.5)} ${x + lean * 0.6} ${topY}" stroke="#6b4a36" stroke-width="${f(6.5 * k)}" fill="none" stroke-linecap="round"/>`
        + `<path d="M${x} ${baseY}Q${x + lean} ${f(baseY - h * 0.5)} ${x + lean * 0.6} ${topY}" stroke="#9a7456" stroke-width="${f(1.3 * k)}" stroke-dasharray="3 7" fill="none"/>`
        + `<g transform="translate(${f(x + lean * 0.6)} ${topY})"><g class="palm-crown">${fronds}<circle r="${f(4.5 * k)}" fill="#5b3a29"/></g></g></g>`;
}

function lapacho(x, baseY, h, k, rng, cls) {
    const topY = baseY - h;
    let canopy = '';
    const cols = ['#f06fa8', '#f48fc0', '#e0508f', '#ffc2dc', '#e86aa6'];
    for (let i = 0; i < 16; i++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * 38 * k;
        canopy += `<circle cx="${f(Math.cos(a) * r * 1.25)}" cy="${f(Math.sin(a) * r * 0.8)}" r="${f((13 + rng() * 11) * k)}" fill="${cols[i % cols.length]}"/>`;
    }
    let petals = '';
    for (let i = 0; i < 5; i++) {
        petals += `<ellipse class="petal p${i + 1}" cx="${f(x - 30 + rng() * 60)}" cy="${f(topY + 20)}" rx="3" ry="1.8" fill="#ffb3d3"/>`;
    }
    return `<g class="${cls}"><path d="M${x} ${baseY}l-2 ${-h}M${x} ${f(baseY - h * 0.6)}l${f(-16 * k)} ${f(-h * 0.3)}M${x} ${f(baseY - h * 0.7)}l${f(16 * k)} ${f(-h * 0.28)}" stroke="#5a3d2e" stroke-width="${f(5 * k)}" stroke-linecap="round" fill="none"/>`
        + `<g transform="translate(${x} ${f(topY - 6)})"><g class="tree-crown">${canopy}</g></g>${petals}</g>`;
}

function car(color, roof) {
    return `<g class="veh-body"><path d="M0 22L6 21 13 9Q15 6 19 6H40Q45 6 48 10L55 20 63 22V31H0z" fill="${color}"/>
<path d="M15 10Q16.5 8 19 8H28V20H11zM31 8H40Q43 8 45 11L50 20H31z" fill="#bfe3f7" opacity=".92"/>
<path d="M0 26H63" stroke="${roof}" stroke-width="2" opacity=".5"/>
<rect x="58" y="22" width="5" height="4" rx="1" fill="#ffe08a"/><rect x="0" y="22" width="4" height="4" rx="1" fill="#ff5a4a"/>
<circle cx="14" cy="31" r="6.2" fill="#1c1f27"/><circle cx="14" cy="31" r="2.6" fill="#9aa4b2"/>
<circle cx="48" cy="31" r="6.2" fill="#1c1f27"/><circle cx="48" cy="31" r="2.6" fill="#9aa4b2"/></g>`;
}

function bus() {
    let windows = '';
    for (let i = 0; i < 7; i++) windows += `<rect x="${14 + i * 17}" y="8" width="13" height="15" rx="2" fill="#bfe3f7" opacity=".92"/>`;
    return `<g class="veh-body"><rect x="0" y="2" width="140" height="36" rx="7" fill="#f4efe2"/>
<rect x="0" y="26" width="140" height="6" fill="#1f6feb"/><rect x="0" y="32" width="140" height="3" fill="#ff8a3d"/>
${windows}<path d="M128 6h8q4 0 4 4v13h-12z" fill="#bfe3f7" opacity=".92"/>
<rect x="104" y="6" width="12" height="28" rx="1" fill="#d8d1bf"/>
<rect x="122" y="0" width="14" height="5" rx="1" fill="#1f2a44"/>
<rect x="136" y="29" width="5" height="4" rx="1" fill="#ffe08a"/>
<circle cx="26" cy="38" r="7.5" fill="#1c1f27"/><circle cx="26" cy="38" r="3" fill="#9aa4b2"/>
<circle cx="108" cy="38" r="7.5" fill="#1c1f27"/><circle cx="108" cy="38" r="3" fill="#9aa4b2"/></g>`;
}

function bird(x, y, cls) {
    return `<g class="bird ${cls}"><g transform="translate(${x} ${y})"><path class="wing" d="M0 0q6 -7 12 0 6 -7 12 0" stroke="#2b2b3a" stroke-width="2" fill="none" stroke-linecap="round"/></g></g>`;
}

function cloud(x, y, k, cls) {
    return `<g class="cloud ${cls}"><g transform="translate(${x} ${y}) scale(${k})" fill="#fff"><ellipse cx="0" cy="0" rx="62" ry="17" opacity=".9"/><ellipse cx="-28" cy="-12" rx="30" ry="17" opacity=".92"/><ellipse cx="14" cy="-18" rx="36" ry="21" opacity=".92"/><ellipse cx="46" cy="-5" rx="24" ry="13" opacity=".9"/></g></g>`;
}

/**
 * Escena de Formosa: el sol sale (o se pone) sobre el río Paraguay, con la ciudad baja a la izquierda, la costa paraguaya
 * al fondo, palmeras karanday y lapachos en flor, un colectivo y dos autos cruzando, nubes y aves. `variant`: 'amanecer' | 'atardecer'.
 * viewBox 1200×560; se dibuja más ancho (-700 a 1900) para que cubra pantallas panorámicas.
 */
export function introScene(variant = 'amanecer') {
    const rng = mulberry32(hashSeed('formosa-intro', 1));
    const dusk = variant === 'atardecer';
    // El cielo "de abajo" (alba o crepúsculo) y el cielo de día se mezclan con el progreso de la carga.
    const skyEdge = dusk
        ? [['0', '#241f57'], ['0.45', '#7a3b8c'], ['0.72', '#ee5f63'], ['0.88', '#ff9a4d'], ['1', '#ffd27a']]
        : [['0', '#22245a'], ['0.45', '#6a3d8f'], ['0.72', '#e0607e'], ['0.88', '#ff9e5e'], ['1', '#ffd98a']];
    const stops = (list) => list.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');

    const far = skyline(rng, { from: -700, to: 640, base: 372, minH: 18, maxH: 52, fill: dusk ? '#9a6a96' : '#8a79ad', gap: 1 });
    const near = skyline(rng, { from: -700, to: 600, base: 424, minH: 44, maxH: 118, fill: dusk ? '#3a2a55' : '#2f3157', windows: true });
    let stars = '';
    for (let i = 0; i < 34; i++) {
        stars += `<circle class="star s${i % 4}" cx="${f(-300 + rng() * 1800)}" cy="${f(-380 + rng() * 520)}" r="${f(0.8 + rng() * 1.3)}" fill="#fff"/>`;
    }
    let shimmer = '';
    for (let i = 0; i < 16; i++) {
        shimmer += `<rect class="shim sh${i % 5}" x="${f(560 + rng() * 1300)}" y="${f(352 + rng() * 66)}" width="${f(26 + rng() * 60)}" height="2" rx="1" fill="#fff" opacity=".55"/>`;
    }
    let reflect = '';
    for (let i = 0; i < 9; i++) {
        reflect += `<rect x="${f(720 - (46 - i * 4) / 2)}" y="${f(350 + i * 8.5)}" width="${f(46 - i * 4)}" height="3" rx="1.5" fill="#fff0b3" opacity="${f(0.85 - i * 0.07)}"/>`;
    }
    let farTrees = '';
    for (let x = -700; x < 1900; x += 7 + Math.floor(rng() * 10)) {
        const h = 5 + rng() * 11;
        farTrees += `<ellipse cx="${x}" cy="${f(346 - h / 2 + 2)}" rx="${f(5 + rng() * 6)}" ry="${f(h / 2 + 2)}" fill="${rng() < 0.5 ? '#46705a' : '#3b6150'}"/>`;
    }
    let dashes = '';
    for (let x = -120; x < 1960; x += 80) dashes += `<rect x="${x}" y="479" width="42" height="3" rx="1.5" fill="#f3e9c6"/>`;
    let grass = '';
    for (let x = -700; x < 1900; x += 11 + Math.floor(rng() * 12)) {
        const h = 6 + rng() * 9;
        grass += `M${x} 560l2 ${-h} 2 ${h}`;
    }

    let hedge = '';
    for (let x = -700; x < 1900; x += 30 + Math.floor(rng() * 40)) {
        hedge += `<ellipse cx="${x}" cy="522" rx="${f(18 + rng() * 14)}" ry="${f(9 + rng() * 5)}" fill="${rng() < 0.5 ? '#2f7a3a' : '#38863f'}"/>`;
        if (rng() < 0.3) hedge += `<circle cx="${x + 6}" cy="518" r="2.5" fill="#ffd36b"/>`;
    }
    let lamps = '';
    for (let x = -600; x < 1800; x += 300) {
        lamps += `<path d="M${x} 446V396q0 -10 10 -10h8" stroke="#3a3f4e" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="${x + 20}" cy="387" rx="8" ry="3.2" fill="#ffe08a"/>`;
    }

    return `<svg class="intro-art" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
<defs>
  <linearGradient id="skyA" gradientUnits="userSpaceOnUse" x1="0" y1="-420" x2="0" y2="345">${stops(skyEdge)}</linearGradient>
  <linearGradient id="skyB" gradientUnits="userSpaceOnUse" x1="0" y1="-420" x2="0" y2="345">${stops([['0', '#2f78cf'], ['0.5', '#62aee9'], ['0.85', '#b9e0f6'], ['1', '#fff0c8']])}</linearGradient>
  <radialGradient id="sunGlow"><stop offset="0" stop-color="#fff1b0" stop-opacity=".95"/><stop offset=".35" stop-color="#ffc56b" stop-opacity=".45"/><stop offset="1" stop-color="#ff9e5e" stop-opacity="0"/></radialGradient>
  <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dusk ? '#e08a6a' : '#e7a98c'}"/><stop offset=".25" stop-color="#6aa6c9"/><stop offset="1" stop-color="#2a6489"/></linearGradient>
  <linearGradient id="lawn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa34c"/><stop offset=".25" stop-color="#4a8f40"/><stop offset="1" stop-color="#2f6a30"/></linearGradient>
  <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0c8" stop-opacity="0"/><stop offset="1" stop-color="#ffd9a0" stop-opacity=".55"/></linearGradient>
</defs>
<g class="art-sky">
  <rect class="sky-a" x="-900" y="-1500" width="3000" height="1845" fill="url(#skyA)"/>
  <rect class="sky-b" x="-900" y="-1500" width="3000" height="1845" fill="url(#skyB)"/>
  <g class="stars">${stars}</g>
</g>
<g class="sun"><circle cx="720" cy="270" r="190" fill="url(#sunGlow)"/><circle cx="720" cy="270" r="44" fill="#fff4b8"/><circle cx="720" cy="270" r="44" fill="#ffd36b" opacity=".35"/></g>
<g class="clouds">${cloud(150, 120, 1.15, 'c1')}${cloud(540, 70, 0.8, 'c2')}${cloud(930, 150, 1, 'c3')}${cloud(1250, 95, 0.7, 'c4')}</g>
<g class="birds">${bird(300, 175, 'b1')}${bird(325, 190, 'b2')}${bird(280, 195, 'b3')}${bird(900, 120, 'b4')}${bird(925, 133, 'b5')}</g>
<rect x="-900" y="338" width="3000" height="12" fill="url(#haze)"/>
<g class="far-shore">${farTrees}<rect x="-900" y="346" width="3000" height="5" fill="#3b6150"/></g>
<g class="river"><rect x="-900" y="350" width="3000" height="82" fill="url(#water)"/>
  <g class="reflect">${reflect}</g><g class="shimmer">${shimmer}</g>
  <g class="boat"><g transform="translate(0 395)"><path d="M0 8h46l-7 9H8z" fill="#f4efe2"/><path d="M8 8l4-10h20l5 10z" fill="#1f6feb"/><rect x="14" y="-6" width="3" height="8" fill="#6b4a36"/><path d="M0 8h46" stroke="#c0392b" stroke-width="2"/><ellipse cx="23" cy="19" rx="30" ry="2" fill="#fff" opacity=".35"/></g></g>
</g>
<path d="M-900 372H600L690 432H-900z" fill="${dusk ? '#6e5a55' : '#5d6b56'}"/>
<g class="city-far">${far.body}</g>
<g class="city-near">${near.body}
  <path d="M410 424V336l12-22 12 22v88zM460 424V336l12-22 12 22v88zM434 424V352h26v72z" fill="${dusk ? '#4a3763' : '#3d3f6b'}"/>
  <path d="M422 310V298M416 304h12M472 310V298M466 304h12" stroke="${dusk ? '#4a3763' : '#3d3f6b'}" stroke-width="2"/>
  <path d="M437 356h20v14h-20z" fill="#ffd36b" opacity=".0"/>
  <path d="M96 424V330M86 330h20l-3 22H89z" stroke="#4a4a68" stroke-width="3" fill="#4a4a68"/>
  <path d="M250 424V262" stroke="#4a4a68" stroke-width="2.5"/><circle class="blink" cx="250" cy="261" r="3.2" fill="#ff4b3e"/>
  <path class="windows" d="${near.wins}" fill="#ffd36b"/></g>
<g class="quay"><rect x="-900" y="424" width="3000" height="26" fill="#cdbf9f"/><rect x="-900" y="424" width="3000" height="3" fill="#a69879"/>
  <path d="M-900 440H1900" stroke="#b9ab8b" stroke-width="1"/></g>
<g class="road"><rect x="-900" y="450" width="3000" height="66" fill="#383d4b"/><rect x="-900" y="450" width="3000" height="3" fill="#2a2e3a"/>
  <g class="dashes">${dashes}</g><rect x="-900" y="513" width="3000" height="4" fill="#c9bea1"/></g>
<g class="traffic">
  <g class="veh v-bus"><g transform="translate(140 438) scale(-1 1)">${bus()}</g></g>
  <g class="veh v-car1"><g transform="translate(0 467) scale(1.15)">${car('#e5483f', '#8c1f1a')}</g></g>
  <g class="veh v-car2"><g transform="translate(72 443) scale(-1.1 1.1)">${car('#18a5a0', '#0c5d5a')}</g></g>
</g>
<rect x="-900" y="517" width="3000" height="620" fill="url(#lawn)"/>
<path d="${grass}" stroke="#3d7a38" stroke-width="2" fill="none"/>
<g class="hedge">${hedge}</g>
<g class="lamps">${lamps}</g>
<g class="trees-front">
  ${lapacho(120, 536, 108, 1.15, rng, 'lap l1')}
  ${palm(300, 538, 205, 1.1, 'pm1')}
  ${palm(1040, 538, 235, 1.25, 'pm2')}
  ${lapacho(1180, 536, 96, 1.05, rng, 'lap l2')}
  ${palm(1330, 538, 190, 1, 'pm3')}
  ${palm(-70, 538, 215, 1.15, 'pm4')}
</g>
</svg>`;
}

// ================================================================ cabecera del lobby, estados vacíos, trofeos y podio

/** Franja ilustrada para el encabezado del lobby: ciudad baja, sol, palmeras y el río. */
export function lobbyHeader() {
    const rng = mulberry32(hashSeed('lobby-art', 3));
    const sk = skyline(rng, { from: -20, to: 700, base: 108, minH: 22, maxH: 62, fill: '#3b4a78', windows: true });
    return `<svg class="lobby-art-svg" viewBox="0 0 640 128" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
<defs>
  <linearGradient id="lh-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a6fd0"/><stop offset=".6" stop-color="#f0877a"/><stop offset="1" stop-color="#ffd27a"/></linearGradient>
  <linearGradient id="lh-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6a58b"/><stop offset="1" stop-color="#2d6a90"/></linearGradient>
</defs>
<rect width="640" height="128" fill="url(#lh-sky)"/>
<circle cx="470" cy="84" r="64" fill="#fff0b3" opacity=".28"/><circle cx="470" cy="84" r="26" fill="#fff4b8"/>
<g fill="#fff" opacity=".8"><ellipse cx="90" cy="26" rx="34" ry="8"/><ellipse cx="112" cy="20" rx="20" ry="9"/><ellipse cx="330" cy="38" rx="28" ry="7"/><ellipse cx="560" cy="22" rx="30" ry="7"/></g>
<rect y="98" width="640" height="30" fill="url(#lh-water)"/>
<path d="M-20 98H330L360 112H-20z" fill="#4f6a4e"/>
<g>${sk.body}<path d="${sk.wins}" fill="#ffd36b" opacity=".85"/></g>
<path d="M-20 108H338L368 128H-20z" fill="#4f8f45"/>
<path d="M420 100h40M440 106h40M430 112h50" stroke="#fff0b3" stroke-width="2" stroke-linecap="round" opacity=".7"/>
<g stroke="#6b4a36" stroke-width="3" fill="none" stroke-linecap="round"><path d="M575 128Q580 92 572 62"/><path d="M30 128Q26 100 34 78"/></g>
<g stroke="#2c6b3b" stroke-width="3" fill="none" stroke-linecap="round"><path d="M572 62q-14 -10 -30 -4M572 62q10 -14 26 -14M572 62q-4 -16 6 -26M572 62q16 -4 30 6M572 62q-18 2 -26 14"/><path d="M34 78q-12 -8 -26 -2M34 78q8 -12 22 -12M34 78q-2 -14 6 -22M34 78q14 -2 24 8"/></g>
</svg>`;
}

/** Copa de campeón: se usa en resultados y en estados vacíos (con `gold: false` queda un contorno gris). */
export function trophy({ gold = true, size = 64 } = {}) {
    const a = gold ? '#ffcf4a' : '#d9dde4';
    const b = gold ? '#f0a41b' : '#b8bfca';
    const c = gold ? '#fff0a8' : '#eef0f4';
    return `<svg class="trophy" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">
<path d="M18 8h28v14c0 9-6 16-14 16s-14-7-14-16z" fill="${a}"/>
<path d="M18 12H9c0 10 4 16 11 17M46 12h9c0 10-4 16-11 17" fill="none" stroke="${b}" stroke-width="3" stroke-linecap="round"/>
<path d="M24 10h4v18c-3-3-4-8-4-13z" fill="${c}" opacity=".7"/>
<rect x="29" y="37" width="6" height="9" fill="${b}"/><rect x="21" y="46" width="22" height="6" rx="2" fill="${a}"/><rect x="17" y="52" width="30" height="6" rx="2" fill="${b}"/>
${gold ? '<path d="M32 15l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#fff6c8"/>' : ''}
</svg>`;
}

/** Medalla redonda con el puesto (1 a 3 = oro, plata, bronce; otro = gris). */
export function medal(place) {
    const cols = { 1: ['#ffcf4a', '#f0a41b', '#fff0a8'], 2: ['#dfe3ea', '#aeb6c2', '#ffffff'], 3: ['#e0985a', '#b06a31', '#f5c79a'] }[place] ?? ['#e7eaee', '#c5cbd3', '#ffffff'];
    return `<svg class="medal" viewBox="0 0 28 32" width="28" height="32" aria-hidden="true" focusable="false">
<path d="M8 0h5l3 9-5 2zM20 0h-5l-3 9 5 2z" fill="${place === 1 ? '#e0507a' : '#4a6fd0'}"/>
<circle cx="14" cy="19" r="11" fill="${cols[1]}"/><circle cx="14" cy="19" r="8.6" fill="${cols[0]}"/><circle cx="11" cy="16" r="3" fill="${cols[2]}" opacity=".65"/>
<text x="14" y="23.2" text-anchor="middle" font-size="11" font-weight="800" fill="#4a3a1a" font-family="system-ui, sans-serif">${place}</text>
</svg>`;
}

/**
 * Podio con los tres primeros. `rows` = [{name, rank, abandoned}] ordenadas por puesto; `meName` marca el tuyo.
 * Los nombres se agregan con textContent (no son de confianza).
 */
export function podium(rows, { meId = null, confetti = false } = {}) {
    const svg = el('svg', { class: 'podium', viewBox: '0 0 300 150', role: 'img', focusable: 'false' });
    const top = rows.filter((r) => !r.abandoned).slice(0, 3);
    svg.setAttribute('aria-label', top.length ? `Podio: ${top.map((r) => `${r.rank}.º ${r.name}`).join(', ')}` : 'Podio vacío');
    const defs = el('defs');
    const g1 = el('linearGradient', { id: 'pd-gold', x1: '0', y1: '0', x2: '0', y2: '1' });
    g1.append(el('stop', { offset: '0', 'stop-color': '#ffd95e' }), el('stop', { offset: '1', 'stop-color': '#f0a41b' }));
    const g2 = el('linearGradient', { id: 'pd-silver', x1: '0', y1: '0', x2: '0', y2: '1' });
    g2.append(el('stop', { offset: '0', 'stop-color': '#e9edf3' }), el('stop', { offset: '1', 'stop-color': '#aeb6c2' }));
    const g3 = el('linearGradient', { id: 'pd-bronze', x1: '0', y1: '0', x2: '0', y2: '1' });
    g3.append(el('stop', { offset: '0', 'stop-color': '#e8a46c' }), el('stop', { offset: '1', 'stop-color': '#b06a31' }));
    defs.append(g1, g2, g3);
    svg.append(defs);

    if (confetti) {
        const rng = mulberry32(hashSeed('confetti', 5));
        const cols = ['#ffcf4a', '#e0507a', '#4a6fd0', '#2fb97a', '#ff8a3d'];
        for (let i = 0; i < 22; i++) {
            svg.append(el('rect', { class: `confetti cf${i % 5}`, x: String(f(8 + rng() * 284)), y: String(f(4 + rng() * 60)), width: '5', height: '3', rx: '1', fill: cols[i % cols.length] }));
        }
    }

    // posiciones: 2.º a la izquierda, 1.º al centro, 3.º a la derecha
    const slots = [
        { place: 2, x: 28, w: 76, h: 54, fill: 'url(#pd-silver)' },
        { place: 1, x: 112, w: 76, h: 76, fill: 'url(#pd-gold)' },
        { place: 3, x: 196, w: 76, h: 40, fill: 'url(#pd-bronze)' },
    ];
    const base = 138;
    svg.append(el('rect', { x: '10', y: String(base), width: '280', height: '4', rx: '2', fill: '#8a8f99', opacity: '.5' }));
    for (const s of slots) {
        const r = top.find((t) => t.rank === s.place) ?? top[s.place - 1];
        const g = el('g', { class: `podium-slot slot${s.place}` });
        g.append(el('rect', { x: String(s.x), y: String(base - s.h), width: String(s.w), height: String(s.h), rx: '5', fill: s.fill }));
        g.append(el('text', { x: String(s.x + s.w / 2), y: String(base - s.h / 2 + 12), 'text-anchor': 'middle', 'font-size': '30', 'font-weight': '800', fill: '#fff', opacity: '.9', 'font-family': 'system-ui, sans-serif' }, String(s.place)));
        if (r) {
            const mine = meId != null && r.user_id === meId;
            const name = r.name.length > 11 ? `${r.name.slice(0, 10)}…` : r.name;
            const label = el('text', { x: String(s.x + s.w / 2), y: String(base - s.h - 8), 'text-anchor': 'middle', 'font-size': '11', 'font-weight': mine ? '800' : '600', fill: 'currentColor', 'font-family': 'system-ui, sans-serif' });
            label.textContent = mine ? `${name} (vos)` : name;
            g.append(label);
            if (s.place === 1) {
                const t = svgFromString(trophy({ size: 30 }));
                t.setAttribute('x', String(s.x + s.w / 2 - 15));
                t.setAttribute('y', String(base - s.h - 46));
                g.append(t);
            }
        }
        svg.append(g);
    }
    return svg;
}

const frame = (inner, label = '') => `<svg class="empty-art" viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" focusable="false">${inner}</svg>${label}`;

/** Ranking sin puntos todavía: copa en contorno sobre un podio vacío. */
export function emptyRanking() {
    return frame(`<ellipse cx="60" cy="72" rx="46" ry="5" fill="#000" opacity=".08"/>
<rect x="22" y="52" width="24" height="20" rx="3" fill="#e3e6ea"/><rect x="48" y="42" width="24" height="30" rx="3" fill="#d4d9e0"/><rect x="74" y="58" width="24" height="14" rx="3" fill="#e3e6ea"/>
<g transform="translate(40 2) scale(.65)" opacity=".9"><path d="M18 8h28v14c0 9-6 16-14 16s-14-7-14-16z" fill="#eef0f4" stroke="#b8bfca" stroke-width="2"/><path d="M18 12H9c0 10 4 16 11 17M46 12h9c0 10-4 16-11 17" fill="none" stroke="#b8bfca" stroke-width="3" stroke-linecap="round"/><rect x="29" y="37" width="6" height="9" fill="#c5cbd3"/><rect x="21" y="46" width="22" height="6" rx="2" fill="#d4d9e0"/></g>
<path d="M30 14l3 3M90 20l-3 3M96 12v5M24 24h4" stroke="#f0a41b" stroke-width="2" stroke-linecap="round" opacity=".7"/>`);
}

/** Sin propiedades todavía: una casita con cartel de "libre". */
export function emptyProperties() {
    return frame(`<ellipse cx="60" cy="72" rx="44" ry="5" fill="#000" opacity=".08"/>
<path d="M28 40L60 14l32 26v32H28z" fill="#f3ead7" stroke="#cdbf9f" stroke-width="2"/><path d="M22 42L60 10l38 32" fill="none" stroke="#c0675a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="52" y="48" width="16" height="24" rx="2" fill="#8a654b"/><rect x="36" y="46" width="12" height="12" rx="1" fill="#bfe3f7"/><rect x="72" y="46" width="12" height="12" rx="1" fill="#bfe3f7"/>
<path d="M98 72V50" stroke="#6b4a36" stroke-width="3"/><rect x="88" y="42" width="24" height="12" rx="2" fill="#2fb97a"/><path d="M93 48h14" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`);
}

/** Sin partidas jugadas: un reloj de arena. */
export function emptyHistory() {
    return frame(`<ellipse cx="60" cy="72" rx="36" ry="5" fill="#000" opacity=".08"/>
<rect x="36" y="8" width="48" height="6" rx="3" fill="#8a654b"/><rect x="36" y="66" width="48" height="6" rx="3" fill="#8a654b"/>
<path d="M42 14h36c0 14-8 20-12 26 4 6 12 12 12 26H42c0-14 8-20 12-26-4-6-12-12-12-26z" fill="#eaf4fb" stroke="#9fb7c8" stroke-width="2"/>
<path d="M48 58h24c-2 4-6 6-8 6h-8c-2 0-6-2-8-6z" fill="#f0a41b"/><path d="M60 40v18" stroke="#f0a41b" stroke-width="2"/><path d="M50 18h20c-1 4-4 8-10 10-6-2-9-6-10-10z" fill="#f0a41b" opacity=".35"/>`);
}

/** Sin salas abiertas: una mesa con sillas vacías y una bandera. */
export function emptyRooms() {
    return frame(`<ellipse cx="60" cy="72" rx="46" ry="5" fill="#000" opacity=".08"/>
<rect x="30" y="44" width="60" height="8" rx="3" fill="#c9a97d"/><rect x="36" y="52" width="5" height="20" fill="#a98a60"/><rect x="79" y="52" width="5" height="20" fill="#a98a60"/>
<path d="M20 70V46h6v24M94 70V46h6v24" stroke="#8a654b" stroke-width="3" stroke-linecap="round"/><rect x="18" y="38" width="10" height="9" rx="2" fill="#d9c3a0"/><rect x="92" y="38" width="10" height="9" rx="2" fill="#d9c3a0"/>
<path d="M60 44V14" stroke="#6b4a36" stroke-width="3" stroke-linecap="round"/><path d="M60 14l26 7-26 8z" fill="#1f6feb"/><circle cx="68" cy="21" r="2.4" fill="#fff4b8"/>`);
}

/** Inserta una ilustración (texto SVG propio) en un contenedor. */
export function mountArt(container, markup) {
    if (!container) return;
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    container.replaceChildren(...t.content.childNodes);
}
