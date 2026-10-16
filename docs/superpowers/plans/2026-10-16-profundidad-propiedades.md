# Profundidad de las propiedades: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada propiedad se pueda mejorar a nivel 1 y 2 (con rama), con mantenimiento diario descontado del ingreso, endpoint idempotente, panel y guía.

**Architecture:** Reglas puras en `App\Economy\Upgrades` (como `Combos`), tres columnas nuevas en `match_properties`, un `UpgradeService` con el mismo orden de bloqueos que `sell`, y el servidor calcula las opciones del panel (el navegador solo las muestra). El ingreso de cada fila pasa a ser neto antes de entrar a los combos.

**Tech Stack:** Laravel 13 / PHP 8.3 / MariaDB, JS vanilla con Vite, `node --test`, PHPUnit.

**Spec:** `docs/superpowers/specs/2026-10-16-profundidad-propiedades-design.md`

## Global Constraints

- Respuestas y textos de pantalla en español rioplatense; todo texto al DOM por `textContent`; sin estilos en línea (CSP).
- Plata en pesos enteros; `floor` en bruto, mantenimiento, costo y descuento.
- Valores iniciales (spec 2.4): nivel 1 → `cost_pct` 0,50, `boost` 0,40, `maint` 0,05; nivel 2 A → 0,80 / 1,10 / 0,30; nivel 2 B → 0,60 / 0,75 / 0,10. Igual para los cuatro tipos.
- Ramas: casa A "Alquiler turístico" / B "Edificio de departamentos" (peso de zona 2); comercio A "Shopping" / B "Mayorista" (crisis a la mitad, solo factor < 1); supermercado A "Hipermercado" / B "Centro logístico" (mejoras −20 % si hay al menos uno); hotel A "Resort" / B "Hotel de negocios". Nivel 1: "Reformada".
- Patrimonio de una propiedad = `price + floor(upgrade_paid × 0,5)`.
- Bandas de recupero (días de juego): nivel 1 entre 5 y 8; nivel 2 A entre 6 y 10; nivel 2 B entre 7 y 11; siempre mayor que `1 / rate_per_day`.
- Código de partida `[A-Za-z0-9]{4,12}`; el ingreso liquidado de a poco debe dar lo mismo que de una vez.
- No tocar `.env`, `vendor/`, `node_modules/` en la PC del usuario; no borrar datos de `ft-test`; mantener `artisan serve`.

## Review Focus

1. Mantenimiento mayor que el bruto con un evento de crisis: la fila rinde 0, nunca negativo, y no resta de otras filas.
2. Doble clic o reintento con la misma clave: un solo cobro y un solo nivel.
3. Propiedad con subasta u oferta abierta: no se mejora.
4. Patrimonio igual en `standings` y en `LoanService::netWorth` (un solo cálculo).
5. Oferta aceptada: nivel, rama y `upgrade_paid` viajan al comprador; venta al banco los pierde con el reembolso de siempre.

---

### Task 1: Configuración y reglas puras `Upgrades`

**Files:**
- Modify: `config/formosa.php` (clave nueva `upgrades`)
- Create: `app/Economy/Upgrades.php`
- Test: `tests/Unit/UpgradesTest.php`

