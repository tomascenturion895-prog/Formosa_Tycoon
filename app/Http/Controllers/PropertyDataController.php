<?php

namespace App\Http\Controllers;

use App\Economy\GameException;
use App\Economy\PropertyCorrectionService;
use App\Enums\PropertyKind;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\View\View;

/**
 * Datos del mapa desactualizados. Avisar lo puede hacer cualquier jugador con sesión; corregir y revisar, solo los moderadores
 * (el middleware `moderador` en las rutas, y el servicio lo vuelve a comprobar).
 */
class PropertyDataController extends Controller
{
    public function __construct(private readonly PropertyCorrectionService $data) {}

    public function report(Request $request, int $property): JsonResponse
    {
        $input = $request->validate([
            'motivo' => ['required', 'string', Rule::in(array_keys(config('formosa.data.report_reasons')))],
            'nota' => ['nullable', 'string', 'max:140'],
        ]);

        $r = $this->data->report($request->user(), $property, $input['motivo'], $input['nota'] ?? null);

        return response()->json(['ok' => true] + $r)->header('Cache-Control', 'no-store, private');
    }

    public function page(): View
    {
        return view('moderacion-mapa', [
            'queue' => $this->data->queue(),
            'edits' => $this->data->recentEdits(),
            'kinds' => collect(PropertyKind::cases())->mapWithKeys(fn (PropertyKind $k) => [$k->value => $k->label()])->all(),
            'reasons' => config('formosa.data.report_reasons'),
        ]);
    }

    public function details(int $property): JsonResponse
    {
        return response()->json($this->data->details($property))->header('Cache-Control', 'no-store, private');
    }

    public function correct(Request $request, int $property)
    {
        $input = $request->validate([
            'rubro' => ['required', 'string', Rule::in(PropertyKind::values())],
            'nombre' => ['nullable', 'string', 'max:120'],
            'motivo' => ['nullable', 'string', 'max:120'],
        ]);

        $result = null;
        $response = $this->act($request, 'Propiedad corregida.', function () use ($request, $property, $input, &$result) {
            $result = $this->data->correct($request->user(), $property, PropertyKind::from($input['rubro']), $input['nombre'] ?? null, $input['motivo'] ?? null);
        });

        return $response instanceof JsonResponse ? $response->setData(['ok' => true] + $result) : $response;
    }

    public function dismiss(Request $request, int $property)
    {
        return $this->act($request, 'Avisos descartados.', fn () => $this->data->dismissReports($request->user(), $property));
    }

    /** Ejecuta la acción y responde según quién llamó: JSON para el mapa, redirección con aviso para la página. */
    private function act(Request $request, string $done, Closure $action): JsonResponse|RedirectResponse
    {
        try {
            $action();
        } catch (GameException $e) {
            if ($request->expectsJson()) {
                throw $e;
            }

            return redirect()->route('moderacion.mapa')->with('error', $e->getMessage());
        }

        return $request->expectsJson()
            ? response()->json(['ok' => true])->header('Cache-Control', 'no-store, private')
            : redirect()->route('moderacion.mapa')->with('ok', $done);
    }
}
