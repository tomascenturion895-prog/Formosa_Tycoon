<?php

namespace App\Economy;

use App\Events\PropertyCorrected;
use App\Formosa\Pricing;
use App\Formosa\TextClean;
use App\Enums\PropertyKind;
use App\Models\Auction;
use App\Models\Property;
use App\Models\PropertyEdit;
use App\Models\PropertyReport;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Datos del mapa desactualizados: avisos de jugadores y correcciones de moderadores.
 *
 * Reglas:
 *  - Los jugadores solo AVISAN (un aviso por jugador y propiedad, con tope de avisos abiertos). Un aviso no cambia nada:
 *    así nadie puede manipular el mapa con cuentas falsas.
 *  - Solo un moderador corrige. Toda corrección queda en `property_edits` (qué había, qué quedó, quién, por qué) y marca la
 *    propiedad como "corregida a mano": la re-importación de OpenStreetMap ya no le pisa rubro, nombre ni precio.
 *  - Corregir cambia precio e ingreso (salen del rubro). Si la propiedad tiene dueño en alguna partida en juego, antes se le
 *    acredita a cada dueño lo acumulado AL INGRESO VIEJO, así nadie pierde (ni gana) plata por el cambio de tarifa a mitad de camino.
 *  - No se corrige una propiedad reservada o en subasta: los jugadores están pujando por el precio que ven.
 *  - Orden de bloqueos: propiedad y después, para acreditar a los dueños, partida y jugador (un cruce raro con el cierre de una
 *    partida lo resuelve el reintento de la transacción).
 *  - El aviso en vivo sale después de confirmar y, si Reverb está caído, no rompe la corrección.
 */
class PropertyCorrectionService
{
    public function __construct(private readonly EconomyService $economy) {}

    /**
     * Corrige rubro y nombre de una propiedad. Idempotente: repetir la misma corrección no cambia ni avisa de nuevo.
     *
     * @return array{changed: bool, verified: bool, paid: int, property: array<string, mixed>}
     *
     * @throws GameException
     */
    public function correct(User $moderator, int $propertyId, PropertyKind $kind, ?string $name, ?string $reason = null): array
    {
        $this->requireModerator($moderator);
        $name = $kind === PropertyKind::Casa ? null : TextClean::line($name, 120); // las casas no llevan nombre (privacidad)
        $reason = TextClean::line($reason, 120);

        $out = DB::transaction(function () use ($moderator, $propertyId, $kind, $name, $reason) {
            $p = Property::query()->lockForUpdate()->find($propertyId) ?? throw GameException::notFound();
            if (Auction::where('active_property_id', $p->id)->exists()) {
                throw GameException::editLocked();
            }

            $same = $p->kind === $kind && $p->name === $name;
            $firstReview = $p->edited_at === null;
            $paid = 0;
            if (! $same || $firstReview) {
                $paid = $this->apply($p, $kind, $name, $moderator->id, 'moderador', $reason, markEdited: true);
            }
            $this->closeReports($p->id, 'resuelto', $moderator->id);

            $fresh = DB::table('properties')->where('id', $p->id)->first();

            return [
                'changed' => ! $same,
                'verified' => $same && $firstReview,
                'paid' => $paid,
                'property' => ['id' => (int) $fresh->id, 'kind' => $fresh->kind, 'name' => $fresh->name, 'price' => (int) $fresh->price, 'income' => (int) $fresh->income_per_day],
            ];
        }, attempts: 3);

        if ($out['changed']) {
            $this->announce($out['property']);
        }

        return $out;
    }

