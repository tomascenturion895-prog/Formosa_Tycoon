@extends('layouts.auth')

@section('titulo', 'Confirmá tu correo')

@section('contenido')
    <p>Te mandamos un enlace a <strong>{{ $email }}</strong>. Abrilo para poder jugar, comprar, pujar y escribir en el chat.</p>
    @if (session('estado'))
        <p class="ok" role="status">{{ session('estado') }}</p>
    @endif
    <form method="POST" action="{{ route('verification.send') }}">
        @csrf
        <button type="submit">Mandar el enlace de nuevo</button>
    </form>
@endsection

@section('alternativa')
    ¿Te equivocaste de correo? Salí desde el mapa y creá la cuenta de nuevo.
@endsection
