# Lobby, pantalla de partida y guías por lugar

Fecha: 2026-10-16 · Estado: pendiente de revisión del dueño del proyecto

## 1. Objetivo

Hoy todo vive en `/mapa`: el mapa pesado está siempre de fondo, "Jugar" abre un diálogo de salas encima y hay **un solo
tutorial** de 14 pasos que mezcla todo, sale una vez y no cubre ofertas, banco, sprint, zonas de evento, feed, sala de espera
ni resultados.

Se quiere:

1. `/mapa` pasa a ser el **lobby** (punto de entrada liviano) y la partida vive en **otra pantalla con URL propia**.
2. **Guías distintas para cada lugar**, que expliquen todo lo que hay ahí, que se puedan volver a abrir y que recuerden lo ya visto.

Éxito: un jugador nuevo entra al lobby, entiende el objetivo, crea o se une a una sala, espera, juega y ve el resultado,
con una guía propia en cada paso; un jugador que vuelve solo ve lo nuevo. El lobby carga sin MapLibre, three.js ni el GeoJSON de propiedades.

Fuera de alcance (queda para después): misiones interactivas que esperan una acción del jugador; chat y voz dentro del lobby;
cambios de reglas del juego, economía o base de datos.

## 2. Pantallas y rutas

| Ruta | Qué es |
|---|---|
| `/` | Redirige a `/mapa` (igual que hoy). |
| `/mapa` | **Lobby.** Vista nueva, entrada Vite propia, sin mapa. |
| `/partida/{código}` | **Pantalla de juego** (la actual `mapa.blade.php`). Mismas tres etapas en la misma URL: sala de espera → partida → resultados. |
| `/explorar` | Mismo mapa y 3D **sin juego** (visitantes incluidos). Es la pantalla de juego con `page = 'explorar'`. |

`{código}` usa la misma validación que hoy (`[A-Za-z0-9]{4,12}`); en el resto de los casos 404.

### 2.1 Lobby (`/mapa`)

Secciones (pestañas en el mismo documento, sin recargar):

- **Salas:** crear una sala (nombre, cupo, pública), unirse con código y lista de salas abiertas en vivo (canal `lobby` de Reverb, como hoy).
  Si el jugador ya está en una sala o partida, arriba va una tarjeta destacada **"Volver a tu partida"** (no redirige solo, para poder ver el lobby).
  Si venía de un enlace a una sala abierta (`/mapa?codigo=ABC123`), el campo del código llega cargado.
- **Ranking:** el ranking global (`/api/ranking`).
- **Mis partidas:** historial (`/api/yo/historial`). Solo con sesión.
- **Cómo se juega:** todas las guías en texto legible (ver §3.5).

Además: botón "Explorar la ciudad" (a `/explorar`), enlaces de ingresar o crear cuenta para visitantes, aviso de correo sin confirmar, enlace a Moderación para moderadores y el botón `?` de guías.

Si crear o unirse responde `ya_estas_en_partida`, el lobby lee `/api/partidas/actual` y lleva al jugador a la URL de su partida.

Visitantes: ven salas, ranking, "Cómo se juega" y los botones de unirse/crear deshabilitados con el aviso de ingresar (como hoy).

### 2.2 Pantalla de juego (`/partida/{código}`)

El servidor entrega la página con `cfg.page = 'partida'` y `cfg.code`. **El navegador decide con `/api/partidas/actual`** (única fuente de verdad del estado del jugador):

| Estado del jugador respecto del código | Resultado |
|---|---|
| Es de ESA partida (`lobby` o `running`) | Se entra normal. En `lobby` abre el diálogo de sala de espera. |
| Es de OTRA partida activa | `location.replace` a la URL de la suya. |
| No tiene partida y esa partida terminó con él adentro | Pantalla de resultados de esa partida. |
| No tiene partida y la sala está abierta (`status = lobby`, pública o no) | Va al lobby con `?codigo=` cargado. |
| Cualquier otro caso (código inexistente, partida ajena en juego, visitante) | Va al lobby con un aviso breve ("Esa sala no existe o no es tuya"). |

