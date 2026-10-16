<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Sala {{ $match['code'] }} — Formosa Tycoon</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    @vite(['resources/css/moderacion.css'])
</head>
<body>
    @php
        $estados = ['lobby' => 'En la sala', 'running' => 'En juego', 'finished' => 'Terminada', 'expired' => 'Vencida'];
        $tz = fn ($d) => $d ? \Illuminate\Support\Carbon::parse($d, 'UTC')->timezone('America/Argentina/Buenos_Aires') : null;
        $hora = fn ($d) => $d ? $tz($d)->format('d/m H:i') : '—';
        $horaSeg = fn ($d) => $d ? $tz($d)->format('d/m H:i:s') : '—';
        $fecha = fn ($d) => $d ? $tz($d)->format('d/m/Y') : '—';
        $plata = fn ($n) => '$ '.number_format((int) $n, 0, ',', '.');
        $m = $match;
        $running = $m['status'] === 'running';
        $done = $m['status'] === 'finished';
        $inRoom = collect($players)->where('in_room', true)->count();
    @endphp
    <main class="mod wide">
        <header>
            <h1>{{ $m['name'] }}</h1>
            <span><a href="{{ route('moderacion.salas') }}">← Salas y partidas</a> · <a href="{{ route('moderacion') }}">Moderación del chat</a></span>
        </header>

        @if (session('ok'))<p class="flash ok" role="status">{{ session('ok') }}</p>@endif
        @if ($errors->any())<p class="flash bad" role="alert">{{ $errors->first() }}</p>@endif
        @if (session('error'))<p class="flash bad" role="alert">{{ session('error') }}</p>@endif

        <section aria-labelledby="h-info" class="card">
            <h2 id="h-info">Partida #{{ $m['id'] }} <span class="pill st-{{ $m['status'] }}">{{ $estados[$m['status']] }}</span></h2>
            <dl class="facts">
                <div><dt>Código</dt><dd>{{ $m['code'] }}</dd></div>
                <div><dt>Visibilidad</dt><dd>{{ $m['is_public'] ? 'Pública' : 'Privada (solo con código)' }}</dd></div>
                <div><dt>Creó</dt><dd>{{ $m['creator'] }}</dd></div>
                <div><dt>Jugadores</dt><dd>{{ $inRoom }} de {{ $m['capacity'] }} (mínimo {{ $m['min_players'] }})</dd></div>
                <div><dt>Dinero inicial</dt><dd>{{ $plata($m['start_cash']) }}</dd></div>
                <div><dt>Duración</dt><dd>{{ $m['duration_minutes'] }} min ({{ $m['days_total'] }} días de juego)</dd></div>
                <div><dt>Creada</dt><dd>{{ $horaSeg($m['created_at']) }}</dd></div>
                @if ($m['lobby_expires_at'])<div><dt>La sala vence</dt><dd>{{ $horaSeg($m['lobby_expires_at']) }}</dd></div>@endif
                @if ($m['started_at'])<div><dt>Empezó</dt><dd>{{ $horaSeg($m['started_at']) }}</dd></div>@endif
                @if ($m['ends_at'])<div><dt>{{ $done ? 'Debía terminar' : 'Termina' }}</dt><dd>{{ $horaSeg($m['ends_at']) }}</dd></div>@endif
                @if ($m['finished_at'])<div><dt>Terminó</dt><dd>{{ $horaSeg($m['finished_at']) }}</dd></div>@endif
                @if ($m['game_day'] !== null)<div><dt>Día de juego</dt><dd>{{ number_format($m['game_day'], 1, ',', '.') }} de {{ $m['days_total'] }}</dd></div>@endif
            </dl>
            @if ($m['can_close'])
                <details class="close-room">
                    <summary>{{ $m['status'] === 'lobby' ? 'Cerrar sala…' : 'Cerrar partida…' }}</summary>
                    <form method="POST" action="{{ route('moderacion.sala.cerrar', $m['id']) }}">
                        @csrf
                        <p class="meta">
                            @if ($m['status'] === 'lobby') Sala abierta sin iniciar. Se cierra y sus jugadores quedan libres para entrar a otra. Usalo si quedó trabada o no corresponde.
                            @else La hora de fin ya pasó y la partida sigue abierta (¿está corriendo el reloj de partidas?). Cerrarla calcula puestos, puntos y ranking, igual que lo haría el reloj.
                            @endif
                            No se puede deshacer.
                        </p>
                        <button type="submit" class="danger">Sí, {{ $m['status'] === 'lobby' ? 'cerrar la sala' : 'cerrar la partida' }}</button>
                    </form>
                </details>
            @endif
        </section>

        <section aria-labelledby="h-jug">
            <h2 id="h-jug">Jugadores ({{ count($players) }})</h2>
            @if ($running)<p class="note">Dinero y patrimonio se calculan al momento de abrir esta página. Recargá para actualizarlos.</p>@endif
            @forelse ($players as $p)
                <article class="card player {{ $p['in_room'] ? '' : 'gone' }}">
                    <div class="player-head">
                        <strong>{{ $p['name'] }}</strong>
                        @if ($p['is_creator'])<span class="pill">creador</span>@endif
                        @if ($p['muted_until'])<span class="pill bad">silenciado hasta {{ $hora($p['muted_until']) }}</span>@endif
                        @if ($p['abandoned'])<span class="pill bad">abandonó</span>
                        @elseif (! $p['in_room'])<span class="pill">salió de la sala</span>@endif
                        @if ($done && $p['final_rank'])<span class="pill ok">terminó {{ $p['final_rank'] }}.º · {{ $p['points_awarded'] }} pts</span>
                        @elseif ($running && $p['rank'])<span class="pill">va {{ $p['rank'] }}.º</span>@endif
                    </div>
                    <dl class="facts small">
                        <div><dt>Efectivo</dt><dd>{{ $plata($p['cash']) }}</dd></div>
                        @if ($p['reserved'] > 0)<div><dt>Reservado en subastas</dt><dd>{{ $plata($p['reserved']) }}</dd></div>@endif
                        <div><dt>Propiedades</dt><dd>{{ $p['properties'] }} ({{ $plata($p['assets']) }})</dd></div>
                        <div><dt>Patrimonio</dt><dd>{{ $plata($done && $p['final_net_worth'] !== null ? $p['final_net_worth'] : $p['net_worth']) }}</dd></div>
                        @if ($running || $m['status'] === 'lobby')<div><dt>Ingreso por día</dt><dd>{{ $plata($p['income_per_day']) }}</dd></div>@endif
                        <div><dt>Entró</dt><dd>{{ $hora($p['joined_at']) }}</dd></div>
                        @if ($p['left_at'])<div><dt>Salió</dt><dd>{{ $hora($p['left_at']) }}</dd></div>@endif
                        <div><dt>Mensajes en la sala</dt><dd>{{ $p['messages'] }}@if ($p['hidden_messages'] > 0) · <span class="tag">{{ $p['hidden_messages'] }} {{ $p['hidden_messages'] === 1 ? 'oculto' : 'ocultos' }}</span>@endif</dd></div>
                        <div><dt>Cuenta creada</dt><dd>{{ $fecha($p['account_since']) }}</dd></div>
                        <div><dt>En total</dt><dd>{{ $p['matches_played'] }} partidas, {{ $p['matches_won'] }} ganadas, {{ $p['rank_points'] }} pts</dd></div>
                    </dl>
                    @if (! $p['is_moderator'])
                        <div class="actions">
                            @if ($p['muted_until'])
                                <form method="POST" action="{{ route('moderacion.quitar-silencio', $p['user_id']) }}">@csrf<input type="hidden" name="sala" value="{{ $m['id'] }}"><button type="submit">Levantar silencio</button></form>
                            @else
                                <form method="POST" action="{{ route('moderacion.silenciar', $p['user_id']) }}" class="inline">
                                    @csrf<input type="hidden" name="sala" value="{{ $m['id'] }}">
                                    <label class="sr-only" for="min-{{ $p['user_id'] }}">Duración del silencio de {{ $p['name'] }}</label>
                                    <select id="min-{{ $p['user_id'] }}" name="minutos">
                                        @foreach ($durations as $d)
                                            <option value="{{ $d }}">{{ $d < 60 ? $d.' min' : ($d < 1440 ? ($d / 60).' h' : ($d / 1440).' d') }}</option>
                                        @endforeach
                                    </select>
                                    <button type="submit" class="danger">Silenciar a {{ $p['name'] }}</button>
                                </form>
                            @endif
                        </div>
                    @endif
                </article>
            @empty
                <p class="empty">Esta partida no tiene jugadores.</p>
            @endforelse
        </section>

        <section aria-labelledby="h-chat">
            <h2 id="h-chat">Chat de la sala ({{ $chat['total'] }} {{ $chat['total'] === 1 ? 'mensaje' : 'mensajes' }})</h2>
            @if ($chat['total'] > count($chat['messages']))<p class="note">Se muestran los últimos {{ count($chat['messages']) }}.</p>@endif
            @forelse ($chat['messages'] as $c)
                <article class="card chatline {{ $c['hidden'] ? 'is-hidden' : '' }}">
                    <p class="meta">
                        <strong>{{ $c['author'] }}</strong> · {{ $horaSeg($c['at']) }}
                        @if ($c['reports'] > 0)· <b>{{ $c['reports'] }}</b> {{ $c['reports'] === 1 ? 'reporte' : 'reportes' }}@endif
                        @if ($c['hidden'])· <span class="tag">oculto{{ $c['hidden_reason'] === 'reportes' ? ' por reportes' : '' }}</span>@endif
                    </p>
                    <p class="body">{{ $c['body'] }}</p>
                    <div class="actions">
                        @if ($c['hidden'])
                            <form method="POST" action="{{ route('moderacion.restaurar', $c['id']) }}">@csrf<input type="hidden" name="sala" value="{{ $m['id'] }}"><button type="submit">Restaurar</button></form>
                        @else
                            <form method="POST" action="{{ route('moderacion.ocultar', $c['id']) }}">@csrf<input type="hidden" name="sala" value="{{ $m['id'] }}"><button type="submit" class="danger">Ocultar</button></form>
                        @endif
                        @if ($c['reports'] > 0)
                            <form method="POST" action="{{ route('moderacion.descartar', $c['id']) }}">@csrf<input type="hidden" name="sala" value="{{ $m['id'] }}"><button type="submit">Descartar reportes</button></form>
                        @endif
                    </div>
                </article>
            @empty
                <p class="empty">Nadie escribió en esta sala.</p>
            @endforelse
            <p class="note">Todo lo que hagas acá queda registrado, igual que en la <a href="{{ route('moderacion') }}">moderación del chat</a>.</p>
        </section>
    </main>
</body>
</html>
