<?php

namespace App\Enums;

/** Tipo de propiedad. El valor es el que se guarda en la base y viaja al navegador. */
enum PropertyKind: string
{
    case Casa = 'casa';
    case Comercio = 'comercio';
    case Supermercado = 'supermercado';
    case Hotel = 'hotel';

    public function label(): string
    {
        return config("formosa.kinds.{$this->value}.label");
    }

    /** Si un edificio tiene varias pistas, gana el de mayor prioridad. */
    public function priority(): int
    {
        return match ($this) {
            self::Casa => 1,
            self::Comercio => 2,
            self::Supermercado => 3,
            self::Hotel => 4,
        };
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $k) => $k->value, self::cases());
    }

    public static function strongest(?self $a, ?self $b): ?self
    {
        if ($a === null) {
            return $b;
        }
        if ($b === null) {
            return $a;
        }

        return $b->priority() > $a->priority() ? $b : $a;
    }
}
