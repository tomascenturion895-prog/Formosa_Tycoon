<?php

namespace App\Console\Commands;

use App\Enums\PropertyKind;
use App\Formosa\Pricing;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Vuelve a calcular precio e ingreso por hora de TODAS las propiedades con los números actuales de config/formosa.php,
 * sin volver a bajar nada de OpenStreetMap y sin tocar dueños, saldos ni cobros pendientes.
 * Sirve después de recalibrar la economía (rendimientos, precios base) con datos ya importados.
 */
class RecalculateEconomy extends Command
{
    protected $signature = 'formosa:recalcular-economia {--simular : Cuenta cuántas cambiarían, sin guardar nada}';

    protected $description = 'Recalcula precio e ingreso por hora de las propiedades con los valores actuales de config/formosa.php';

    public function handle(): int
    {
        $dry = (bool) $this->option('simular');
        $changed = 0;
        $total = 0;

        DB::table('properties')->orderBy('id')->select(['id', 'kind', 'area_m2', 'price', 'income_per_day'])->chunkById(1000, function ($rows) use ($dry, &$changed, &$total) {
            foreach ($rows as $r) {
                $total++;
                $kind = PropertyKind::tryFrom($r->kind);
                if ($kind === null) {
                    continue;
                }
                $new = Pricing::for($kind, (float) $r->area_m2);
                if ((int) $r->price === $new['price'] && (int) $r->income_per_day === $new['income']) {
                    continue;
                }
                $changed++;
                if (! $dry) {
                    // updated_at cambia a propósito: el ETag de /api/propiedades depende de él y los mapas deben recargar los precios.
                    DB::table('properties')->where('id', $r->id)->update(['price' => $new['price'], 'income_per_day' => $new['income'], 'updated_at' => now()]);
                }
            }
        });

        $this->components->info(($dry ? 'Cambiarían ' : 'Actualizadas ')."{$changed} de {$total} propiedades.");
        if (! $dry && $changed > 0) {
            $this->line('Los mapas abiertos toman los precios nuevos al recargar la página.');
        }

        return self::SUCCESS;
    }
}
