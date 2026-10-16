# Formosa Tycoon

Un juego tipo Monopoly sobre el mapa real de la ciudad de Formosa (Argentina): cada edificio es una propiedad que se compra, rinde dinero y (desde la Fase 3) se disputa en subasta. Corre en el navegador.

**Estado: Fases 1 a 6 completas, más la actualización de datos desactualizados del mapa (ver más abajo).** Mapa, cuentas de jugador, billetera, cobro de ingresos, mapa en tiempo real, **subasta** cuando dos quieren lo mismo, **chat** con moderación, calidad y carga con datos reales (Fase 5) y pulido: **sonidos, animaciones y tutorial** (Fase 6).

## Puesta en marcha (Laragon)

```bash
composer install                  # incluye laravel/reverb (tiempo real)
# crear la base (HeidiSQL o):  mysql -uroot -e "CREATE DATABASE formosa_tycoon CHARACTER SET utf8mb4"
php artisan migrate:fresh --seed  # tablas + barrio de ejemplo + 4 jugadores de ejemplo
npm install
```

Si ya tenías una fase anterior andando, alcanza con `php artisan migrate` y `npm run build` (o reiniciar `npm run dev`). Las Fases 5 y 6 **no agregan tablas**. Si la base ya tiene propiedades importadas, corré además `php artisan formosa:recalcular-economia` para que tomen los rendimientos nuevos (no toca dueños ni saldos).

Antes de abrirlo a otras personas: `php artisan formosa:chequeo --produccion` revisa la instalación y dice qué falta.

Después, **cuatro terminales** abiertas a la vez (la cuarta es opcional pero recomendada):

```bash
npm run dev                       # 1) el front (Vite)
php artisan serve                 # 2) la aplicación  → http://127.0.0.1:8000
php artisan reverb:start          # 3) el tiempo real (WebSocket, puerto 8080)
php artisan juego:reloj           # 4) cierra las subastas en cuanto vencen (aunque no haya nadie mirando)
```

**Atajo en Windows:** con Laragon prendido (MySQL/MariaDB en verde), `.\scripts\iniciar.ps1` levanta la web, Reverb, el reloj de partidas y el planificador de una vez (necesita haber corrido `npm run build`) y abre el navegador. Ctrl+C lo cierra todo. Para jugar con amigos por internet, `.\scripts\tunel.ps1` hace lo mismo y además abre los túneles de Cloudflare; los dos avisan si la base de datos está apagada.

Abrí http://127.0.0.1:8000, creá una cuenta (recibís $ 40.000) y comprá.

**Pantallas:** `/mapa` es el **lobby** (salas, ranking, historial; liviano, sin mapa ni 3D), `/partida/CÓDIGO` es la partida (sala de espera, juego y resultados en la misma dirección) y `/explorar` es el mapa sin partida. Abrí el mapa en otra ventana (o en otro navegador, con otra cuenta) para ver los cambios en vivo. Si Reverb está apagado, el juego sigue andando y el mapa se actualiza solo cada 20 segundos.

## Cómo se juega

