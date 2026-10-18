# Holdy (PWA) – guía rápida

## Qué hace
- Cargás a mano cada posición: broker (Interactive Brokers o Balanz), ticker, cantidad, precio de compra y moneda.
- Muestra valor actual, ganancia en plata y en %, peso dentro de la cartera y totales por broker y por moneda (USD y ARS nunca se mezclan).
- La idea es pasar todo a Interactive Brokers: las posiciones que siguen en Balanz se pueden marcar como migradas.
- Tus datos quedan solo en el dispositivo (no se suben a ningún servidor). Desde Ajustes podés exportar/importar un archivo de respaldo.

## De dónde salen los precios
- **Automático (Finnhub):** acciones de EE.UU. (las que tenés en IBKR). Necesita una API key gratuita de https://finnhub.io/register. Se pega en Ajustes → "Probar clave".
- **Manual:** para cualquier otro activo (por ejemplo, acciones argentinas o CEDEARs en Balanz) cargás vos el precio actual. La app guarda cuándo lo cargaste.
- Los precios se piden al abrir la app y cada minuto mientras está abierta. Si no hay conexión, muestra los últimos guardados.

## Cómo publicarla (hace falta para que se instale en el celu)
Una PWA tiene que estar en una dirección web con https. Opciones gratuitas:

**GitHub Pages**
1. Creá un repositorio nuevo en GitHub y subí todos los archivos de esta carpeta.
2. Settings → Pages → Branch `main` / carpeta raíz → Save.
3. En un par de minutos queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.

**Netlify (arrastrar y soltar)**
1. Entrá a https://app.netlify.com/drop, arrastrá la carpeta y te da una dirección.

Si algún paso cambió en esos sitios, avisame y lo ajustamos.

## Instalarla como app
- **Android (Chrome):** menú ⋮ → "Instalar app" o "Agregar a pantalla principal".
- **iPhone (Safari):** botón Compartir → "Agregar a pantalla de inicio".

## Para tener en cuenta
- Si tu API key queda guardada en el navegador del celu, cualquiera que use ese celu desbloqueado podría verla. La clave gratuita no da acceso a dinero ni a cuentas, solo a cotizaciones.
- Si borrás los datos del navegador se pierden las posiciones: exportá un respaldo de vez en cuando.
- El plan gratuito de Finnhub tiene límite de consultas por minuto; con una cartera chica alcanza de sobra.

## Servidor de precios compartido (Cloudflare Worker)
Para que quien use Holdy no tenga que crear cuenta en Finnhub, los precios pueden pasar por un Worker propio que guarda la clave como secreto.
- El código está en `worker/worker.js`. Hay que crear un Worker en Cloudflare, pegar ese código y guardar la clave de Finnhub como secreto con el nombre `FINNHUB_KEY`.
- Después se pone la dirección del Worker en `PROXY_URL` (arriba del script de `index.html`; hoy apunta a lingering-wind-a188.hernan-ss.workers.dev).
- Todos los usuarios comparten el límite del plan gratuito de Finnhub. Si Holdy tiene muchos usuarios, cada uno puede usar su propia clave desde Ajustes.

## Funciones de la app
- **Variación del día** por posición y en el total de cada moneda (para acciones con precio automático).
- **Filtro por broker** (Todos / IBKR / Balanz) y **orden** (mayor valor, ganancia % o $, variación del día, ticker). Las monedas nunca se mezclan.
- **Ocultar montos**: tapa importes y cantidades (los porcentajes siguen visibles). Queda guardado en el dispositivo.
- **Lista en acordeón**: cada acción es una fila simple (valor y ganancia %); al tocarla se abre el detalle (cantidad, compra, actual, día, valor, ganancia, peso) y las acciones. Se abre una a la vez.
- **Migración a IBKR**: porcentaje del valor ya en Interactive Brokers y botón "Pasar a IBKR" en cada posición de Balanz (mantiene cantidad y precio de compra).
- **Perfiles y código para compartir**: podés tener varios perfiles (botón con el nombre arriba). "Compartir" genera un código (ej. ABCDE-FGHJK). Tu amigo lo pega en Perfiles → "Agregar perfil" y ve tu cartera en solo lectura; cada vez que cambies algo en la tuya se actualiza sola en la suya. "Dejar de compartir" borra el código. Quien tiene el código ve cantidades y precios de compra.
- Si el servidor todavía no tiene la sincronización activada, "Compartir" ofrece un link con una foto fija (no se actualiza).
- **Recordatorio de respaldo** si pasaron más de 2 semanas sin exportar, y botón **Instalar app** en Ajustes cuando el navegador lo permite (Android/Chrome).


