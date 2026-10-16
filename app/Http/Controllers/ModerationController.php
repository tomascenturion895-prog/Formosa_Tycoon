<?php

namespace App\Http\Controllers;

use App\Economy\GameException;
use App\Economy\ModerationService;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\View\View;

/**
 * Moderación del chat. Reportar lo puede hacer cualquier jugador; el resto está detrás del middleware `moderador`.
 * Las acciones sirven a dos pantallas: el chat (fetch, responde JSON) y la página /moderacion (formularios, redirige).
 */
class ModerationController extends Controller
{
    public function __construct(private readonly ModerationService $moderation) {}

    public function page(): View
    {
        return view('moderacion', ['queue' => $this->moderation->queue(), 'durations' => config('formosa.chat.mute_minutes')]);
    }

    public function report(Request $request, int $message): JsonResponse
    {
        $data = $request->validate(['motivo' => ['required', 'string', Rule::in(array_keys(config('formosa.chat.report_reasons')))]]);

        $r = $this->moderation->report($request->user(), $message, $data['motivo']);

        return response()->json(['ok' => true] + $r)->header('Cache-Control', 'no-store, private');
    }

    public function hide(Request $request, int $message)
    {
        return $this->act($request, 'Mensaje oculto.', fn () => $this->moderation->hide($request->user(), $message));
    }

    public function restore(Request $request, int $message)
    {
        return $this->act($request, 'Mensaje restaurado.', fn () => $this->moderation->restore($request->user(), $message));
    }

    public function dismiss(Request $request, int $message)
    {
        return $this->act($request, 'Reportes descartados.', fn () => $this->moderation->dismiss($request->user(), $message));
    }

    public function mute(Request $request, int $user)
    {
        $data = $request->validate(['minutos' => ['required', 'integer'], 'motivo' => ['nullable', 'string', 'max:120']]);

        return $this->act($request, 'Jugador silenciado.', fn () => $this->moderation->mute($request->user(), $user, (int) $data['minutos'], $data['motivo'] ?? null));
    }

    public function unmute(Request $request, int $user)
    {
        return $this->act($request, 'Silencio levantado.', fn () => $this->moderation->unmute($request->user(), $user));
    }

    /**
     * Ejecuta la acción y responde según quién llamó: JSON para el chat, redirección con aviso para la página.
     * Si el formulario viene de la ficha de una sala (campo `sala`), vuelve a esa ficha en vez de a la cola de moderación.
     */
    private function act(Request $request, string $done, Closure $action): JsonResponse|RedirectResponse
    {
        $back = fn () => redirect()->to($this->backUrl($request));
        try {
            $action();
        } catch (GameException $e) {
            if ($request->expectsJson()) {
                throw $e;
            }

            return $back()->with('error', $e->getMessage());
        }

        return $request->expectsJson()
            ? response()->json(['ok' => true])->header('Cache-Control', 'no-store, private')
            : $back()->with('ok', $done);
    }

    private function backUrl(Request $request): string
    {
        $room = (string) $request->input('sala', '');

        return ctype_digit($room) && strlen($room) <= 15 ? route('moderacion.sala', (int) $room) : route('moderacion');
    }
}