- Tocás una propiedad libre → **Reclamar**. Queda **reservada** para vos: se aparta su precio de tu saldo (aparece como "reservado") y corre una ventana de 10 segundos. Si nadie la disputa, **es tuya al precio de lista**.
- Cada propiedad acumula `ingreso por hora × tiempo`, hasta un tope de 12 h sin cobrar. **Cobrar** lo pasa a tu saldo. Volver seguido rinde más.
- Si otro jugador la quiere en esos 10 segundos, la **disputa**: lo hace pujando el mínimo (precio + 5 %, con un piso de $ 100). Eso abre la **subasta**, que dura 30 segundos y tiene la cuenta regresiva en pantalla.
- Cada puja tiene que superar a la anterior por ese mínimo. Solo el que **va ganando** tiene plata reservada: si lo superan, se le libera al instante y recibe un aviso.
- **Anti-francotirador:** una puja en los últimos 10 segundos estira el cierre 10 segundos más (hasta 6 veces), para que nadie gane con el último milisegundo.
- Al terminar, la propiedad es de la puja más alta, que paga **su propia puja**. Los que perdieron no pagan nada.
- Se puede ir ganando como máximo 5 subastas a la vez. La plata reservada no se puede gastar en otra cosa.
- Todos los tiempos los marca el **servidor**; el navegador solo muestra la cuenta regresiva (corrigiendo la diferencia con su propio reloj).
- Con `FORMOSA_DISPUTA_SEGUNDOS=0` en `.env` se vuelve a la compra directa e instantánea de la Fase 2.
- Tus propiedades llevan borde dorado; las de otros, el color fuerte de su dueño. Lo **libre** se ve en tonos suaves según el tipo (casas arena, comercios celeste, supermercados verde, hoteles lavanda), así lo que tiene dueño resalta de lejos.
- **HUD:** saldo, cantidad de propiedades, ingreso por hora y tu **puesto en el ranking**.
- **Mis propiedades:** lista de lo tuyo ordenada por ingreso, con lo acumulado en cada una; tocar una te lleva a ella en el mapa.
- **Ranking:** los 20 jugadores con más patrimonio (saldo + precio de lista de sus propiedades), con tu puesto aunque no estés entre ellos. Lo ve cualquiera, también sin cuenta.
- **Vender al banco:** en la ficha de una propiedad tuya, por el **60 %** del precio de lista (`economy.sell_ratio` en `config/formosa.php`). Pide confirmar con un segundo toque. Antes se te acredita lo que tenía acumulado; queda en el libro como "venta" y la propiedad queda libre para cualquiera. Comprar y vender enseguida siempre pierde plata.
- **Ficha:** el título dice dónde está ("Casa en Calle 5") en vez de repetir el tipo, y muestra **en cuántas horas se paga** con lo que rinde.
- **Vista 3D (botón 3D):** la ciudad se arma con three.js al activarla (no pesa en la carga inicial): casas con techo a dos aguas, chimeneas y ventanas; comercios con toldo de color; supermercados; hoteles en torre de 6 a 14 pisos; césped, ~7.000 árboles en veredas y patios, calles de asfalto con veredas y línea central amarilla, y faroles. Lo que tiene dueño lleva **el techo del color del jugador** y lo tuyo, **techo dorado**. Se toca el edificio (paredes o techo) para abrir su ficha. Los filtros de la leyenda también valen en 3D.
- **Hora de la ciudad:** el reloj del HUD marca la hora interna. **24 horas de juego son 24 minutos reales** (1 segundo real = 1 minuto de juego; `FORMOSA_MINUTOS_POR_DIA` lo cambia). Sale de la hora del servidor, así todos ven la misma. Franjas: **madrugada** (0 a 6), **día** (6 a 13), **tarde** (13 a 20) y **noche** (20 a 24). La luz cambia de a poco: amanecer y atardecer cálidos, noche azulada; en 3D se prenden ventanas y faroles, y en 2D el mapa se oscurece con un filtro suave. Tocar el reloj deja la luz de día fija (la hora sigue corriendo). `/explorar?hora=21` muestra cómo se ve a esa hora. Es solo visual: no cambia precios, ingresos ni subastas.
- **Barra de herramientas** (abajo a la izquierda): Leyenda (abierta en escritorio, plegada en celular; se recuerda), 3D, Sonido y `?` (guía). En pantallas táctiles todo lo que se toca mide 44 px o más.
- **Sonidos** (compra, cobro, puja, te superaron, ganaste, perdiste, chat y error): se sintetizan en el navegador, no hay archivos de audio. Se activan o apagan con el botón *Sonido* y se recuerda la elección. Hasta el primer toque no suena nada (lo exige el navegador).
- **Animaciones:** un anillo marca la propiedad que cambia de dueño (también las compras de otros, si están a la vista), el saldo corre hasta el valor nuevo y destella, y los montos suben desde el botón al cobrar o comprar. Con "reducir movimiento" activado en el sistema, se apagan todas.
- **Guías:** ver la sección *Pantallas y guías* más abajo (reemplazan al tutorial único anterior).

## Chat

El botón **Chat** (abajo a la derecha) abre el chat, con **dos pestañas** para que no haya confusión:

- **Sala**: solo los jugadores de **tu partida**. Además de lo que escriben, muestra los **avisos automáticos del juego** (en verde, sin autor y sin opción de reportar): *"Ana compró Supermercado Carrefour por $150.000"*, subasta ganada, venta al banco, quién entra, sale o abandona, el inicio, *"Quedan 10 / 5 minutos"* y el final con el ganador. Es un canal **privado** (`partida.{id}.chat`): lo autoriza `POST /broadcasting/auth` (sesión + CSRF, solo para quien juega esa partida) y el historial (`GET /api/partidas/{id}/chat`) da 403 a quien no es de la partida. Al terminar o abandonar la partida la pestaña queda en **solo lectura** hasta que empiece otra. Sin partida, la pestaña no existe.
- **Global**: todos los jugadores, charla libre (`GET/POST /api/chat/global`; `/api/chat` sigue andando igual). Cualquiera puede **leerlo**, incluso sin cuenta; **escribir** exige estar registrado. No recibe avisos del juego.
- Los límites, el anti-spam, la moderación (reportar, ocultar, silenciar) y la retención funcionan en los dos; un silencio vale en ambos. Cada pestaña tiene su contador de no leídos (los avisos del juego no suman) y se recuerda la última que usaste.
- Los avisos del juego se generan en el servidor, **después** de confirmar la compra, la subasta o el cierre, y si el chat falla la operación sigue igual.
- Para que la sala llegue en vivo, el servidor web tiene que exponer `/broadcasting/auth` (ya está registrado en `bootstrap/app.php`, con un límite de 30 por minuto y jugador). Si la autorización falla o Reverb está caído, la sala se lee por consulta cada 10 s.

Reglas comunes:

