<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#1f6feb">
    <title>@yield('titulo') — Formosa Tycoon</title>
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    <link rel="alternate icon" href="{{ asset('favicon.ico') }}" sizes="any">
    @vite(['resources/css/auth.css'])
</head>
<body>
    <main class="auth">
        <a class="auth-brand" href="{{ route('mapa') }}">Formosa Tycoon</a>
        <h1>@yield('titulo')</h1>
        @yield('contenido')
        <p class="auth-alt">@yield('alternativa')</p>
        <p class="auth-alt"><a href="{{ route('mapa') }}">← Volver al lobby</a></p>
    </main>
</body>
</html>