**Interfaces:**
- Produces (todas estáticas, `final class Upgrades`):
  - `option(string $kind, int $level, ?string $branch): array{label: string, cost_pct: float, boost: float, maint: float}`; lanza `InvalidArgumentException` si la combinación no existe (nivel 0, rama con nivel 1, rama faltante o inválida con nivel 2).
  - `rowIncome(string $kind, int $base, int $level, ?string $branch, float $eventFactor): int` → `max(0, floor(floor($base×(1+boost)) × dampenFactor(...)) − floor($base×maint))`; nivel 0 devuelve `floor($base × $eventFactor)`, igual que hoy.
  - `dampenFactor(string $kind, int $level, ?string $branch, float $factor): float` → solo comercio nivel 2 rama `b` y `$factor < 1`: `1 − (1 − $factor) × 0.5`; si no, `$factor`.
  - `cost(int $price, int $toLevel, ?string $branch, bool $discount): int` → `floor($price × cost_pct)` y, con descuento, `floor(ese × 0.8)`.
  - `zoneWeight(string $kind, int $level, ?string $branch): int` → 2 solo para casa nivel 2 rama `b`, si no 1.
  - `hasDiscount(array $ownedRows): bool` → alguna fila con `kind` supermercado, `level` 2, `branch` `b`.
  - `assetValue(int $price, int $upgradePaid): int` → `$price + floor($upgradePaid × config('formosa.upgrades.net_worth_ratio'))`.
  - `paybackDays(string $kind, int $toLevel, ?string $branch, int $base, int $price, bool $discount, int $fromLevel, ?string $fromBranch): float` → costo / (neto nuevo − neto actual) con factor 1; `INF` si el aumento no es positivo.
  - `next(string $kind, int $level, ?string $branch, int $base, int $price, bool $discount): list<array{level: int, branch: ?string, label: string, cost: int, gross: int, maintenance: int, net: int, payback_days: float}>` → opciones disponibles desde el estado actual (nivel 0: una; nivel 1: dos ramas; nivel 2: vacío).

- [ ] **Step 1: Escribir las pruebas que fallan** en `tests/Unit/UpgradesTest.php`, con estos nombres y aserciones (valores de la sección Global Constraints):
  - `test_ingreso_nivel_cero_no_cambia`: `rowIncome('casa', 1000, 0, null, 1.2) === 1200`.
  - `test_nivel_uno_suma_bruto_y_resta_mantenimiento`: base 1000, factor 1 → `1350`.
  - `test_rama_a_y_b_del_nivel_dos`: base 1000, factor 1 → A `800`, B `650`.
  - `test_el_mantenimiento_no_se_multiplica_con_el_sprint`: base 1000, nivel 1, factor 2,0 → `floor(1400 × 2) − 50 = 2750`.
  - `test_el_ingreso_nunca_baja_de_cero`: base 1000, nivel 2 A, factor 0 → `0`.
  - `test_mayorista_amortigua_solo_las_crisis`: comercio nivel 2 B: `dampenFactor(...,0.6) === 0.8`, `dampenFactor(...,1.5) === 1.5`; casa nivel 2 B: `dampenFactor(...,0.6) === 0.6`.
  - `test_costo_con_y_sin_descuento`: precio 40000, nivel 1 → `20000`; con descuento `16000`; nivel 2 B → `24000`, con descuento `19200`.
  - `test_peso_de_zona_solo_en_edificio_de_departamentos`.
  - `test_descuento_solo_con_centro_logistico`: filas con y sin supermercado nivel 2 rama b.
  - `test_valor_del_activo_cuenta_la_mitad_de_lo_invertido`: `assetValue(10000, 5001) === 12500`.
  - `test_las_opciones_siguientes_segun_el_estado`: nivel 0 → 1 opción; nivel 1 → 2 (ramas `a`,`b`); nivel 2 → `[]`.
  - `test_option_rechaza_combinaciones_invalidas` (nivel 0, nivel 1 con rama, nivel 2 sin rama, rama `c`).
  - `test_bandas_de_recupero_para_los_cuatro_tipos`: para cada tipo de `config('formosa.kinds')`, con `base = round(price × rate_per_day)`: nivel 1 en [5, 8]; nivel 2 A en [6, 10]; nivel 2 B en [7, 11]; todos `> 1 / rate`.
- [ ] **Step 2: Correr y ver que fallan.** Run: `cd $S/ft-test && php artisan test --filter=UpgradesTest` (tras `bash $S/sync.sh`). Expected: FAIL con "Class App\Economy\Upgrades not found".
- [ ] **Step 3: Agregar `upgrades` a `config/formosa.php`:** `net_worth_ratio` 0.5; `discount` 0.20; `levels` con las tres opciones y sus etiquetas por tipo (tabla de Global Constraints), más `dampen_down` 0.5 para el comercio B. Implementar `Upgrades` con las firmas de arriba (sin base de datos; lee solo `config`).
- [ ] **Step 4: Correr.** Run: `php artisan test --filter=UpgradesTest`. Expected: PASS (13 pruebas).
- [ ] **Step 5: Commit.** `git add config/formosa.php app/Economy/Upgrades.php tests/Unit/UpgradesTest.php && git commit -m "feat: reglas puras de mejoras de propiedades"`

