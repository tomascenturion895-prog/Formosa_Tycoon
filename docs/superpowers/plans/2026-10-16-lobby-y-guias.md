# Lobby, pantalla de partida y guías — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/mapa` pasa a ser un lobby liviano, la partida vive en `/partida/{código}`, el mapa libre en `/explorar`, y cada lugar tiene sus propias guías.

**Architecture:** Dos vistas Blade con entradas Vite separadas (lobby sin MapLibre/three; juego como hoy) y una clase `PublicConfig` compartida. Las guías son datos puros con versión (`guides-model.js`) más un motor DOM único (`guide.js`) que generaliza `tutorial.js`; el "visto" vive en `localStorage`.

**Tech Stack:** Laravel 13 / PHP 8.3 (PHPUnit), Vite 8, JS vanilla en módulos ES (`node --test`), MapLibre GL, Reverb/Echo, Playwright para el recorrido en navegador.

**Spec:** `docs/superpowers/specs/2026-10-16-lobby-y-guias-design.md`

## Cómo se prueba y se entrega (este proyecto no usa git)

- Donde otros planes dicen "commit", acá es un **punto de control**: la suite correspondiente en verde.
- PHP: `S=/tmp/claude-0/-home-claude/1c90124d-eb93-5237-ab33-3d1675a8e5a4/scratchpad; bash $S/sync.sh && cd $S/ft-test && php artisan test --filter=<Clase>` (todo: sin `--filter`).
- JS: `cd /home/claude/formosa-tycoon && node --test tests/js/<archivo>.test.mjs` (todo: `npm run test:js`).
- Navegador: `bash $S/sync-e2e.sh && bash $S/start-e2e.sh` (web `:8001`, Reverb `:8081`, base `formosa_e2e`) y scripts Playwright en `$S`.
- Entrega al final de cada etapa: copiar los archivos cambiados a `/mnt/user-data/outputs/<nombre>/<ruta>`, `device_commit_files` a `C:\laragon\www\formosa-tycoon\<ruta>`, comprobar md5 con `device_bash`. Nunca tocar `.env`, `vendor/` ni `node_modules/` de la PC; no borrar nada sin permiso. En la PC: `npm run build` y reiniciar el lanzador (no hay migraciones).

## Global Constraints

- Sin cambios de base de datos, de economía ni de endpoints públicos nuevos; el "visto" es solo del navegador (`localStorage`, clave `formosa.guias.v1`).
- Todo texto de guías, salas y jugadores se escribe con `textContent` (nunca HTML) y sin estilos en línea en el marcado (CSP).
- `{código}` valida `[A-Za-z0-9]{4,12}`; fuera de eso, 404. Se compara siempre en mayúsculas y sin espacios.
- El grafo de importaciones de `resources/js/lobby/main.js` no incluye `maplibre-gl`, `three`, `map/main.js`, `map/intro.js` ni `map/city*`.
- `?guia=ID` reemplaza a `?tutorial=1` y `?lobby=1`. `/mapa?p=`, `?hora=` y `?debug=` pasan a `/explorar`.
- Español rioplatense en toda la interfaz (voseo). Textos de guías con los números reales de `cfg`.

## Review Focus