    /**
     * Cambio de rubro que viene de la re-importación (un local que ya no figura en OpenStreetMap). No marca la propiedad como
     * corregida a mano: la próxima importación puede volver a decidir. Se salta lo reservado/en subasta o ya corregido a mano.
     */
    public function reclassifyFromOsm(int $propertyId, PropertyKind $kind, ?string $name, string $reason): bool
    {
        $name = $kind === PropertyKind::Casa ? null : TextClean::line($name, 120);

        $changed = DB::transaction(function () use ($propertyId, $kind, $name, $reason) {
            $p = Property::query()->lockForUpdate()->find($propertyId);
            if (! $p || $p->edited_at !== null || ($p->kind === $kind && $p->name === $name) || Auction::where('active_property_id', $p->id)->exists()) {
                return null;
            }
            $this->apply($p, $kind, $name, null, 'osm', TextClean::line($reason, 120), markEdited: false);

            return DB::table('properties')->where('id', $p->id)->first();
        }, attempts: 3);

        if ($changed) {
            $this->announce(['id' => (int) $changed->id, 'kind' => $changed->kind, 'name' => $changed->name, 'price' => (int) $changed->price, 'income' => (int) $changed->income_per_day]);
        }

        return $changed !== null;
    }

    /**
     * Acredita al dueño lo acumulado a la tarifa vigente y reinicia el reloj de esa propiedad. La usa el importador antes de
     * cambiar un ingreso. Devuelve cuánto se acreditó (0 si no tiene dueño o no había nada).
     */
    public function settle(int $propertyId): int
    {
        return DB::transaction(function () use ($propertyId) {
            $p = Property::query()->lockForUpdate()->find($propertyId);

            return $p ? $this->economy->settleOwnersOf($p->id) : 0;
        }, attempts: 3);
    }

    /**
     * Aviso de un jugador. Un aviso por jugador y propiedad (repetirlo no suma).
     *
     * @return array{replayed: bool}
     *
     * @throws GameException
     */
    public function report(User $reporter, int $propertyId, string $reason, ?string $note = null): array
    {
        if (! array_key_exists($reason, config('formosa.data.report_reasons'))) {
            throw GameException::invalidReason();
        }
        if (! Property::query()->whereKey($propertyId)->exists()) {
            throw GameException::notFound();
        }
        $max = (int) config('formosa.data.max_open_reports_per_user');
        $already = PropertyReport::query()->where('property_id', $propertyId)->where('reporter_id', $reporter->id)->exists();
        if (! $already && $max > 0 && PropertyReport::query()->where('reporter_id', $reporter->id)->where('status', 'abierto')->count() >= $max) {
            throw GameException::tooManyReports($max);
        }

        try {
            PropertyReport::forceCreate(['property_id' => $propertyId, 'reporter_id' => $reporter->id, 'reason' => $reason, 'note' => TextClean::line($note, 140)]);

            return ['replayed' => false];
        } catch (UniqueConstraintViolationException) {
            return ['replayed' => true];
        }
    }

    /** Descarta los avisos abiertos de una propiedad (los datos estaban bien). */
    public function dismissReports(User $moderator, int $propertyId): int
    {
        $this->requireModerator($moderator);

        return $this->closeReports($propertyId, 'descartado', $moderator->id);
    }

    /**
     * Propiedades con avisos abiertos, las más avisadas primero.
     *
     * @return list<array<string, mixed>>
     */
    public function queue(int $limit = 100): array
    {
        $rows = DB::table('property_reports as r')
            ->join('properties as p', 'p.id', '=', 'r.property_id')
            ->where('r.status', 'abierto')
            ->groupBy('p.id', 'p.kind', 'p.name', 'p.street')
            ->select(['p.id', 'p.kind', 'p.name', 'p.street', DB::raw('COUNT(*) AS n'), DB::raw('MAX(r.created_at) AS last_at')])
            ->orderByDesc('n')->orderByDesc('last_at')->limit($limit)
            ->get();
        if ($rows->isEmpty()) {
            return [];
        }

        $detail = DB::table('property_reports')->where('status', 'abierto')->whereIn('property_id', $rows->pluck('id'))->orderBy('id')->get(['property_id', 'reason', 'note'])->groupBy('property_id');
        // "Con dueño" = lo tiene alguien en una partida que se está jugando ahora.
        $owned = DB::table('match_properties as mp')->join('matches as m', 'm.id', '=', 'mp.match_id')->where('m.status', 'running')
            ->whereIn('mp.property_id', $rows->pluck('id'))->distinct()->pluck('mp.property_id')->flip();

        return $rows->map(function ($r) use ($detail, $owned) {
            $list = $detail->get($r->id, collect());

            return [
                'id' => (int) $r->id,
                'kind' => $r->kind,
                'name' => $r->name,
                'street' => $r->street,
                'owned' => $owned->has($r->id),
                'reports' => (int) $r->n,
                'reasons' => $list->countBy('reason')->all(),
                'notes' => $list->pluck('note')->filter()->unique()->take(4)->values()->all(),
            ];
        })->all();
    }

