<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Datos del mapa — Formosa Tycoon</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    @vite(['resources/css/moderacion.css'])
</head>
<body>
    <main class="mod">
        <header>
            <h1>Datos del mapa desactualizados</h1>
            <span><a href="{{ route('moderacion') }}">Moderación del chat</a> · <a href="{{ route('moderacion.salas') }}">Salas y partidas</a> · <a href="{{ route('mapa') }}">← Volver al lobby</a></span>
        </header>

        @if (session('ok'))<p class="flash ok" role="status">{{ session('ok') }}</p>@endif
        @if ($errors->any())<p class="flash bad" role="alert">{{ $errors->first() }}</p>@endif
        @if (session('error'))<p class="flash bad" role="alert">{{ session('error') }}</p>@endif

        <section aria-labelledby="h-av">
            <h2 id="h-av">Avisos de jugadores</h2>
            @forelse ($queue as $q)
                <article class="card">
                    <p class="meta">
                        <strong>{{ $q['name'] ?? ($kinds[$q['kind']] ?? $q['kind']) }}</strong>
                        ({{ $kinds[$q['kind']] ?? $q['kind'] }}){{ $q['street'] ? ' · '.$q['street'] : '' }}
                        · propiedad #{{ $q['id'] }}
                        · <b>{{ $q['reports'] }}</b> {{ $q['reports'] === 1 ? 'aviso' : 'avisos' }}
                        ({{ collect($q['reasons'])->map(fn ($n, $k) => ($reasons[$k] ?? $k).' '.$n)->implode(', ') }})
                        @if ($q['owned'])· <span class="tag">tiene dueño: cambiar el rubro cambia su ingreso</span>@endif
                    </p>
                    @foreach ($q['notes'] as $note)
                        <p class="body">“{{ $note }}”</p>
                    @endforeach
                    <div class="actions">
                        <a href="{{ route('explorar') }}?p={{ $q['id'] }}">Ver en el mapa</a>
                        <form method="POST" action="{{ route('moderacion.corregir', $q['id']) }}" class="inline">
                            @csrf
                            <input type="hidden" name="rubro" value="casa">
                            <input type="hidden" name="motivo" value="Cerrado">
                            <button type="submit" class="danger">Marcar como cerrado</button>
                        </form>
                        <form method="POST" action="{{ route('moderacion.corregir', $q['id']) }}" class="inline">
                            @csrf
                            <label class="sr-only" for="rub-{{ $q['id'] }}">Rubro</label>
                            <select id="rub-{{ $q['id'] }}" name="rubro">
                                @foreach ($kinds as $value => $label)
                                    <option value="{{ $value }}" @selected($value === $q['kind'])>{{ $label }}</option>
                                @endforeach
                            </select>
                            <label class="sr-only" for="nom-{{ $q['id'] }}">Nombre</label>
                            <input id="nom-{{ $q['id'] }}" name="nombre" type="text" maxlength="120" placeholder="Nombre" value="{{ $q['name'] }}">
                            <button type="submit">Guardar</button>
                        </form>
                        <form method="POST" action="{{ route('moderacion.descartar-avisos', $q['id']) }}">@csrf<button type="submit">Está bien, descartar</button></form>
                    </div>
                </article>
            @empty
                <p class="empty">No hay avisos pendientes.</p>
            @endforelse
        </section>

        <section aria-labelledby="h-ed">
            <h2 id="h-ed">Últimas correcciones</h2>
            @forelse ($edits as $e)
                <article class="card row">
                    <p class="meta">
                        #{{ $e['property_id'] }}: {{ $kinds[$e['old_kind']] ?? $e['old_kind'] }}{{ $e['old_name'] ? ' “'.$e['old_name'].'”' : '' }}
                        → <b>{{ $kinds[$e['new_kind']] ?? $e['new_kind'] }}{{ $e['new_name'] ? ' “'.$e['new_name'].'”' : '' }}</b>
                        · {{ $e['source'] === 'osm' ? 're-importación' : ($e['actor'] ?? 'moderador') }} · {{ $e['created_at'] }}@if ($e['reason']) · {{ $e['reason'] }}@endif
                    </p>
                </article>
            @empty
                <p class="empty">Todavía no se corrigió nada.</p>
            @endforelse
        </section>

        <p class="note">Los jugadores solo avisan: un aviso nunca cambia nada solo. Lo que corrijas a mano queda protegido: al volver a importar desde OpenStreetMap no se pisa. Un local cerrado pasa a ser una casa sin nombre. Si la propiedad tiene dueño, antes del cambio se le acredita lo que había acumulado. Todo queda en el historial.</p>
    </main>
</body>
</html>