1. Visitante o persona ajena abre `/partida/ABC123`: va al lobby con el código cargado y un aviso; nunca pantalla en blanco ni error (Task 5).
2. Código en la URL en minúsculas o con espacios apunta a la misma sala (Task 5).
3. `localStorage` bloqueado o con contenido corrupto: las guías siguen funcionando y no lanzan (Task 7).
4. La sala vence, se cierra o se abandona mientras se está en `/partida/CÓDIGO` (también desde otra pestaña): aviso y vuelta al lobby, sin quedar colgado (Task 5).
5. Funciones apagadas (eventos, voz, sprint, banco) o `cfg` incompleto: ninguna guía muestra `undefined`, `NaN` ni pasos vacíos (Tasks 7 y 11).

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `app/Support/PublicConfig.php` (nuevo) | Config pública del navegador: `forGame`, `forLobby`. |
| `app/Http/Controllers/LobbyController.php`, `GameScreenController.php` (nuevos) | `/mapa`; `/partida/{code}` y `/explorar`. |
| `resources/views/lobby.blade.php` (nuevo), `partida.blade.php` (ex `mapa.blade.php`), `partials/guias.blade.php` (nuevo) | Vistas. |
| `resources/js/lobby/{main,rooms,params,manual}.js` (nuevos) | Entrada y piezas del lobby. |
| `resources/js/map/{lists,entry-model,focus-trap,waiting-room}.js` (nuevos) | Listas de ranking/historial, decisión de entrada, trampa de foco, sala de espera. `lobby.js` se elimina. |
| `resources/js/guides/{guides-model,guides-state,guide,manual-model}.js` (nuevos) | Catálogo, estado visto, motor DOM, manual. `tutorial.js` y `tutorial-model.js` se eliminan. |
| `resources/css/lobby.css` (nuevo), `paneles.css` | Estilos del lobby y de guías/menú. El lobby también carga `map.css` y `paneles.css` (solo CSS). |

---

## ETAPA 1 — Separar las pantallas

### Task 1: `PublicConfig`

**Files:**
- Create: `app/Support/PublicConfig.php`
- Modify: `app/Http/Controllers/MapController.php` (`show()` delega en `PublicConfig::forGame`)
- Test: `tests/Feature/PublicConfigTest.php`

**Interfaces:**
- Produces: `PublicConfig::forGame(?\App\Models\User $user): array` (el arreglo de hoy más `bank`, `offers`, `sprint`); `PublicConfig::forLobby(?User $user): array` con las claves `match, economy, auction, combos, events, voice, chat, kinds, bank, offers, sprint, user, urls, reverb, clock` (sin `center`, `zoom`, `data`, `static`).
- Nuevas claves (valores de `config('formosa.*')`): `bank = {ratePct, latePct, maxSharePct, maxLoans, minAmount, terms}`, `offers = {durationSeconds, decideSeconds, feePct, minPrice}`, `sprint = {enabled, seconds, incomePct, flashInterval, flashSeconds, flashStartPct, comebackPct, blockLoans}`.

- [ ] **Step 1: Escribir `PublicConfigTest`** con `forGame_trae_el_mapa_y_la_partida` (claves `center, zoom, kinds, static, clock, data, user`), `forLobby_no_trae_datos_del_mapa` (sin `static`, `center`, `zoom`), `bank_offers_sprint_reflejan_la_configuracion` (`bank.ratePct === config('formosa.bank.rate_pct')`, `bank.terms === [5,10,20]`, `offers.feePct`, `sprint.seconds`), `user_nunca_incluye_correo` (`assertArrayNotHasKey('email', …['user'])`).
- [ ] **Step 2: Ejecutarlo y ver que falla** (`--filter=PublicConfigTest`): clase inexistente.
- [ ] **Step 3: Implementar `PublicConfig`** moviendo el arreglo de `MapController::show()` sin cambiar claves existentes; `forLobby` selecciona del de juego las claves listadas.
- [ ] **Step 4: Punto de control:** `PublicConfigTest` y toda la suite PHP en verde (sin cambios de comportamiento).

### Task 2: Rutas `/partida/{code}` y `/explorar`

**Files:**
- Create: `app/Http/Controllers/GameScreenController.php`
- Modify: `routes/web.php`; renombrar `resources/views/mapa.blade.php` → `partida.blade.php` (y `MapController::show` pasa a renderizar `partida` provisoriamente)
- Test: `tests/Feature/GameScreenTest.php`

**Interfaces:**
- Produces: `GameScreenController::partida(Request $r, string $code): View` (config de `forGame` + `page='partida'`, `code` en mayúsculas), `::explorar(Request $r): View` (`page='explorar'`, `code=null`); rutas nombradas `partida` y `explorar`.

