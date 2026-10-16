<?php

/*
|--------------------------------------------------------------------------
| Formosa Tycoon: datos del mapa y economía base
|--------------------------------------------------------------------------
| Los precios, tamaños y ritmos de ingreso son valores de PARTIDA: se calibran con una simulación (Fase 2).
| Las zonas (bbox) son aproximadas: ajustalas mirando el mapa.
*/

// Un día de juego dura estos minutos REALES (config única: la usan el reloj de la partida y el ciclo día/noche del mapa).
$minutesPerDay = max(1, (int) env('FORMOSA_MINUTOS_POR_DIA', 2));

return [

    // Centro y zoom inicial del mapa (aprox. centro de la ciudad de Formosa).
    'center' => ['lat' => -26.183, 'lng' => -58.178],
    'zoom' => 15.5,

    // Zonas importables. bbox = sur, oeste, norte, este (grados).
    'districts' => [
        'microcentro-costanera' => ['south' => -26.195, 'west' => -58.190, 'north' => -26.172, 'east' => -58.165],
    ],
    'default_district' => 'microcentro-costanera',

    'overpass_url' => env('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
    'overpass_timeout' => 200,
    // Overpass pide identificarse: poné un correo o URL de contacto en OVERPASS_CONTACT.
    'user_agent' => 'FormosaTycoon/0.1',
    'overpass_contact' => env('OVERPASS_CONTACT', 'sin-contacto'),

    // Por tipo: precio base, superficie típica (m²) para escalar el precio, rendimiento (fracción del precio que
    // rinde por DÍA DE JUEGO) y color en el mapa. Recupero en días de juego = 1 / rate_per_day.
    // Con partidas de 40 min y 1 día = 2 min reales (20 días por partida) el recupero base es de 4 a 5 días de juego (con los
    // combos baja a 3-4): el primer reinvertido llega rápido y la partida se siente ágil. Lo barato rinde MÁS por peso invertido
    // (la casa se recupera en 4 días) y lo caro rinde menos por peso pero muchísimo en plata absoluta (un hotel suma $ 80.000
    // por día, en 5): al principio conviene crecer en casas y comercios, y llegar a los pocos supermercados y hoteles del mapa
    // exige haber reinvertido bien (se disputan en subasta). Con 3 días o menos el mapa entero se agotaba antes del final:
    // el simulador deja ~60 % del mapa libre al terminar con estos valores.
    // Probalo con `formosa:simular-economia` y, si cambiás estos números, corré `formosa:recalcular-economia`.
    'kinds' => [
        'casa' => ['label' => 'Casa', 'base_price' => 10000, 'typical_area' => 120, 'rate_per_day' => 0.250, 'color' => '#d6ccb4', 'height' => 6],
        'comercio' => ['label' => 'Comercio', 'base_price' => 40000, 'typical_area' => 150, 'rate_per_day' => 0.230, 'color' => '#7cc4e8', 'height' => 9],
        'supermercado' => ['label' => 'Supermercado', 'base_price' => 150000, 'typical_area' => 800, 'rate_per_day' => 0.210, 'color' => '#6fcf97', 'height' => 12],
        'hotel' => ['label' => 'Hotel', 'base_price' => 400000, 'typical_area' => 600, 'rate_per_day' => 0.200, 'color' => '#c9a7eb', 'height' => 28],
    ],

    // Combos (profundidad estratégica): bonus de ingreso por lo que el jugador junta DENTRO de la partida.
    //  - zona: la ciudad se divide en una grilla de `zone_deg` grados (~250 m). Con N propiedades propias en la misma celda,
    //    el ingreso de ESAS propiedades sube el porcentaje del escalón más alto alcanzado (3 → +5 %, 5 → +8 %, 8 → +12 %).
    //  - variedad: tener los cuatro tipos (casa, comercio, supermercado y hotel) suma `variety` sobre el ingreso base total.
    // Se calcula siempre desde lo que se tiene (no se guarda): al comprar o vender, el ingreso por día cambia solo.
    // Calibrado con `formosa:simular-economia` (los jugadores simulados agrupan al máximo, el peor caso): con +10/20/30 % y variedad
    // +10 % el mapa quedaba 84 % ocupado al final y la partida se volvía una carrera de saturación; con estos valores queda ~45 % libre.
    'combos' => [
        'zone_deg' => 0.0025,
        'zone_tiers' => [3 => 0.05, 5 => 0.08, 8 => 0.12],
        'variety' => 0.05,
    ],

    // Mapa: propiedades y calles como archivos estáticos en public/data (los entrega el servidor sin arrancar Laravel). Ver MapSnapshot.
    'map' => ['static' => (bool) env('FORMOSA_MAPA_ESTATICO', true)],

    // Eventos de partida (profundidad estratégica): ventanas de tiempo en las que un tipo de propiedad rinde más o menos.
    // El calendario sale de forma DETERMINISTA del id de la partida (no se guarda ni hay proceso que lo dispare): todos los
    // jugadores ven el mismo, y el ingreso se calcula partiendo el tiempo en tramos (ver EconomyService::accrue).
    // Cada partida sortea `per_match` eventos distintos y los reparte en tramos iguales desde el día `first_day`.
    // Un evento se anuncia `announce_days` días de juego antes, para poder prepararse (comprar o subastar lo que va a rendir).
    'events' => [
        'enabled' => (bool) env('FORMOSA_EVENTOS', true),
        'per_match' => 4,
        'first_day' => 3,
        'duration_days' => 3,
        'announce_days' => 1,
        // Cada evento vale solo para UNA zona (celda de la grilla de combos) que tenga al menos `zone_min_props` propiedades.
        'zonal' => (bool) env('FORMOSA_EVENTOS_ZONA', true),
        'zone_min_props' => 30,
        'types' => [
            'feria' => ['label' => 'Feria en el centro', 'kind' => 'comercio', 'pct' => 0.30, 'text' => 'Los comercios rinden más.'],
            'turismo' => ['label' => 'Temporada turística', 'kind' => 'hotel', 'pct' => 0.40, 'text' => 'Los hoteles rinden más.'],
            'compras' => ['label' => 'Semana de compras', 'kind' => 'supermercado', 'pct' => 0.30, 'text' => 'Los supermercados rinden más.'],
            'boom' => ['label' => 'Boom inmobiliario', 'kind' => 'casa', 'pct' => 0.25, 'text' => 'Las casas rinden más.'],
            'crisis' => ['label' => 'Crisis de alquileres', 'kind' => 'casa', 'pct' => -0.20, 'text' => 'Las casas rinden menos.'],
        ],
    ],

    // Sprint final: en los últimos `seconds` segundos TODO rinde `income_pct` más (1.0 = el doble), sale una subasta relámpago cada
    // `flash_interval` segundos (dura `flash_seconds`, sin prórroga, arranca en `flash_start_pct` % del precio de lista) y quien va
    // en el último tercio del ranking compra con `comeback_pct` % de descuento. Con `block_loans` no se piden préstamos nuevos.
    'sprint' => [
        'enabled' => (bool) env('FORMOSA_SPRINT', true),
        'seconds' => (int) env('FORMOSA_SPRINT_SEGUNDOS', 300),
        'income_pct' => 1.0,
        'flash_interval' => 60,
        'flash_seconds' => 20,
        'flash_start_pct' => 60,
        'comeback_pct' => 10,
        'block_loans' => true,
    ],

    // El precio escala con la superficie, acotado, y se redondea a múltiplos de price_step.
    'area_factor' => ['min' => 0.6, 'max' => 2.0],
    'price_step' => 500,

    // Un edificio genérico (building=yes) solo cuenta como casa dentro de este rango de superficie (m²).
    'house_area' => ['min' => 20, 'max' => 600],

    // Los comercios mapeados solo como punto reciben una huella cuadrada de este lado (metros).
    'synthetic_footprint_m' => 12,

    // Economía del jugador (el dinero inicial y el reloj están en `match`).
    'economy' => [
        'max_signups_per_ip_per_day' => 40, // cuentas nuevas por IP por día (varias personas pueden compartir una IP: una escuela)
        'sell_ratio' => 0.6,          // vender al banco devuelve esta fracción del precio de lista (comprar y vender enseguida siempre pierde)
        'ranking_size' => 20,         // jugadores que muestra el ranking global
    ],

    // Chat de voz de la sala (WebRTC, de jugador a jugador). El audio NO pasa por el servidor: Reverb solo hace de "teléfono" para que
    // los navegadores se pongan de acuerdo (canal de presencia `partida.{id}.voz`, autorizado solo a quienes siguen en la sala).
    // El micrófono arranca siempre cerrado. STUN gratuito alcanza para la mayoría de las redes; si algún jugador no conecta
    // (datos móviles, redes de empresa) hace falta un servidor TURN: FORMOSA_VOZ_TURN_URL / _USUARIO / _CLAVE.
    'voice' => [
        'enabled' => (bool) env('FORMOSA_VOZ', true),
        'stun' => array_values(array_filter(array_map('trim', explode(',', (string) env('FORMOSA_VOZ_STUN', 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'))))),
        'turn_url' => env('FORMOSA_VOZ_TURN_URL'),
        'turn_user' => env('FORMOSA_VOZ_TURN_USUARIO'),
        'turn_pass' => env('FORMOSA_VOZ_TURN_CLAVE'),
    ],

    // Partidas por salas (Fase K1). Cada partida tiene su propio mapa de dueños y su propio dinero.
    'match' => [
        'duration_minutes' => (int) env('FORMOSA_PARTIDA_MINUTOS', 40),
        // 1 día de juego = estos minutos reales: 40 min / 2 = 20 días por partida. El reloj parte de `started_at` de CADA partida.
        'minutes_per_day' => $minutesPerDay,
        'start_cash' => (int) env('FORMOSA_DINERO_INICIAL', 60000), // igual para todos los jugadores de la partida
        'min_players' => (int) env('FORMOSA_PARTIDA_MIN_JUGADORES', 2), // para iniciar; 1 sirve para pruebas
        'min_capacity' => 2,
        'max_capacity' => 8,
        'default_capacity' => 8,
        'name_max' => 40,
        'lobby_ttl_minutes' => (int) env('FORMOSA_SALA_VENCE_MINUTOS', 15), // una sala sin iniciar vence a los N min de creada
        'history' => 50,           // partidas que devuelve /api/yo/historial
        'points' => [
            // Solo suman quienes terminan la partida. Los empatados reparten el promedio (hacia abajo) de los puestos que ocupan.
            'places' => [1 => 100, 2 => 60, 3 => 35],
            'other' => 15,         // del 4.º en adelante
            'property_bonus' => 1, // puntos por propiedad al final...
            'property_bonus_cap' => 20, // ...hasta esta cantidad
        ],
    ],

    // Cuentas.
    'auth' => [
        // Si está activo, hay que confirmar el correo (enlace firmado) antes de comprar, pujar, cobrar, escribir o reportar.
        // Hace falta un MAIL_MAILER real en producción (en desarrollo, MAIL_MAILER=log deja el enlace en storage/logs).
        'verify_email' => (bool) env('FORMOSA_VERIFICAR_EMAIL', false),
        // Freno a los bots de registro sin servicios externos: campo trampa + el formulario no se acepta en menos de N segundos.
        'antibot' => (bool) env('FORMOSA_ANTIBOT', true),
        'min_form_seconds' => 3,
        'max_form_seconds' => 7200,
    ],

    // Subasta (Fase 3). Todos los tiempos son del SERVIDOR; el navegador solo muestra la cuenta regresiva.
    'auction' => [
        // Ventana desde que alguien reclama una propiedad libre: si nadie la disputa, se la lleva al precio de lista.
        // 0 = compra directa inmediata (como en la Fase 2; lo usan las pruebas y sirve para jugar sin esperar).
        // Ritmo acortado para partidas de 40 min: disputa de 5 s y subasta de 20 s. Cada partida tiene sus propias subastas.
        'dispute_seconds' => (int) env('FORMOSA_DISPUTA_SEGUNDOS', 5),
        'duration_seconds' => (int) env('FORMOSA_SUBASTA_SEGUNDOS', 20), // desde que otro jugador la disputa
        'snipe_window_seconds' => 5,   // una puja en los últimos N s extiende el cierre...
        'snipe_extend_seconds' => 5,   // ...hasta N s después de esa puja...
        'max_extensions' => 6,         // ...como mucho esta cantidad de veces (la subasta no puede ser eterna)
        'min_increment' => 100,        // cada puja sube al menos esto, o el porcentaje de abajo si es mayor
        'min_increment_pct' => 5,
        'max_active_per_user' => (int) env('FORMOSA_SUBASTAS_MAX', 5), // subastas activas que un jugador puede ir ganando a la vez (cada una reserva plata)
    ],

    // Ofertas entre jugadores: el dueño fija un mínimo y un "comprá ya"; los demás ofertan en el medio y el dueño decide.
    'offers' => [
        'duration_seconds' => (int) env('FORMOSA_OFERTA_SEGUNDOS', 120), // cuánto se puede ofertar
        'decide_seconds' => (int) env('FORMOSA_OFERTA_DECIDIR_SEGUNDOS', 45), // cuánto tiene el dueño para aceptar después de que cierran las ofertas
        'fee_pct' => (int) env('FORMOSA_OFERTA_COMISION', 5),      // % de la venta que se queda el banco (lo paga el vendedor)
        'min_price' => 100,                                         // el mínimo que se puede fijar
        'max_open_per_seller' => (int) env('FORMOSA_OFERTAS_MAX', 3), // ofertas abiertas que un dueño puede tener a la vez
        'max_leading_per_user' => 5,                                // ofertas que un jugador puede ir ganando a la vez (cada una reserva plata)
    ],

    // Banco: préstamos que se devuelven por día de juego.
    'bank' => [
        'rate_pct' => (int) env('FORMOSA_BANCO_INTERES', 3),         // % por día de juego sobre el capital que falta devolver
        'late_pct' => (int) env('FORMOSA_BANCO_MORA', 2),            // % por día de juego de recargo sobre lo atrasado
        'max_share_pct' => (int) env('FORMOSA_BANCO_MAXIMO', 50),    // lo máximo que se puede pedir: este % del patrimonio (ya sin la deuda)
        'max_loans' => (int) env('FORMOSA_BANCO_PRESTAMOS', 2),      // préstamos abiertos a la vez
        'min_amount' => 1000,
        'terms' => [5, 10, 20],                                      // plazos disponibles, en días de juego
    ],

    // Chat (Fase 4).
    'chat' => [
        'max_length' => 280,           // caracteres por mensaje (ya limpio de espacios y caracteres invisibles)
        'history' => 50,               // mensajes que se cargan al abrir
        'per_read' => 100,             // tope por lectura al ponerse al día tras una caída
        'repeat_seconds' => 30,        // el mismo texto del mismo jugador no se acepta de nuevo dentro de esta ventana (0 = sin control)
        'retention_days' => (int) env('FORMOSA_CHAT_DIAS', 7), // `chat:limpiar` borra lo más viejo...
        'max_rows' => 5000,            // ...y deja como mucho esta cantidad de mensajes del chat GLOBAL, aunque sean recientes
        'room_max_rows' => 1000,       // tope de mensajes de CADA sala (jugadores + avisos); las salas terminadas se conservan hasta `retention_days`
        'time_notices_minutes' => [10, 5], // avisos de sistema "Quedan N minutos" en la sala

        // Moderación.
        'report_reasons' => ['spam' => 'Spam', 'acoso' => 'Acoso', 'ofensivo' => 'Contenido ofensivo', 'otro' => 'Otro'],
        'auto_hide_min_age_hours' => (int) env('FORMOSA_REPORTE_EDAD_HORAS', 12), // solo cuentan para ocultar solo los reportes de cuentas con esta antigüedad (frena a quien crea cuentas para censurar; 0 = todas)
        'auto_hide_reports' => 3,      // un mensaje con tantos reportes de personas DISTINTAS se oculta solo hasta que un moderador lo revise (0 = nunca)
        'mute_minutes' => [10, 60, 1440, 10080], // duraciones de silencio permitidas (10 min, 1 h, 1 día, 7 días)
    ],

    // Hora interna de la ciudad (luz de día, tarde, noche y madrugada). Es la misma duración de día que usa la economía
    // (`match.minutes_per_day`); el navegador la calcula desde `started_at` de la partida, no desde la hora del servidor.
    'clock' => [
        'minutes_per_day' => $minutesPerDay,
    ],

    // Datos del mapa desactualizados (Fase 7): avisos de jugadores, correcciones de moderadores y re-importación.
    'data' => [
        'report_reasons' => [
            'cerrado' => 'Ya cerró',
            'otro_rubro' => 'Ahora es otro rubro',
            'otro_nombre' => 'Cambió de nombre',
            'no_existe' => 'No existe o está mal ubicado',
        ],
        'max_open_reports_per_user' => 20, // avisos abiertos a la vez por jugador (frena llenar la cola de revisión)
        'import_min_ratio' => 0.7,         // si la descarga nueva trae menos que esta fracción de lo que hay, se sospecha de una descarga cortada
    ],

    // Dónde se conecta el NAVEGADOR al servidor de tiempo real (Reverb). Puede diferir de REVERB_HOST si hay proxy.
    'realtime' => [
        'host' => env('VITE_REVERB_HOST', env('REVERB_HOST', 'localhost')),
        'port' => (int) env('VITE_REVERB_PORT', env('REVERB_PORT', 8080)),
        'scheme' => env('VITE_REVERB_SCHEME', env('REVERB_SCHEME', 'http')),
    ],

    // Dónde se guardan las calles (disco "local").
    'roads_file' => 'formosa/calles.geojson',

    // Entorno de la ciudad 3D (agua, plazas, parques, emblemáticos, semáforos y paradas), en el disco "local".
    'environment_file' => 'formosa/entorno.geojson',
    'environment' => [
        // El entorno y las calles se descargan en la zona ampliada estos metros hacia cada lado, así la ciudad
        // no termina en seco en el borde de lo importado (las propiedades siguen siendo solo las de la zona).
        'margin_m' => 500,
    ],
];
