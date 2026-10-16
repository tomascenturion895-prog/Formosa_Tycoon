<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="description" content="Formosa Tycoon: jugá partidas de 40 minutos: comprá edificios reales de la ciudad de Formosa y terminá con el mayor patrimonio.">
    <meta name="theme-color" content="#1f6feb">
    <title>Formosa Tycoon — {{ ($config['page'] ?? 'partida') === 'explorar' ? 'Explorar' : 'Partida' }}</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    {{-- intro.js (cinemática de carga) va primero y aparte: sale en el primer cuadro, sin esperar a MapLibre --}}
    @vite(['resources/css/map.css', 'resources/css/paneles.css', 'resources/js/map/intro.js', 'resources/js/map/main.js'])
    <script nonce="{{ Illuminate\Support\Facades\Vite::cspNonce() }}">window.__MAP_CONFIG__ = {{ Illuminate\Support\Js::from($config) }};</script>
</head>
<body class="intro-activa">
    {{-- Cinemática de carga: se ve desde el primer cuadro; intro.js la anima y la cierra (o la quita si no corresponde). --}}
    <div id="intro" class="intro" role="dialog" aria-modal="true" aria-labelledby="intro-title" aria-describedby="intro-status" tabindex="-1">
        <div id="intro-scene" class="intro-scene" aria-hidden="true"></div>
        <div class="intro-brand">
            <span id="intro-mark" class="intro-mark" aria-hidden="true"></span>
            <h2 id="intro-title" class="intro-logo">Formosa <span>Tycoon</span></h2>
            <p class="intro-tagline">Comprá la ciudad, edificio por edificio</p>
        </div>
        <div class="intro-card">
            <p id="intro-note" class="intro-note" hidden></p>
            <p id="intro-tip" class="intro-tip"></p>
            <div class="intro-bar" role="progressbar" aria-labelledby="intro-status" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="intro-fill" class="intro-fill"></span></div>
            <p id="intro-status" class="intro-status" role="status" aria-live="polite">Armando el mapa…</p>
            <div class="intro-actions">
                <button id="intro-enter" type="button" class="intro-enter" hidden disabled>Tocá para jugar</button>
                <button id="intro-skip" type="button" class="intro-skip">Saltar</button>
            </div>
        </div>
    </div>

    <div id="map" role="application" aria-label="Mapa de Formosa con las propiedades del juego"></div>
    <div id="noche" class="noche" aria-hidden="true" hidden></div>

    <header class="hud">
        <div class="hud-top">
            <h1>Formosa Tycoon <span id="live" class="live" hidden></span></h1>
            <span id="hud-mini" class="hud-mini" aria-hidden="true" hidden></span>
            <button id="clock" class="clock" type="button" aria-pressed="true" title="Hora de la ciudad. Tocá para dejar la luz de día fija.">
                <span id="clock-time" class="clock-time">--:--</span> <span id="clock-phase" class="clock-phase"></span>
            </button>
            <button id="hud-min" class="hud-min-btn" type="button" aria-expanded="true" aria-controls="hud-body" title="Minimizar el panel" aria-label="Minimizar el panel">▾</button>
        </div>
        <div id="hud-body" class="hud-body">
        <p id="stats" aria-live="polite">Cargando mapa…</p>

        @if ($config['user'])
            <div class="hud-player">
                <p class="hud-name">{{ $config['user']['name'] }}</p>
                <form method="POST" action="{{ route('logout') }}" class="hud-logout">
                    @csrf
                    <button type="submit" class="link">Salir</button>
                </form>
                @unless ($config['user']['verified'])
                    <p class="hud-verify" role="alert">Confirmá tu correo para jugar. <a href="{{ route('verification.notice') }}">Reenviar el enlace</a></p>
                @endunless

                <section id="match-hud" class="match-hud" aria-label="Tu partida" data-nivel="normal" hidden>
                    <div class="match-top">
                        <div id="match-ring" class="match-ring">
                            <p class="match-timer"><span class="sr-only">Tiempo restante: </span><strong id="match-countdown" role="timer" aria-live="off">40:00</strong></p>
                        </div>
                        <div class="match-daybox">
                            <p class="match-day"><span id="match-day">Día 1/20</span></p>
                            <p class="match-dayleft">Termina el día en <strong id="day-left">–</strong></p>
                            <div class="day-bar" aria-hidden="true"><span id="day-bar"></span></div>
                        </div>
                    </div>
                    <div class="match-progress" aria-hidden="true" title="Avance de la partida"><span id="match-bar"></span></div>
                    <div class="match-events-row">
                        <div id="match-events" class="match-events" aria-label="Eventos de la partida" hidden></div>
                        <button id="match-events-help" type="button" class="guide-help" data-guide="partida-combos-eventos" aria-label="Cómo funcionan los eventos y el sprint" hidden>?</button>
                    </div>
                    <p id="match-sr" class="sr-only" role="status" aria-live="polite"></p>
                    <p class="hud-money hud-cash"><span class="lbl">Efectivo</span> <strong id="balance">…</strong> <span class="hud-income">+<span id="my-income">$ 0</span>/día</span> <span id="reserved-wrap" class="hud-reserved" hidden>· reservado <strong id="reserved">$ 0</strong></span></p>
                    <div class="hud-tiles">
                        <p class="hud-money hud-net"><span class="lbl">Patrimonio</span> <strong id="networth">…</strong></p>
                        <p id="hud-stats" class="hud-stats"><span id="my-count">0</span> prop. · puesto <span id="my-rank">–</span></p>
                    </div>
                    <p id="hud-gap" class="hud-gap" hidden></p>
                    <details id="standings-box" class="standings" open>
                        <summary>Posiciones <span id="standings-sub" class="standings-sub"></span></summary>
                        <ol id="standings" class="standings-list" aria-label="Posiciones en vivo"></ol>
                    </details>
                </section>

                <p id="explore-note" class="explore-note">Estás explorando el mapa. Para comprar, sumate a una partida de 40 minutos.</p>

                <div class="hud-actions">
                    <a id="btn-lobby" class="hud-btn primary" href="{{ route('mapa') }}">Lobby</a>
                    <button id="btn-room" type="button" aria-haspopup="dialog" hidden>Mi sala</button>
                    <button id="btn-mine" type="button" aria-controls="drawer" hidden>Mis propiedades</button>
                    <button id="btn-bank" type="button" aria-controls="bank" aria-expanded="false" hidden>Banco</button>
                    <button id="btn-ranking" type="button" aria-controls="drawer">Ranking</button>
                    <button id="btn-history" type="button" aria-controls="drawer">Mis partidas</button>
                    <button id="btn-leave" type="button" class="danger-lite" hidden>Abandonar</button>
                </div>
                @if ($config['user']['moderator'])
                    <a class="hud-mod" href="{{ route('moderacion') }}">Moderación</a>
                @endif
            </div>
        @else
            <p class="hud-guest"><a href="{{ route('login') }}">Ingresar</a> o <a href="{{ route('registro') }}">crear cuenta</a> para jugar</p>
            <div class="hud-actions">
                <a id="btn-lobby" class="hud-btn primary" href="{{ route('mapa') }}">Ver salas</a>
                <button id="btn-ranking" type="button" aria-controls="drawer">Ranking</button>
            </div>
        @endif

        <p id="aviso" class="aviso" role="status" hidden></p>
        <p id="entry-error" class="aviso error" role="alert" hidden>No se pudo leer tu partida. <button id="entry-retry" type="button" class="link">Reintentar</button> · <a href="{{ route('mapa') }}">Volver al lobby</a></p>

        <section id="subastas-box" class="auction-list" aria-label="Subastas en curso" hidden>
            <h2>Subastas en curso <button type="button" class="guide-help" data-guide="partida-subastas" aria-label="Cómo funcionan las subastas">?</button></h2>
            <ul id="subastas"></ul>
        </section>
        </div>
    </header>

    <p id="match-banner" class="match-banner" role="alert" hidden></p>
    {{-- Actividad de los demás jugadores (compras, subastas, ventas). Las tarjetas las agrega feed.js. --}}
    <div id="feed" class="feed" role="region" aria-label="Actividad de la partida"></div>

    <section id="legend" class="legend" aria-label="Tipos de propiedad">
        <h2>Propiedades</h2>
        <ul id="legend-list"></ul>
        <p class="legend-note only-2d"><span class="swatch swatch-owned"></span> Con dueño: color del jugador</p>
        @if ($config['user'])
            <p class="legend-note only-2d"><span class="swatch swatch-mine"></span> Tuyas: borde dorado</p>
        @endif
        <p class="legend-note only-3d"><span class="swatch swatch-owned"></span> Techo de color: tiene dueño</p>
        @if ($config['user'])
            <p class="legend-note only-3d"><span class="swatch swatch-mine-3d"></span> Techo dorado: tuyas</p>
        @endif
    </section>

    <button id="ui-show" class="ui-show" type="button" title="Volver a mostrar los paneles (tecla H)" hidden>Mostrar paneles</button>

    <nav class="toolbar" aria-label="Herramientas del mapa">
        <button id="btn-legend" type="button" aria-expanded="true" aria-controls="legend">Leyenda</button>
        <button id="btn3d" type="button" aria-pressed="false">3D</button>
        <div id="settings" class="settings">
            <button id="btn-ajustes" type="button" aria-expanded="false" aria-controls="ajustes-panel" title="Calidad, tránsito, sonido y música">Ajustes</button>
            <div id="ajustes-panel" class="ajustes" role="group" aria-label="Ajustes del mapa" hidden>
                <label class="toolbar-select only-3d" for="calidad">
                    <span class="ajuste-nombre">Calidad 3D</span>
                    <select id="calidad">
                        <option value="auto">Automática</option>
                        <option value="baja">Baja</option>
                        <option value="media">Media</option>
                        <option value="alta">Alta</option>
                    </select>
                </label>
                <button id="btn-transito" class="only-3d" type="button" aria-pressed="true" title="Autos, motos y colectivos en las calles 3D">Tránsito</button>
                <button id="btn-sound" type="button" aria-pressed="true" aria-label="Sonido" title="Efectos de sonido">Sonido</button>
                <button id="btn-feed" type="button" aria-pressed="true" title="Tarjetas con lo que hacen los demás jugadores">Actividad</button>
                <div id="music-ctl" class="music-ctl">
                    <button id="btn-music" type="button" aria-pressed="true" title="Música (tecla M)">Música</button>
                    <button id="btn-music-vol" type="button" class="music-vol-btn" aria-expanded="false" aria-controls="music-panel" aria-label="Volumen de la música" title="Volumen de la música">
                        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/><path d="M13 7.5a3.5 3.5 0 0 1 0 5M15.2 5.4a6.5 6.5 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                    </button>
                    <div id="music-panel" class="music-panel" role="group" aria-label="Volumen de la música" hidden>
                        <label for="music-volume" class="music-label">Volumen de la música <output id="music-volume-out" for="music-volume">60 %</output></label>
                        <input id="music-volume" type="range" min="0" max="100" step="5" value="60">
                        <p class="music-hint">Tecla M: silenciar o activar.</p>
                    </div>
                </div>
            </div>
        </div>
        <button id="btn-help" type="button" aria-label="Cómo jugar">?</button>
        <button id="btn-ui" type="button" aria-pressed="false" title="Ocultar todos los paneles para ver solo el mapa (tecla H)">Ocultar</button>
    </nav>

    <section id="bank" class="drawer bank" aria-labelledby="bank-title" hidden>
        <header class="drawer-head">
            <h2 id="bank-title">Banco</h2>
            <button type="button" class="guide-help" data-guide="partida-banco" aria-label="Cómo funciona el banco">?</button>
            <button id="bank-close" type="button" class="icon" aria-label="Cerrar">×</button>
        </header>
        <div id="bank-body" class="bank-body"></div>
    </section>

    <section id="drawer" class="drawer" aria-labelledby="drawer-title" hidden>
        <header class="drawer-head">
            <h2 id="drawer-title"></h2>
            <button id="drawer-close" type="button" class="icon" aria-label="Cerrar">×</button>
        </header>
        <p id="drawer-note" class="drawer-note"></p>
        <ol id="drawer-list" class="drawer-list"></ol>
    </section>

    @include('partials.guias')

    <section id="chat" class="chat" aria-label="Chat de jugadores">
        @if ($config['user'] && ($config['voice']['enabled'] ?? false))
            <section id="voice" class="voice" aria-label="Voz de la sala" hidden>
                <div class="voice-bar">
                    <button id="voice-mic" class="voice-mic" type="button" aria-pressed="false" title="Tocá para hablar">
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" fill="currentColor"/><path class="voice-slash" d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
                        <span class="voice-mic-text" aria-hidden="true">Micrófono</span>
                        <span id="voice-mic-label" class="sr-only">Micrófono apagado</span>
                    </button>
                    <button id="voice-deaf" class="voice-deaf" type="button" aria-pressed="false" title="Dejar de oír a los demás">
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z" fill="currentColor"/><path class="voice-slash" d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
                        <span class="sr-only">Sonido de los demás</span>
                    </button>
                    <button id="voice-toggle" class="voice-toggle" type="button" aria-expanded="false" aria-controls="voice-list"><span id="voice-status">Voz</span> <svg class="voice-chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>
                <ul id="voice-list" class="voice-list" aria-label="Jugadores en la voz" hidden></ul>
                <p id="voice-note" class="voice-note" role="status" hidden></p>
            </section>
        @endif
        <button id="chat-toggle" class="chat-toggle" type="button" aria-expanded="false" aria-controls="chat-body">
            Chat <span id="chat-unread" class="chat-unread" hidden>0</span>
        </button>
        <div id="chat-body" class="chat-body" hidden>
            <header class="chat-top">
                <h2>Chat</h2>
                <button id="chat-close" type="button" class="icon" aria-label="Cerrar el chat">×</button>
            </header>
            {{-- Dos canales: Sala (solo mi partida, con los avisos del juego) y Global (todos, charla libre). Sin partida solo hay Global. --}}
            <div id="chat-tabs" class="chat-tabs single" role="tablist" aria-label="Canales del chat">
                <button id="chat-tab-sala" class="chat-tab" type="button" role="tab" aria-selected="false" aria-controls="chat-panel-sala" tabindex="-1" hidden>
                    Sala <span id="chat-badge-sala" class="chat-unread" hidden>0</span>
                </button>
                <button id="chat-tab-global" class="chat-tab on" type="button" role="tab" aria-selected="true" aria-controls="chat-panel-global" tabindex="0">
                    Global <span id="chat-badge-global" class="chat-unread" hidden>0</span>
                </button>
            </div>
            <div id="chat-panel-sala" class="chat-panel" role="tabpanel" aria-labelledby="chat-tab-sala" hidden>
                <p id="chat-hint-sala" class="chat-hint"></p>
                <div class="chat-log-wrap" role="log" aria-live="polite" aria-relevant="additions" aria-label="Mensajes de la sala">
                    <ol id="chat-log-sala" class="chat-log" tabindex="0"></ol>
                </div>
            </div>
            <div id="chat-panel-global" class="chat-panel" role="tabpanel" aria-labelledby="chat-tab-global">
                <p id="chat-hint-global" class="chat-hint"></p>
                <div class="chat-log-wrap" role="log" aria-live="polite" aria-relevant="additions" aria-label="Mensajes del chat global">
                    <ol id="chat-log-global" class="chat-log" tabindex="0"></ol>
                </div>
            </div>
            @if ($config['user'])
                <form id="chat-form" class="chat-form" novalidate>
                    <label for="chat-input" id="chat-input-label" class="sr-only">Mensaje para el chat global</label>
                    <input id="chat-input" type="text" maxlength="{{ $config['chat']['max'] }}" autocomplete="off" enterkeyhint="send" placeholder="Escribí a todos (global)…">
                    <button id="chat-send" type="submit">Enviar</button>
                </form>
                <p id="chat-msg" class="chat-msg" role="status" hidden></p>
            @else
                <p class="chat-guest"><a href="{{ route('login') }}">Ingresá</a> o <a href="{{ route('registro') }}">creá una cuenta</a> para escribir.</p>
            @endif
        </div>
    </section>


    {{-- Sala de espera: se puede cerrar para explorar el mapa y se vuelve a abrir con "Mi sala". Las salas abiertas, crear y unirse viven en el lobby (/mapa). --}}
    <div id="lobby" class="overlay" hidden>
        <section class="dialog lobby" role="dialog" aria-modal="true" aria-labelledby="lobby-title" tabindex="-1">
            <header class="dialog-head">
                <h2 id="lobby-title">Sala de espera</h2>
                <button id="lobby-close" type="button" class="icon" aria-label="Cerrar y explorar el mapa">×</button>
            </header>

            <div id="lobby-room" class="lobby-view">
                <p class="lobby-code-label">Código de la sala</p>
                <p class="lobby-code"><strong id="room-code" aria-label="Código">------</strong> <button id="room-copy" type="button" class="link">Copiar</button></p>
                <p id="room-meta" class="lobby-meta"></p>
                <h3 class="lobby-sub">Jugadores <span id="room-count"></span></h3>
                <ul id="room-players" class="player-list" aria-label="Jugadores en la sala"></ul>
                <p id="room-wait" class="lobby-empty" role="status"></p>
                <p id="room-msg" class="lobby-msg" role="status" hidden></p>
                <div class="dialog-actions">
                    <button id="room-start" type="button" class="primary">Iniciar partida</button>
                    <button id="room-leave" type="button">Salir de la sala</button>
                </div>
            </div>
        </section>
    </div>

    <div id="results" class="overlay" hidden>
        <section class="dialog results" role="dialog" aria-modal="true" aria-labelledby="results-title" tabindex="-1">
            <header class="dialog-head">
                <h2 id="results-title">Partida terminada</h2>
                <button id="results-close" type="button" class="icon" aria-label="Cerrar los resultados">×</button>
            </header>
            <div id="results-art" class="results-art"></div>
            <p id="results-name" class="results-name"></p>
            <div id="results-me" class="results-me" hidden>
                <p class="results-place"><span id="results-place">1.º</span> <small id="results-of">de 4</small></p>
                <dl class="results-stats">
                    <div><dt>Patrimonio</dt><dd id="results-worth"></dd></div>
                    <div><dt>Propiedades</dt><dd id="results-props"></dd></div>
                    <div><dt>Puntos ganados</dt><dd id="results-points"></dd></div>
                </dl>
            </div>
            <p id="results-msg" class="lobby-msg" role="status" hidden></p>
            <h3 class="lobby-sub">Tabla final</h3>
            <ol id="results-table" class="results-table" aria-label="Tabla final de la partida"></ol>
            <div class="dialog-actions">
                <button id="results-again" type="button" class="primary">Jugar otra vez</button>
                <button id="results-ranking" type="button">Ranking global</button>
                <button id="results-map" type="button" class="link">Ver el mapa</button>
            </div>
        </section>
    </div>

    <aside id="panel" class="panel" aria-live="polite" hidden>
        <button id="panel-close" type="button" class="panel-close" aria-label="Cerrar detalle">×</button>
        <p id="panel-kind" class="panel-kind"></p>
        <h2 id="panel-title"></h2>
        <p id="panel-street" class="panel-street"></p>
        <dl>
            <div><dt>Precio</dt><dd id="panel-price"></dd></div>
            <div><dt>Ingreso</dt><dd id="panel-income"></dd></div>
            <div><dt>Se recupera en</dt><dd id="panel-payback"></dd></div>
            <div><dt>Superficie</dt><dd id="panel-area"></dd></div>
            <div><dt>Dueño</dt><dd id="panel-owner"></dd></div>
        </dl>
        <div id="offer-box" class="auction-box offer-box" hidden>
            <p id="offer-status" class="auction-status"></p>
            <button type="button" class="guide-help offer-help" data-guide="partida-ofertas" aria-label="Cómo funcionan las ofertas">?</button>
            <p id="offer-timer" class="auction-timer" role="timer" aria-live="off"></p>
            <dl>
                <div><dt>Mínimo</dt><dd id="offer-min"></dd></div>
                <div><dt>Comprá ya</dt><dd id="offer-buynow"></dd></div>
                <div><dt>Mejor oferta</dt><dd id="offer-best"></dd></div>
            </dl>
            <form id="offer-bid-form" class="bid-form" novalidate hidden>
                <label for="offer-bid-input">Tu oferta ($)</label>
                <div class="bid-row">
                    <input id="offer-bid-input" type="number" inputmode="numeric" min="1" step="1" autocomplete="off">
                    <button id="btn-offer-bid" type="submit">Ofertar</button>
                </div>
                <button id="btn-offer-buynow" type="button" class="offer-buynow"></button>
            </form>
            <div id="offer-owner-actions" class="offer-actions" hidden>
                <button id="btn-offer-accept" type="button" hidden></button>
                <button id="btn-offer-cancel" type="button" class="offer-cancel">Retirar la oferta</button>
            </div>
        </div>
        <details id="offer-new" class="data-box offer-new" hidden>
            <summary>Ofrecerla a otros jugadores <button type="button" class="guide-help" data-guide="partida-ofertas" aria-label="Cómo funcionan las ofertas">?</button></summary>
            <form id="offer-form" class="data-form" novalidate>
                <label for="offer-min-input">Mínimo ($): no la vendés por menos</label>
                <input id="offer-min-input" type="number" inputmode="numeric" min="1" step="1" autocomplete="off">
                <label for="offer-max-input">Comprá ya ($): se vende en el acto</label>
                <input id="offer-max-input" type="number" inputmode="numeric" min="1" step="1" autocomplete="off">
                <p id="offer-hint" class="data-hint"></p>
                <button id="btn-offer-open" type="submit">Poner en oferta</button>
            </form>
        </details>
        <div id="panel-roi" class="panel-roi" hidden>
            <div class="roi-bar" aria-hidden="true"><span id="roi-fill"></span></div>
            <p id="roi-of" class="roi-of"></p>
        </div>
        <p id="panel-combo" class="panel-combo" hidden></p>
        <p id="panel-event" class="panel-combo panel-event" hidden></p>
        <div id="auction-box" class="auction-box" hidden>
            <p id="auction-status" class="auction-status"></p>
            <p id="auction-timer" class="auction-timer" role="timer" aria-live="off"></p>
            <dl>
                <div><dt>Puja actual</dt><dd id="auction-bid"></dd></div>
                <div><dt>Va ganando</dt><dd id="auction-leader"></dd></div>
            </dl>
            <form id="bid-form" class="bid-form" novalidate hidden>
                <label for="bid-input">Tu puja ($)</label>
                <div class="bid-row">
                    <input id="bid-input" type="number" inputmode="numeric" min="1" step="1" autocomplete="off">
                    <button id="btn-bid" type="submit">Pujar</button>
                </div>
            </form>
        </div>
        <details id="data-box" class="data-box" hidden>
            <summary id="data-summary">¿Datos desactualizados?</summary>
            <form id="report-form" class="data-form" novalidate hidden>
                <label for="report-reason">¿Qué cambió?</label>
                <select id="report-reason"></select>
                <label for="report-note">Detalle (opcional)</label>
                <input id="report-note" type="text" maxlength="140" autocomplete="off">
                <button id="btn-report" type="submit">Enviar aviso</button>
                <p class="data-hint">Un moderador lo revisa. Tu aviso no cambia el mapa solo.</p>
            </form>
            <form id="fix-form" class="data-form" novalidate hidden>
                <p id="fix-info" class="data-hint"></p>
                <label for="fix-kind">Rubro</label>
                <select id="fix-kind"></select>
                <label for="fix-name">Nombre</label>
                <input id="fix-name" type="text" maxlength="120" autocomplete="off">
                <label for="fix-reason">Motivo (opcional)</label>
                <input id="fix-reason" type="text" maxlength="120" autocomplete="off">
                <div class="data-actions">
                    <button id="btn-fix" type="submit">Guardar</button>
                    <button id="btn-closed" type="button" class="danger">Marcar como cerrado</button>
                </div>
                <p id="fix-warn" class="data-hint" hidden></p>
            </form>
            <p id="data-msg" class="panel-msg" role="status" hidden></p>
        </details>
        <div class="panel-actions">
            <button id="btn-buy" type="button" hidden></button>
            <button id="btn-sell" type="button" class="secondary" hidden></button>
            <p id="panel-after" class="panel-after" hidden></p>
            <a id="link-login" href="{{ route('login') }}" hidden>Ingresá para jugar</a>
            <a id="btn-join-cta" class="cta" href="{{ route('mapa') }}" hidden>Sumate a una partida para comprar</a>
            <p id="panel-msg" class="panel-msg" role="status" hidden></p>
        </div>
    </aside>
</body>
</html>