- [ ] **Step 1: Test:** `partida_responde_con_el_mapa_y_el_codigo_en_mayusculas` (`GET /partida/abc123` → 200, `assertSee('id="map"', false)`, config `page==='partida'`, `code==='ABC123'`), `codigo_invalido_da_404` (`/partida/ab`, `/partida/abc-123`), `explorar_no_tiene_codigo`, `partida_permite_el_microfono` (`Permissions-Policy` contiene `microphone=(self)`).
- [ ] **Step 2: Ejecutar y ver que falla** (404).
- [ ] **Step 3: Implementar controlador y rutas** con `->where('code','[A-Za-z0-9]{4,12}')`; el `<title>` de la vista depende de `page`.
- [ ] **Step 4: Punto de control:** `GameScreenTest` y suite PHP en verde.

### Task 3: Módulo `lists.js` (ranking e historial compartidos)

**Files:**
- Create: `resources/js/map/lists.js`
- Modify: `resources/js/map/drawer.js` (usa los modelos; el cajón se ve igual)
- Test: `tests/js/lists.test.mjs`

**Interfaces:**
- Produces: `rankingModel({ players, mine, user }): { note: string, rows: Row[] }`, `historyModel({ matches }): { note: string, rows: Row[] }`, `rowElement(row: Row): HTMLLIElement` con `Row = { lead?: number|string, color?: string, title, sub?, value, small?, me?: boolean }` (medalla para `lead` 1 a 3 vía `art.js`).
- Los textos son los de hoy en `drawer.js` (nota "Puntos por partida: 1.º 100, 2.º 60, 3.º 35, el resto 15, más 1 por propiedad (hasta 20). Quien abandona no suma.").

- [ ] **Step 1: Tests:** `ranking_marca_mi_fila_y_numera` (3 jugadores → `rows[0].lead===1`, `me` en el del usuario), `ranking_agrega_mi_posicion_si_no_estoy_en_la_tabla` (`mine.ranking={position:7,matches:2,wins:0,points:12}` → última fila `title 'Ana (vos)'` y `note` empieza con `Tu posición: 7.º con 12 puntos. `), `historial_vacio_sin_nota`, `historial_cuenta_victorias_y_puntos` (nota `2 partidas · 1 victoria · N puntos`; abandonada → `lead '–'`).
- [ ] **Step 2: Ejecutar y ver que falla.**
- [ ] **Step 3: Extraer** la preparación de datos de `renderRanking`/`renderHistory` a `lists.js` y hacer que el cajón los use.
- [ ] **Step 4: Punto de control:** `node --test tests/js/lists.test.mjs` y `npm run test:js` en verde.

### Task 4: Página del lobby en `/mapa`

**Files:**
- Create: `app/Http/Controllers/LobbyController.php`, `resources/views/lobby.blade.php`, `resources/js/lobby/{main,rooms,params}.js`, `resources/css/lobby.css`
- Modify: `routes/web.php` (`/mapa` → `LobbyController@show`), `vite.config.js` (entrada `resources/js/lobby/main.js` y `lobby.css`), tests PHP que piden `/mapa`
- Test: `tests/Feature/LobbyTest.php`, `tests/js/lobby-params.test.mjs`, `tests/js/lobby-graph.test.mjs`

**Interfaces:**
- Consumes: `PublicConfig::forLobby`, `createGame()` (`game.create/join/refresh/state`), `connectRealtime(cfg.reverb, handlers)` + `watchLobby(true)` (handlers no usados como funciones vacías salvo `onLobby`), `lists.js`, `getJson`.
- Produces ids de la vista: `#lobby-resume`, `#tab-salas|ranking|historial|manual`, `#panel-salas|ranking|historial|manual`, `#room-form`, `#room-name`, `#room-cap`, `#room-public`, `#code-form`, `#code-input`, `#room-list`, `#room-empty`, `#lobby-msg`, `#btn-explorar`, `#btn-help`.
- `parseLobbyParams(search: string): { code: string|null, notice: string|null }` con `notice` ∈ `sala` | `vencida` | `ingresar` (texto en `NOTICES`).
- Al crear o unirse: `location.assign('/partida/' + match.code)`. Si la API responde `ya_estas_en_partida`: `game.refresh()` y redirigir a la URL de `game.state.match.code`.