### Task 2: Peso de zona en `Combos`

**Files:**
- Modify: `app/Economy/Combos.php` (`evaluate`)
- Test: `tests/Unit/CombosTest.php`

**Interfaces:**
- Consumes: filas `['id','kind','lat','lng','income']` más `'weight'` opcional (int, por defecto 1).
- Produces: `evaluate` suma `weight` al conteo de la zona. El campo `count` de cada zona devuelta es el conteo con pesos; `ids` sigue siendo la lista de propiedades.

- [ ] **Step 1: Pruebas que fallan** (en `CombosTest`): `test_el_peso_dos_sube_el_escalon_de_zona` (dos filas en la misma celda, una con `weight` 2 → `count` 3 y el primer escalón aplicado) y `test_sin_peso_todo_queda_igual` (las pruebas existentes pasan sin tocarse).
- [ ] **Step 2:** Run `php artisan test --filter=CombosTest`. Expected: FAIL en la primera.
- [ ] **Step 3:** Implementar el peso en el conteo de `byZone`.
- [ ] **Step 4:** Run `php artisan test --filter=CombosTest`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: peso de zona en los combos"`

### Task 3: Migración, enumeración del libro y errores

**Files:**
- Create: `database/migrations/2026_10_26_000001_add_upgrades_to_match_properties.php`
- Modify: `app/Enums/LedgerType.php` (caso `Mejora = 'mejora'`), `app/Economy/GameException.php`
- Test: `tests/Feature/UpgradeMigrationTest.php`

**Interfaces:**
- Produces: columnas `match_properties.level` (tinyint unsigned NOT NULL default 0), `.branch` (char(1) NULL), `.upgrade_paid` (unsigned int NOT NULL default 0) con las tres restricciones CHECK de la spec 3.2; `ledger_entries.type` acepta `mejora` y la regla `ledger_sign_by_type` agrega `(type = 'mejora' AND amount < 0 AND property_id IS NOT NULL)`.
- Produces: `GameException::upgradeUnavailable(): static` (código `mejora_no_disponible`, 409), `GameException::invalidBranch(): static` (código `rama_invalida`, 422).

- [ ] **Step 1: Pruebas que fallan** (`UpgradeMigrationTest`, usa la base de pruebas ya migrada): `test_las_filas_nuevas_arrancan_en_nivel_cero`; `test_nivel_dos_sin_rama_es_rechazado_por_la_base`; `test_nivel_uno_con_rama_es_rechazado`; `test_nivel_con_upgrade_paid_cero_es_rechazado`; `test_nivel_mayor_a_dos_es_rechazado`; `test_el_libro_acepta_mejora_negativa_con_propiedad` y `test_el_libro_rechaza_mejora_positiva`. Cada una inserta con `DB::table` y espera `QueryException`.
- [ ] **Step 2:** Run `php artisan test --filter=UpgradeMigrationTest`. Expected: FAIL (columnas inexistentes).
- [ ] **Step 3:** Escribir la migración con el patrón de `2026_10_24_000001_create_loans.php` (soltar la regla, cambiar el `enum`, volver a crearla; solo en `mysql`/`mariadb`/`pgsql`). `down()` se niega con `RuntimeException` si hay movimientos `mejora`, y si no suelta las restricciones y columnas y restaura enum y regla. Agregar el caso del enum y las dos excepciones.
- [ ] **Step 4:** Run `php artisan test --filter=UpgradeMigrationTest` y luego `php artisan migrate:rollback --step=1 && php artisan migrate` sobre la base de pruebas. Expected: PASS y rollback/migrate sin errores.
- [ ] **Step 5: Commit.** `git add database app && git commit -m "feat: columnas de mejora y movimiento mejora en el libro"`

### Task 4: Ingreso y patrimonio con mejoras

