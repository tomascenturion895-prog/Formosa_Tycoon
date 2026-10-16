<?php

namespace App\Http\Controllers;

use Illuminate\Foundation\Auth\EmailVerificationRequest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Confirmación de correo (solo se usa si FORMOSA_VERIFICAR_EMAIL=true). */
class VerificationController extends Controller
{
    public function notice(Request $request): View|RedirectResponse
    {
        if ($request->user()->hasVerifiedEmail()) {
            return redirect()->route('mapa');
        }

        return view('auth.verificar', ['email' => $request->user()->email]);
    }

    /** El enlace del correo (firmado y con vencimiento). */
    public function verify(EmailVerificationRequest $request): RedirectResponse
    {
        $request->fulfill();

        return redirect()->route('mapa');
    }

    public function resend(Request $request): RedirectResponse
    {
        if (! $request->user()->hasVerifiedEmail()) {
            rescue(fn () => $request->user()->sendEmailVerificationNotification(), report: true);
        }

        return back()->with('estado', 'Te mandamos un enlace nuevo. Revisá también la carpeta de spam.');
    }
}