- [ ] **Step 1: Tests PHP** `LobbyTest`: `mapa_es_el_lobby` (`assertViewIs('lobby')`, `assertDontSee('id="map"', false)`, `assertSee('id="room-list"', false)`), `visitante_ve_ingresar_y_crear_cuenta`, `muestra_el_aviso_de_correo_sin_confirmar` (texto "Confirmá tu correo para jugar"), `jugador_ve_su_nombre_y_no_su_correo`. Actualizar los tests viejos que piden `/mapa`: `MapApiTest` (el mapa pasa a `/explorar`), `VoiceTest` (cabecera en `/explorar`); los que miran `config` de usuario/chat o cabeceras siguen en `/mapa`.
- [ ] **Step 2: Tests JS:** `lobby-params` → `?codigo=abc123` da `'ABC123'`; `?codigo=a!` da `null`; `?aviso=sala` da el texto; aviso desconocido da `null`. `lobby-graph` recorre recursivamente los `import` de `resources/js/lobby/main.js` y falla si alcanza un especificador que coincide con la lista prohibida de Global Constraints.
- [ ] **Step 3: Ejecutar y ver que fallan.**
- [ ] **Step 4: Implementar** controlador, vista (reusa `art.js` `lobbyHeader()` y `emptyRooms()`; carga `map.css`, `paneles.css`, `lobby.css`; estructura de pestañas con `role=tablist`), `rooms.js` (lista en vivo, crear, unirse, deshabilitado para visitantes con "Ingresá para unirte"), tarjeta "Volver a tu partida" (`game.refresh()` y `status` ∈ `lobby|running` → enlace a `/partida/{code}`), pestañas Ranking e Historial con `lists.js`, `?codigo=` y `?aviso=` (se limpian con `history.replaceState`).
- [ ] **Step 5: Punto de control:** `LobbyTest`, suite PHP, `npm run test:js` en verde; `npm run build` en `ft-e2e` sin errores.

### Task 5: La pantalla de juego se acomoda

**Files:**
- Create: `resources/js/map/entry-model.js`, `focus-trap.js`, `waiting-room.js`
- Modify: `resources/js/map/main.js`, `results.js` (importa `trapFocus` de `focus-trap.js`), `resources/views/partida.blade.php`
- Delete: `resources/js/map/lobby.js`
- Test: `tests/js/entry-model.test.mjs`

**Interfaces:**
- Produces: `resolveEntry({ page, code, user, current }): { action: 'stay'|'redirect'|'check-finished', url?: string, finishedId?: number }` y `destinationAfter(reason: 'left'|'abandoned'|'again'|'expired'): string` (`'/mapa'`, salvo `expired` → `'/mapa?aviso=vencida'`). `current` es la respuesta de `/api/partidas/actual`.
- Reglas de `resolveEntry`: `page==='explorar'` → `stay`; sin `user` → `redirect` a `/mapa?codigo=CODE&aviso=ingresar`; partida activa (`lobby|running`) con el mismo código → `stay`, con otro → `redirect` a `/partida/{ese código}`; sin partida activa y `last_finished_match_id` → `check-finished`; resto → `redirect` a `/mapa?codigo=CODE&aviso=sala`. El código se normaliza con `trim().toUpperCase()`.
- `createWaitingRoom({ $, user, game, onChange, onLeft }): { open, close, isOpen, refresh }` (solo la vista de sala: código, copiar, jugadores, iniciar, salir, vencimiento; `onLeft()` tras salir).

