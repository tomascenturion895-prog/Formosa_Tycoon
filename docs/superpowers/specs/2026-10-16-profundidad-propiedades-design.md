# Profundidad de las propiedades: mejoras, especializaciones y mantenimiento

Fecha: 2026-10-16. Estado: pendiente de revisión.

## 1. Objetivo y alcance

**Qué se quiere.** Que una propiedad deje de ser "comprar y cobrar" y tenga decisiones propias: invertir en ella, elegir un perfil (más ingreso con más costo, o más estable) y pagar un costo continuo por eso. Así hay una forma de gastar plata que no sea comprar otra propiedad, y dos jugadores con las mismas propiedades pueden jugar distinto.

**Qué entra.**
- Dos niveles de mejora por propiedad. El nivel 2 es una especialización de dos ramas, distinta por tipo.
- Mantenimiento diario por mejora, descontado del ingreso. El ingreso que se muestra es neto.
- Un endpoint para mejorar, con el movimiento en el libro de cuentas.
- Panel de propiedad con vista previa, guía nueva y textos.
- Integración con ofertas, venta al banco, patrimonio, eventos, sprint y combos.

**Qué no entra (primera versión).** Cambio de aspecto en el 3D, avisos de mejoras en la actividad de la sala, bots, mejoras reversibles, impuesto progresivo y averías al azar.

**Criterios de éxito.**
1. Mejorar una propiedad cambia el ingreso por día según las tablas de la sección 3, y el servidor y la pantalla muestran el mismo número.
2. Ninguna mejora rinde más que comprar otra propiedad del mismo tipo (el recupero de la mejora es siempre más lento que `1 / rate_per_day`), y los tiempos de recupero caen en las bandas de la sección 3.
3. Repetir la misma petición (doble clic, reintento de red) no cobra dos veces ni sube dos niveles.
4. Con la partida cerrada, la propiedad en subasta o en oferta, o sin plata disponible, no se puede mejorar y el mensaje dice por qué.
5. El patrimonio y el ranking cuentan las mejoras igual en todos los lugares donde se calcula.

## 2. Reglas del juego

### 2.1 Niveles y ramas

Cada propiedad de una partida está en nivel 0 (sin mejora), 1 o 2.

- **Nivel 1, "Reformada".** Un solo camino, igual para todos los tipos.
- **Nivel 2, especialización.** Se elige la rama **A** o la **B** (según el tipo) y no se puede cambiar ni deshacer. Solo se llega desde el nivel 1; no se salta de 0 a 2.

| Tipo | Rama A | Rama B | Efecto propio de la rama B |
|---|---|---|---|
| Casa | Alquiler turístico | Edificio de departamentos | Cuenta como 2 propiedades para el combo de zona. |
| Comercio | Shopping | Mayorista | Los eventos que bajan el ingreso le pegan la mitad. |
| Supermercado | Hipermercado | Centro logístico | Mientras tengas al menos uno, tus mejoras cuestan 20 % menos. |
| Hotel | Resort | Hotel de negocios | Sin efecto extra: su ventaja es el mantenimiento bajo. |

La rama A de todos los tipos es la de más ingreso y más mantenimiento.

### 2.2 Ingreso, mantenimiento y neto

Sea `I` el ingreso por día de lista de la propiedad (`properties.income_per_day`, sin eventos ni combos).

- **Bruto** = `floor(I × (1 + boost))`, con `boost` según nivel y rama.
- **Mantenimiento** = `floor(I × maint)`, con `maint` según nivel y rama. Se calcula sobre `I`, así que no cambia con eventos ni sprint.
- **Ingreso de la fila** (el que entra a eventos y combos) = `max(0, floor(bruto × factor_de_eventos) − mantenimiento)`.

`factor_de_eventos` es el actual (`MatchEvents::factor`, que ya incluye el sprint). La rama B del comercio lo modifica así: si el factor es menor que 1, pasa a `1 − (1 − factor) × 0,5`. Los factores mayores que 1 no se tocan.

Los combos se calculan sobre el ingreso de la fila (ya neto). La rama B de la casa suma 2 al conteo de su zona (no cambia su ingreso ni el de las demás). El combo de variedad no cambia.

La plata llega neta en el cobro de siempre; **no hay un movimiento aparte por mantenimiento**. El panel desglosa bruto, mantenimiento y neto para que se vea de dónde sale.

### 2.3 Costo de mejorar

Costo = `floor(price × cost_pct)` con `price` el precio de lista de la propiedad. El costo del nivel 2 es lo que se paga encima del nivel 1 (no se devuelve nada del 1). Con un centro logístico propio, el costo baja un 20 % (`floor(costo × 0,8)`); construir el primer centro logístico se paga completo, porque todavía no hay uno.

