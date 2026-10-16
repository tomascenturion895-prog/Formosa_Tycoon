<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="description" content="Formosa Tycoon: jugá partidas de {{ $config['match']['durationMinutes'] }} minutos: comprá edificios reales de la ciudad de Formosa y terminá con el mayor patrimonio.">
    <meta name="theme-color" content="#1f6feb">
    <title>Formosa Tycoon — Lobby</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    {{-- El lobby no carga el mapa: solo estilos compartidos (map.css y paneles.css) y su propio JS. --}}
    @vite(['resources/css/map.css', 'resources/css/paneles.css', 'resources/css/lobby.css', 'resources/js/lobby/main.js'])
    <script nonce="{{ Illuminate\Support\Facades\Vite::cspNonce() }}">window.__MAP_CONFIG__ = {{ Illuminate\Support\Js::from($config) }};</script>
</head>
<body class="lobby-body">
    <main class="dialog lobby lobby-page" aria-labelledby="lobby-title">
        <div id="lobby-art" class="lobby-art" aria-hidden="true"></div>
        <header class="lobby-head">
            <h1 id="lobby-title">Formosa <span>Tycoon</span></h1>
            <div class="lobby-tools">
                @if ($config['user'])
                    <span class="lobby-who">{{ $config['user']['name'] }}</span>
                    <form method="POST" action="{{ route('logout') }}" class="lobby-logout">
                        @csrf
                        <button type="submit" class="link">Salir</button>
                    </form>
                @endif
                @if ($config['user'] && $config['user']['moderator'])
                    <a class="lobby-link" href="{{ route('moderacion') }}">Moderación</a>
                @endif
                <button id="btn-help" type="button" class="lobby-help" aria-label="Cómo jugar">?</button>
            </div>
        </header>

        <p class="lobby-intro">Partidas de <strong>{{ $config['match']['durationMinutes'] }}</strong> minutos para {{ $config['match']['minCapacity'] }} a {{ $config['match']['maxCapacity'] }} jugadores. Todos arrancan con la misma plata y gana quien termina con más patrimonio.</p>

        @if ($config['user'] && ! $config['user']['verified'])
            <p class="lobby-msg error" role="alert">Confirmá tu correo para jugar. <a href="{{ route('verification.notice') }}">Reenviar el enlace</a></p>
        @endif

        <section id="lobby-resume" class="lobby-resume" aria-label="Tu partida" hidden>
            <p id="lobby-resume-text"></p>
            <a id="lobby-resume-link" class="lobby-cta" href="#">Volver a tu partida</a>
        </section>

        <div id="lobby-tabs" class="lobby-tabs" role="tablist" aria-label="Secciones del lobby">
            <button id="tab-salas" class="lobby-tab" type="button" role="tab" aria-selected="true" aria-controls="panel-salas">Salas</button>
            <button id="tab-ranking" class="lobby-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-ranking" tabindex="-1">Ranking</button>
            @if ($config['user'])
                <button id="tab-historial" class="lobby-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-historial" tabindex="-1">Mis partidas</button>
            @endif
            <button id="tab-manual" class="lobby-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-manual" tabindex="-1">Cómo se juega</button>
        </div>

        <section id="panel-salas" class="lobby-panel" role="tabpanel" aria-labelledby="tab-salas">
            @if ($config['user'])
                <div class="lobby-grid">
                    <form id="room-form" class="lobby-card" novalidate>
                        <h2>Crear una sala</h2>
                        <label for="room-name">Nombre</label>
                        <input id="room-name" type="text" maxlength="{{ $config['match']['nameMax'] }}" autocomplete="off" placeholder="Sala de {{ $config['user']['name'] }}">
                        <label for="room-cap">Jugadores (cupo)</label>
                        <select id="room-cap">
                            @for ($i = $config['match']['minCapacity']; $i <= $config['match']['maxCapacity']; $i++)
                                <option value="{{ $i }}" @selected($i === $config['match']['defaultCapacity'])>{{ $i }} jugadores</option>
                            @endfor
                        </select>
                        <label class="check"><input id="room-public" type="checkbox" checked> Sala pública (aparece en el listado)</label>
                        <button id="room-create" type="submit" class="primary">Crear sala</button>
                    </form>
                    <form id="code-form" class="lobby-card" novalidate>
                        <h2>Unirme con un código</h2>
                        <label for="code-input">Código de la sala</label>
                        <input id="code-input" type="text" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" inputmode="text">
                        <button id="code-join" type="submit">Unirme</button>
                    </form>
                </div>
            @else
                <p class="lobby-guest"><a href="{{ route('login') }}">Ingresá</a> o <a href="{{ route('registro') }}">creá una cuenta</a> para crear una sala o unirte a una.</p>
            @endif
            <h2 class="lobby-sub">Salas abiertas</h2>
            <ul id="room-list" class="room-list" aria-label="Salas abiertas"></ul>
            <div id="room-empty" class="lobby-empty lobby-empty-art" hidden><span id="room-empty-art" aria-hidden="true"></span><p>Todavía no hay salas abiertas. Creá la primera.</p></div>
            <p id="lobby-msg" class="lobby-msg" role="status" hidden></p>
        </section>

        <section id="panel-ranking" class="lobby-panel" role="tabpanel" aria-labelledby="tab-ranking" hidden>
            <p id="lobby-ranking-note" class="lobby-note"></p>
            <ol id="lobby-ranking-list" class="lobby-list" aria-label="Ranking global"></ol>
        </section>

        @if ($config['user'])
            <section id="panel-historial" class="lobby-panel" role="tabpanel" aria-labelledby="tab-historial" hidden>
                <p id="lobby-history-note" class="lobby-note"></p>
                <ol id="lobby-history-list" class="lobby-list" aria-label="Mis partidas"></ol>
            </section>
        @endif

        <section id="panel-manual" class="lobby-panel" role="tabpanel" aria-labelledby="tab-manual" hidden>
            <p class="lobby-note">Todo lo que hay que saber, por pantalla. Tocá una guía para leerla; adentro del juego el botón ? te muestra la misma ayuda señalando cada parte.</p>
            <div id="lobby-manual" class="lobby-manual"></div>
        </section>

        <footer class="lobby-foot">
            <a id="btn-explorar" class="lobby-link" href="{{ route('explorar') }}">Explorar la ciudad sin jugar</a>
        </footer>
    </main>

    @include('partials.guias')
</body>
</html>
