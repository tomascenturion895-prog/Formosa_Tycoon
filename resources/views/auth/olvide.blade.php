@extends('layouts.auth')

@section('titulo', 'Recuperar contraseña')

@section('contenido')
    @if (session('ok'))<p class="ok" role="status">{{ session('ok') }}</p>@endif
    <form method="POST" action="{{ route('password.email') }}" novalidate>
        @csrf
        <p class="ayuda">Escribí el correo con el que te registraste y te mandamos un enlace para elegir una contraseña nueva.</p>
        <label for="email">Correo</label>
        <input id="email" name="email" type="email" value="{{ old('email') }}" required autocomplete="email" autofocus
               @error('email') aria-describedby="email-error" @enderror>
        @error('email')<p id="email-error" class="error" role="alert">{{ $message }}</p>@enderror
        <button type="submit">Enviar enlace</button>
    </form>
@endsection

@section('alternativa')
    ¿Te acordaste? <a href="{{ route('login') }}">Ingresá</a>
@endsection