Para que no parpadee el juego antes de redirigir, la carga pesada (mapa, propiedades, calles, 3D) arranca **después** de resolver este estado.

Crear una sala o unirse (desde el lobby) termina en `location.assign('/partida/' + code)`.
Salir de la sala, **Abandonar**, cerrar resultados con "Jugar otra vez", o que la sala venza por falta de inicio, llevan al lobby (`/mapa`).
"Ver el mapa" de los resultados queda en la misma página, como hoy.

### 2.3 Explorar (`/explorar`)

La pantalla de juego sin partida: no abre salas de espera ni consulta `/api/partidas/actual` más allá de lo que ya hace hoy para un visitante.
`btn-play` pasa a ser un enlace al lobby ("Jugar"). Soporta `?p=ID` (abrir una propiedad), `?hora=` y `?debug=` como hoy;
los enlaces de moderación "Ver en el mapa" (`moderacion-mapa.blade.php`) apuntan a `/explorar?p=ID`.
`/mapa?p=`, `?hora=` y `?debug=` dejan de existir (el lobby no tiene mapa).

### 2.4 Cómo se corta el código

- **Configuración pública compartida:** el arreglo que arma hoy `MapController::show()` pasa a una clase `App\Support\PublicConfig`
  con dos métodos: `forLobby()` (usuario, economía/partida, URLs, Reverb, eventos, combos, voz, chat para textos de guías)
  y `forGame()` (todo lo anterior más centro, zoom, kinds, archivos estáticos, reloj, datos, subastas). Sin cambios de contenido.
- **Controladores:** `LobbyController@show` (`/mapa`), `GameScreenController@partida` y `@explorar`. `MapController` conserva las rutas `api/*` de datos.
- **Vistas:** `lobby.blade.php` (nueva), `partida.blade.php` (el actual `mapa.blade.php` renombrado, con el diálogo de sala de espera y sin el listado de salas), `explorar` reutiliza `partida.blade.php`.
- **JS del lobby:** nueva entrada `resources/js/lobby/main.js`. Reutiliza `api.js`, `game.js` (crear/unirse), `realtime.js` (`watchLobby`), `art.js`, `owners.js`, `format.js` y el render de ranking/historial que hoy está en `drawer.js` (se extrae lo que haga falta a un módulo compartido).
  Debe poder arrancar **sin** `maplibre-gl` ni `three` en su grafo de importaciones (se verifica en el build).
- **JS del juego:** `lobby.js` se reduce a la **sala de espera** (código, jugadores, iniciar, salir, copiar, vencimiento). La lista de salas, crear y unirse por código se mueven al lobby nuevo. `main.js` pierde `maybeOpenLobby`, el `btn-play` como abridor de diálogo y `lobby.open` desde el CTA ("Sumate a una partida" pasa a ser un enlace al lobby).
- **Vite:** se agrega la entrada del lobby; `lobby.blade.php` solo carga sus CSS y JS (no `intro.js`: la cinemática de carga es del mapa).
- **Enlaces que apuntan a `route('mapa')`** (login, verificación, vistas de auth, moderación) siguen yendo al lobby, que es lo correcto.
- `scripts/iniciar.ps1` y `scripts/tunel.ps1` abren `/mapa`: no cambian.

## 3. Sistema de guías

### 3.1 Contenido como datos

Un módulo puro `resources/js/guides/guides-model.js` (sin DOM, probado con `node --test`) exporta el catálogo:

```
{ id, place, title, summary, version, auto, steps: (ctx) => [{ title, text, targets }] }
```

- `place`: `lobby | sala | partida | resultados | explorar`.
- `ctx = { cfg, user }`: los textos usan los números reales de la configuración, como hoy (duración, días, descuentos, comisiones, tasas del banco, sprint, etc.).
- `targets`: selectores CSS en orden de preferencia; se señala el primero visible y si ninguno lo está la tarjeta va centrada (comportamiento actual).
- `auto`: `true` en la guía principal del lugar, que se abre sola la primera vez. `version`: entero; subirlo la vuelve a marcar como nueva.
- Los pasos que dependen de una función apagada (eventos, sprint, voz, banco) no aparecen si la configuración la apaga.

