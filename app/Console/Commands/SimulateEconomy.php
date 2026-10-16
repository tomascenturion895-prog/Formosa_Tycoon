<?php

namespace App\Console\Commands;

use App\Economy\EconomySimulator;
use App\Enums\PropertyKind;
use App\Formosa\DemoDistrict;
use App\Formosa\Pricing;
use App\Formosa\PropertyBuilder;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class SimulateEconomy extends Command
{
    protected $signature = 'formosa:simular-economia
        {--partidas=30 : Cantidad de partidas a simular}
        {--sillas=pasivo,pasivo,casas,casas,reinvertidor,reinvertidor,mixto,mixto : Estrategia de cada jugador, separadas por coma (2 a 8)}
        {--dinero-inicial= : Dinero inicial (por defecto, el de config)}
        {--minutos-por-dia= : Minutos reales por día de juego (por defecto, el de config)}
        {--duracion= : Minutos reales de la partida (por defecto, el de config)}
        {--escala=1 : Multiplica el ingreso de todas las propiedades}
        {--semilla=1 : Semilla del azar: misma semilla, mismo resultado}
        {--sin-eventos : Simular sin los eventos de la partida}
        {--sin-combos : Simular sin los combos de zona y variedad}
        {--demo : Usar el barrio de ejemplo aunque haya datos importados}';

    protected $description = 'Simula partidas de 40 minutos con jugadores ficticios para calibrar dinero inicial y rendimientos';

    public function handle(): int
    {
        $props = ! $this->option('demo') && DB::table('properties')->exists() ? $this->dbRows() : $this->demoRows();
        $scale = (float) $this->option('escala');
        $props = array_map(fn ($r) => ['income' => (int) round($r['income'] * $scale)] + $r, $props);

        $seats = array_values(array_filter(array_map('trim', explode(',', (string) $this->option('sillas')))));
        $unknown = array_diff($seats, array_keys(EconomySimulator::STRATEGIES));
        if ($unknown !== [] || count($seats) < 2 || count($seats) > 8) {
            $this->components->error('--sillas necesita entre 2 y 8 estrategias de: '.implode(', ', array_keys(EconomySimulator::STRATEGIES)));

            return self::FAILURE;
        }

        $start = (int) ($this->option('dinero-inicial') ?: config('formosa.match.start_cash'));
        $mpd = (float) ($this->option('minutos-por-dia') ?: config('formosa.match.minutes_per_day'));
        $duration = (float) ($this->option('duracion') ?: config('formosa.match.duration_minutes'));
        $matches = max(1, (int) $this->option('partidas'));
        $opts = ['start_cash' => $start, 'seconds_per_day' => (int) round($mpd * 60), 'duration_seconds' => (int) round($duration * 60), 'seed' => (int) $this->option('semilla'), 'events' => ! $this->option('sin-eventos'), 'combos' => ! $this->option('sin-combos')];

        $r = EconomySimulator::summarize($props, $seats, $matches, $opts);

        $this->components->info(sprintf(
            '%d propiedades · %d partidas · %d jugadores · inicial $%s · %s min (%s días de %s min)',
            count($props), $matches, count($seats), number_format($start, 0, ',', '.'), $duration, round($duration / $mpd, 1), $mpd,
        ));
        $this->table(
            ['Estrategia', 'Jugadores', 'Patrimonio prom.', 'Mín.', 'Máx.', 'Propiedades', 'Ingreso/día', 'Puesto prom.', 'Puntos prom.', 'Victorias'],
            array_map(fn ($x) => [$x['strategy'], $x['players'], $this->n($x['net_worth']), $this->n($x['min']), $this->n($x['max']), $x['properties'], $this->n($x['income_per_day']), $x['rank'], $x['points'], $x['wins']], $r['rows']),
        );
        $this->line("Propiedades libres al final: {$r['free_pct']} %");

        $worth = array_column($r['rows'], 'net_worth', 'strategy');
        foreach (['reinvertidor', 'mixto', 'casas'] as $s) {
            if (isset($worth[$s], $worth['pasivo']) && $worth['pasivo'] > 0) {
                $this->line(sprintf('Relación %s / pasivo: x%s', $s, round($worth[$s] / $worth['pasivo'], 2)));
            }
        }

        $days = array_keys(reset($r['timeline']) ?: []);
        if ($days !== []) {
            $step = max(1, (int) ceil(count($days) / 10));
            $shown = array_values(array_filter($days, fn ($d, $i) => $i % $step === 0 || $d === end($days), ARRAY_FILTER_USE_BOTH));
            $this->line('Patrimonio promedio por día de juego:');
            $this->table(
                array_merge(['Estrategia'], array_map(fn ($d) => "día {$d}", $shown)),
                array_map(fn ($s) => array_merge([$s], array_map(fn ($d) => $this->n($r['timeline'][$s][$d]), $shown)), array_keys($r['timeline'])),
            );
        }

        return self::SUCCESS;
    }

    private function n(int|float $v): string
    {
        return number_format($v, 0, ',', '.');
    }

    /** Los precios guardados pueden ser viejos: se recalculan con las reglas de hoy (tipo + superficie). */
    private function dbRows(): array
    {
        return DB::table('properties')->get(['kind', 'area_m2', 'lat', 'lng'])->map(function ($r) {
            $p = Pricing::for(PropertyKind::from($r->kind), $r->area_m2 !== null ? (float) $r->area_m2 : null);

            return ['price' => $p['price'], 'income' => $p['income'], 'kind' => $r->kind, 'lat' => (float) $r->lat, 'lng' => (float) $r->lng];
        })->all();
    }

    /** @return list<array{price: int, income: int, kind: string}> */
    private function demoRows(): array
    {
        $demo = DemoDistrict::elements(config('formosa.center.lat'), config('formosa.center.lng'));
        $built = PropertyBuilder::build($demo['buildings'], 'demo');

        return array_map(fn ($r) => ['price' => $r['price'], 'income' => $r['income_per_day'], 'kind' => $r['kind'], 'lat' => (float) $r['lat'], 'lng' => (float) $r['lng']], $built['rows']);
    }
}
