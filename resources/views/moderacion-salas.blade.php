<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Salas y partidas — Formosa Tycoon</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    @vite(['resources/css/moderacion.css'])
</head>
<body>
    @php
        $estados = ['lobby' => 'En la sala', 'running' => 'En juego', 'finished' => 'Terminada', 'expired' => 'Vencida'];
        $hora = fn ($d) => $d ? \Illuminate\Support\Carbon::parse($d, 'UTC')->timezone('America/Argentina/Buenos_Aires')->format('d/m H:i') : '—';
        $tabs = ['activas' => 'Activas', 'terminadas' => 'Terminadas', 'vencidas' => 'Vencidas', 'todas' => 'Todas'];
    @endphp
    <main class="mod wide">
        <header>
            <h1>Salas y partidas</h1>
            <span><a href="{{ route('moderacion') }}">Moderación del chat</a> · <a href="{{ route('moderacion.mapa') }}">Datos del mapa</a> · <a href="{{ route('mapa') }}">← Volver al lobby</a></span>
        </header>

        <nav class="tabs" aria-label="Filtrar partidas">
            @foreach ($tabs as $key => $label)
                <a href="{{ route('moderacion.salas', array_filter(['estado' => $key, 'q' => $search])) }}" @class(['on' => $filter === $key]) @if ($filter === $key) aria-current="page" @endif>{{ $label }} <b>{{ $counts[$key] }}</b></a>
            @endforeach
        </nav>

        <form method="GET" action="{{ route('moderacion.salas') }}" class="search" role="search">
            <input type="hidden" name="estado" value="{{ $filter }}">
            <label class="sr-only" for="q">Buscar por código, nombre de sala o creador</label>
            <input id="q" type="text" name="q" value="{{ $search }}" maxlength="60" placeholder="Código, nombre de sala o creador">
            <button type="submit">Buscar</button>
            @if ($search !== '')<a href="{{ route('moderacion.salas', ['estado' => $filter]) }}">Quitar búsqueda</a>@endif
        </form>

        <section aria-labelledby="h-salas">
            <h2 id="h-salas">{{ $tabs[$filter] }} ({{ count($rooms) }})</h2>
            @forelse ($rooms as $r)
                <a class="card room" href="{{ route('moderacion.sala', $r['id']) }}">
                    <span class="room-main">
                        <strong>{{ $r['name'] }}</strong>
                        <span class="meta">#{{ $r['id'] }} · código {{ $r['code'] }} · {{ $r['is_public'] ? 'pública' : 'privada' }} · creó {{ $r['creator'] }}</span>
                    </span>
                    <span class="room-side">
                        <span class="pill st-{{ $r['status'] }}">{{ $estados[$r['status']] }}</span>
                        <span class="meta">{{ $r['players'] }}/{{ $r['capacity'] }} jugadores</span>
                        <span class="meta">
                            @if ($r['status'] === 'running') termina {{ $hora($r['ends_at']) }}
                            @elseif ($r['status'] === 'finished') terminó {{ $hora($r['finished_at']) }}
                            @else creada {{ $hora($r['created_at']) }}
                            @endif
                        </span>
                    </span>
                </a>
            @empty
                <p class="empty">{{ $search !== '' ? 'No hay partidas que coincidan con la búsqueda.' : 'No hay partidas en este estado.' }}</p>
            @endforelse
            @if (count($rooms) >= 100)<p class="note">Se muestran las 100 más nuevas. Usá la búsqueda para encontrar una anterior.</p>@endif
        </section>

        <p class="note">Entrá a una partida para ver a sus jugadores y su chat, silenciar, ocultar mensajes o cerrar una sala trabada. Todo queda registrado. No se muestran correos ni direcciones IP. Las horas son de Argentina.</p>
    </main>
</body>
</html>
