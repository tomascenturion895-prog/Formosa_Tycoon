<?php

namespace Tests\Unit;

use App\Economy\MatchScoring;
use PHPUnit\Framework\TestCase;

class MatchScoringTest extends TestCase
{
    private array $cfg = ['places' => [1 => 100, 2 => 60, 3 => 35], 'other' => 15, 'property_bonus' => 1, 'property_bonus_cap' => 20];

    private function f(int $id, int $worth, int $props = 0): array
    {
        return ['user_id' => $id, 'net_worth' => $worth, 'properties' => $props];
    }

    public function test_puntos_por_puesto(): void
    {
        $r = MatchScoring::score([$this->f(1, 500), $this->f(2, 400), $this->f(3, 300), $this->f(4, 200), $this->f(5, 100)], $this->cfg);

        $this->assertSame([1, 2, 3, 4, 5], array_column($r, 'rank'));
        $this->assertSame([100, 60, 35, 15, 15], array_column($r, 'points'));
    }

    public function test_el_orden_de_entrada_no_importa(): void
    {
        $r = MatchScoring::score([$this->f(7, 100), $this->f(3, 900), $this->f(5, 500)], $this->cfg);

        $this->assertSame(1, $r[3]['rank']);
        $this->assertSame(2, $r[5]['rank']);
        $this->assertSame(3, $r[7]['rank']);
    }

    public function test_bonus_por_propiedad_con_tope(): void
    {
        $r = MatchScoring::score([$this->f(1, 500, 5), $this->f(2, 400, 50)], $this->cfg);

        $this->assertSame(105, $r[1]['points']);
        $this->assertSame(80, $r[2]['points']); // 60 + tope de 20
        $this->assertSame(20, $r[2]['bonus']);
    }

    public function test_empate_comparte_puesto_y_reparte_los_puntos_hacia_abajo(): void
    {
        $r = MatchScoring::score([$this->f(1, 500), $this->f(2, 500), $this->f(3, 100)], $this->cfg);

        $this->assertSame(1, $r[1]['rank']);
        $this->assertSame(1, $r[2]['rank']);
        $this->assertSame(80, $r[1]['points']); // (100 + 60) / 2
        $this->assertSame(80, $r[2]['points']);
        $this->assertSame(3, $r[3]['rank']);    // puesto de competición: 1, 1, 3
        $this->assertSame(35, $r[3]['points']);
    }

    public function test_empate_en_los_puestos_bajos_y_un_solo_jugador(): void
    {
        $r = MatchScoring::score([$this->f(1, 900), $this->f(2, 50), $this->f(3, 50), $this->f(4, 50)], $this->cfg);
        $this->assertSame([1, 2, 2, 2], array_column($r, 'rank'));
        $this->assertSame(36, $r[2]['points']); // (60 + 35 + 15) / 3 = 36,67 -> 36

        $this->assertSame(100, MatchScoring::score([$this->f(9, 10)], $this->cfg)[9]['points']);
    }
}