- Los mensajes llegan en vivo por Reverb (canal público `chat` para el global). Si el tiempo real se cae, se leen de nuevo solos (cada 10 s, y de una al reconectar), sin perder ni repetir ninguno.
- Hasta 280 caracteres, en una sola línea. Se quitan los caracteres invisibles o de control (y los que invierten el sentido de lectura) y las cadenas de marcas combinantes.
- Todo se muestra como **texto**: si alguien escribe HTML, se ve tal cual y no se ejecuta.
- **Anti-spam:** 10 mensajes por minuto y 150 por hora por jugador, 60 por minuto por IP (así crear cuentas no multiplica el cupo), y el mismo texto no se acepta de nuevo durante 30 s.
- **Sin duplicados:** cada envío lleva una clave; si el navegador reintenta (doble toque, red lenta) el servidor devuelve el mismo mensaje en vez de guardar otro.
- Se guardan 7 días (`FORMOSA_CHAT_DIAS`), con tope **por canal**: 5.000 mensajes en el global y 1.000 en cada sala (`formosa.chat.room_max_rows`); una sala terminada se conserva hasta cumplir los 7 días. `php artisan chat:limpiar` borra el resto; el planificador lo corre cada hora (ver abajo).
- Un punto rojo con número en el botón avisa de mensajes sin leer.

## Moderación del chat

- **Reportar:** en cada mensaje ajeno hay un botón `⋯` con los motivos (spam, acoso, contenido ofensivo, otro). Cada jugador reporta un mensaje una sola vez.
- **Ocultado automático:** con **3 reportes de cuentas distintas** el mensaje desaparece para todos (en vivo) hasta que un moderador lo revise. Para que nadie arme cuentas falsas para censurar, solo cuentan los reportes de cuentas con más de **12 horas** (`FORMOSA_REPORTE_EDAD_HORAS`; poné `0` en tu `.env` para probarlo en local con cuentas recién creadas), nunca se oculta solo un mensaje de un moderador, y un mensaje que un moderador ya revisó no se vuelve a ocultar solo.
- **Moderadores:** se asignan **solo por comando** (no hay formulario ni forma de pedirlo al registrarse):

  ```bash
  php artisan moderador:asignar Ana            # le da el rol
  php artisan moderador:asignar Ana --quitar   # se lo saca
  ```

  Un moderador ve el enlace **Moderación** en el mapa (página `/moderacion`) y, en el chat, opciones extra por mensaje: **Ocultar** y **Silenciar** al autor (10 min, 1 h, 1 día o 7 días).
- **La página `/moderacion`** lista los mensajes reportados u ocultos (con cuántos reportes, por qué motivo y cuántos vienen de cuentas nuevas), permite **restaurar**, **descartar reportes** o **silenciar**, y muestra los silencios vigentes para **levantarlos**. Descartar los reportes de un mensaje que se ocultó solo por reportes lo vuelve a mostrar.
- **Salas y partidas** (`/moderacion/salas`): lista de partidas (activas, terminadas, vencidas o todas, con búsqueda por código, nombre de sala o creador) y, al entrar a una, su **ficha**: datos de la partida, cada jugador (efectivo, propiedades, patrimonio, ingreso por día, puesto, cuándo entró o salió, si abandonó o está silenciado, mensajes y cuenta) y el chat de la sala con los mensajes ocultos marcados. No muestra correos ni IP. Desde la ficha se puede **silenciar** o levantar el silencio, **ocultar** o restaurar mensajes (las mismas acciones de arriba, y vuelven a la ficha) y **cerrar una sala trabada**: una sala abierta sin iniciar se vence y libera a sus jugadores; una partida en juego solo se puede cerrar cuando ya pasó su hora de fin (puestos, puntos y ranking salen igual que con el reloj). Una partida a la que todavía le queda tiempo no se toca. El cierre queda en `moderation_log` como `cerrar_sala`.
- Un silenciado puede leer y reportar, pero no escribir (ve hasta qué hora). Un moderador no puede silenciarse ni silenciar a otro moderador.
- **Registro de todo** (tabla `moderation_log`): quién ocultó, restauró, descartó o silenció a quién y cuándo, con copia del texto del mensaje. No se borra con la limpieza del chat. También queda anotado el ocultado automático y los cambios de rol.

Para que la limpieza corra sola hace falta el planificador: `php artisan schedule:work` en una terminal (o, en un servidor, el cron `* * * * * php artisan schedule:run`). Si no corre, el chat sigue funcionando pero la tabla crece.

## Cómo se cierran las subastas

Cualquiera de estas tres cosas cierra una subasta vencida (es seguro que pasen a la vez: solo el primero cierra y cobra):

1. **`php artisan juego:reloj`** (recomendado): un bucle que revisa cada segundo. Funciona aunque no haya ningún navegador abierto.
2. **Los navegadores**: cuando la cuenta regresiva llega a cero, el navegador le pide al servidor que cierre.
3. **`php artisan schedule:work`** + la tarea `subastas:cerrar` (cada minuto) o una lectura pública de `/api/subastas`: respaldo lento.

