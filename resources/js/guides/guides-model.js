// Catálogo de guías del juego. Es lógica pura (sin DOM) para poder probarla con `node --test`.
// Cada guía: { id, place, title, summary, version, auto, available?(ctx), steps(ctx) }.
//   - place: dónde se ofrece (lobby | sala | partida | resultados | explorar).
//   - auto: se abre sola la primera vez que se entra al lugar. version: subirla la vuelve a marcar como nueva.
//   - steps(ctx): ctx = { cfg, user }; los textos usan los números reales de la configuración del servidor.
// Cada paso: { title, text, targets } — `targets` son selectores CSS en orden de preferencia; se señala el primero
// que esté visible y, si ninguno lo está, la tarjeta aparece centrada.

export const PLACES = ['lobby', 'sala', 'partida', 'resultados', 'explorar'];

const pesos = (n) => `$\u00a0${Math.round(n).toLocaleString('es-AR')}`; // espacio fino: que el signo no quede solo al final de la línea

/** Puntos por puesto, en texto: "100 / 60 / 35 y 15 del 4.º en adelante". */
export function pointsText(points) {
    const p = points ?? {};
    const places = Object.keys(p.places ?? {}).sort((a, b) => a - b).map((k) => p.places[k]);
    if (places.length === 0) {
        return 'según tu puesto';
    }
    const resto = p.other != null ? ` y ${p.other} del ${places.length + 1}.º en adelante` : '';
    return `${places.join(' / ')}${resto}`;
}

/** Números de la partida que usan varios textos, con valores por defecto razonables si falta algo de la configuración. */
function facts(cfg) {
    const m = cfg.match ?? {};
    const minutesPerDay = m.minutesPerDay ?? 2;
    return {
        m,
        minutes: m.durationMinutes ?? 40,
        minCap: m.minCapacity ?? 2,
        maxCap: m.maxCapacity ?? 8,
        minPlayers: m.minPlayers ?? m.minCapacity ?? 2,
        minutesPerDay,
        days: m.daysTotal ?? Math.floor((m.durationMinutes ?? 40) / Math.max(1, minutesPerDay)),
        cash: cfg.economy?.startCash ?? 0,
        sell: Math.round((cfg.economy?.sellRatio ?? 0.6) * 100),
        dispute: cfg.auction?.dispute ?? 0,
    };
}

