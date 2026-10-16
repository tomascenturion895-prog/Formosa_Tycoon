<?php

namespace Tests\Unit\Formosa;

use App\Enums\PropertyKind;
use App\Formosa\Classifier;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class ClassifierTest extends TestCase
{
    public static function cases(): array
    {
        return [
            'hotel por turismo' => [['tourism' => 'hotel'], null, PropertyKind::Hotel],
            'hostel' => [['tourism' => 'hostel', 'building' => 'yes'], 300.0, PropertyKind::Hotel],
            'edificio hotel' => [['building' => 'hotel'], null, PropertyKind::Hotel],
            'supermercado por shop' => [['shop' => 'supermarket'], null, PropertyKind::Supermercado],
            'supermercado por edificio' => [['building' => 'supermarket'], 900.0, PropertyKind::Supermercado],
            'comercio por shop' => [['shop' => 'bakery'], null, PropertyKind::Comercio],
            'comercio por amenity' => [['amenity' => 'pharmacy'], null, PropertyKind::Comercio],
            'comercio por edificio retail' => [['building' => 'retail'], 200.0, PropertyKind::Comercio],
            'local vacio no es comercio' => [['shop' => 'vacant'], null, null],
            'casa explicita' => [['building' => 'house'], 90.0, PropertyKind::Casa],
            'casa residencial' => [['building' => 'residential'], 150.0, PropertyKind::Casa],
            'yes de tamano normal es casa' => [['building' => 'yes'], 120.0, PropertyKind::Casa],
            'yes demasiado chico' => [['building' => 'yes'], 10.0, null],
            'yes demasiado grande' => [['building' => 'yes'], 5000.0, null],
            'yes sin superficie no se arriesga' => [['building' => 'yes'], null, null],
            'iglesia no se compra' => [['building' => 'church'], 400.0, null],
            'escuela no se compra' => [['building' => 'school'], 800.0, null],
            'hospital no se compra' => [['amenity' => 'hospital', 'building' => 'yes'], 3000.0, null],
            'sin etiquetas' => [[], 100.0, null],
            'hotel gana a supermercado' => [['tourism' => 'hotel', 'shop' => 'supermarket'], null, PropertyKind::Hotel],
            'supermercado gana a comercio' => [['shop' => 'supermarket', 'amenity' => 'bank'], null, PropertyKind::Supermercado],
            'comercio gana a casa' => [['building' => 'house', 'shop' => 'kiosk'], 80.0, PropertyKind::Comercio],
        ];
    }

    #[DataProvider('cases')]
    public function test_clasifica(array $tags, ?float $area, ?PropertyKind $expected): void
    {
        $this->assertSame($expected, Classifier::classify($tags, $area));
    }
}