    /**
     * Lo que ve un moderador al abrir la ficha: avisos abiertos y última corrección.
     *
     * @return array{reports: int, reasons: array<string, int>, notes: list<string>, edited: array<string, mixed>|null}
     */
    public function details(int $propertyId): array
    {
        $open = DB::table('property_reports')->where('property_id', $propertyId)->where('status', 'abierto')->get(['reason', 'note']);
        $last = DB::table('property_edits as e')->leftJoin('users as u', 'u.id', '=', 'e.actor_id')
            ->where('e.property_id', $propertyId)->orderByDesc('e.id')->first(['e.created_at', 'e.source', 'e.reason', 'u.name as actor']);

        return [
            'reports' => $open->count(),
            'reasons' => $open->countBy('reason')->all(),
            'notes' => $open->pluck('note')->filter()->unique()->take(4)->values()->all(),
            'edited' => $last ? ['at' => (string) $last->created_at, 'by' => $last->actor, 'source' => $last->source, 'reason' => $last->reason] : null,
        ];
    }

    /**
     * Últimas correcciones, para la página de revisión.
     *
     * @return list<array<string, mixed>>
     */
    public function recentEdits(int $limit = 20): array
    {
        return DB::table('property_edits as e')->leftJoin('users as u', 'u.id', '=', 'e.actor_id')->join('properties as p', 'p.id', '=', 'e.property_id')
            ->orderByDesc('e.id')->limit($limit)
            ->get(['e.property_id', 'e.source', 'e.old_kind', 'e.new_kind', 'e.old_name', 'e.new_name', 'e.reason', 'e.created_at', 'u.name as actor'])
            ->map(fn ($e) => (array) $e)->all();
    }

    // ------------------------------------------------------------------ internos

    /** Cambia rubro, nombre, precio e ingreso de una propiedad ya bloqueada. Devuelve lo acreditado al dueño. */
    private function apply(Property $p, PropertyKind $kind, ?string $name, ?int $actorId, string $source, ?string $reason, bool $markEdited): int
    {
        ['price' => $price, 'income' => $income] = Pricing::for($kind, (float) $p->area_m2);

        $paid = 0;
        if ($income !== (int) $p->income_per_day) {
            $paid = $this->economy->settleOwnersOf($p->id);
        }

        $now = now()->toDateTimeString();
        $update = ['kind' => $kind->value, 'name' => $name, 'price' => $price, 'income_per_day' => $income, 'updated_at' => $now];
        if ($markEdited) {
            $update += ['edited_at' => $now, 'edited_by' => $actorId];
        }
        DB::table('properties')->where('id', $p->id)->update($update);

        PropertyEdit::forceCreate([
            'property_id' => $p->id, 'actor_id' => $actorId, 'source' => $source,
            'old_kind' => $p->kind->value, 'new_kind' => $kind->value, 'old_name' => $p->name, 'new_name' => $name,
            'old_price' => $p->price, 'new_price' => $price, 'old_income' => $p->income_per_day, 'new_income' => $income,
            'paid_out' => $paid, 'reason' => $reason,
        ]);

        return $paid;
    }

    private function closeReports(int $propertyId, string $status, int $by): int
    {
        return DB::table('property_reports')->where('property_id', $propertyId)->where('status', 'abierto')
            ->update(['status' => $status, 'resolved_by' => $by, 'resolved_at' => now()->toDateTimeString()]);
    }

    /** @param array{id: int, kind: string, name: ?string, price: int, income: int} $p */
    private function announce(array $p): void
    {
        $catalog = OwnersVersion::bumpCatalog();
        rescue(fn () => event(new PropertyCorrected($p['id'], $p['kind'], $p['name'], $p['price'], $p['income'], $catalog)), report: true);
    }

    private function requireModerator(User $user): void
    {
        if (! $user->isModerator()) {
            throw GameException::notModerator();
        }
    }
}
