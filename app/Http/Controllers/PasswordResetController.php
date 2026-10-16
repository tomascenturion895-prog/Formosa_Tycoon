<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Auth\Events\PasswordReset;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\Password as PasswordRule;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;

/**
 * "Olvidé mi contraseña": enlace de un solo uso por correo (vence en 60 min, ver config/auth.php).
 * Siempre responde lo mismo exista o no la cuenta, así no sirve para averiguar qué correos están registrados.
 */
class PasswordResetController extends Controller
{
    public function request(): View
    {
        return view('auth.olvide');
    }

    public function send(Request $request): RedirectResponse
    {
        $request->merge(['email' => Str::lower(trim((string) $request->input('email')))]);
        $request->validate(['email' => ['required', 'string', 'email', 'max:254']]);

        // El resultado (enviado, no existe, demasiado seguido) no se le cuenta a quien pide: mismo mensaje siempre.
        rescue(fn () => Password::sendResetLink(['email' => $request->input('email')]), report: true);

        return back()->with('ok', 'Si hay una cuenta con ese correo, te mandamos un enlace para elegir una contraseña nueva. Revisá también el correo no deseado.');
    }

    public function edit(Request $request, string $token): View
    {
        return view('auth.restablecer', ['token' => $token, 'email' => (string) $request->query('email', '')]);
    }

    public function update(Request $request): RedirectResponse
    {
        $request->merge(['email' => Str::lower(trim((string) $request->input('email')))]);
        $data = $request->validate([
            'token' => ['required', 'string', 'max:200'],
            'email' => ['required', 'string', 'email', 'max:254'],
            'password' => ['required', 'string', 'confirmed', PasswordRule::defaults()],
        ]);

        $status = Password::reset($data, function (User $user, string $password) {
            $user->forceFill(['password' => Hash::make($password), 'remember_token' => Str::random(60)])->save();
            event(new PasswordReset($user));
        });

        if ($status !== Password::PASSWORD_RESET) {
            throw ValidationException::withMessages(['email' => 'El enlace no es válido o ya venció. Pedí uno nuevo.']);
        }

        return redirect()->route('login')->with('ok', 'Listo: ya podés ingresar con tu contraseña nueva.');
    }
}
