<?php

namespace App\Http\Controllers;

use App\Economy\OwnersVersion;
use App\Formosa\EnvironmentStore;
use App\Formosa\MapSnapshot;
use App\Formosa\RoadsStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;

class MapController extends Controller
{
    /**
     * Geometría y datos fijos de todas las propiedades (GeoJSON). Cambia solo al re-importar,
     * así que se cachea; el dueño NO va acá sino en `estado()`, que cambia seguido.
     */
    public function properties(Request $request): Response|JsonResponse
    {
        $etag = MapSnapshot::propertiesEtag();

        $response = response()->json(null)->setEtag($etag)->setPublic()->setMaxAge(60);
        if ($response->isNotModified($request)) {
            return $response;
        }

        // El cuerpo (varios MB con miles de edificios) se arma una vez por cambio de datos y se reparte desde la caché.
        $json = Cache::remember("map.properties.{$etag}", 3600, fn () => MapSnapshot::propertiesJson());

        // Comprimido si el navegador lo acepta (4 MB bajan a ~0,4 MB). Un servidor web delante (Nginx/Apache) puede hacerlo él.
        // El comprimido también se guarda: comprimir 4 MB en cada pedido era lo más caro de esta ruta.
        $gzip = function_exists('gzencode') && str_contains((string) $request->header('Accept-Encoding'), 'gzip');
        $body = $gzip ? Cache::remember("map.properties.gz.{$etag}", 3600, fn () => base64_encode(gzencode($json, 5))) : null;
        $response = response($gzip ? base64_decode($body) : $json, 200, ['Content-Type' => 'application/json'])
            ->setEtag($etag)->setPublic()->setMaxAge(60);
        $response->headers->set('Vary', 'Accept-Encoding');
        if ($gzip) {
            $response->headers->set('Content-Encoding', 'gzip');
        }

        return $response;
    }

    public function roads(Request $request): JsonResponse
    {
        $response = response()->json(RoadsStore::get())->setPublic()->setMaxAge(300);
        if ($modified = RoadsStore::lastModified()) {
            $response->setLastModified(\DateTime::createFromFormat('U', (string) $modified));
        }

        return $response;
    }

    /** Entorno de la ciudad 3D (GeoJSON). Cambia solo al importar: se cachea igual que las calles. */
    public function environment(Request $request): JsonResponse
    {
        $response = response()->json(EnvironmentStore::get(), 200, [], JSON_UNESCAPED_UNICODE)->setPublic()->setMaxAge(300);
        if ($modified = EnvironmentStore::lastModified()) {
            $response->setLastModified(\DateTime::createFromFormat('U', (string) $modified));
        }

        return $response;
    }
}