Si no corre ninguna, las subastas vencidas quedan en pausa (la plata sigue reservada) hasta que pase una de las tres cosas. En producción, dejá `juego:reloj` como servicio (Supervisor / systemd) y avisá si `subastas:cerrar` reporta atrasos.

Variables opcionales en `.env`: `FORMOSA_DISPUTA_SEGUNDOS` (10), `FORMOSA_SUBASTA_SEGUNDOS` (30), `FORMOSA_SUBASTAS_MAX` (5). El resto (incremento, tiempo extra) está en `config/formosa.php`, sección `auction`.

## Economía y su calibración

Los valores (dinero inicial, precios, rendimientos, tope) están en `config/formosa.php` y salen de una simulación:

```bash
php artisan formosa:simular-economia                         # 20 jugadores, 14 días, con lo que haya en la base
php artisan formosa:simular-economia --jugadores=300 --dias=30
php artisan formosa:simular-economia --escala=0.5            # rendimientos a la mitad
php artisan formosa:simular-economia --dinero-inicial=20000 --tope-horas=12
php artisan formosa:recalcular-economia                      # aplica los números de config/ a propiedades ya importadas
```

**Calibración de la Fase 5**, hecha con el reparto real de Formosa (12.328 casas, 161 comercios, 15 supermercados, 9 hoteles; precio mediano $ 11.000):

| | Antes (1 %/h, tope 24 h, $ 30.000) | Ahora (0,4 %/h, tope 12 h, $ 40.000) |
|---|---|---|
| Una casa recupera su precio en | ~4 días | ~10 días cobrando todo |
| Patrimonio mediano a los 14 días | ×19 | ×2,4 |
| Mapa libre a los 14 días, con 200 jugadores | 37 % | 83 % |
| Mapa libre a los 14 días, con 1.000 jugadores | 0 % (agotado) | 30 % |
| Mapa libre a los 30 días, con 200 / 1.000 jugadores | — | 50 % / 0 % |

Con el rendimiento anterior la plata se multiplicaba por 19 en dos semanas y el mapa se agotaba enseguida; ahora la temporada dura semanas y entrar seguido rinde más: a los 30 días un jugador intenso (8 visitas por día) tiene ~3 veces más propiedades que uno casual (1 por día). Los supermercados y hoteles son pocos (24 en total) y rinden apenas más por peso (0,48 % y 0,5 % por hora): son premios a disputar en subasta, no una forma de enriquecerse rápido. Si el juego queda muy lento o muy rápido en la práctica, se ajusta `rate_per_hour` y se corre `formosa:recalcular-economia`.

## Datos reales de Formosa

```bash
# poner un mail en OVERPASS_CONTACT dentro de .env, y después:
php artisan formosa:importar --simular    # muestra qué importaría, sin guardar
php artisan formosa:importar              # importa edificios, comercios y calles
```

- Fuente: OpenStreetMap vía Overpass. Mostramos "© OpenStreetMap contributors" (licencia ODbL).
- Re-importar es seguro: actualiza rubros, nombres, precios y geometrías, **nunca** el dueño ni los cobros. Lo que un moderador corrigió a mano **no se pisa** (ver más abajo). Si cambiás precios en la configuración, usá `formosa:recalcular-economia`.
- **Rendimiento con datos reales:** el centro de Formosa trae unas 12.500 construcciones (casi todas casas). `/api/propiedades` pesa ~4 MB y viaja comprimido (~0,4 MB); se arma una vez por importación y se reparte desde la caché. Para medir la fluidez en tu PC abrí `/explorar?debug=1` y mové el mapa: arriba aparecen los cuadros por segundo.
- **Qué se hizo en la Fase 5 para que ande fluido:** los bordes de las propiedades solo se dibujan de cerca (zoom 14,5 o más); los resaltes (tus propiedades, subastas, selección) viven en una capa aparte que contiene solo las pocas propiedades marcadas, en vez de tres capas de bordes sobre las 12.500; y se apagó el antialias del relleno. Medido con 13.000 propiedades y render por software (mucho más lento que una placa de video real): mover el mapa pasó de 3 a ~8 cuadros/s y el zoom de 3 a ~6,5. El encuadre inicial ignora el 1 % de propiedades más alejadas para que una propiedad suelta en el campo no deje la ciudad diminuta.
- Sin conexión a Overpass: `--archivo=edificios.json --calles-archivo=calles.json` con respuestas ya descargadas.

## Entorno 3D y muestra de datos

`formosa:importar` también baja el **entorno** de la ciudad 3D: río y lagunas, plazas, parques, canchas, usos del suelo, edificios emblemáticos (catedral, Casa de Gobierno, estación, museos, iglesias, monumentos) y mobiliario de calle (semáforos, paradas de colectivo, cruces peatonales). Se guarda en `storage/app/private/formosa/entorno.geojson` y se sirve en `GET /api/entorno`.

