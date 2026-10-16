<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Illuminate\Validation\Rules\Password;
use Illuminate\View\View;

class AuthController extends Controller
{
    public function showRegister(): View
    {
        // Marca de cuándo se abrió el formulario (cifrada: no se puede inventar). Un bot que lo manda al instante, no pasa.
        return view('auth.registro', ['formToken' => Crypt::encryptString((string) time())]);
    }

    public function register(Request $request): RedirectResponse
    {
        $this->rejectBots($request);
        // Se normaliza ANTES de validar, para que "unique" compare lo mismo que se va a guardar en cualquier motor de base.
        $this->normalizeEmail($request);
        $this->normalizeName($request);
        $data = $request->validate([
            // El apodo se ve públicamente (es el "dueño" en el mapa): letras LATINAS (con acentos y ñ), números y algunos
            // signos, sin HTML. Se excluyen otros alfabetos para que nadie se haga pasar por otro con letras parecidas.
            'name' => [
                'required', 'string', 'min:3', 'max:24', 'regex:/^[\p{Latin}0-9][\p{Latin}0-9 ._-]*$/u',
                // Sin distinguir mayúsculas: "ana" y "Ana" son el mismo apodo (la base de datos puede no distinguirlas).
                fn ($attr, $value, $fail) => User::whereRaw('LOWER(name) = ?', [mb_strtolower($value)])->exists()
                    ? $fail(__('validation.unique', ['attribute' => __('validation.attributes.name')]))
                    : null,
            ],
            'email' => ['required', 'string', 'email', 'max:254', 'unique:users,email'],
            'password' => ['required', 'string', 'confirmed', Password::defaults()],
        ]);

        try {
            $user = User::create(['name' => $data['name'], 'email' => $data['email'], 'password' => $data['password']]); // la clave se hashea en el modelo
        } catch (UniqueConstraintViolationException) {
            // Dos registros simultáneos con el mismo apodo o correo: la base frenó al segundo. Es un error de formulario, no un 500.
            throw ValidationException::withMessages(['name' => __('validation.unique', ['attribute' => __('validation.attributes.name')])]);
        }
        // El dinero ya no se entrega al registrarse: cada jugador recibe el inicial al empezar cada partida (MatchService::start).

        Auth::login($user);
        $request->session()->regenerate();
        // Si la verificación está activa, sale el correo con el enlace; un fallo del correo no debe impedir registrarse.
        rescue(fn () => $user->sendEmailVerificationNotification(), report: true);

        return redirect()->route($user->hasVerifiedEmail() ? 'mapa' : 'verification.notice');
    }

    public function showLogin(): View
    {
        return view('auth.ingresar');
    }

    public function login(Request $request): RedirectResponse
    {
        $this->normalizeEmail($request);
        $credentials = $request->validate([
            'email' => ['required', 'string', 'email', 'max:254'],
            'password' => ['required', 'string', 'max:255'],
        ]);

        // Límite por correo + IP: frena adivinar contraseñas sin dejar afuera a todo un colegio detrás de una misma IP.
        $key = $credentials['email'].'|'.$request->ip();
        // Y un tope por cuenta desde cualquier IP: frena a quien prueba contraseñas contra una cuenta usando muchas IP.
        $accountKey = 'login-cuenta|'.$credentials['email'];
        foreach ([[$key, 5], [$accountKey, 30]] as [$k, $max]) {
            if (RateLimiter::tooManyAttempts($k, $max)) {
                throw ValidationException::withMessages([
                    'email' => trans('auth.throttle', ['seconds' => RateLimiter::availableIn($k)]),
                ]);
            }
        }

        if (! Auth::attempt(['email' => $credentials['email'], 'password' => $credentials['password']], $request->boolean('recordar'))) {
            RateLimiter::hit($key, 60);
            RateLimiter::hit($accountKey, 3600);
            // Mismo mensaje exista o no el correo: no se revela qué cuentas hay.
            throw ValidationException::withMessages(['email' => trans('auth.failed')]);
        }

        RateLimiter::clear($key);
        $request->session()->regenerate();

        return redirect()->intended(route('mapa'));
    }

    public function logout(Request $request): RedirectResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect()->route('mapa');
    }

    /** Campo trampa lleno, o formulario enviado demasiado rápido / demasiado tarde / sin marca: se rechaza con un mensaje genérico. */
    private function rejectBots(Request $request): void
    {
        if (! config('formosa.auth.antibot')) {
            return;
        }
        $fail = fn (string $why) => throw ValidationException::withMessages(['formulario' => $why]);

        if ((string) $request->input('sitio_web', '') !== '') {
            $fail('No pudimos crear la cuenta. Probá de nuevo.');
        }
        try {
            $openedAt = (int) Crypt::decryptString((string) $request->input('_ft', ''));
        } catch (DecryptException) {
            $fail('El formulario venció. Volvé a intentar.');
        }
        $age = time() - $openedAt;
        if ($age < (int) config('formosa.auth.min_form_seconds')) {
            $fail('Fue muy rápido. Esperá un instante y enviá de nuevo.');
        }
        if ($age > (int) config('formosa.auth.max_form_seconds')) {
            $fail('El formulario venció. Volvé a intentar.');
        }
    }

    private function normalizeEmail(Request $request): void
    {
        if (is_string($request->input('email'))) {
            $request->merge(['email' => Str::lower(trim($request->input('email')))]);
        }
    }

    private function normalizeName(Request $request): void
    {
        $name = $request->input('name');
        if (is_string($name)) {
            $name = trim(preg_replace('/\s+/u', ' ', $name));
            if (class_exists(\Normalizer::class)) {
                $name = \Normalizer::normalize($name, \Normalizer::FORM_KC) ?: $name; // "Ａｄｍｉｎ" (ancho completo) pasa a "Admin": no se puede imitar a otro con letras equivalentes
            }
            $request->merge(['name' => $name]);
        }
    }
}
