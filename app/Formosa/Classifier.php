<?php

namespace App\Formosa;

use App\Enums\PropertyKind;

/**
 * Decide si un elemento de OpenStreetMap es una propiedad del juego y de qué tipo.
 * Devuelve null cuando no se puede comprar (iglesias, escuelas, hospitales, galpones, edificios sin datos, etc.).
 */
final class Classifier
{
    private const HOTEL_TOURISM = ['hotel', 'hostel', 'guest_house', 'motel', 'apartment'];

    private const SUPERMARKET_SHOP = ['supermarket', 'department_store', 'mall'];

    private const COMMERCE_AMENITY = ['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'ice_cream', 'pharmacy', 'bank', 'marketplace'];

    private const COMMERCE_BUILDING = ['retail', 'commercial', 'kiosk', 'shop'];

    private const HOUSE_BUILDING = ['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'apartments'];

    /** Valores de `shop` que no son un comercio abierto. */
    private const NOT_A_SHOP = ['vacant', 'no', 'yes_closed', 'disused'];

    /**
     * @param  array<string, string>  $tags  etiquetas de OSM
     * @param  float|null  $areaM2  superficie de la huella, si se conoce
     */
    public static function classify(array $tags, ?float $areaM2 = null): ?PropertyKind
    {
        $building = $tags['building'] ?? null;
        $shop = $tags['shop'] ?? null;
        $tourism = $tags['tourism'] ?? null;
        $amenity = $tags['amenity'] ?? null;

        // De mayor a menor prioridad: hotel, supermercado, comercio, casa.
        if (in_array($tourism, self::HOTEL_TOURISM, true) || $building === 'hotel') {
            return PropertyKind::Hotel;
        }
        if (in_array($shop, self::SUPERMARKET_SHOP, true) || $building === 'supermarket') {
            return PropertyKind::Supermercado;
        }
        if (($shop !== null && ! in_array($shop, self::NOT_A_SHOP, true))
            || in_array($amenity, self::COMMERCE_AMENITY, true)
            || in_array($building, self::COMMERCE_BUILDING, true)) {
            return PropertyKind::Comercio;
        }

        if (in_array($building, self::HOUSE_BUILDING, true)) {
            return PropertyKind::Casa;
        }

        // `building=yes` es el comodín de OSM: solo es casa si el tamaño es razonable. Sin superficie, no se arriesga.
        if ($building === 'yes' && $areaM2 !== null) {
            $range = config('formosa.house_area');
            if ($areaM2 >= $range['min'] && $areaM2 <= $range['max']) {
                return PropertyKind::Casa;
            }
        }

        return null;
    }
}