### 3.2 Catálogo

| Lugar | Guía (id) | Contenido |
|---|---|---|
| Lobby | `lobby-bienvenida` (auto) | Objetivo, duración, plata inicial, cómo se gana. |
| | `lobby-salas` | Crear, unirse por código o lista, salas públicas y privadas. |
| | `lobby-ranking` | Ranking global, puntos por puesto, bono por propiedad, historial. |
| Sala de espera | `sala-espera` (auto) | Código e invitar, mínimo de jugadores, solo el creador inicia, la sala vence, mientras tanto se puede recorrer el mapa. |
| | `sala-social` | Chat de sala, chat global y voz de la sala. |
| Partida | `partida-tablero` (auto) | Reloj, día, efectivo, ingreso por día, patrimonio (restando deuda), puesto, posiciones. |
| | `partida-comprar` (auto) | Elegir una propiedad, panel, reclamar y disputa, precio de recupero, vender al banco, leyenda y colores. |
| | `partida-subastas` | Subastas en curso, pujar, reserva de plata, extensión por puja tardía, subasta relámpago. |
| | `partida-ofertas` | Ofrecer una propiedad (mínimo y "comprá ya"), ofertar, aceptar, retirar. |
| | `partida-combos-eventos` | Zona y variedad, eventos por zona (anuncio, zona marcada, propiedades afectadas), sprint final (×2, relámpagos, descuento de remontada, préstamos bloqueados). |
| | `partida-banco` | Préstamos: monto máximo, interés por día, plazos, mora, máximo de préstamos, bloqueo en sprint. |
| | `partida-social` | Chat sala/global, voz, feed de actividad y cómo apagarlo. |
| | `partida-herramientas` | 3D, ajustes, ocultar paneles (H), reloj de la ciudad, música. |
| Resultados | `resultados` (auto) | Puesto, patrimonio, puntos, tabla final, jugar otra vez. |
| Explorar | `explorar` (auto) | Recorrer la ciudad, leyenda, 3D, cómo jugar (enlace al lobby), crear cuenta (visitantes). |

Esto reemplaza a `tutorial.js` y `tutorial-model.js`; sus textos se reparten entre estas guías (se conservan y se amplían).
`pointsText` se reutiliza.

### 3.3 Motor y estado

- `resources/js/guides/guide.js` generaliza `tutorial.js`: tarjeta con foco sobre un elemento (`tour-focus`), Atrás/Siguiente/Saltar, Escape, `place()` para escritorio y hoja inferior en celular, foco accesible. Misma tarjeta HTML y CSS que hoy (`#tour`), presente en ambas vistas.
- API: `open(id)`, `openAuto()` (abre la guía `auto` pendiente del lugar; encadena las `auto` pendientes de la partida), `menu`.
- **Visto:** `localStorage` clave `formosa.guias.v1` con `{ [id]: versionVista }`, lectura y escritura dentro de `try/catch`. La lógica (`isSeen`, `pending`, `markSeen`) es pura y se prueba.
  La clave vieja `formosa.tutorial.v2` se ignora: quien ya vio el tutorial viejo verá las guías nuevas una vez.
- Se abren solas **solo** en un navegador de una persona (no con `navigator.webdriver`) y después de que el jugador entró (en el mapa, tras la intro). `?guia=ID` fuerza abrir una guía (reemplaza a `?tutorial=1`; lo usan las pruebas).

### 3.4 Menú y puntos de entrada