La plata sale del disponible del jugador (efectivo menos reservas de subastas y ofertas). El servidor libera primero el ingreso pendiente, igual que en una venta.

### 2.4 Valores iniciales

Se calibran con el simulador, pero estos son los de partida y los que fijan las pruebas de la sección 5. `cost_pct` es sobre el precio de lista; `boost` y `maint` son sobre `I`.

| Nivel / rama | cost_pct | boost | maint |
|---|---|---|---|
| 1, Reformada | 0,50 | 0,40 | 0,05 |
| 2, rama A | 0,80 | 1,10 | 0,30 |
| 2, rama B | 0,60 | 0,75 | 0,10 |

Los números son iguales para los cuatro tipos; lo que cambia es `I` (porque cada tipo tiene su `rate_per_day`) y el efecto de la rama B.

**Bandas de recupero** (días de juego, `costo / aumento del ingreso neto por día`, medido contra el nivel anterior, sin eventos ni combos). Con `rate` = `rate_per_day` del tipo: nivel 1 entre 5 y 8; nivel 2 rama A entre 6 y 10; rama B entre 7 y 11. En todos los casos el recupero tiene que ser mayor que `1 / rate`. Una prueba de configuración recorre los cuatro tipos y falla si alguien cambia la tabla y se sale de las bandas.

Con los valores iniciales: nivel 1 recupera en `1,43 / rate` días (5,7 para casa, 7,1 para hotel); rama A en `1,78 / rate` (7,1 a 8,9); rama B en `2,0 / rate` (8,0 a 10,0).

### 2.5 Interacciones

| Situación | Regla |
|---|---|
| Subasta o oferta abierta sobre la propiedad | No se puede mejorar (mismo bloqueo que la venta al banco). |
| Oferta entre jugadores | La mejora viaja con la propiedad. El comprador paga lo que ofertó; la comisión sigue siendo la de siempre. |
| Venta al banco | Devuelve el mismo porcentaje del precio de lista y la mejora se pierde. El panel lo avisa antes de confirmar. |
| El jugador abandona la partida | Pierde sus propiedades y sus mejoras (ya pasa con las propiedades). |
| Sprint final | Se puede mejorar. El mantenimiento no se duplica; el bruto sí (por el factor). La vista previa muestra el recupero contra el tiempo que queda. |
| Patrimonio y ranking | Una propiedad vale `price + floor(upgrade_paid × 0,5)`, donde `upgrade_paid` es lo realmente pagado en mejoras (con descuento). Invertir no es plata tirada, pero pierde la mitad hasta que rinde. |
| Préstamos | El tope de préstamo usa el patrimonio, así que las mejoras lo suben. Es aceptado. |

## 3. Diseño técnico

### 3.1 Reglas puras: `App\Economy\Upgrades`

Clase final sin base de datos, como `Combos`, con la configuración en `config/formosa.php` (`upgrades`). Firmas:

- `levels(): array` y `option(string $kind, int $level, ?string $branch): array` con `cost_pct`, `boost`, `maint`, `label`.
- `rowIncome(int $base, int $level, ?string $branch, float $eventFactor, string $kind): int` → ingreso neto de la fila.
- `cost(int $price, int $toLevel, ?string $branch, bool $discount): int`.
- `zoneWeight(string $kind, int $level, ?string $branch): int` → 1 o 2.
- `dampenFactor(string $kind, int $level, ?string $branch, float $factor): float`.
- `hasDiscount(array $ownedRows): bool` → hay al menos un supermercado en nivel 2 rama B.
- `assetValue(int $price, int $upgradePaid): int`.
- `paybackDays(string $kind, int $toLevel, ?string $branch, int $base, int $price, bool $discount): float`.
- `next(...)`: las opciones que ofrece el panel (nivel siguiente y ramas), con costo, neto nuevo, mantenimiento y recupero.

`Combos::evaluate` acepta `weight` opcional por fila (por defecto 1) y lo suma al conteo de la zona. La lista `ids` y el bonus por ingreso no cambian.

### 3.2 Base de datos

Una migración nueva sobre `match_properties`:

| Columna | Tipo | Regla |
|---|---|---|
| `level` | tinyint unsigned, NOT NULL, default 0 | CHECK `level BETWEEN 0 AND 2` |
| `branch` | char(1), NULL | CHECK `(level < 2 AND branch IS NULL) OR (level = 2 AND branch IN ('a','b'))` |
| `upgrade_paid` | unsigned int, NOT NULL, default 0 | CHECK `(level = 0 AND upgrade_paid = 0) OR (level > 0 AND upgrade_paid > 0)` |

Más: el tipo `mejora` en la enumeración `ledger_entries.type` y en la regla de signos (`type = 'mejora' AND amount < 0 AND property_id IS NOT NULL`), con el mismo patrón de las migraciones de venta y préstamos.

