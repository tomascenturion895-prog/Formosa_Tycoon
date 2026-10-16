<?php

namespace App\Economy;

use RuntimeException;

/**
 * Error esperable del juego (no un bug): propiedad ocupada, saldo insuficiente, etc.
 * `errorCode` es estable para que el navegador decida qué mostrar; `message` va listo para el jugador.
 */
class GameException extends RuntimeException
{
    /** @param array<string, int|string> $context */
    final public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 422,
        public readonly array $context = [],
    ) {
        parent::__construct($message);
    }

    public static function notFound(): static
    {
        return new static('propiedad_inexistente', 'Esa propiedad no existe.', 404);
    }

    public static function taken(bool $byYou): static
    {
        return $byYou
            ? new static('ya_es_tuya', 'Esa propiedad ya es tuya.', 409)
            : new static('ocupada', 'Alguien se te adelantó: esa propiedad ya tiene dueño.', 409);
    }

    public static function keyReused(): static
    {
        return new static('clave_reutilizada', 'Esa clave ya se usó para otra compra. Reintentá desde la pantalla.', 409);
    }

    public static function insufficientFunds(int $price, int $balance): static
    {
        return new static(
            'saldo_insuficiente',
            'No te alcanza el dinero disponible. Lo que tenés ganando en otras subastas está reservado.',
            422,
            ['precio' => $price, 'saldo' => $balance, 'faltan' => $price - $balance],
        );
    }

    public static function inAuction(): static
    {
        return new static('en_subasta', 'Esa propiedad está en subasta: pujá para quedártela.', 409);
    }

    public static function upgradeUnavailable(): static
    {
        return new static('mejora_no_disponible', 'Esa propiedad ya tiene esa mejora o todavía no se puede hacer: se sube de a un nivel.', 409);
    }

    public static function busyForUpgrade(bool $offer): static
    {
        return $offer
            ? new static('en_oferta', 'Esa propiedad está en oferta: retirala antes de mejorarla.', 409)
            : new static('en_subasta', 'Esa propiedad está en subasta: no se puede mejorar ahora.', 409);
    }

    public static function invalidBranch(): static
    {
        return new static('rama_invalida', 'Elegí una de las dos especializaciones del nivel 2.', 422);
    }

    public static function auctionNotFound(): static
    {
        return new static('subasta_inexistente', 'Esa subasta no existe.', 404);
    }

    public static function auctionClosed(): static
    {
        return new static('subasta_cerrada', 'Esa subasta ya terminó.', 409);
    }

    public static function auctionEnded(int $auctionId = 0): static
    {
        return new static('subasta_terminada', 'La subasta terminó justo ahora.', 409, ['auction' => $auctionId]);
    }

    /** Interno: otro tiene la propiedad reservada y todavía corre su ventana; AuctionService::claim() la disputa pujando. */
    public static function contested(int $auctionId): static
    {
        return new static('reclamo_competido', 'Esa propiedad ya está reservada por otro jugador.', 409, ['auction' => $auctionId]);
    }

    public static function lowBid(int $min): static
    {
        return new static('puja_baja', 'Tu puja tiene que superar la actual.', 422, ['minimo' => $min]);
    }

    public static function alreadyLeading(): static
    {
        return new static('ya_lideras', 'Ya vas ganando esta subasta.', 409);
    }

    public static function tooManyAuctions(int $max): static
    {
        return new static('demasiadas_subastas', "Ya vas ganando {$max} subastas a la vez. Esperá a que termine alguna.", 422, ['maximo' => $max]);
    }

    // ---- Chat (Fase 4)

    public static function emptyMessage(): static
    {
        return new static('mensaje_vacio', 'Escribí algo para enviar.', 422);
    }

    public static function messageTooLong(int $max): static
    {
        return new static('mensaje_largo', "El mensaje puede tener hasta {$max} caracteres.", 422, ['maximo' => $max]);
    }

    public static function repeatedMessage(int $seconds): static
    {
        return new static('mensaje_repetido', 'Ya dijiste eso hace un momento. Esperá un poco para repetirlo.', 429, ['espera' => $seconds]);
    }

    public static function chatKeyReused(): static
    {
        return new static('clave_reutilizada', 'Ese envío ya se usó con otro texto. Volvé a enviarlo.', 409);
    }

    public static function roomReadOnly(): static
    {
        return new static('sala_solo_lectura', 'Esa sala ya no está en juego: el chat quedó solo para leer.', 409);
    }

    // ---- Moderación

    /** @param int $untilMs cuándo vence el silencio (ms desde 1970, hora del servidor) */
    public static function muted(int $untilMs): static
    {
        return new static('silenciado', 'Un moderador te silenció en el chat.', 403, ['hasta' => $untilMs]);
    }

    public static function messageNotFound(): static
    {
        return new static('mensaje_inexistente', 'Ese mensaje no existe.', 404);
    }

    public static function ownReport(): static
    {
        return new static('reporte_propio', 'No podés reportar tu propio mensaje.', 422);
    }

    public static function userNotFound(): static
    {
        return new static('usuario_inexistente', 'Ese jugador no existe.', 404);
    }

    public static function invalidTarget(): static
    {
        return new static('usuario_invalido', 'No podés silenciar a ese jugador.', 422);
    }

    public static function roomNotFound(): static
    {
        return new static('partida_inexistente', 'Esa partida no existe.', 404);
    }

    public static function cannotClose(): static
    {
        return new static('no_se_puede_cerrar', 'Esa partida no se puede cerrar ahora: ya terminó, o está en juego y todavía le queda tiempo.', 409);
    }

    public static function invalidDuration(): static
    {
        return new static('duracion_invalida', 'Elegí una de las duraciones disponibles.', 422);
    }

    public static function editLocked(): static
    {
        return new static('en_subasta_no_editable', 'No se puede corregir una propiedad mientras está reservada o en subasta. Esperá a que termine.', 409);
    }

    public static function tooManyReports(int $max): static
    {
        return new static('demasiados_avisos', "Ya tenés {$max} avisos esperando revisión. Esperá a que los revise un moderador.", 429);
    }

    public static function invalidReason(): static
    {
        return new static('motivo_invalido', 'Elegí uno de los motivos de la lista.', 422);
    }

    public static function notModerator(): static
    {
        return new static('no_moderador', 'Solo los moderadores pueden hacer esto.', 403);
    }

    public static function notYours(): static
    {
        return new static('no_es_tuya', 'Esa propiedad no es tuya.', 403);
    }

    // ---- Partidas por salas (K1)

    public static function matchNotFound(): static
    {
        return new static('partida_inexistente', 'Esa partida no existe.', 404);
    }

    public static function codeNotFound(): static
    {
        return new static('codigo_invalido', 'No encontramos una sala abierta con ese código.', 404);
    }

    public static function alreadyInMatch(int $matchId): static
    {
        return new static('ya_estas_en_partida', 'Ya estás en una partida. Salí de esa antes de entrar a otra.', 409, ['partida' => $matchId]);
    }

    public static function notInMatch(): static
    {
        return new static('no_estas_en_partida', 'No estás jugando esa partida.', 403);
    }

    public static function matchFull(): static
    {
        return new static('sala_llena', 'La sala está llena.', 409);
    }

    public static function matchNotOpen(): static
    {
        return new static('sala_cerrada', 'Esa sala ya no está abierta.', 409);
    }

    public static function matchNotRunning(): static
    {
        return new static('partida_no_en_juego', 'La partida no está en juego.', 409);
    }

    public static function matchNotFinished(): static
    {
        return new static('partida_no_terminada', 'La partida todavía no terminó.', 409);
    }

    public static function notCreator(): static
    {
        return new static('no_sos_el_creador', 'Solo quien creó la sala puede iniciarla.', 403);
    }

    public static function notEnoughPlayers(int $min): static
    {
        return new static('faltan_jugadores', "Hacen falta al menos {$min} jugadores para iniciar.", 422, ['minimo' => $min]);
    }

    public static function invalidCapacity(int $min, int $max): static
    {
        return new static('cupo_invalido', "El cupo tiene que estar entre {$min} y {$max} jugadores.", 422, ['minimo' => $min, 'maximo' => $max]);
    }

    // ---- Ofertas entre jugadores

    public static function offerNotFound(): static
    {
        return new static('oferta_inexistente', 'Esa oferta no existe.', 404);
    }

    public static function offerClosed(): static
    {
        return new static('oferta_cerrada', 'Esa oferta ya terminó.', 409);
    }

    /** Interno: el plazo venció mientras se actuaba; OfferService la cierra y le avisa al jugador. */
    public static function offerEnded(int $offerId = 0): static
    {
        return new static('oferta_terminada', 'La oferta terminó justo ahora.', 409, ['offer' => $offerId]);
    }

    public static function inOffer(): static
    {
        return new static('en_oferta', 'Esa propiedad está en oferta. Retirala antes de venderla al banco.', 409);
    }

    public static function alreadyOffered(): static
    {
        return new static('ya_en_oferta', 'Esa propiedad ya está en oferta.', 409);
    }

    public static function offerPrices(int $minAllowed): static
    {
        return new static('precios_invalidos', "El mínimo tiene que ser de al menos {$minAllowed} y el \"comprá ya\" tiene que ser mayor que el mínimo.", 422, ['minimo_permitido' => $minAllowed]);
    }

    public static function tooManyOffers(int $max): static
    {
        return new static('demasiadas_ofertas', "Ya tenés {$max} ofertas abiertas. Esperá a que termine alguna o retirá una.", 422, ['maximo' => $max]);
    }

    public static function tooManyLeading(int $max): static
    {
        return new static('demasiadas_ofertas_ganando', "Ya vas ganando {$max} ofertas a la vez. Esperá a que termine alguna.", 422, ['maximo' => $max]);
    }

    public static function ownOffer(): static
    {
        return new static('oferta_propia', 'No podés ofertar por tu propia propiedad.', 403);
    }

    public static function offerLowBid(int $min): static
    {
        return new static('oferta_baja', 'Tu oferta tiene que alcanzar el mínimo y superar la actual.', 422, ['minimo' => $min]);
    }

    public static function noBids(): static
    {
        return new static('sin_ofertas', 'Todavía nadie ofertó por esa propiedad.', 409);
    }

    // ---- Banco (préstamos)

    public static function loanNotFound(): static
    {
        return new static('prestamo_inexistente', 'Ese préstamo no existe.', 404);
    }

    public static function loanClosed(): static
    {
        return new static('prestamo_cerrado', 'Ese préstamo ya está pagado.', 409);
    }

    public static function loanTerm(): static
    {
        return new static('plazo_invalido', 'Elegí uno de los plazos disponibles.', 422);
    }

    public static function loanAmount(int $min): static
    {
        return new static('monto_invalido', "El préstamo mínimo es de {$min}.", 422, ['minimo' => $min]);
    }

    public static function loanTooBig(int $max): static
    {
        return new static('prestamo_excedido', 'El banco no te presta tanto: tu patrimonio no alcanza.', 422, ['maximo' => $max]);
    }

    public static function tooManyLoans(int $max): static
    {
        return new static('demasiados_prestamos', "Ya tenés {$max} préstamos abiertos. Devolvé alguno antes de pedir otro.", 422, ['maximo' => $max]);
    }

    public static function loanArrears(): static
    {
        return new static('prestamo_con_mora', 'Tenés cuotas atrasadas: ponete al día antes de pedir otro préstamo.', 422);
    }

    public static function loanSprint(): static
    {
        return new static('prestamo_sprint', 'En el sprint final ya no se piden préstamos.', 422);
    }

    public static function nothingToPay(): static
    {
        return new static('sin_efectivo', 'No tenés efectivo libre para pagar ahora.', 422);
    }
}