- [ ] **Step 1: Tests** `entry-model`: `explorar_siempre_se_queda`, `visitante_va_al_lobby_con_codigo_y_aviso_ingresar`, `mi_sala_se_queda`, `otra_partida_mia_redirige_a_su_url`, `codigo_en_minusculas_y_con_espacios_coincide` (Review Focus 2), `sin_partida_con_terminada_pide_comprobar`, `ajena_o_inexistente_va_al_lobby_con_aviso_sala` (Review Focus 1), `destinos_tras_salir_abandonar_jugar_otra_vez_y_vencer` (Review Focus 4).
- [ ] **Step 2: Ejecutar y ver que fallan.**
- [ ] **Step 3: Implementar** `entry-model.js` y `focus-trap.js` (mover `trapFocus` tal cual).
- [ ] **Step 4: `waiting-room.js`:** mover de `lobby.js` solo `renderRoom`, `show`, acciones `room-start`/`room-leave`/`room-copy`, vencimiento y `trapFocus`. Quitar de `partida.blade.php` la vista `#lobby-rooms` y `#lobby-explore` (el título del diálogo queda "Sala de espera") y reemplazar `#btn-play` y `#btn-join-cta` por enlaces a `/mapa` ("Volver al lobby", "Sumate a una partida para comprar").
- [ ] **Step 5: `main.js`:** (a) `entryP = game.refresh()` al arrancar (en paralelo con el estilo del mapa) y, tras el `Promise.all` de la carga, `resolveEntry` con `cfg.page`/`cfg.code`: `redirect` → `location.replace(url)` y `return`; `check-finished` → pedir `/api/partidas/{id}/resultado`, si `match.code` coincide mostrar resultados, si no ir al lobby con aviso `sala`; error al leer la partida → aviso "No se pudo leer tu partida" con reintentar y enlace al lobby. (b) Quitar `maybeOpenLobby`, `tutorialOpen` para el lobby, `rt.watchLobby`/`onLobby` y la rama de visitante de `createLobby`. (c) Usar `destinationAfter`: salir de la sala y **Abandonar** (`location.assign` tras éxito), `results` `onAgain`, y `expired` (aviso 2,5 s y luego redirigir). (d) `renderPlayState` ya no maneja `btn-play`.
- [ ] **Step 6: Punto de control:** `npm run test:js` y suite PHP en verde; `sync-e2e.sh` compila.

### Task 6: Enlaces, documentación y recorrido en navegador

**Files:**
- Modify: `resources/views/moderacion-mapa.blade.php` (línea del enlace "Ver en el mapa" → `route('explorar')?p=…`), `README.md` (rutas nuevas, `/explorar?hora=` y `?debug=`)
- Create: `$S/e2e-etapa1.mjs` (Playwright)

- [ ] **Step 1: Actualizar enlace y README.**
- [ ] **Step 2: Escribir `e2e-etapa1.mjs`** (escritorio y 390 px): visitante en `/mapa` (salas visibles, botones deshabilitados); jugador A crea sala → URL `/partida/CODE` y diálogo de espera; jugador B se une desde el lobby; A inicia → HUD de partida; A abandona → `/mapa`; `/partida/ZZZZZZ` → `/mapa?codigo=ZZZZZZ&aviso=sala` con el aviso visible y sin errores de consola; `/explorar` carga las propiedades dibujadas; la tarjeta "Volver a tu partida" aparece al reabrir `/mapa` con una partida activa.
- [ ] **Step 3: Ejecutar** (`sync-e2e.sh`, `start-e2e.sh`, el script): todo pasa, sin errores en consola.
- [ ] **Step 4: Punto de control de la etapa:** suite PHP + JS + recorrido en verde; **entregar a la PC** (ver arriba) y avisar al dueño.

---

## ETAPA 2 — Motor de guías

### Task 7: Catálogo y estado "visto" (lógica pura)

**Files:**
- Create: `resources/js/guides/guides-model.js`, `resources/js/guides/guides-state.js`
- Test: `tests/js/guides-model.test.mjs`, `tests/js/guides-state.test.mjs` (migrar los casos de `pointsText` desde `tests/js/tutorial-model.test.mjs`)