Seguridad de la migración: las columnas llevan valor por defecto, así que las filas existentes quedan en nivel 0 sin reescribir; la tabla solo tiene filas de partidas y es chica. `down()` borra las columnas y vuelve la regla anterior, y se niega a correr si hay movimientos `mejora` en el libro (igual que la migración de ventas). Los modelos y servicios existentes no necesitan cambios para seguir insertando: los valores por defecto hacen el nivel 0.

### 3.3 Servicio y endpoint

`UpgradeService::upgrade(User $user, int $matchId, int $propertyId, int $toLevel, ?string $branch, ?string $idempotencyKey): array`, en una clase nueva para no seguir engordando `EconomyService` (que aporta `liveMatch`, `lockPlayer` y `settleIncome`). Orden de bloqueos igual que `sell`: partida compartida, propiedad, jugador.

Pasos dentro de una transacción:
1. Partida en juego; propiedad existente; el usuario es el dueño.
2. No está en subasta ni en oferta.
3. `toLevel` es `nivel actual + 1`; si el destino es 2, `branch` es válido para el tipo; si es 1, `branch` va vacío. Si no coincide: error de estado (409).
4. Liquidar el ingreso pendiente del jugador.
5. Costo con descuento si corresponde; el disponible alcanza.
6. Actualizar `level`, `branch`, `upgrade_paid += costo`; restar el efectivo; escribir el movimiento `mejora` (monto negativo, `property_id`, clave de idempotencia).

Idempotencia: la clave viaja en el encabezado `Idempotency-Key` como en compra y venta. Con una clave ya usada para la misma propiedad y nivel destino se devuelve el resultado anterior (`replayed: true`); con la misma clave para otra cosa, error `clave_reusada`. Aparte, sin clave, el paso 3 impide subir dos veces con un doble clic.

Ruta: `POST /api/partidas/{match}/propiedades/{property}/mejorar` con cuerpo `{ "nivel": 1|2, "rama": "a"|"b" }` (rama solo para el nivel 2), mismas restricciones de rutas, límite de frecuencia y `Cache-Control: no-store` que `vender`. Respuesta: `{ ok, property_id, level, branch, cost, balance, income_per_day, replayed }`.

Errores nuevos en `GameException` con códigos estables: `mejora_no_disponible` (estado: nivel ya alcanzado o salto de nivel), `rama_invalida`, `propiedad_ocupada` (reutiliza `inAuction` e `inOffer` existentes). Fondos insuficientes reutiliza `insufficientFunds`.

### 3.4 Dónde se calcula el ingreso y el patrimonio

Hay que pasar `level`, `branch` y `upgrade_paid` por todos los lugares que hoy leen `income_per_day` y `price`:

- `EconomyService::ownedRows` y `standings` (filas con `income` neto, `weight`).
- `EconomyService::evaluateAt`: aplica `dampenFactor`, luego `rowIncome`, luego `Combos::evaluate`.
- `EconomyService::snapshot`: cada propiedad propia trae `level`, `branch`, `upgrade_paid`, `gross`, `maintenance`, `net` y `upgrade` (las opciones del panel, calculadas en el servidor para no duplicar la cuenta en JavaScript).
- Patrimonio: `standings` y `LoanService::netWorth` usan `Upgrades::assetValue`. Es el único cambio permitido en esos dos lugares; la prueba de la sección 5 compara ambos.
- `EconomySimulator`: se mantiene sin mejoras (nivel 0) para no cambiar la calibración existente.

El resto de los servicios que escriben `match_properties` (subasta, oferta, compra, corrección de propiedades) no cambian: las inserciones toman los valores por defecto y la oferta solo cambia el dueño. `MatchService` borra las filas del que abandona, y con eso se van las mejoras.

### 3.5 Pantalla

- En el panel de una propiedad propia, bajo los datos actuales: bloque "Mejoras" con el nivel, el desglose (bruto, mantenimiento, neto) y un botón por opción. Cada opción muestra el costo, el ingreso neto nuevo, el mantenimiento y "se recupera en N días" (con una nota si N supera los días que quedan). Si no alcanza la plata o está en subasta/oferta, el botón queda deshabilitado con la razón escrita (no solo el color).
- Elegir la rama del nivel 2 pide una confirmación dentro de la página (sin `confirm()`): "No se puede deshacer".
- La tarjeta de una oferta entre jugadores muestra el nivel y la rama de la propiedad (`OfferService` los incluye en su lista), para que el comprador sepa qué está comprando.
- El botón "Vender" avisa que la mejora se pierde si el nivel es mayor que 0.
- El texto va siempre por `textContent`, sin estilos en línea (CSP), con las etiquetas de accesibilidad de los paneles actuales y el teclado igual que el resto.
- `zoneHint` (copia del navegador de los combos, solo pistas) suma `weight`.
- `PublicConfig::forLobby` expone `upgrades` (niveles, costos, ramas y etiquetas) para las guías y la pestaña "Cómo se juega".
- Guía nueva `partida-mejoras` (lugar `partida`, no automática) y un botón `?` en el bloque. La guía explica niveles, ramas, mantenimiento, neto, qué se pierde al vender y los efectos de la rama B, con los números de la configuración.