- Calles y entorno se piden en la zona **ampliada 500 m** hacia cada lado (`environment.margin_m` en `config/formosa.php`), así la ciudad no termina en seco; las propiedades siguen siendo solo las de la zona. Las superficies muy grandes (el río Paraguay) se recortan a esa caja.
- Las calles ahora guardan sentido (`oneway`), carriles, ancho, calzada (asfalto, tierra…), velocidad máxima, rotondas y puentes. Un archivo de calles viejo sigue andando.
- Si el entorno no se puede descargar, se avisa y la importación **sigue** (queda el entorno anterior).
- Sin conexión: `--entorno-archivo=entorno.json`. Con `--archivo` y sin `--entorno-archivo` no se descarga (igual que las calles).
- El barrio de ejemplo (`php artisan db:seed`) trae un bulevar de dos manos, calles de tierra, una peatonal, el río, la Plaza San Martín, una plaza chica, emblemáticos, semáforos y paradas.

Para probar el 3D con la ciudad real sin pasar la base entera:

```bash
php artisan formosa:exportar-muestra                       # → storage/app/private/formosa/muestra.json
php artisan formosa:exportar-muestra --distrito=microcentro-costanera --salida=muestra.json
```

Escribe un solo JSON con `generated_at`, `district`, `properties` (id, tipo, nombre, superficie, lat/lng y geometría), `roads` y `environment`. **No lleva dueños, precios ni datos de jugadores**: se puede mandar tranquilo. El comando muestra la ruta y el tamaño del archivo.

## Datos del mapa desactualizados (comercios que cerraron o cambiaron)

OpenStreetMap lo editan voluntarios y en Formosa está viejo: hay locales que cerraron o cambiaron de rubro. Hay dos caminos, que se complementan.

**1. Corregir desde el juego**
- **Cualquier jugador con sesión** abre una propiedad y toca **¿Datos desactualizados?**: elige qué cambió (ya cerró, otro rubro, cambió de nombre, no existe o está mal ubicado) y puede dejar una nota de hasta 140 caracteres. Un aviso **nunca cambia nada solo**: así no se puede manipular el mapa con cuentas falsas. Un jugador no puede tener más de 20 avisos esperando revisión.
- **Los moderadores** ven en la misma ficha **Corregir datos**: eligen rubro y nombre, o tocan **Marcar como cerrado** (el local pasa a ser una casa sin nombre). La ficha les muestra los avisos de jugadores y la última corrección. Al guardar, todos los mapas abiertos se actualizan en vivo (color, nombre, precio e ingreso).
- **`/moderacion/mapa`** es la cola de revisión: propiedades con avisos (las más avisadas primero), con las notas, enlace **Ver en el mapa**, corregir, marcar como cerrado o **descartar** el aviso (estaba bien). Abajo, el historial de correcciones. Se llega también desde la página de moderación del chat.
- Corregir cambia el rubro y por eso el **precio y el ingreso** (salen del rubro y la superficie). Si la propiedad **tiene dueño, se le acredita antes lo que había acumulado a la tarifa vieja** (queda en el libro como un cobro), así nadie pierde ni gana por el cambio a mitad de camino. Si el rubro baja (de hotel a casa), el dueño conserva la propiedad pero ya no rinde lo mismo: no hay reembolso.
- **No se corrige una propiedad reservada o en subasta** (los jugadores están pujando por el precio que ven); hay que esperar a que termine.
- Todo queda en la tabla `property_edits` (qué había, qué quedó, quién, por qué, cuánto se acreditó). Corregir marca la propiedad como **corregida a mano**; también sirve para "confirmar que está bien" y protegerla.

**2. Volver a bajar OpenStreetMap sin perder las correcciones**

```bash
php artisan formosa:importar --simular                      # compara con lo que hay y muestra qué cambiaría
php artisan formosa:importar                                # aplica lo nuevo de OSM
php artisan formosa:importar --ausentes=casa                # además: comercios que ya no figuran pasan a casa
```

