@extends('layouts.auth')

@section('titulo', 'Crear cuenta')

@section('contenido')
    <form method="POST" action="{{ route('registro.guardar') }}" novalidate>
        @csrf
        @if (config('formosa.auth.antibot'))
            {{-- Trampa para bots: una persona no ve este campo; si llega con algo escrito, no es una persona. --}}
            <div class="trampa" aria-hidden="true">
                <label for="sitio_web">No completes este campo</label>
                <input id="sitio_web" name="sitio_web" type="text" tabindex="-1" autocomplete="off" value="">
            </div>
            <input type="hidden" name="_ft" value="{{ $formToken }}">
        @endif
        @error('formulario')<p class="error" role="alert">{{ $message }}</p>@enderror

        <label for="name">Apodo</label>
        <input id="name" name="name" type="text" value="{{ old('name') }}" required minlength="3" maxlength="24"
               autocomplete="nickname" aria-describedby="name-ayuda @error('name') name-error @enderror" autofocus>
        <p id="name-ayuda" class="ayuda">Es lo que verán los demás como dueño de tus propiedades. No uses tu nombre real.</p>
        @error('name')<p id="name-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="email">Correo</label>
        <input id="email" name="email" type="email" value="{{ old('email') }}" required autocomplete="email"
               @error('email') aria-describedby="email-error" @enderror>
        @error('email')<p id="email-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password"
               aria-describedby="password-ayuda @error('password') password-error @enderror">
        <p id="password-ayuda" class="ayuda">Al menos 8 caracteres, con letras y números.</p>
        @error('password')<p id="password-error" class="error" role="alert">{{ $message }}</p>@enderror

        <label for="password_confirmation">Repetir contraseña</label>
        <input id="password_confirmation" name="password_confirmation" type="password" required autocomplete="new-password">

        <button type="submit">Crear cuenta y recibir el dinero inicial</button>
    </form>
@endsection

@section('alternativa')
    ¿Ya tenés cuenta? <a href="{{ route('login') }}">Ingresá</a>
@endsection
