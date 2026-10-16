@extends('layouts.auth')

@section('titulo', 'Ingresar')

@section('contenido')
    @if (session('ok'))<p class="ok" role="status">{{ session('ok') }}</p>@endif
    <form method="POST" action="{{ route('login.entrar') }}" novalidate>
        @csrf

        <label for="email">Correo</label>
        <input id="email" name="email" type="email" value="{{ old('email') }}" required autocomplete="email" autofocus
               @error('email') aria-describedby="email-error" @enderror>
        @error('email')<p id="email-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">

        <label class="check"><input type="checkbox" name="recordar" value="1"> Mantener la sesión abierta</label>

        <button type="submit">Ingresar</button>
        <p class="ayuda"><a href="{{ route('password.request') }}">¿Olvidaste tu contraseña?</a></p>
    </form>
@endsection

@section('alternativa')
    ¿Primera vez? <a href="{{ route('registro') }}">Creá tu cuenta</a>
@endsection