**Files:**
- Modify: `app/Economy/EconomyService.php` (`ownedRows`, `evaluateAt`, `standings`, `snapshot`), `app/Economy/LoanService.php` (`netWorth`)
- Test: `tests/Feature/UpgradeIncomeTest.php`

**Interfaces:**
- Consumes: `Upgrades::rowIncome`, `dampenFactor`, `zoneWeight`, `hasDiscount`, `assetValue`, `next`; columnas del Task 3.
- Produces: las filas de `ownedRows` y de `standings` llevan `base`, `kind`, `level`, `branch`, `upgrade_paid`; `evaluateAt` arma `income = Upgrades::rowIncome(...)` y `weight = Upgrades::zoneWeight(...)` antes de `Combos::evaluate`. `snapshot()['properties'][]` suma `level` (int), `branch` (?string), `upgrade_paid` (int), `gross`, `maintenance`, `net` (ints, con factor 1) y `upgrade` (lista de `Upgrades::next(...)`, con `discount` según las propiedades del jugador). `standings` y `LoanService::netWorth` suman `Upgrades::assetValue(price, upgrade_paid)` por propiedad.

- [ ] **Step 1: Pruebas que fallan** (`UpgradeIncomeTest`, con fábricas de las pruebas de `EconomyServiceTest`; insertar nivel y rama con `DB::table('match_properties')->update`): `test_el_ingreso_por_dia_es_neto`; `test_un_evento_de_crisis_no_deja_ingreso_negativo` (activar un evento con `Carbon::setTestNow` dentro de la ventana del calendario de la partida); `test_el_sprint_duplica_el_bruto_y_no_el_mantenimiento`; `test_la_rama_b_de_la_casa_completa_el_combo_de_zona` (dos casas en la misma celda, una con nivel 2 rama b y una tercera ya cuenta); `test_liquidar_de_a_poco_da_lo_mismo_que_de_una_vez` con una mejora; `test_el_patrimonio_cuenta_la_mitad_de_lo_invertido`; `test_standings_y_prestamo_usan_el_mismo_patrimonio` (compara `standings()[i]['net_worth']` con `LoanService::netWorthOf($matchId, $userId, $cash, $debt)`); `test_el_snapshot_trae_desglose_y_opciones`.
- [ ] **Step 2:** Run `php artisan test --filter=UpgradeIncomeTest`. Expected: FAIL.
- [ ] **Step 3:** Implementar. `ownedRows` agrega `mp.level, mp.branch, mp.upgrade_paid, p.price` y devuelve `base` (el `income_per_day`), `level`, `branch`; `evaluateAt` calcula por fila `factor = MatchEvents::factor(...)` (si hay eventos activos, si no 1.0) y `income = Upgrades::rowIncome($kind, $base, $level, $branch, $factor)` (que aplica `dampenFactor` por dentro). Mantener `income` en la fila como hoy para `Combos`. Hacer público en `LoanService` el cálculo de patrimonio como `netWorthOf(int $matchId, int $userId, int $cash, int $debt): int` (hoy privado `netWorth`).
- [ ] **Step 4:** Run `php artisan test` (suite completa). Expected: PASS sin romper las 571 existentes.
- [ ] **Step 5: Commit.** `git commit -am "feat: ingreso neto y patrimonio con mejoras"`

### Task 5: `UpgradeService`, ruta y controlador

**Files:**
- Create: `app/Economy/UpgradeService.php`
- Modify: `app/Http/Controllers/GameController.php` (acción `upgrade`), `routes/web.php`
- Test: `tests/Feature/UpgradeServiceTest.php`, `tests/Feature/UpgradeApiTest.php`

**Interfaces:**
- Consumes: `EconomyService::liveMatch`, `lockPlayer`, `settleIncome`; `Upgrades::cost`, `hasDiscount`; `LedgerType::Mejora`.
- Produces: `UpgradeService::upgrade(User $user, int $matchId, int $propertyId, int $toLevel, ?string $branch, ?string $idempotencyKey): array{property_id: int, level: int, branch: ?string, cost: int, balance: int, income_per_day: int, replayed: bool}`.
- Produces: `POST /api/partidas/{match}/propiedades/{property}/mejorar`, nombre `api.mejorar`, mismo grupo y restricciones que `api.vender`, cuerpo `{nivel: 1|2, rama?: 'a'|'b'}`, encabezado `Idempotency-Key`, respuesta `{ok: true, match_id} + resultado`, `Cache-Control: no-store, private`.