## 4. Manejo de errores y casos límite

| Caso | Resultado |
|---|---|
| Dos clics rápidos al mismo botón | La segunda petición ve el nivel ya subido y responde 409 `mejora_no_disponible`, sin cobrar. |
| Reintento de red con la misma clave | Mismo resultado, `replayed: true`, sin segundo cobro. |
| Dos pestañas, una compra y otra mejora | Los bloqueos en orden fijo evitan el cruce; una de las dos espera. |
| Plata alcanza para la mejora pero está reservada en una subasta | Falla por fondos insuficientes con el disponible real. |
| Partida que vence durante la petición | Error de partida no en juego, sin cambios. |
| Mantenimiento mayor que el bruto (evento de crisis en rama A) | El ingreso de esa fila es 0, nunca negativo, y no se descuenta de otras propiedades. |
| Propiedad que cambia de precio por una corrección del admin | El costo futuro usa el precio nuevo; lo ya pagado queda en `upgrade_paid`. |
| Descuento del centro logístico | Se calcula con las filas bloqueadas dentro de la transacción; no depende de lo que muestre el navegador. |

## 5. Pruebas

Se escriben antes que el código (TDD).

- **`Upgrades` (PHPUnit unitario):** `rowIncome` para cada nivel y rama; piso en 0; mantenimiento fijo frente a eventos y sprint; `dampenFactor` solo en la rama B del comercio y solo por debajo de 1; `cost` con y sin descuento; `zoneWeight`; `assetValue`.
- **Bandas de recupero:** recorre los cuatro tipos con la configuración real y falla fuera de las bandas o si el recupero no supera `1 / rate`.
- **Combos:** la fila con `weight` 2 sube el escalón de zona y no cambia los demás resultados con peso 1.
- **Servicio (PHPUnit de funcionalidad):** mejora feliz de 0→1 y 1→2 con el libro, el efectivo y el ingreso; saltar de 0 a 2; rama inválida o faltante; no dueño; subasta u oferta abiertas; fondos insuficientes; reintento con la misma clave; clave reutilizada; doble envío sin clave; centro logístico (el primero a precio completo, la siguiente con descuento); la liquidación previa no pierde ingresos.
- **Integración:** la oferta aceptada traspasa nivel y rama y la lista de ofertas los muestra; la venta al banco devuelve el porcentaje del precio de lista; el patrimonio de `standings` es igual al de `LoanService::netWorth`; el préstamo máximo sube con las mejoras; el ingreso liquidado a lo largo de un evento y del sprint es el mismo liquidando de a poco que de una vez.
- **Migración:** las filas existentes quedan en nivel 0; las restricciones rechazan combinaciones inválidas (nivel 2 sin rama, nivel 1 con rama, `upgrade_paid` en cero con nivel); `down()` se niega si hay movimientos `mejora`.
- **JavaScript (`node --test`):** formateo de las opciones y del desglose; `zoneHint` con peso; el catálogo de guías con la guía nueva (versión, lugar, pasos con y sin configuración).
- **e2e:** mejorar una propiedad hasta el nivel 2 desde el panel, ver el ingreso neto cambiar, el aviso al vender y el rechazo con la plata reservada. Se agregan a los scripts existentes y se repasa la accesibilidad con axe.

## 6. Entrega

- Una migración nueva: el usuario corre `php artisan migrate` (además de `npm run build`, reiniciar el lanzador y Ctrl+F5).
- Se actualizan el README (sección de economía y de guías) y `docs/`.
- Entrega a la PC con el método de siempre (manifiesto md5, solo archivos distintos, verificación posterior). No se toca `.env`, `vendor/` ni `node_modules/`.

## 7. Decisiones y supuestos a revisar

1. **Hotel de negocios:** el diseño hablado decía "parejo en eventos"; para no complicar los eventos (el sprint también es un evento) su ventaja queda en el mantenimiento bajo. La rama B del comercio sí amortigua las crisis.
2. **Las mejoras no se ven en el 3D ni en la actividad de la sala.** Queda para una segunda vuelta.
3. **Las cifras de la sección 2.4 son de partida.** Si el recupero queda fuera de las bandas, se ajusta la tabla y no el código.
4. **El préstamo máximo sube con las mejoras** (usa el patrimonio). Se acepta; si resulta explotable, se pone un tope.