export const GUIDES = [
    // ---------------------------------------------------------------- Lobby
    {
        id: 'lobby-bienvenida',
        place: 'lobby',
        title: 'Bienvenido a Formosa Tycoon',
        summary: 'De qué se trata el juego y cómo se gana.',
        version: 1,
        auto: true,
        steps: ({ cfg, user }) => {
            const f = facts(cfg);
            return [
                {
                    title: 'Bienvenido a Formosa Tycoon',
                    text: `Cada edificio del mapa es una propiedad de la Formosa real. Jugás partidas de ${f.minutes} minutos con ${f.minCap} a ${f.maxCap} jugadores. Todos arrancan con ${pesos(f.cash)} y gana quien termina con más patrimonio (efectivo + valor de sus propiedades, menos lo que debas).`,
                    targets: [],
                },
                {
                    title: user ? 'Entrá a una sala' : 'Mirá las salas',
                    text: user
                        ? 'Acá, en el lobby, creás una sala, te unís a una abierta o entrás con un código. Cuando están los jugadores mínimos, el creador la inicia y arranca el reloj.'
                        : 'Acá ves las salas abiertas y el ranking. Para crear una sala o unirte necesitás una cuenta: es gratis y no pedimos tu nombre real.',
                    targets: user ? ['#room-form', '#room-list'] : ['#room-list'],
                },
                {
                    title: 'Cómo se gana',
                    text: `Comprás propiedades, cobrás lo que rinden cada día (${f.minutesPerDay} minutos reales por día, ${f.days} días por partida) y reinvertís. Al final sumás puntos al ranking global según tu puesto. Perder una partida no resta puntos.`,
                    targets: [],
                },
                {
                    title: 'Ayuda cuando quieras',
                    text: 'El botón ? de arriba abre las guías del lugar donde estás: salas, ranking, la partida y mucho más. También hay una pestaña "Cómo se juega" con todo junto para leer antes de empezar.',
                    targets: ['#btn-help'],
                },
            ];
        },
    },
    {
        id: 'lobby-salas',
        place: 'lobby',
        title: 'Salas: crear y unirse',
        summary: 'Cómo crear una sala, entrar por código o desde la lista.',
        version: 1,
        auto: false,
        steps: ({ cfg }) => {
            const f = facts(cfg);
            return [
                {
                    title: 'Crear una sala',
                    text: `Ponele nombre, elegí el cupo (de ${f.minCap} a ${f.maxCap} jugadores) y decidí si es pública. Una sala pública aparece en la lista para que cualquiera se una; una privada solo se entra con el código.`,
                    targets: ['#room-form'],
                },
                {
                    title: 'Unirte con un código',
                    text: 'Si un amigo te pasó el código de su sala, pegalo acá. No importa si lo escribís en mayúsculas o minúsculas.',
                    targets: ['#code-form'],
                },
                {
                    title: 'Salas abiertas',
                    text: `La lista se actualiza sola. Tocá Unirme en la que quieras. Una sala que nadie inicia se cierra a los ${f.m.lobbyTtlMinutes ?? 15} minutos.`,
                    targets: ['#room-list'],
                },
            ];
        },
    },
    {
        id: 'lobby-ranking',
        place: 'lobby',
        title: 'Ranking e historial',
        summary: 'Cómo se suman los puntos y dónde ver tus partidas.',
        version: 1,
        auto: false,
        steps: ({ cfg, user }) => {
            const f = facts(cfg);
            const bonus = f.m.points?.property_bonus ?? 1;
            const cap = f.m.points?.property_bonus_cap ?? 20;
            const steps = [
                {
                    title: 'Ranking global',
                    text: `Al terminar cada partida sumás puntos según tu puesto (${pointsText(f.m.points)}) más ${bonus} punto por propiedad, hasta ${cap}. El ranking junta los puntos de todas tus partidas.`,
                    targets: ['#tab-ranking'],
                },
            ];
            if (user) {
                steps.push({
                    title: 'Tus partidas',
                    text: 'En "Mis partidas" ves cómo te fue en cada una: puesto, patrimonio y puntos. Tocá una para ver la tabla final.',
                    targets: ['#tab-historial'],
                });
            }
            return steps;
        },
    },

    // ---------------------------------------------------------------- Sala de espera
    {
        id: 'sala-espera',
        place: 'sala',
        title: 'La sala de espera',
        summary: 'Invitar jugadores e iniciar la partida.',
        version: 1,
        auto: true,
        steps: ({ cfg }) => {
            const f = facts(cfg);
            return [
                {
                    title: 'Invitá con el código',
                    text: 'Compartí este código (con el botón Copiar) para que tus amigos entren desde el lobby. Si la sala es pública, también aparece en la lista.',
                    targets: ['#room-code'],
                },
                {
                    title: 'Jugadores',
                    text: `Acá ves quiénes están. La partida se puede iniciar con ${f.minPlayers} jugadores o más; el cupo máximo es el que elegiste al crear la sala.`,
                    targets: ['#room-players'],
                },
                {
                    title: 'Iniciar la partida',
                    text: `Solo el creador de la sala la inicia, y arranca el reloj de ${f.minutes} minutos. Si nadie la inicia, la sala se cierra a los ${f.m.lobbyTtlMinutes ?? 15} minutos. Mientras esperás podés recorrer el mapa.`,
                    targets: ['#room-start', '#room-players'],
                },
            ];
        },
    },
    {
        id: 'sala-social',
        place: 'sala',
        title: 'Chat y voz',
        summary: 'Hablá con tu sala mientras esperás.',
        version: 1,
        auto: false,
        steps: ({ cfg, user }) => {
            const steps = [
                {
                    title: 'Chat: Sala y Global',
                    text: 'Hay dos chats. "Sala" es solo de tu partida; "Global" es para charlar con todos. Sé amable: hay moderadores.',
                    targets: ['#chat-toggle'],
                },
            ];
            if (user && cfg.voice?.enabled) {
                steps.push({
                    title: 'Voz de la sala',
                    text: 'Arriba del chat aparece la voz de tu partida. Entrás escuchando y con el micrófono apagado: tocá el micrófono cuando quieras hablar y volvé a tocarlo para callarte. Necesita permiso del navegador la primera vez.',
                    targets: ['#voice', '#chat-toggle'],
                });
            }
            return steps;
        },
    },

    // ---------------------------------------------------------------- Partida
    {
        id: 'partida-tablero',
        place: 'partida',
        title: 'Tu tablero',
        summary: 'Reloj, plata, ingreso por día y posiciones.',
        version: 1,
        auto: true,
        steps: ({ cfg }) => {
            const f = facts(cfg);
            const bonus = f.m.points?.property_bonus ?? 1;
            const cap = f.m.points?.property_bonus_cap ?? 20;
            return [
                {
                    title: 'Tu tablero',
                    text: `Arriba ves el tiempo que queda, el día (cada día dura ${f.minutesPerDay} minutos reales, hay ${f.days} por partida), tu efectivo, cuánto sumás por día y tu patrimonio. No cobrás a mano: las propiedades pagan solas al pasar cada día.`,
                    targets: ['#match-hud'],
                },
                {
                    title: 'Posiciones y puntos',
                    text: `Las posiciones se actualizan en vivo. Al terminar sumás puntos al ranking global según tu puesto (${pointsText(f.m.points)}) más ${bonus} punto por propiedad, hasta ${cap}.`,
                    targets: ['#standings-box', '#match-hud'],
                },
            ];
        },
    },
    {
        id: 'partida-comprar',
        place: 'partida',
        title: 'Comprar propiedades',
        summary: 'Elegir, reclamar y recuperar la inversión.',
        version: 1,
        auto: true,
        steps: ({ cfg }) => {
            const f = facts(cfg);
            return [
                {
                    title: 'Elegí qué comprar',
                    text: 'Tocá un edificio para ver su precio, cuánto rinde por día y en cuántos días se recupera. Lo libre se ve en tonos suaves según el tipo (casa, comercio, supermercado, hotel); lo que ya tiene dueño, en el color de su jugador y lo tuyo con borde o techo dorado. La leyenda te deja ocultar tipos.',
                    targets: ['#legend'],
                },
                {
                    title: 'Reclamala o subastala',
                    text: f.dispute > 0
                        ? `Si está libre, tocá Reclamar: si nadie la disputa en ${f.dispute} segundos, es tuya al precio de lista. Si otro jugador también la quiere se abre una subasta corta y gana quien puja más (una puja en los últimos segundos alarga el reloj).`
                        : 'Si está libre, tocá Comprar y es tuya al precio de lista.',
                    targets: ['#panel'],
                },
                {
                    title: 'Estrategia',
                    text: `Comprar temprano es lo que más rinde, porque cada propiedad paga todos los días que le quedan: reinvertí lo que cobrás. Fijate en el "se recupera en N días" de cada una: con ${f.days} días de partida, lo que tarda poco en pagarse conviene al principio y lo caro a mitad de camino. Si necesitás plata, podés vender una al banco, que devuelve el ${f.sell} % de su valor, o subastarla.`,
                    targets: [],
                },
            ];
        },
    },

    {
        id: 'partida-subastas',
        place: 'partida',
        title: 'Subastas',
        summary: 'Pujar por una propiedad y cómo funciona la reserva de plata.',
        version: 1,
        auto: false,
        steps: ({ cfg }) => {
            const a = cfg.auction ?? {};
            const sp = cfg.sprint ?? {};
            const steps = [
                {
                    title: 'Subastas en curso',
                    text: 'Cuando dos jugadores quieren la misma propiedad se abre una subasta. Aparece en el panel de arriba a la izquierda con su cuenta regresiva: tocá una para ir a la propiedad y pujar.',
                    targets: ['#subastas-box', '#hud-body'],
                },
                {
                    title: 'Cómo pujar',
                    text: `Cada subasta dura unos ${a.duration ?? 30} segundos. Ofrecé más que la puja actual: gana quien tenga la mayor al terminar el reloj. Una puja en los últimos segundos alarga la cuenta, así que nadie puede ganar en el último instante sin que los demás respondan.`,
                    targets: ['#auction-box', '#subastas-box'],
                },
                {
                    title: 'Tu plata queda reservada',
                    text: 'Mientras vas ganando una subasta, esa plata queda reservada y no la podés usar en otra cosa. Si te superan, se libera sola. No podés pujar más de lo que tenés disponible.',
                    targets: ['#match-hud'],
                },
            ];
            if (sp.enabled) {
                steps.push({
                    title: 'Subasta relámpago',
                    text: `En el sprint final aparece una subasta relámpago cada ${sp.flashInterval ?? 60} segundos: dura solo ${sp.flashSeconds ?? 20} segundos y arranca al ${sp.flashStartPct ?? 60} % del precio de lista. Son oportunidades: hay que mirar rápido.`,
                    targets: ['#subastas-box', '#match-events'],
                });
            }
            return steps;
        },
    },
    {
        id: 'partida-ofertas',
        place: 'partida',
        title: 'Ofertas entre jugadores',
        summary: 'Vender una propiedad tuya a otro jugador, o comprar una en oferta.',
        version: 1,
        auto: false,
        steps: ({ cfg }) => {
            const o = cfg.offers ?? {};
            const fee = o.feePct ?? 5;
            return [
                {
                    title: 'Ofrecer una propiedad tuya',
                    text: `Tocá una propiedad tuya y abrí "Ofrecerla a otros jugadores". Fijás un mínimo (desde ${pesos(o.minPrice ?? 100)}): no la vendés por menos. Opcional: un precio de "Comprá ya", para que se venda en el acto si alguien lo paga.`,
                    targets: ['#offer-new', '#panel'],
                },
                {
                    title: 'Ofertar por una propiedad',
                    text: `Cuando una propiedad está en oferta, los demás jugadores ofertan durante ${o.durationSeconds ?? 120} segundos. La oferta tiene que alcanzar el mínimo y superar a la mejor. Tu plata queda reservada mientras vas ganando, y se libera si te superan.`,
                    targets: ['#offer-box', '#panel'],
                },
                {
                    title: 'Aceptar o retirar',
                    text: `Cuando se cierran las ofertas, el dueño tiene ${o.decideSeconds ?? 45} segundos para aceptar la mejor. Si no la acepta, termina sin venta. También puede retirar la oferta antes. En una venta, el banco se queda el ${fee} % (lo paga el vendedor).`,
                    targets: ['#offer-box'],
                },
            ];
        },
    },
    {
        id: 'partida-combos-eventos',
        place: 'partida',
        title: 'Combos, eventos y sprint',
        summary: 'Qué hace rendir más a tus propiedades.',
        version: 1,
        auto: false,
        steps: ({ cfg }) => {
            const tiers = Object.entries(cfg.combos?.zoneTiers ?? { 3: 0.1 }).sort((a, b) => a[0] - b[0]);
            const tierText = tiers.map(([n, p]) => `${n} o más → +${Math.round(p * 100)} %`).join(', ');
            const variety = Math.round((cfg.combos?.variety ?? 0.1) * 100);
            const steps = [
                {
                    title: 'Combos: juntá y variá',
                    text: `Dos formas de ganar más por día. Zona: las propiedades tuyas que están juntas (en la misma zona, más o menos dos cuadras) rinden más: ${tierText}. Variedad: si tenés los cuatro tipos (casa, comercio, supermercado y hotel), todo tu ingreso sube +${variety} %. Al tocar una propiedad, el panel te dice qué combo te falta.`,
                    targets: ['#panel'],
                },
            ];
            const ev = cfg.events;
            if (ev?.enabled) {
                steps.push({
                    title: 'Eventos de la partida',
                    text: `En cada partida hay ${ev.perMatch} eventos al azar que duran ${ev.durationDays} días de juego: por ejemplo una feria que hace rendir más a los comercios, una temporada turística para los hoteles o una crisis que hace rendir menos a las casas. Se anuncian ${ev.announceDays} día antes y algunos afectan solo a una zona: en el mapa se marca con un recuadro (verde si sube, rojo si baja, azul si todavía no empezó). Son iguales para todos los jugadores de la sala.`,
                    targets: ['#match-events', '#match-hud'],
                });
            }
            const sp = cfg.sprint;
            if (sp?.enabled) {
                const mins = Math.round((sp.seconds ?? 300) / 60);
                steps.push({
                    title: 'Sprint final',
                    text: `En los últimos ${mins} minutos arranca el sprint: todo rinde ${sp.incomePct >= 1 && Number.isInteger(sp.incomePct) ? `x${1 + sp.incomePct}` : `+${Math.round(sp.incomePct * 100)} %`}. Hay una subasta relámpago cada ${sp.flashInterval ?? 60} segundos y quienes van en el último tercio del ranking compran con ${sp.comebackPct ?? 10} % de descuento para poder remontar.${sp.blockLoans ? ' No se pueden pedir préstamos nuevos.' : ''}`,
                    targets: ['#match-events', '#match-hud'],
                });
            }
            return steps;
        },
    },
    {
        id: 'partida-banco',
        place: 'partida',
        title: 'Banco y préstamos',
        summary: 'Pedir plata prestada, devolverla y qué pasa si te atrasás.',
        version: 1,
        auto: false,
        available: ({ cfg }) => Boolean(cfg.bank),
        steps: ({ cfg }) => {
            const b = cfg.bank;
            const terms = (b.terms ?? []).join(' / ');
            const steps = [
                {
                    title: 'Pedir un préstamo',
                    text: `Si necesitás plata para comprar, el banco te presta desde ${pesos(b.minAmount ?? 1000)} y hasta el ${b.maxSharePct} % de tu patrimonio (sin contar lo que ya debés). Podés tener hasta ${b.maxLoans} préstamos abiertos a la vez. Se abre con el botón Banco.`,
                    targets: ['#btn-bank', '#bank'],
                },
                {
                    title: 'Plazos e interés',
                    text: `Elegís el plazo: ${terms} días de juego. Cada día pagás una cuota y un interés del ${b.ratePct} % sobre el capital que todavía no devolviste. Podés cancelar antes y pagar solo lo que corresponde.`,
                    targets: ['#bank'],
                },
                {
                    title: 'Si te atrasás',
                    text: `Si un día no te alcanza la plata para la cuota, lo atrasado se recarga un ${b.latePct} % por día. La deuda se resta de tu patrimonio, así que endeudarte solo conviene si lo que comprás rinde más de lo que cuesta el préstamo.`,
                    targets: ['#bank', '#match-hud'],
                },
            ];
            if (cfg.sprint?.enabled && cfg.sprint.blockLoans) {
                steps.push({
                    title: 'No en el sprint final',
                    text: 'Durante el sprint final no se pueden pedir préstamos nuevos: pedí con tiempo si lo necesitás.',
                    targets: ['#btn-bank'],
                });
            }
            return steps;
        },
    },
    {
        id: 'partida-social',
        place: 'partida',
        title: 'Chat, voz y actividad',
        summary: 'Hablar con tu sala y ver qué hacen los demás.',
        version: 1,
        auto: false,
        steps: ({ cfg, user }) => {
            const steps = [
                {
                    title: 'Chat: Sala y Global',
                    text: 'Hay dos chats. "Sala" es solo de tu partida y ahí aparecen los avisos de compras y ventas; "Global" es para charlar con todos. Sé amable: hay moderadores.',
                    targets: ['#chat-toggle'],
                },
            ];
            if (user && cfg.voice?.enabled) {
                steps.push({
                    title: 'Voz de la sala',
                    text: 'Arriba del chat aparece la voz de tu partida. Entrás escuchando y con el micrófono apagado: tocá el micrófono cuando quieras hablar y volvé a tocarlo para callarte. Con el parlante dejás de oír a todos, y desde la lista podés silenciar a uno solo. Necesita permiso del navegador la primera vez.',
                    targets: ['#voice', '#chat-toggle'],
                });
            }
            steps.push({
                title: 'Actividad de los demás',
                text: 'Las tarjetas que aparecen en pantalla muestran lo que hacen los otros jugadores: compras, subastas, ofertas y ventas. Si te distraen, apagalas en Ajustes → Actividad.',
                targets: ['#feed', '#btn-ajustes'],
            });
            return steps;
        },
    },
    {
        id: 'partida-mejoras',
        place: 'partida',
        title: 'Mejoras',
        summary: 'Invertir en tus propiedades, elegir un perfil y pagar el mantenimiento.',
        version: 1,
        auto: false,
        available: ({ cfg }) => Boolean(cfg.upgrades),
        steps: ({ cfg }) => {
            const u = cfg.upgrades;
            const kinds = Object.entries(u.kinds);
            const levels = kinds[0]?.[1].levels ?? [];
            const n1 = levels.find((l) => l.level === 1) ?? { costPct: 0, boostPct: 0, maintPct: 0 };
            const a = levels.find((l) => l.branch === 'a') ?? { costPct: 0, boostPct: 0, maintPct: 0 };
            const b = levels.find((l) => l.branch === 'b') ?? { costPct: 0, boostPct: 0, maintPct: 0 };
            const logistics = u.kinds.supermercado?.levels.find((l) => l.branch === 'b')?.label ?? 'centro logístico';
            const kindName = (k) => cfg.kinds?.[k]?.label ?? k.charAt(0).toUpperCase() + k.slice(1);
            const branches = kinds.map(([k, v]) => {
                const la = v.levels.find((l) => l.branch === 'a');
                const lb = v.levels.find((l) => l.branch === 'b');
                return `${kindName(k)}: ${la?.label} o ${lb?.label} (${v.branchBEffect})`;
            }).join(' ');
            return [
                {
                    title: 'Dos niveles de mejora',
                    text: `Tocá una propiedad tuya y mirá el bloque Mejoras. El nivel 1 (Reformada) cuesta el ${n1.costPct} % del precio de lista y sube su ingreso un ${n1.boostPct} %. Después podés pasar al nivel 2 eligiendo una especialización. Se sube de a un nivel y no se deshace.`,
                    targets: ['#panel-upgrades', '#panel'],
                },
                {
                    title: 'Elegí una especialización',
                    text: `En el nivel 2 elegís entre dos ramas. La primera rinde más (hasta +${a.boostPct} % de ingreso) pero cuesta ${a.costPct} % del precio y pide más mantenimiento; la segunda rinde +${b.boostPct} %, cuesta ${b.costPct} % y tiene ventajas propias. ${branches}`,
                    targets: ['#up-options', '#panel-upgrades'],
                },
                {
                    title: 'Mantenimiento y neto',
                    text: `Cada mejora tiene un mantenimiento diario (${n1.maintPct} % en el nivel 1, entre ${b.maintPct} % y ${a.maintPct} % en el 2) que se resta de su ingreso: el número que ves es neto y nunca baja de cero. Las crisis te pegan más cuanto más caro sea el mantenimiento. Si vendés al banco perdés la mejora, y en tu patrimonio cada peso invertido cuenta el ${u.netWorthPct} %. ${u.discountPct > 0 ? `Con un ${logistics}, tus mejoras cuestan ${u.discountPct} % menos.` : ''}`.trim(),
                    targets: ['#up-net', '#panel-upgrades'],
                },
            ];
        },
    },
    {
        id: 'partida-herramientas',
        place: 'partida',
        title: 'Herramientas del mapa',
        summary: '3D, ajustes, ocultar paneles, reloj y música.',
        version: 1,
        auto: false,
        steps: () => [
            {
                title: 'Vista 3D y leyenda',
                text: 'Abajo a la izquierda: Leyenda muestra u oculta los tipos de propiedad y 3D cambia a la ciudad en volumen. Para moverte: arrastrá; para acercarte, rueda del mouse o pellizco.',
                targets: ['.toolbar', '#btn3d'],
            },
            {
                title: 'Ajustes',
                text: 'En Ajustes elegís la calidad del 3D, si hay tránsito en las calles, el sonido, la actividad de los demás y la música (con su volumen; la tecla M la silencia).',
                targets: ['#btn-ajustes', '.toolbar'],
            },
            {
                title: 'Ocultar paneles y reloj',
                text: 'El botón Ocultar (o la tecla H) esconde todos los paneles para ver solo el mapa. El reloj de la ciudad marca la hora: de noche se prenden las luces. Tocalo para dejar la luz de día fija; la hora sigue corriendo y es solo visual.',
                targets: ['#btn-ui', '.toolbar'],
            },
        ],
    },

    // ---------------------------------------------------------------- Resultados
    {
        id: 'resultados',
        place: 'resultados',
        title: 'Resultados de la partida',
        summary: 'Cómo leer tu puesto, patrimonio y puntos.',
        version: 1,
        auto: true,
        steps: ({ cfg }) => {
            const f = facts(cfg);
            return [
                {
                    title: 'Tu resultado',
                    text: `Acá ves tu puesto, tu patrimonio final y los puntos que sumaste (${pointsText(f.m.points)} según el puesto, más un bono por propiedad). Perder no resta puntos.`,
                    targets: ['#results-me'],
                },
                {
                    title: 'Tabla final',
                    text: 'La tabla muestra a todos los jugadores ordenados por patrimonio: efectivo más el valor de sus propiedades, menos las deudas.',
                    targets: ['#results-table'],
                },
                {
                    title: 'Jugar otra vez',
                    text: 'Volvés al lobby para crear una sala nueva o unirte a otra. Los puntos ya quedaron sumados en el ranking.',
                    targets: ['#results-again'],
                },
            ];
        },
    },

    // ---------------------------------------------------------------- Explorar
    {
        id: 'explorar',
        place: 'explorar',
        title: 'Recorrer la ciudad',
        summary: 'Mirar el mapa sin jugar una partida.',
        version: 1,
        auto: true,
        steps: ({ cfg, user }) => {
            const steps = [
                {
                    title: 'Explorá Formosa',
                    text: 'Este es el mapa sin partida: podés recorrer la ciudad, tocar cualquier edificio para ver su tipo, precio y cuánto rinde por día. Nada de lo que hagas acá cambia una partida.',
                    targets: [],
                },
                {
                    title: 'Leyenda y 3D',
                    text: 'La leyenda explica los colores y te deja ocultar tipos de propiedad. Con el botón 3D ves los edificios en volumen, y de noche se prenden las luces de la ciudad.',
                    targets: ['#legend', '#btn3d'],
                },
            ];
            steps.push(user
                ? {
                    title: 'Para jugar',
                    text: 'Para jugar una partida volvé al lobby con el botón de arriba: ahí creás una sala o te unís a una.',
                    targets: ['#btn-lobby'],
                }
                : {
                    title: 'Creá tu cuenta',
                    text: `Es gratis y no pedimos tu nombre real. Con cuenta podés crear o unirte a una sala de ${facts(cfg).minutes} minutos; sin cuenta podés recorrer el mapa y mirar el ranking.`,
                    targets: ['.hud-guest'],
                });
            return steps;
        },
    },
];

export const guideById = (id) => GUIDES.find((g) => g.id === id);

/** Guías de un lugar que están disponibles con esta configuración, en el orden del catálogo. */
export const guidesFor = (place, ctx) => GUIDES.filter((g) => g.place === place && (!g.available || g.available(ctx)));

/** Filas del menú de guías del lugar actual, en el orden del catálogo; `status` es new | updated | seen. */
export function menuItems(place, state, ctx) {
    return guidesFor(place, ctx).map((g) => ({ id: g.id, title: g.title, summary: g.summary, status: state.status(g) }));
}