**Interfaces:**
- Produces: `type Guide = { id: string, place: 'lobby'|'sala'|'partida'|'resultados'|'explorar', title: string, summary: string, version: number, auto: boolean, available?: (ctx) => boolean, steps: (ctx) => Step[] }`, `type Step = { title: string, text: string, targets: string[] }`, `ctx = { cfg, user }`; `GUIDES: Guide[]`; `PLACES: string[]`; `guidesFor(place, ctx): Guide[]` (solo `available`); `guideById(id): Guide|undefined`; `pointsText(points)` (movido de `tutorial-model.js`).
- `createGuideState(storage: { getItem, setItem } | null): { status(g): 'new'|'updated'|'seen', mark(g): void, pendingAuto(place, ctx): Guide[] }`; clave `formosa.guias.v1`, valor JSON `{ [id]: version }`.
- Guías de esta etapa y sus `targets`: `lobby-bienvenida` (auto), `lobby-salas` (`#room-form`, `#code-form`, `#room-list`), `lobby-ranking` (`#tab-ranking`, `#tab-historial`), `sala-espera` (auto; `#room-code`, `#room-players`, `#room-start`), `sala-social` (`#chat-toggle`, `#voice`), `partida-tablero` (auto; `#match-hud`, `#standings-box`), `partida-comprar` (auto; `#legend`, `#panel`), `resultados` (auto; `#results-me`, `#results-table`, `#results-again`), `explorar` (auto; `#legend`, `#btn3d`, `.hud-guest`). Los textos salen del tutorial actual, ampliados con lo de la spec §3.2.

- [ ] **Step 1: Tests de modelo:** `cada_guia_arma_pasos_con_la_configuracion_real` (fixture con la forma de `PublicConfig::forGame`; títulos y textos no vacíos, sin `undefined`/`NaN`/`[object`, `targets` es lista de strings); `con_funciones_apagadas_no_quedan_pasos_vacios` (eventos, voz, sprint apagados y `bank` ausente; Review Focus 5); `ids_unicos_y_una_guia_auto_por_lugar_como_minimo`; `los_textos_usan_los_numeros_reales` (`lobby-bienvenida` incluye duración y plata inicial; `partida-comprar` incluye `${dispute} segundos`).
- [ ] **Step 2: Tests de estado:** `marca_y_lee`; `version_nueva_queda_actualizada`; `pendingAuto_devuelve_solo_auto_no_vistas_en_orden`; `storage_que_lanza_no_rompe` (getItem y setItem lanzan); `contenido_corrupto_se_trata_como_vacio` para `'abc'`, `'[]'`, `'null'`, `'{"x":"y"}'` (Review Focus 3); `sin_storage` (`null`).
- [ ] **Step 3: Ejecutar y ver que fallan.**
- [ ] **Step 4: Implementar** ambos módulos (lectura/escritura siempre dentro de `try/catch`; versiones no enteras se ignoran).
- [ ] **Step 5: Punto de control:** `node --test` de los dos archivos y `npm run test:js` en verde.

### Task 8: Motor DOM, tarjeta y menú

**Files:**
- Create: `resources/js/guides/guide.js`, `resources/views/partials/guias.blade.php`
- Modify: `resources/css/paneles.css` (menú de guías, etiqueta "Nuevo", `.guide-help`), `resources/views/lobby.blade.php` y `partida.blade.php` (incluyen el parcial en lugar del bloque `#tour`)
- Test: `tests/js/guide-menu.test.mjs`

**Interfaces:**
- Consumes: `guidesFor`, `guideById`, `createGuideState`, `trapFocus`.
- Produces: `createGuides({ $, cfg, user, getPlace: () => string, reduceMotion, storage }): { open(id), openAuto(), openMenu(), isOpen() }` y la función pura `menuItems(place, state, ctx): { id, title, summary, status }[]` (en `guides-model.js`, orden del catálogo).
- Ids del parcial: la tarjeta conserva `#tour`, `#tour-title`, `#tour-text`, `#tour-count`, `#tour-prev`, `#tour-next`, `#tour-skip`; el menú es `#guide-menu` (`role=dialog`, `aria-modal=true`) con `#guide-menu-list` y `#guide-menu-close`.