## Activar la sincronización por código (una sola vez, en Cloudflare)
Usa el mismo Worker de precios, con un almacén KV:
1. Cloudflare → Storage & databases → KV → Create a namespace (`holdy-profiles`).
2. Tu Worker → Settings → Bindings → Add → KV namespace, variable `HOLDY_KV` → elegí `holdy-profiles`.
3. Edit code → pegá el contenido actual de `worker/worker.js` → Deploy.
Plan gratuito de KV: unas 1.000 escrituras por día; Holdy agrupa los cambios para gastar pocas.


## Estructura y direcciones
- `index.html` (raíz): página de presentación. `app/`: la app (PWA). La dirección principal es https://holdy.pages.dev (Cloudflare Pages, se actualiza solo con cada cambio en GitHub); https://hernansson.github.io/holdy/ sigue activa.
- Login con Google: proyecto "Holdy" en Google Cloud (ID de cliente en `app/index.html` y `worker/worker.js`). La app está en modo "Prueba": solo entran los emails agregados como usuarios de prueba (Google Auth Platform → Público). Para que entre cualquiera, hay que publicarla.
- El Worker (`worker/worker.js`) verifica el token de Google y guarda la cartera de cada usuario en el KV. Tras cambiarlo hay que pegarlo en Cloudflare y desplegar.
- Entrada: al abrir la app sin sesión se ve solo la pantalla "Entrá con Google" (`#gate`); la cartera y los links de compartir se habilitan después de iniciar sesión. La landing manda directo a la app si ya hay sesión guardada (`cartera.auth.v1`).
- ETFs europeos (VUAA, EQAC): el Worker prueba Finnhub y, si no tiene el símbolo, Yahoo Finance (bolsa de Londres `.L`, o el símbolo exacto si lleva sufijo, ej. VUAA.DE). Devuelve la moneda real; si no coincide con la de la posición, la app avisa. Hay que volver a pegar `worker/worker.js` en Cloudflare para activarlo.
- Comparar rendimientos: botón "Comparar" (aparece con 2 o más perfiles). Rendimiento ponderado por tiempo con efectivo virtual (lo cobrado en ventas se reutiliza antes de contar plata nueva), usando compras con fecha, ventas registradas y precios diarios de `/history` del Worker (Yahoo, cierres sin dividendos). Solo posiciones en USD con fecha de compra. Referencia: SPY. Hay que volver a pegar `worker/worker.js` en Cloudflare para activar `/history`.
- Moneda para mostrar (CCL / MEP / $): como las apps internacionales (StocksCafe, Portfolio Performance, Sharesight). Lo que pagaste va con el dólar CCL y MEP del día de cada compra y lo que vale, con el de hoy; en las ventas, la venta va con el dólar del día de la venta. La ganancia se separa en "por la acción" (dólar fijo) y "por el dólar". Cada lote y cada venta guarda `x=[ccl,mep]` de su día (el Excel de Balanz lo trae); si falta, se usa el historial de argentinadatos.com (o `/fx` del Worker como respaldo; hay que volver a pegar `worker/worker.js` en Cloudflare para activarlo). Las acciones y CEDEARs se guardan en dólar CCL; los bonos, en dólar MEP.
- Fondos comunes (FCI): se importan del Excel de Balanz (ej. INSTITUA = Balanz Institucional - Clase A). El valor de la cuotaparte se trae cada 4 h de argentinadatos.com (`/v1/finanzas/fci/<categoría>/ultimo`, datos de la CNV) y se pasa a dólar CCL con el de hoy. La posición lleva la marca `{fci:P}` (fondo en pesos) o `{fci:D}` (en dólares) en la nota. Si no se encuentra el fondo, se puede poner precio manual.
- Cupones y dividendos: tarjeta arriba de las pestañas Renta fija (cupones próximos y cobrados) y Acciones (dividendos cobrados); al tocarla abre una hoja desde abajo.
- Los fondos van en la pestaña Renta fija (salvo los de renta variable, que van en Acciones), con la leyenda "Fondo en pesos/dólares" bajo el ticker. No entran en Cupones.
- "¿Qué pasó con X?" (botón en el detalle de cada acción): el Worker (`/insight`) junta noticias del último mes, opinión de analistas y perfil (Finnhub gratis), precio de un año (Yahoo) y pide un resumen a Workers AI (Llama, cupo gratis diario de Cloudflare). Se guarda 12 h en el KV. Para activarlo: en el Worker → Settings → Bindings → Add → Workers AI, nombre de variable `AI`; después pegar `worker/worker.js` y Deploy. Sin el binding funciona igual pero sin el resumen.
- Buscar (lupa arriba): busca cualquier acción o ETF de EE.UU. por nombre o ticker (`/search` del Worker, Finnhub) y abre la misma pantalla "¿Qué pasó con X?".
- IBKR automático (Perfiles → el perfil, solo si tiene posiciones de IBKR): el usuario guarda el token del Flex Web Service y el Query ID (Worker `/me/ibkr`, KV `ib:<usuario>`). `/me/ibkr/sync` pide el reporte (SendRequest/GetStatement v3) y la app lo importa como un archivo, incluido el efectivo de "Cash Report" (EndingCash → Plata sin invertir de IBKR). Se actualiza solo al abrir la app si pasaron 12 h.
- Versión visible (menú): `APP_SEMVER` en index.html, semántica y a mano (mayor.funciones.arreglos). `APP_VER`/`CACHE` (holdy-vNNN) es interno y sube en cada publicación.