- Lo corregido a mano o en subasta solo actualiza la **forma** del edificio; rubro, nombre y precio no se tocan.
- Si OSM cambió el ingreso de una propiedad con dueño, se le acredita antes lo acumulado.
- Los comercios que **ya no aparecen** en OSM solo se avisan, salvo que uses `--ausentes=casa` (pasan a casa sin nombre; no se marcan como corregidos, así la próxima importación puede volver a decidir). Si la descarga trae menos del 70 % de lo que hay, el comando se detiene (puede ser una descarga cortada de Overpass); `--forzar` lo ignora.
- **Lo importante:** esto solo trae lo que alguien ya corrigió en OpenStreetMap. Si el dato está viejo allá, sigue viejo acá. Lo más duradero es corregirlo en [openstreetmap.org](https://www.openstreetmap.org) (cualquiera puede, con una cuenta gratuita): beneficia a todos y entra solo en la próxima importación.

## Cómo se decide qué es cada edificio

Por las etiquetas de OpenStreetMap, en este orden: hotel › supermercado › comercio › casa. Un `building=yes` genérico cuenta como casa solo si mide entre 20 y 600 m². Un comercio mapeado como punto se fusiona con el edificio que lo contiene o, si no hay, recibe una huella sintética de 12 m. Precio = base del tipo × factor por superficie (0,6 a 2,0), redondeado a 500.

## Pantallas y guías

Tres pantallas, cada una con su dirección:

- **`/mapa` — el lobby.** Liviano: no carga el mapa ni el 3D ni las propiedades. Crear una sala, unirse con un código o desde la lista (se actualiza en vivo), ranking, historial y la pestaña **Cómo se juega**. Si estás en una partida, una tarjeta te lleva de vuelta. Los visitantes ven las salas y el ranking, y cómo ingresar.
- **`/partida/CÓDIGO` — la partida.** Sala de espera, juego y resultados viven en la misma dirección. El código se compara sin importar mayúsculas. Si la sala no es tuya, no existe o venció, volvés al lobby con un aviso. Abandonar también vuelve al lobby.
- **`/explorar` — el mapa sin partida.** Para recorrer la ciudad. `/explorar?hora=21` muestra la luz de esa hora, `/explorar?debug=1` los cuadros por segundo y `/explorar?p=ID` abre esa propiedad (lo usa la página de revisión de moderadores).

**Guías.** Son datos con versión (`resources/js/guides/guides-model.js`) y un solo motor. Hay 15, agrupadas por lugar: lobby (bienvenida, salas, ranking), sala de espera (sala, chat y voz), partida (tablero, comprar, subastas, ofertas, combos y eventos, banco, chat y actividad, herramientas), resultados y explorar. Los textos usan los números reales de la configuración (`PublicConfig::forLobby`), y lo que está apagado (eventos, sprint, voz, banco) no aparece.

- La **guía principal de cada lugar se abre sola la primera vez**, una sola vez (se guarda en `localStorage`, clave `formosa.guias.v1`; si se sube la `version` de una guía vuelve a figurar como *Nuevo*). Los navegadores automatizados no las abren solas.
- El botón **`?`** abre el menú de guías del lugar donde estás, con la marca *Nuevo*. Algunos paneles tienen su propio **`?`** (banco, subastas, ofertas, eventos y sprint) que abre la guía de ese tema.
- **`?guia=ID`** en la dirección fuerza una guía (por ejemplo `/explorar?guia=partida-comprar`); las pruebas automáticas la usan.
- La pestaña **Cómo se juega** del lobby muestra todas las guías como texto, para leerlas antes de jugar sin marcarlas como vistas.
- Cada guía se cierra con *Saltar* o Escape, que devuelve el foco a donde estabas.

## Pruebas

```bash
php artisan test
```

341 pruebas (SQLite en memoria y MariaDB 10.11). Las que comprueban restricciones CHECK de la base solo corren en MySQL/MariaDB/PostgreSQL.

Pruebas de JavaScript (hora del día, geometría 3D, guías, lobby; sin dependencias): `npm run test:js`.

## Estructura

| Dónde | Qué |
|---|---|
| `app/Economy/` | `EconomyService` (compra directa, cobro, billetera), `AuctionService` (reserva, disputa, pujas, cierre), `AuctionRules` y `ChatRules` (reglas puras), `ChatService` (enviar, leer, limpiar, avisos de sistema), `RoomNotices` (texto de los avisos del juego en la sala), `ModerationService` (reportes, ocultar, silencios, registro), ingresos, simulador |
| `app/Formosa/` | Importación: Overpass, clasificación, precios, geometría, barrio demo |
| `app/Http/Controllers/` | `LobbyController` (`/mapa`), `GameScreenController` (`/partida/CÓDIGO` y `/explorar`), `MapController` (API pública del mapa), `GameController` (reclamar/cobrar), `AuctionController` (pujar, cerrar, listar), `ChatController` (leer y enviar, global y sala), `ModerationController`, `AuthController` |
| `app/Console/Commands/` | `juego:reloj` (cierra subastas al vencer), `subastas:cerrar`, `chat:limpiar`, `moderador:asignar`, `formosa:chequeo` (revisión de la instalación), `formosa:recalcular-economia`, importador (con `--ausentes`) y simulador |
| `app/Events/` | Avisos en vivo: `PropertyOwnerChanged` y `AuctionUpdated` (canal público `map`), `ChatMessageSent` y `ChatMessageHidden` (canal público `chat` si es del global, privado `partida.{id}.chat` si es de una sala) |
| `resources/js/map/` | Mapa (MapLibre), llamadas a la API, estado del jugador, conexión en vivo (Echo), resaltes (`highlights.js`), sonido (`sound.js`), animaciones (`effects.js`) |
| `resources/js/lobby/` | Lobby (`/mapa`): salas, ranking, historial y manual; no carga el mapa ni three.js |
| `resources/js/guides/` | Guías: catálogo con textos (`guides-model.js`), estado "visto" (`guides-state.js`), motor y menú (`guide.js`) y manual (`manual-model.js`) |
| `app/Support/PublicConfig.php` | Configuración pública del navegador: `forLobby` (reglas para textos) y `forGame` (suma datos del mapa) |
| `config/formosa.php` | Zonas, tipos, precios, rendimientos y economía |

## Reglas de diseño que conviene no romper

- Solo `EconomyService` y `AuctionService` mueven saldos o cambian dueños: todo en una transacción, bloqueando **siempre en el mismo orden**: propiedad, subasta, billeteras (por id).
- No usar `lockForUpdate()` para buscar una subasta que puede no existir: en InnoDB bloquea un "hueco" del índice y dos reclamos sobre propiedades distintas se traban entre sí (deadlock). La fila de la propiedad ya serializa todo lo de su subasta.
- La plata reservada (`wallets.reserved`) es siempre la suma de las pujas que el jugador va ganando; la base impide que supere el saldo. Cada cambio de saldo deja un movimiento en `ledger_entries` (saldo = suma del libro).
- Dinero siempre en enteros. Nada de decimales.
- Los textos de OpenStreetMap y los apodos son datos no confiables: en el front se pintan con `textContent`.
- La lectura pública del mapa (`/api/propiedades*`, `/api/calles`, `/api/subastas`) y el cierre de subastas no usan sesión ni cookies; el cierre tiene su propio límite de pedidos.
- Moderación: el rol se lee de la base en cada pedido y se exige en el middleware **y** en el servicio; el cliente solo decide qué botones mostrar. Toda decisión queda en `moderation_log`.
- El chat guarda y numera en el servidor; el autor sale SIEMPRE de la sesión (nunca del pedido) y el cliente descarta repetidos por número. Los límites son por jugador **y** por IP; el control de texto repetido es blando a propósito (el límite duro es el rate limiter).
- Los plazos de la subasta son del servidor, en segundos enteros redondeados hacia arriba. El navegador nunca decide quién ganó.

## Para publicarlo en internet

Corré `php artisan formosa:chequeo --produccion`: revisa todo lo de abajo y sale con error si algo grave falta (sirve en un script de despliegue).

### Desplegar en Render

El archivo [`render.yaml`](./render.yaml) define la aplicación web, una base PostgreSQL, Reverb (WebSocket), el reloj del juego y el planificador. El [`Dockerfile`](./Dockerfile) compila los recursos de Vite e instala PHP con soporte para PostgreSQL.

1. Subí este repositorio a GitHub y en Render elegí **New > Blueprint**, conectá el repositorio y confirmá los recursos declarados. El Blueprint crea recursos `starter` y una base `basic-256mb`, que son planes pagos de Render; revisá los precios antes de aprobarlos.
2. El primer despliegue ejecuta `php artisan migrate --force`. No carga datos de demostración: registrá una cuenta y, si querés poblar el mapa, importalo después desde los comandos de administración.
3. El Blueprint genera `APP_KEY` y las credenciales de Reverb en un grupo de entorno compartido. No las reemplaces por las claves de ejemplo del `.env.example`. Si elegís otro nombre de servicio o dominio, actualizá `APP_URL`, `REVERB_ALLOWED_ORIGINS` y `VITE_REVERB_HOST` en ese grupo; el host de Reverb para el servidor Laravel (`REVERB_HOST`) debe seguir siendo su nombre privado interno.
4. Configurá un correo SMTP en el servicio web si vas a habilitar verificación de cuentas o recuperación de contraseña. En Render, agregá `MAIL_MAILER`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_SCHEME` y `MAIL_FROM_ADDRESS` como variables secretas.

Render usa PostgreSQL administrado y conserva sesiones y caché en la base. Reverb, el reloj de un segundo y el planificador corren como servicios separados. Para comprobar la instalación, ejecutá `php artisan formosa:chequeo --produccion` desde la consola del servicio web. Si importás datos nuevos del mapa, asegurate de publicar también sus archivos estáticos con `php artisan mapa:publicar`.

**Configuración**
- `APP_ENV=production`, `APP_DEBUG=false`, `APP_URL` con `https`, `SESSION_SECURE_COOKIE=true`.
- Claves propias de Reverb (`REVERB_APP_KEY`/`SECRET`): con las de ejemplo la aplicación se niega a arrancar en producción. `REVERB_ALLOWED_ORIGINS=tu-dominio.com`.
- `TRUSTED_PROXIES` con la IP **concreta** del proxy (no `*` si el servidor se puede alcanzar sin pasar por él: se podría falsificar la IP y esquivar los límites). Cerrá el acceso directo al servidor.
- `CACHE_STORE=file`, `database` o Redis (no `array`: los límites de pedidos y la caché del mapa no persistirían).

**Procesos que tienen que estar corriendo**
- `php artisan reverb:start` (tiempo real). Si se cae, el juego sigue: los mapas se actualizan por consulta cada 20 s.
- `php artisan juego:reloj` como servicio (systemd, Supervisor o NSSM en Windows): cierra las subastas puntualmente.
- El planificador (`php artisan schedule:work`, o un cron cada minuto con `schedule:run`): limpia el chat. Sin él el chat crece sin límite de antigüedad.
- Opcional, para muchos jugadores: `QUEUE_CONNECTION=database` y `php artisan queue:work` (los avisos en vivo salen fuera del pedido del jugador).

**Cuentas**
- **Recuperar la contraseña:** "¿Olvidaste tu contraseña?" en la pantalla de ingreso manda un enlace de un solo uso (vence en 60 min). Responde lo mismo exista o no la cuenta, y tiene límite por IP. Necesita un `MAIL_MAILER` real; con `log`, el enlace queda en `storage/logs/laravel.log`.
- `FORMOSA_ANTIBOT=true` (por defecto): el registro lleva un campo trampa y no acepta formularios enviados en menos de 3 segundos ni vencidos. Frena bots simples sin servicios externos; **no** reemplaza a un CAPTCHA si el juego recibe ataques serios.
- `FORMOSA_VERIFICAR_EMAIL=true`: hay que confirmar el correo (enlace firmado de 60 minutos, reenvío limitado) antes de comprar, pujar, cobrar, escribir o reportar. Necesita un `MAIL_MAILER` real (SMTP, Mailgun, SES…); en desarrollo, `MAIL_MAILER=log` deja el enlace en `storage/logs/laravel.log`. Recomendado antes de abrir al público: los silencios del chat son por cuenta y, sin verificar, se esquivan creando otra.
- Pendiente (decisión tuya): una política de contenido para los moderadores y, si hay abuso real, un CAPTCHA.

**Seguridad incluida** (probada con 43 ataques automáticos contra el servidor y con navegadores reales)
- **Content-Security-Policy con nonce** en cada página: solo corren los scripts propios; un `<script>` o un `onerror` inyectado no se ejecuta. Con `npm run dev` se omite (Vite inyecta sus propios scripts).
- CSRF en todo lo que escribe, cookies `HttpOnly` y `SameSite=Lax`, APIs públicas sin cookies ni correos, ids validados, montos validados, apodos sin HTML, el rol de moderador no se puede pedir al registrarse.
- Login: 5 intentos por correo+IP por minuto **y** 30 por cuenta por hora desde cualquier IP (frena probar contraseñas con muchas IP). Mismo mensaje de error exista o no la cuenta.
- El tiempo real no acepta mensajes de los navegadores (solo el servidor publica).
- `formosa:chequeo` avisa si `REVERB_ALLOWED_ORIGINS` es `*` o si el correo no sale a ningún lado.
- **Pendiente de tu lado:** correr `composer audit` (desde acá no se llega a Packagist; `npm audit` dio 0 vulnerabilidades).

**Rendimiento en Apache (Laragon)**: `public/.htaccess` comprime JS, CSS y JSON (la primera carga baja de ~1,6 MB a ~0,45 MB) y deja que el navegador guarde un año los archivos de `/build` (cambian de nombre en cada `npm run build`). MapLibre va en un archivo aparte: al actualizar el juego solo se baja de nuevo el código propio (~40 KB). Con `php artisan serve` no hay compresión: para medir, usá Apache o Nginx.

## Lo que se midió en la Fase 5 (límites conocidos)

Medido en un servidor de desarrollo de 2 núcleos compartido con el generador de carga, así que son pisos, no techos; con Nginx + PHP-FPM + OPcache rinde bastante más.

- **Lecturas públicas** (`/api/subastas`, `/api/chat`, `/mapa`, `/api/propiedades` con ETag): 70 a 95 pedidos/s por servidor de desarrollo, casi todo el costo es el arranque de Laravel. `/api/propiedades/estado` (todos los dueños, 280 KB con 6.000 propiedades ocupadas) pasó de 53 a 84 pedidos/s al guardarse en caché por "versión de dueños" (se invalida con cada compra o cierre) y responder 304 cuando no cambió.
- **Escrituras concurrentes:** 40 jugadores comprando, pujando, escribiendo y consultando a la vez, más 16 reclamando la misma propiedad, 12 pujando lo mismo, cierres contra pujas y cobros simultáneos: **cero** violaciones del libro (saldo = suma de movimientos), de reservas, de dueños o de cobros dobles; cero excepciones y cero deadlocks.
- **Tiempo real:** 900 conexiones simultáneas a Reverb reciben cada aviso en ~25 ms. **Con el bucle de eventos por defecto de PHP, Reverb se cae al pasar de ~1.000 conexiones** (límite de `select()`). Para más jugadores a la vez hay que instalar `ext-uv` o `ext-event` (Linux) o repartir en varios servidores. Hasta entonces, un jugador sin conexión en vivo sigue jugando por consulta.

## Privacidad

No se guardan nombres de particulares ni números de puerta: solo edificios, comercios con nombre público y calles. El apodo de cada jugador es público (aparece como dueño en el mapa): el formulario pide no usar el nombre real.