- [ ] **Step 1: Test** `menuItems`: `respeta_el_orden_y_el_lugar`, `etiqueta_nuevo_actualizada_y_vista`.
- [ ] **Step 2: Ejecutar y ver que falla.**
- [ ] **Step 3: `guide.js`:** portar `pickTarget`, `place`, `show`, `close` de `tutorial.js`. Cerrar o llegar al final marca la guía (`state.mark`). `open(id)` abre una guía; `openAuto()` encadena las `pendingAuto` del lugar actual (300 ms entre una y otra) y no hace nada con `navigator.webdriver`, salvo `?guia=ID` (que abre esa guía y la fuerza). `openMenu()` abre el diálogo con foco atrapado, Escape cierra y devuelve el foco. Un clic en cualquier `[data-guide]` del documento abre esa guía.
- [ ] **Step 4: Punto de control:** `guide-menu.test.mjs` y `npm run test:js` en verde.

### Task 9: Cableado y retiro del tutorial viejo

**Files:**
- Modify: `resources/js/lobby/main.js`, `resources/js/map/main.js` (reemplaza `createTutorial`; `#btn-help` abre el menú; `getPlace()` devuelve `explorar`, `sala` si `match.status==='lobby'`, `partida` si hay partida en juego; tras mostrar resultados el lugar es `resultados`), `resources/css/map.css` (la tarjeta queda por encima de los diálogos: `z-index` mayor que `.overlay`)
- Delete: `resources/js/map/tutorial.js`, `tutorial-model.js`, `tests/js/tutorial-model.test.mjs`
- Create: `$S/e2e-guias.mjs`

- [ ] **Step 1: Cablear** el lobby (`openAuto()` al cargar; `#btn-help` → menú) y el juego (`openAuto()` después de `intro.whenDone()` y cada vez que cambia el lugar; las guías `sala-espera` y `resultados` se abren al mostrarse esos diálogos).
- [ ] **Step 2: Borrar** `tutorial.js`, `tutorial-model.js` y su test, y quitar `?tutorial=1`/`?lobby=1` de los scripts de prueba existentes.
- [ ] **Step 3: `e2e-guias.mjs`** (escritorio y 390 px, sin `navigator.webdriver` simulado con `?guia=`): primera visita al lobby abre `lobby-bienvenida`, la segunda no; `?guia=partida-comprar` abre esa guía; el menú lista las guías del lugar con "Nuevo"; en 390 px la tarjeta es hoja inferior y queda dentro de la pantalla aunque el objetivo esté oculto; la tarjeta se ve por encima del diálogo de resultados.
- [ ] **Step 4: Punto de control de la etapa:** suite PHP + JS + `e2e-etapa1.mjs` + `e2e-guias.mjs` en verde; **entregar a la PC**.

---

## ETAPA 3 — Guías de partida, `?` por panel y manual

### Task 10: Las seis guías de partida restantes

**Files:**
- Modify: `resources/js/guides/guides-model.js`
- Test: `tests/js/guides-model.test.mjs`

**Interfaces:**
- Produces (todas `place:'partida'`, `auto:false`, `version:1`): `partida-subastas` (usa `cfg.auction.duration/dispute`, `cfg.sprint.flashSeconds`), `partida-ofertas` (`cfg.offers.durationSeconds/decideSeconds/feePct/minPrice`), `partida-combos-eventos` (`cfg.combos`, `cfg.events`, sprint: `seconds`, `incomePct`, `flashInterval`, `comebackPct`, `blockLoans`), `partida-banco` (`cfg.bank.*`; `available: ctx => !!ctx.cfg.bank`), `partida-social` (feed, chat, voz si `cfg.voice.enabled`), `partida-herramientas` (3D, ajustes, `H`, reloj, música). Targets: `#subastas-box`, `#offer-new`, `#offer-box`, `#match-events`, `#btn-bank`, `#bank`, `#chat-toggle`, `#voice`, `.toolbar`.