- [ ] **Step 1: Pruebas de servicio que fallan** (`UpgradeServiceTest`): `test_mejora_de_cero_a_uno_cobra_y_escribe_el_libro`; `test_mejora_de_uno_a_dos_con_rama`; `test_no_se_salta_de_cero_a_dos`; `test_rama_invalida_o_faltante`; `test_nivel_uno_con_rama_es_rama_invalida`; `test_solo_el_dueno_mejora`; `test_no_se_mejora_con_subasta_abierta`; `test_no_se_mejora_con_oferta_abierta`; `test_fondos_insuficientes_cuentan_lo_reservado`; `test_la_misma_clave_devuelve_lo_mismo_y_no_cobra_dos_veces`; `test_la_clave_para_otra_propiedad_es_error`; `test_dos_envios_sin_clave_solo_suben_un_nivel` (el segundo lanza `mejora_no_disponible`); `test_el_primer_centro_logistico_se_paga_completo_y_el_segundo_con_descuento`; `test_se_liquida_el_ingreso_pendiente_antes_de_cobrar`; `test_partida_terminada_no_permite_mejorar`.
- [ ] **Step 2: Pruebas de API que fallan** (`UpgradeApiTest`): `test_requiere_sesion`; `test_ruta_valida_los_numeros`; `test_respuesta_trae_nivel_costo_y_saldo`; `test_cuerpo_invalido_da_422` (nivel 3, rama `c`); `test_encabezado_de_clave_invalido_da_422`.
- [ ] **Step 3:** Run `php artisan test --filter=Upgrade`. Expected: FAIL.
- [ ] **Step 4: Implementar `UpgradeService::upgrade`** con los pasos de la spec 3.3 (transacción con 3 intentos; reproducción por `idempotency_key` en el libro con `type = mejora` revisando que `property_id` coincida; el nivel destino de la reproducción es el de la fila actual, no se vuelve a ejecutar). Orden de bloqueos: partida compartida, propiedad (`Property::lockForUpdate`), jugador. Descuento calculado leyendo las filas del jugador dentro de la transacción. Agregar acción y ruta.
- [ ] **Step 5:** Run `php artisan test --filter=Upgrade`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add app routes tests && git commit -m "feat: mejorar propiedades (servicio, ruta y libro)"`

### Task 6: Ofertas, venta al banco y traspaso

**Files:**
- Modify: `app/Economy/OfferService.php` (lista de ofertas)
- Test: `tests/Feature/UpgradeTradeTest.php`

**Interfaces:**
- Produces: cada oferta en la lista que ya arma `OfferService` (línea ~355) suma `level` (int), `branch` (?string) y `label` (?string, etiqueta de la rama o "Reformada"; `null` si nivel 0).

- [ ] **Step 1: Pruebas que fallan:** `test_la_oferta_aceptada_traspasa_nivel_rama_e_inversion`; `test_la_lista_de_ofertas_muestra_nivel_y_etiqueta`; `test_vender_al_banco_devuelve_el_porcentaje_de_lista_y_pierde_la_mejora` (la fila desaparece, el reembolso es el de siempre); `test_abandonar_la_partida_borra_las_mejoras`.
- [ ] **Step 2:** Run `php artisan test --filter=UpgradeTradeTest`. Expected: FAIL solo en las pruebas de la lista.
- [ ] **Step 3:** Agregar los tres campos a la lista de ofertas (leer `level`, `branch` de `match_properties`, etiqueta con `Upgrades::option`). No cambiar `complete()`: solo cambia `owner_id`, `bought_at` y `price_paid`.
- [ ] **Step 4:** Run `php artisan test`. Expected: PASS completo.
- [ ] **Step 5: Commit.** `git commit -am "feat: la oferta muestra la mejora y la mejora viaja con la propiedad"`

### Task 7: Configuración pública y modelo JavaScript

**Files:**
- Modify: `app/Support/PublicConfig.php` (clave `upgrades` en `forLobby`), `resources/js/map/combos.js` (`zoneHint` suma `weight`), `tests/Feature/PublicConfigTest.php`
- Create: `resources/js/map/upgrades-model.js`, `tests/js/upgrades-model.test.mjs`
- Modify: `tests/js/combos.test.mjs`

**Interfaces:**
- Produces (`PublicConfig`): `upgrades` = `{discountPct: int, netWorthPct: int, kinds: {<tipo>: {levels: [{level, branch, label, costPct, boostPct, maintPct}], branchBEffect: string}}}`. Los porcentajes son enteros (ej. 50), el texto del efecto B sale de la configuración.
- Produces (`upgrades-model.js`, puro): `describeOption(option, money, daysLeft): {title, costText, netText, maintText, paybackText, warn}`; `blockReason({playing, mine, busy, available, cost, inAuction, inOffer}): string|''`; `sellWarning(level): string|''`.
- Produces: `zoneHint(at, mine, owned, rules)` suma `m.weight ?? 1` de cada propiedad propia de la zona.

- [ ] **Step 1: Pruebas que fallan:** PHP `test_la_configuracion_publica_trae_las_mejoras` (claves, porcentajes y etiquetas); JS en `upgrades-model.test.mjs`: `describeOption` con y sin recupero mayor que los días que quedan (`warn` no vacío), `blockReason` para cada causa en orden (no jugando, no es tuya, ocupada en subasta, en oferta, ocupado el panel, sin plata con la cantidad que falta), `sellWarning(0) === ''` y `sellWarning(2)` menciona que se pierde; en `combos.test.mjs`: `zoneHint` cuenta `weight` 2.
- [ ] **Step 2:** Run `npm run test:js` y `php artisan test --filter=PublicConfigTest`. Expected: FAIL.
- [ ] **Step 3:** Implementar las tres piezas; sin DOM en el modelo.
- [ ] **Step 4:** Run ambos. Expected: PASS.
- [ ] **Step 5: Commit.** `git add app resources tests && git commit -m "feat: configuración pública y modelo del panel de mejoras"`

### Task 8: Panel de mejoras, aviso al vender y tarjeta de oferta

**Files:**
- Modify: `resources/views/partida.blade.php` (bloque `#panel-upgrades` dentro del panel, antes de `.panel-actions`, con `?` hacia la guía), `resources/js/map/main.js` (render en la función del panel de propiedad), `resources/js/map/game.js` (acción `upgrade(propertyId, level, branch)` y propiedades con `level`, `branch`, `upgrade_paid`, `weight` en `state.props`), `resources/js/map/offers-ui.js` (nivel y etiqueta en la tarjeta), `resources/css/paneles.css`
- Test: `tests/js/panel-model.test.mjs` (si hace falta ajustar), `tests/js/offers-model.test.mjs`

