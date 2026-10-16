<?php

namespace App\Console\Commands;

use App\Formosa\EnvironmentStore;
use App\Formosa\RoadsStore;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Exporta en un solo JSON lo que hace falta para probar la ciudad 3D con los datos reales: la forma y el tipo de cada
 * propiedad, las calles y el entorno. Sin dueños, saldos ni nada de los jugadores: se puede mandar por correo.
 */
class ExportSample extends Command
{
    protected $signature = 'formosa:exportar-muestra
        {--salida=storage/app/private/formosa/muestra.json : Archivo a escribir (relativo a la carpeta del proyecto)}
        {--distrito= : Solo las propiedades de esta zona (por defecto, todas)}';

    protected $description = 'Exporta propiedades (sin dueños), calles y entorno 3D en un JSON para probar el 3D con la ciudad real';

    public function handle(): int
    {
        $out = (string) $this->option('salida');
        if ($out === '') {
            $this->components->error('Indicá un archivo con --salida.');

            return self::FAILURE;
        }
        $path = $this->isAbsolute($out) ? $out : base_path($out);
        $district = $this->option('distrito') ?: null;

        $query = DB::table('properties')->select(['id', 'kind', 'name', 'area_m2', 'lat', 'lng', 'geometry'])->orderBy('id');
        if ($district !== null) {
            $query->where('district', $district);
        }

        $properties = [];
        foreach ($query->cursor() as $p) {
            $properties[] = [
                'id' => (int) $p->id,
                'kind' => (string) $p->kind,
                'name' => $p->name,
                'area_m2' => (float) $p->area_m2,
                'lat' => (float) $p->lat,
                'lng' => (float) $p->lng,
                'geometry' => json_decode((string) $p->geometry, true),
            ];
        }
        if ($properties === []) {
            $this->components->warn($district !== null ? "No hay propiedades en la zona '{$district}'." : 'No hay propiedades importadas.');
        }

        $sample = [
            'generated_at' => now()->toIso8601String(),
            'district' => $district,
            'properties' => $properties,
            'roads' => RoadsStore::get(),
            'environment' => EnvironmentStore::get(),
        ];

        $dir = dirname($path);
        if (! is_dir($dir) && ! @mkdir($dir, 0775, true) && ! is_dir($dir)) {
            $this->components->error("No se pudo crear la carpeta: {$dir}");

            return self::FAILURE;
        }
        $json = json_encode($sample, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        if (@file_put_contents($path, $json) === false) {
            $this->components->error("No se pudo escribir el archivo: {$path}");

            return self::FAILURE;
        }

        $this->line(sprintf(
            '%d propiedades · %d tramos de calle · %d elementos del entorno',
            count($properties), count($sample['roads']['features'] ?? []), count($sample['environment']['features'] ?? []),
        ));
        $this->components->info(sprintf('Muestra guardada en %s (%s).', realpath($path) ?: $path, $this->size(strlen($json))));

        return self::SUCCESS;
    }

    private function isAbsolute(string $path): bool
    {
        return str_starts_with($path, '/') || str_starts_with($path, '\\') || (bool) preg_match('/^[A-Za-z]:[\\\\\/]/', $path);
    }

    private function size(int $bytes): string
    {
        return $bytes >= 1048576 ? number_format($bytes / 1048576, 1, ',', '.').' MB' : number_format($bytes / 1024, 1, ',', '.').' KB';
    }
}