- [ ] **Step 1: Tests:** `banco_incluye_tasa_plazos_y_maximos` (texto con `ratePct`, `terms.join(' / ')`, `maxLoans`, `maxSharePct`), `ofertas_menciona_la_comision`, `combos_eventos_incluye_sprint_solo_si_esta_encendido`, `banco_no_aparece_si_falta_cfg_bank` (`guidesFor('partida', ctx)` no lo incluye), y los chequeos genéricos de Task 7 ahora sobre las 15 guías (Review Focus 5).
- [ ] **Step 2: Ejecutar y ver que fallan.**
- [ ] **Step 3: Escribir las guías** (3 a 5 pasos cada una, voseo, números reales).
- [ ] **Step 4: Punto de control:** `npm run test:js` en verde.

### Task 11: Botones `?` por panel

**Files:**
- Modify: `resources/views/partida.blade.php` (botón `.guide-help` con `data-guide` y `aria-label` en: cabecera de `#bank` → `partida-banco`; `#offer-new summary` y `#offer-box` → `partida-ofertas`; título de `#subastas-box` → `partida-subastas`), `resources/js/map/main.js` (`renderEvents` agrega un botón `?` con `data-guide="partida-combos-eventos"` al banner de evento y sprint, con `textContent`), `resources/css/paneles.css`
- Modify: `$S/e2e-guias.mjs`

- [ ] **Step 1: Agregar los botones** (que no cambien el orden de tabulación de los formularios ni el cálculo de `renderEvents`).
- [ ] **Step 2: Ampliar `e2e-guias.mjs`:** dentro de una partida en juego, el `?` del banco abre la guía "Banco", el de subastas la de subastas, el del banner de evento la de combos y eventos; cada tarjeta se puede cerrar con Escape devolviendo el foco al `?`.
- [ ] **Step 3: Punto de control:** `e2e-guias.mjs` en verde (escritorio y 390 px).

### Task 12: "Cómo se juega" en el lobby

**Files:**
- Create: `resources/js/guides/manual-model.js`, `resources/js/lobby/manual.js`
- Modify: `resources/views/lobby.blade.php` (contenedor `#lobby-manual`), `resources/js/lobby/main.js`, `lobby.css`
- Test: `tests/js/manual-model.test.mjs`

**Interfaces:**
- Produces: `manualSections(ctx): { place: string, label: string, guides: { id, title, summary, steps: { title, text }[] }[] }[]` (orden de `PLACES`, etiquetas Lobby / Sala de espera / Partida / Resultados / Explorar; solo guías `available`; los pasos no llevan `targets`). `renderManual(container, sections)` en `manual.js` (un `<details>` por guía, todo con `textContent`).

- [ ] **Step 1: Tests:** `cinco_secciones_en_orden`, `los_pasos_no_traen_targets_y_coinciden_con_stepsOf`, `no_incluye_guias_no_disponibles`, `no_marca_nada_como_visto` (el estado no se toca).
- [ ] **Step 2: Ejecutar y ver que fallan.**
- [ ] **Step 3: Implementar** modelo y render; la pestaña `#tab-manual` carga las secciones con `forLobby` (que ya trae `bank`, `offers`, `sprint`).
- [ ] **Step 4: Punto de control:** `npm run test:js` y `lobby-graph.test.mjs` (el manual no debe traer MapLibre/three) en verde.

### Task 13: Cierre

**Files:**
- Modify: `README.md` (lobby, partida, explorar y guías), `$S/audit-a11y.mjs` (revisa `/mapa` y una partida)

- [ ] **Step 1: README:** describir las tres pantallas, las guías y `?guia=ID`.
- [ ] **Step 2: Auditoría de accesibilidad** del lobby, el menú de guías y la tarjeta (foco, nombres accesibles, contraste); corregir lo que salga.
- [ ] **Step 3: Regresión completa:** suite PHP, `npm run test:js`, `e2e-etapa1.mjs`, `e2e-guias.mjs`, y la medición de carga de `/mapa` (peso del JS del lobby frente al del mapa).
- [ ] **Step 4: Entregar a la PC** y avisar al dueño con los pasos de activación (`npm run build`, reiniciar el lanzador, Ctrl+F5).