- El botón `?` abre un **menú de guías del lugar actual**: lista con título, resumen, ✓ si está vista y la etiqueta "Nuevo" si la versión cambió. Elegir una la abre.
- En el lobby el `?` lista las guías del lobby; en la sala de espera, las de sala; en la partida, las de partida; en resultados, las de resultados.
- **`?` por panel** que abre la guía del tema directamente: Banco (`partida-banco`), Ofertas en el panel de propiedad (`partida-ofertas`), lista de subastas (`partida-subastas`), banner de evento y sprint (`partida-combos-eventos`).
- El menú es un diálogo accesible (rol, foco, Escape, trampa de foco con `trapFocus`).

### 3.5 "Cómo se juega" en el lobby

Pestaña que recorre **todo** el catálogo y muestra cada guía como tarjeta de texto con sus pasos (usa `steps(ctx)` y descarta `targets`).
Así se puede leer todo antes de jugar. No marca como vista ninguna guía.

## 4. Datos, seguridad y errores

- **Sin cambios de base de datos ni de economía.** El "visto" es solo del navegador.
- Todo texto de guías, salas y jugadores se escribe con `textContent` (nunca HTML), como hoy.
- La redirección de `/partida/{código}` no revela nada nuevo: usa `/api/partidas/actual` (sesión) y las lecturas públicas que ya existen. Un código ajeno no muestra datos de esa partida.
- Si falla `/api/partidas/actual` al entrar a `/partida/...`, se muestra el aviso "No se pudo leer tu partida" con botón a reintentar y enlace al lobby (no se queda en blanco).
- Lobby sin Reverb disponible: la lista de salas se carga igual por `/api/partidas` y se refresca al volver a la pestaña (degrada sin errores).
- Si falta `localStorage`: las guías pueden volver a salir en la próxima visita; no se rompe nada.
- Se mantiene el límite de pedidos existente (`throttle`); las pantallas nuevas no agregan endpoints públicos nuevos.

## 5. Etapas (cada una se prueba y se despliega por separado)

1. **Separar pantallas.** `PublicConfig`, rutas y controladores, `lobby.blade.php` + entrada Vite, `partida.blade.php`, `explorar`, `lobby.js` reducido a sala de espera, redirecciones del §2.2, enlaces de moderación. Las guías siguen siendo el tutorial viejo (movido a la pantalla de juego y a explorar).
2. **Motor de guías.** `guides-model`, `guide.js`, menú `?`, estado visto, guías de lobby, sala de espera, resultados y explorar.
3. **Guías de partida.** Las ocho guías de partida, `?` por panel y la pestaña "Cómo se juega".

## 6. Pruebas

- **PHPUnit:** `/mapa` responde 200 y no incluye el JS del mapa; `/partida/ABC123` y `/explorar` responden 200 con el JS del juego; código inválido da 404; `PublicConfig` entrega las claves que usan las vistas; redirecciones de login/verificación siguen en `/mapa`.
- **JS (`node --test`):** catálogo (cada guía arma pasos con la configuración real y con funciones apagadas; títulos y textos no vacíos; `targets` es lista), estado visto (versiones, `pending`, lectura con `localStorage` roto), reglas de decisión del §2.2 (función pura `resolveEntry`), menú (orden y etiquetas).
- **Build:** comprobación automática de que el grafo del lobby no importa `maplibre-gl` ni `three` y de su peso.
- **Navegador (Playwright, escritorio y 390 px):** lobby → crear sala → `/partida/CÓDIGO` en espera → segundo jugador se une → iniciar → guía principal → comprar → `?` y menú → resultados → "Jugar otra vez" al lobby. Enlace a sala ajena, código inexistente, visitante y `/explorar`.
- Se mantienen las pruebas actuales; las que dependían de `?lobby=1` y `?tutorial=1` se actualizan.

## 7. Riesgos

- `main.js` (≈1.870 líneas) se toca en pocos lugares, pero es el archivo más delicado: cada etapa se cierra con la suite completa (PHP, JS y navegador).
- Costumbre de enlaces guardados a `/mapa?p=`: solo los usa moderación y se actualizan.
- La redirección por estado agrega un pedido antes de dibujar el mapa; se compensa con que el lobby es mucho más liviano y con que las propiedades siguen siendo archivos estáticos cacheados.
