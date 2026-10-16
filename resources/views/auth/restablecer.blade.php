@extends('layouts.auth')

@section('titulo', 'Contraseña nueva')

@section('contenido')
    <form method="POST" action="{{ route('password.update') }}" novalidate>
        @csrf
        <input type="hidden" name="token" value="{{ $token }}">

        <label for="email">Correo</label>
        <input id="email" name="email" type="email" value="{{ old('email', $email) }}" required autocomplete="email"
               @error('email') aria-describedby="email-error" @enderror>
        @error('email')<p id="email-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="password">Contraseña nueva</label>
        <input id="password" name="password" type="password" required autocomplete="new-password" aria-describedby="password-ayuda @error('password') password-error @enderror">
        <p id="password-ayuda" class="ayuda">Al menos 8 caracteres, con letras y números.</p>
        @error('password')<p id="password-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="password_confirmation">Repetir contraseña</label>
        <input id="password_confirmation" name="password_confirmation" type="password" required autocomplete="new-password">

        <button type="submit">Guardar contraseña</button>
    </form>
@endsection
