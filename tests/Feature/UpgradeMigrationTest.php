<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\Support\PlaysMatches;
use Tests\TestCase;

/** Columnas de mejora en match_properties y movimiento "mejora" en el libro. Las restricciones CHECK solo existen en MariaDB/MySQL/PostgreSQL. */
class UpgradeMigrationTest extends TestCase
{
    use PlaysMatches, RefreshDatabase;

    private function ownedRow(): array
    {
        $ana = User::factory()->create();
        $match = $this->startedMatch([$ana]);
        $p = $this->makeProperty();
        DB::table('match_properties')->insert(['match_id' => $match->id, 'property_id' => $p->id, 'owner_id' => $ana->id, 'bought_at' => now(), 'price_paid' => 100]);

        return ['match_id' => $match->id, 'property_id' => $p->id, 'user_id' => $ana->id];
    }

    private function requireChecks(): void
    {
        if (! in_array(DB::getDriverName(), ['mysql', 'mariadb', 'pgsql'], true)) {
            $this->markTestSkipped('Las restricciones CHECK no existen en '.DB::getDriverName().'.');
        }
    }

    private function setRow(array $row, array $values): void
    {
        DB::table('match_properties')->where('match_id', $row['match_id'])->where('property_id', $row['property_id'])->update($values);
    }

    public function test_las_filas_nuevas_arrancan_en_nivel_cero(): void
    {
        $this->assertTrue(Schema::hasColumns('match_properties', ['level', 'branch', 'upgrade_paid']));
        $row = $this->ownedRow();
        $r = DB::table('match_properties')->where('match_id', $row['match_id'])->first();
        $this->assertSame([0, null, 0], [(int) $r->level, $r->branch, (int) $r->upgrade_paid]);
    }

    public function test_nivel_dos_con_rama_y_pago_es_valido(): void
    {
        $row = $this->ownedRow();
        $this->setRow($row, ['level' => 2, 'branch' => 'b', 'upgrade_paid' => 500]);
        $this->assertSame('b', DB::table('match_properties')->where('match_id', $row['match_id'])->value('branch'));
    }

    public function test_nivel_dos_sin_rama_es_rechazado_por_la_base(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        $this->expectException(QueryException::class);
        $this->setRow($row, ['level' => 2, 'branch' => null, 'upgrade_paid' => 500]);
    }

    public function test_nivel_uno_con_rama_es_rechazado(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        $this->expectException(QueryException::class);
        $this->setRow($row, ['level' => 1, 'branch' => 'a', 'upgrade_paid' => 500]);
    }

    public function test_nivel_con_upgrade_paid_cero_es_rechazado(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        $this->expectException(QueryException::class);
        $this->setRow($row, ['level' => 1, 'branch' => null, 'upgrade_paid' => 0]);
    }

    public function test_nivel_mayor_a_dos_es_rechazado(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        $this->expectException(QueryException::class);
        $this->setRow($row, ['level' => 3, 'branch' => 'a', 'upgrade_paid' => 500]);
    }

    public function test_el_libro_acepta_mejora_negativa_con_propiedad(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        DB::table('ledger_entries')->insert(['match_id' => $row['match_id'], 'user_id' => $row['user_id'], 'type' => 'mejora', 'amount' => -50, 'balance_after' => 1, 'property_id' => $row['property_id'], 'created_at' => now()]);
        $this->assertSame(1, DB::table('ledger_entries')->where('type', 'mejora')->count());
    }

    public function test_el_libro_rechaza_mejora_positiva(): void
    {
        $this->requireChecks();
        $row = $this->ownedRow();
        $this->expectException(QueryException::class);
        DB::table('ledger_entries')->insert(['match_id' => $row['match_id'], 'user_id' => $row['user_id'], 'type' => 'mejora', 'amount' => 50, 'balance_after' => 1, 'property_id' => $row['property_id'], 'created_at' => now()]);
    }
}
