<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Moderación — Formosa Tycoon</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    @vite(['resources/css/moderacion.css'])
</head>
<body>
    <main class="mod">
        <header>
            <h1>Moderación del chat</h1>
            <span><a href="{{ route('moderacion.salas') }}">Salas y partidas</a> · <a href="{{ route('moderacion.mapa') }}">Datos del mapa</a> · <a href="{{ route('mapa') }}">← Volver al lobby</a></span>
        </header>

        @if (session('ok'))<p class="flash ok" role="status">{{ session('ok') }}</p>@endif
        @if ($errors->any())<p class="flash bad" role="alert">{{ $errors->first() }}</p>@endif
        @if (session('error'))<p class="flash bad" role="alert">{{ session('error') }}</p>@endif

        <section aria-labelledby="h-rep">
            <h2 id="h-rep">Mensajes reportados y ocultos</h2>
            @forelse ($queue['reports'] as $r)
                <article class="card {{ $r['hidden'] ? 'is-hidden' : '' }}">
                    <p class="meta">
                        <strong>{{ $r['author'] }}</strong> · {{ $r['match_id'] === null ? 'Chat global' : 'Sala (partida #'.$r['match_id'].')' }} · {{ $r['at'] }} ·
                        <b>{{ $r['reports'] }}</b> {{ $r['reports'] === 1 ? 'reporte' : 'reportes' }}
                        @if ($r['reports'] > 0)({{ collect($r['reasons'])->map(fn ($n, $k) => (config('formosa.chat.report_reasons')[$k] ?? $k).' '.$n)->implode(', ') }})@endif
                        @if ($r['new_accounts'] > 0)· <span class="tag">{{ $r['new_accounts'] }} de cuentas nuevas</span>@endif
                        @if ($r['hidden'])· <span class="tag">oculto{{ $r['hidden_reason'] === 'reportes' ? ' por reportes' : '' }}</span>@endif
                    </p>
                    <p class="body">{{ $r['body'] }}</p>
                    <div class="actions">
                        @if ($r['hidden'])
                            <form method="POST" action="{{ route('moderacion.restaurar', $r['id']) }}">@csrf<button type="submit">Restaurar</button></form>
                        @else
                            <form method="POST" action="{{ route('moderacion.ocultar', $r['id']) }}">@csrf<button type="submit" class="danger">Ocultar</button></form>
                        @endif
                        <form method="POST" action="{{ route('moderacion.descartar', $r['id']) }}">@csrf<button type="submit">Descartar reportes</button></form>
                        <form method="POST" action="{{ route('moderacion.silenciar', $r['user_id']) }}" class="inline">
                            @csrf
                            <label class="sr-only" for="min-{{ $r['id'] }}">Duración del silencio</label>
                            <select id="min-{{ $r['id'] }}" name="minutos">
                                @foreach ($durations as $m)
                                    <option value="{{ $m }}">{{ $m < 60 ? $m.' min' : ($m < 1440 ? ($m / 60).' h' : ($m / 1440).' d') }}</option>
                                @endforeach
                            </select>
                            <button type="submit" class="danger">Silenciar a {{ $r['author'] }}</button>
                        </form>
                    </div>
                </article>
            @empty
                <p class="empty">No hay mensajes reportados ni ocultos.</p>
            @endforelse
        </section>

        <section aria-labelledby="h-mut">
            <h2 id="h-mut">Silencios vigentes</h2>
            @forelse ($queue['mutes'] as $m)
                <article class="card row">
                    <p class="meta"><strong>{{ $m['player'] }}</strong> hasta {{ $m['expires_at'] }} · por {{ $m['moderator'] }}@if ($m['reason']) · {{ $m['reason'] }}@endif</p>
                    <form method="POST" action="{{ route('moderacion.quitar-silencio', $m['user_id']) }}">@csrf<button type="submit">Levantar</button></form>
                </article>
            @empty
                <p class="empty">Nadie está silenciado.</p>
            @endforelse
        </section>

        <p class="note">Los mensajes con {{ config('formosa.chat.auto_hide_reports') }} reportes de jugadores distintos se ocultan solos hasta que los revises. Restaurar un mensaje descarta sus reportes y ya no se vuelve a ocultar solo. Solo cuentan para eso los reportes de cuentas con más de {{ config('formosa.chat.auto_hide_min_age_hours') }} h de antigüedad. Todo lo que hagas queda registrado.</p>
    </main>
</body>
</html>