## Cómo publicar un cambio (para cuando toques el código)
1. Editá `app/index.html` (la app entera está en ese archivo) y hacé commit de tus cambios.
2. Subí la versión con npm, como en cualquier proyecto:
   - `npm version patch` → arreglo o retoque chico (1.9.3 → 1.9.4)
   - `npm version minor` → función nueva (1.9.3 → 1.10.0)
   - `npm version major` → cambio enorme (1.9.3 → 2.0.0)
   Además de `package.json`, copia la versión a `APP_SEMVER` (lo que se ve en el menú) y sube el número interno del caché
   en `app/index.html` (`APP_VER`) y `app/sw.js` (`CACHE`) con `tools/sync-version.js`; hace el commit "1.9.4" y el tag `v1.9.4`.
3. `git push && git push --tags`: Cloudflare Pages publica la app sola en un minuto.
4. Si cambiaste `worker/worker.js`, también se publica solo (GitHub Actions → "Publicar Worker"); el resultado de la prueba se ve en la pestaña Actions del repositorio.
- IBKR en segundo plano: el Worker tiene una tarea diaria (cron `0 11 * * *` y `0 14 * * *`: 8:00 y 11:00 de Argentina, después del cierre contable de IBKR) que trae el reporte de cada usuario conectado y lo guarda 24 h en `ibc:<usuario>`; al abrir la app se aplica al instante. El pedido manual va en dos pasos (SendRequest y luego `?poll=1` cada 4 s, hasta 3 minutos).
- Carteras compartidas: para verlas hay que haber entrado a Holdy; el Worker anota quién mira (`pv:<código>`: nombre, email, última vez) y el dueño lo ve en Compartir (`GET /p/<código>/viewers` con el secreto) y puede quitar el acceso (`POST /p/<código>/block`).
- Qué ve cada persona (Compartir → Configurar): el Worker arma una versión recortada por persona (`viewFor`): solo acciones/renta fija, un broker, sin ventas, sin plata sin invertir, sin dividendos/cupones, vencimiento del acceso, y "solo porcentajes" (cantidades y montos multiplicados por un número secreto de esa persona; la app del otro fuerza "ocultar montos"). Hay una configuración "para quien entre nuevo" (`pv.d`).
- Reportes (menú): pantalla con período (este mes / mes anterior) y secciones con interruptores; arma una hoja A4 (`#rptPaper`) con resultado del mes (evolución diaria de `evoBuild` + ventas + cupones + dividendos), movimientos, posiciones, distribución, cobros y operaciones. "Descargar PDF" usa `window.print()` con CSS de impresión (`html.rpt-print`).
- Próximos dividendos (hoja Dividendos → Próximos): estimados con `/divs` del Worker (dividendos por acción de los últimos 2 años, Yahoo): cada cuánto paga (mediana de los intervalos del último año) y el último monto × tus acciones × 0,7 (retención de EE.UU.).
- Proyección (menú): dos modos — "¿Cuánto voy a tener?" (con aporte mensual) y "¿Cuánto tengo que poner?" (meta: llegar a un monto, en dólares de hoy o de ese momento, o vivir con X por mes para siempre o hasta una edad). Monte Carlo (2.000 escenarios, semilla fija) en dólares reales; supuestos editables (rendimiento real, volatilidad, inflación de EE.UU.) con presets SPY 6,5%, VUAA 6,7%, 60/40 4,8%, bonos 2%. Muestra cada monto en dólares de ese año y de hoy. El gasto por mes es proporcional al capital (simSpendPer1) y el aporte necesario se busca por bisección sobre capital = cap×G + aporte×A.