**Interfaces:**
- Consumes: `describeOption`, `blockReason`, `sellWarning` (Task 7); `me.properties[].upgrade/level/branch/gross/maintenance/net` (Task 4); respuesta de `api.mejorar` (Task 5).
- Produces: `game.upgrade(propertyId, level, branch)` → hace `postJson(`${base()}/propiedades/${propertyId}/mejorar`, {'Idempotency-Key': newKey()}, {nivel, rama})`, actualiza `setBalance` y refresca el snapshot.

- [ ] **Step 1: Pruebas que fallan:** en `offers-model.test.mjs`, el texto de una oferta con `level` 2 incluye la etiqueta y con `level` 0 no agrega nada. (La parte de DOM se prueba en el e2e de Task 10.)
- [ ] **Step 2:** Run `npm run test:js`. Expected: FAIL en lo nuevo.
- [ ] **Step 3:** Implementar. En el bloque: nivel y etiqueta actuales, tres líneas de desglose (bruto, mantenimiento, neto) y un botón por opción de `upgrade`; el botón del nivel 2 abre una confirmación dentro de la página ("No se puede deshacer", Confirmar / Cancelar) y recién ahí llama a `game.upgrade`. Botón deshabilitado con `blockReason` escrito. `#btn-sell` muestra `sellWarning(level)` en su confirmación. Oculto si no es mía o no se está jugando. Todo con `textContent`, clases CSS en `paneles.css`, `aria-live="polite"` para el mensaje y foco devuelto al botón al cerrar la confirmación.
- [ ] **Step 4:** Run `npm run test:js && npm run build`. Expected: PASS y build sin errores.
- [ ] **Step 5: Commit.** `git add resources && git commit -m "feat: panel de mejoras en la pantalla de partida"`

### Task 9: Guía "Mejoras", manual y README

**Files:**
- Modify: `resources/js/guides/guides-model.js` (guía `partida-mejoras`), `tests/js/guides-model.test.mjs`, `README.md`
- Modify: `resources/views/partida.blade.php` (botón `?` ya agregado en Task 8; verificar `data-guia="partida-mejoras"`)

**Interfaces:**
- Consumes: `cfg.upgrades` (Task 7).
- Produces: guía `{id: 'partida-mejoras', place: 'partida', title: 'Mejoras', summary: 'Invertir en tus propiedades, elegir un perfil y pagar el mantenimiento.', version: 1, auto: false, available: ({cfg}) => Boolean(cfg.upgrades), steps}` con 3 pasos: niveles y costo; ramas y qué cambia cada una; mantenimiento, neto y qué se pierde al vender (con los porcentajes de `cfg.upgrades`). `targets` de cada paso: `['#panel-upgrades', '#panel']`.

- [ ] **Step 1: Pruebas que fallan:** `la guía de mejoras existe, es de la partida, no es automática y trae 3 pasos con la configuración`, `no está disponible sin cfg.upgrades`, y que el catálogo sigue sin ids repetidos ni destinos inexistentes (las pruebas existentes de `guides-model` ya lo cubren y deben seguir pasando).
- [ ] **Step 2:** Run `npm run test:js`. Expected: FAIL.
- [ ] **Step 3:** Implementar la guía y agregar una sección "Mejoras y mantenimiento" al README (reglas, tabla de valores, cómo calibrar, migración nueva).
- [ ] **Step 4:** Run `npm run test:js`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: guía de mejoras y documentación"`

### Task 10: Verificación completa y entrega

**Files:**
- Modify: `$S/ft-e2e/e2e-etapa1.mjs` o un script nuevo `e2e-mejoras.mjs` (en `$S`, no en el proyecto)

- [ ] **Step 1:** Escribir `e2e-mejoras.mjs` con `k2-lib.mjs`: dos usuarios, una partida iniciada, comprar una casa, mejorar a nivel 1 y a nivel 2 con confirmación, ver el ingreso neto y el desglose cambiar en el panel, el aviso al vender, el botón deshabilitado con la plata reservada, y cero errores de consola. Agregar la comprobación axe del panel con `bypassCSP: true`.
- [ ] **Step 2:** Run `bash $S/sync.sh && cd $S/ft-test && php artisan migrate --force && php artisan test` y `npm run test:js`. Expected: PHP todo verde (571 anteriores + las nuevas, 4 omitidas), JS todo verde (356 anteriores + las nuevas).
- [ ] **Step 3:** Run `bash $S/sync-e2e.sh`, esperar ~65 s entre corridas y ejecutar `e2e-etapa1.mjs`, `e2e-guias.mjs`, `e2e-mejoras.mjs` y `audit-a11y2.mjs`. Expected: 26/26, 45/45, todo OK del nuevo, axe 0 violaciones.
- [ ] **Step 4:** Revisión final de la rama completa (autorrevisión si no se usan subagentes) contra la spec y la sección Review Focus.
- [ ] **Step 5:** Entrega a `C:\laragon\www\formosa-tycoon` con manifiesto md5 de `app resources routes tests config database docs vite.config.js README.md scripts`, copiando solo los archivos distintos o faltantes, verificando con `md5sum -c` y borrando el manifiesto. Informar los pasos del usuario: `php artisan migrate`, `npm run build`, reiniciar el lanzador y Ctrl+F5.
