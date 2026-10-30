# Holdy: contexto completo del proyecto

> Documento para retomar el trabajo en cualquier chat nuevo **sin configurar nada de nuevo**.
> Estado al **26/10/2026 · versión 1.37.2**. Si algo de acá contradice el código, manda el código.

---

## 1. Quién, cómo y reglas de trabajo

- **Dueño:** Hernán (cuenta GitHub `hernansson`). La app es personal y la usan él y sus amigos.
- **Idioma:** responder **siempre en castellano rioplatense** (vos, tenés). Se quejó cuando le respondieron en inglés. Puede escribir en inglés o sin tildes; igual se responde en castellano.
- **Estilo de respuesta:** corto y claro, sin jerga técnica salvo que la pida. Al terminar algo: qué cambió, en qué versión y qué probaste. Usar listas cuando hay varios puntos.
- **Antes de construir algo grande:** proponer opciones numeradas, con una recomendación, y esperar el "dale / mandale / sí". Para arreglos chicos o bugs, hacerlos directo.
- **Opinar en serio:** pidió explícitamente "opiná diferente siempre que pienses que está mal". No darle la razón por darla.
- **Probar antes de publicar:** cada push a `main` va a producción. Probar con Playwright (ver §10) antes de cada release y mirar las capturas.
- **Rollback fácil:** si un cambio de diseño puede no gustarle, avisar cuál es la versión anterior para volver. Ya pasó: el resultado de Proyección abajo no le gustó y se revirtió.
- **Seguridad:** el token de IBKR y el token de Cloudflare **nunca** pasan por el chat. `CLOUDFLARE_API_TOKEN` lo guardó él como *secret* del repo en GitHub.
- **Simplicidad:** cuida mucho que la app sea simple y "nítida". Le molesta lo invasivo, lo enorme, lo repetido y lo que muestra demasiada info en lugares chicos.

---

## 2. Qué es Holdy

PWA (app web instalable) para seguir una cartera de inversiones en **dólares**: acciones y ETFs de EE.UU., CEDEARs, acciones argentinas con ADR, bonos (renta fija), FCIs y plata sin invertir. Tiene una parte social: seguir carteras de amigos, feed de movimientos, reacciones y comentarios, ranking.

- **App:** https://holdy.pages.dev/app/ · **landing:** https://holdy.pages.dev/
- **Repo:** https://github.com/hernansson/holdy (rama `main`)
- **Worker (servidor):** `https://lingering-wind-a188.hernan-ss.workers.dev` (nombre `lingering-wind-a188`)
- Espejo viejo todavía activo: https://hernansson.github.io/holdy/
- `GUIA.md` es una guía vieja (de cuando todo era manual). **Este archivo la reemplaza.**

---

## 3. Estructura del repo

```
index.html            Landing (presentación, login con Google, OG tags para WhatsApp)
og.jpg                Imagen de vista previa al compartir la app (1200x630)
og-seguir.jpg         Imagen de vista previa del link "seguir mi cartera"
seguir/index.html     Página puente del link para seguir una cartera (?c=CÓDIGO) → redirige a /?seguir=CÓDIGO
privacidad.html, terminos.html
app/index.html        TODA la app: HTML + CSS + JS en un solo archivo (~6.700 líneas, vanilla JS, "use strict")
app/sw.js             Service worker (caché + push)
app/manifest.webmanifest, íconos (icon-192/512, apple-touch-icon, badge-96 = ícono blanco de notificación)
worker/worker.js      Cloudflare Worker (~1.050 líneas)
tools/sync-version.js Copia la versión de package.json a APP_VER (index.html) y CACHE (sw.js)
.github/workflows/worker.yml  Publica el Worker cuando cambia worker/**
package.json          Versión de la app (hoy 1.37.2)
CONTEXTO.md           Este documento
```

---

## 4. Cómo se publica (ya está todo configurado)

- **App y landing:** Cloudflare Pages publica solo con cada push a `main` (1 o 2 minutos).
- **Worker:** el workflow `worker.yml` corre cuando cambia `worker/**`. Lee del Worker existente la cuenta, el KV `HOLDY_KV` y la fecha de compatibilidad, arma `wrangler.toml` y hace `wrangler deploy`. Usa el secret `CLOUDFLARE_API_TOKEN`. No toca los secretos guardados en Cloudflare (`FINNHUB_KEY`). Cron: `35 * * * *`.
- **Flujo de release** (siempre así, con las líneas de atribución):

```bash
cd holdy
git commit -qam "Descripción del cambio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0198NSewpkBVE3N9NHgtDyVG"
npm version patch -m "v%s

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0198NSewpkBVE3N9NHgtDyVG"   # minor si es una función nueva grande
git push origin main
```

  `npm version` corre `tools/sync-version.js`: actualiza `APP_VER` en `app/index.html` y `CACHE` en `app/sw.js`, que tienen que cambiar juntos en cada versión para que el celu se actualice. Para revertir: `git revert <hash>` y release.
- **Novedades:** en **cada** versión (también los arreglos chicos, lo pidió Hernán) agregar una entrada arriba de todo en `NOVEDADES` (app/index.html) con la versión exacta que va a salir, un título y 1 a 3 líneas cortas. Al abrir la versión nueva sale una hoja con eso (espera a que no haya nada abierto). Si una versión queda sin entrada, sale una genérica "Arreglos y mejoras", que es vaga: mejor escribirla.
- **Ver si el Worker se publicó:** `gh run list -L 3 | grep -i worker`. Los logs a veces dan 403 desde el sandbox; si falla, compilar localmente con `npx wrangler@4 deploy --dry-run --outdir out` (ver §10).
- **No se puede desde el sandbox:** `curl` a `holdy.pages.dev` o al Worker (el proxy lo bloquea) ni push de tags (403). La verificación real la hace Hernán en el celu.

---

## 5. Servicios externos y límites

| Servicio | Para qué | Notas |
|---|---|---|
| Finnhub (`FINNHUB_KEY`, secret del Worker) | Cotización actual (`/quote`), búsqueda | Plan gratis, solo uso personal; el plan pago cuesta US$ 3.500/mes |
| Yahoo Finance | Historial diario (`/history`), con precio ajustado por dividendos (3ª columna) | Uso personal. Alias: EQAC→EQAC.SW; prueba sufijos .L y .SW |
| dolarapi.com | Dólar CCL y MEP (factor de CEDEARs) | Desde la app |
| data912.com | Precios de bonos argentinos | Desde la app |
| argentinadatos.com (CNV) | Cuotapartes de FCI | Desde la app |
| Workers AI (binding `AI`) | "¿Qué pasó con X?" (insight) y "Preguntale a tu cartera" | Modelos llama-3.1-8b (fp8 y normal). 10.000 neuronas/día gratis; si se pasa, 429 → "Por hoy se llegó al límite…" |
| Google OAuth | Login | Client ID `554911510319-s9etahete05ilh86dd2r2bfnilq1jgkm.apps.googleusercontent.com`. La app está en modo **Prueba**: solo entran los emails cargados como usuarios de prueba en Google Auth Platform |
| Web Push (VAPID) | Notificaciones | Claves guardadas en KV `vapid:`; push sin payload (el SW lee el inbox) |

**Límites del plan gratis de Cloudflare:** Workers 100.000 pedidos/día; KV 100.000 lecturas y **1.000 escrituras por día** (el cuello de botella); AI 10.000 neuronas/día.
**Costo estimado si creciera:** unos US$ 1,20 por mes por usuario muy activo (casi todo IA); 100 usuarios ≈ US$ 31/mes (realista) a US$ 120 (peor caso). Licencias de datos para uso comercial son caras (Twelve Data US$ 499/mes, EODHD US$ 399/mes, etc.).
**Límite de amigos hoy:** unos 10 usuarios totalmente conectados entre sí (por las escrituras KV del chat y "visto").

---

## 6. Worker: rutas y datos

`ALLOWED_ORIGINS`: `https://hernansson.github.io`, `https://holdy.pages.dev` (sin header Origin también pasa, por ejemplo `<img>`).

| Ruta | Qué hace |
|---|---|
| `GET /quote?symbol=` | Cotización (Finnhub o Yahoo) |
| `GET /history?symbols=a,b&from=AAAA-MM-DD` | Historial (máx. 20 símbolos por pedido; la app parte en tandas; si una tanda falla, usa las demás). Caché en memoria 6 h |
| `GET /divs`, `/fx`, `/insight?symbol=`, `/search` | Dividendos, dólar histórico, resumen IA + noticias, búsqueda |
| `POST /auth/google` → `{session}` | Verifica el token de Google; sesión en KV `s:<sha256(session)>`, dura 30 días |
| `POST /auth/logout` | Borra la sesión |
| `GET/PUT /me/data` | Cartera del usuario sincronizada entre dispositivos (KV `u:<sub>`) |
| `GET/PUT /me/profile` | Perfil público: `{n: nombre, ph: foto dataURL, by: año de nacimiento, t}`. KV `pf:<sub>`; foto también en `av:<uid>`. **El GET lee directo de KV** (no de la memoria de 6 h) |
| `GET /av/<uid>?v=<versión>` | Foto de perfil como imagen, caché "immutable" (cambia la versión → se baja de nuevo) |
| `/me/ibkr`, `/me/ibkr/sync` | IBKR automático (Flex Query; token del usuario en KV `ib:`/`ibc:`) |
| `/me/push`, `/me/push/test`, `GET /push/key`, `POST /push/inbox` | Suscripción, preferencias, prueba, clave pública, bandeja (`pin:<sha(endpoint)>`) |
| `POST /me/ask` | Preguntale a tu cartera (la app manda los números ya calculados; la IA solo redacta) |
| `GET/PUT/DELETE /p/<código>[/...]` | Cartera compartida. KV `p:<código>` = `{secretHash, data, updated, o:{s,n}}`; quién mira en `pv:<código>` (config de qué ve cada uno, revocados) |
| `GET/POST /fx/<código>` | Social de una cartera compartida (KV `fx:<código>`). POST `{key,re}` reacción (🔥👏😬🤔😂), `{key,t,rp?,h?}` comentario (máx. 300, guarda los últimos 60, `rp` = responder a un id, `h` = "la tiene" con su %), `{key,lk:id}` me gusta, `{key,del:id}` borrar (autor o dueño). GET devuelve `{k, owner, ow, us:{uid:{n,v}}}` |

`key` de un movimiento: `b|TICKER|AAAA-MM-DD` (compra) o `s|...` (venta).
**Cron (cada hora, minuto 35, UTC):** 11 y 14 → IBKR automático; 12 → avisos de cobros; 21 lun–vie → cierre del mercado (el aviso abre `#hoy`).
**Avisos (`pushTo`):** tipos `fr` (amigos, activado por defecto), cierre, cobros, IBKR. Deep link de comentarios: `#feed/<código>/<key>`.
**Memoria en el Worker:** `PF` (perfiles, 6 h), `histCache` (historial, 6 h).
**Lección aprendida (dos veces):** un comentario `//` escrito en la misma línea **delante** de código tapó ese código, y `node --check` no lo detectó. Usar `/* */` en línea o el comentario en su propia línea, y compilar siempre con `wrangler deploy --dry-run`.

**Optimización pendiente (no hacerla hasta que Hernán diga):** en el polling de `/fx` se repite la lectura de sesión, perfil y `pv`. Cachearlas y escribir el "visto" (`pv`) cada 12 h en vez de cada 1 h subiría el límite a unos 30 amigos.

---

## 7. La app (app/index.html): organización

Todo es vanilla JS dentro de un IIFE. Helpers clave: `$`, `el(tag,cls,text)`, `load/save` (localStorage), `fmtPct`, `mR/mRs` (montos), `dayNum/dayStr/todayStr`, `api(method,path,body)` (con `Authorization: Bearer`), `fetchHistory(list,from)`.

### Pantallas
`setScr(el)` con `SCREENS=[cmpView,dlgProf,dlgSet,rptView,simView,pushView,askView,feedView,hubView]`. Las pantallas entran desde la derecha y salen con animación (`.scr.leave`). Todas usan `history.pushState({scr:1})`, así que el atrás del celu vuelve. Hay sub-pasos con atrás propio: `pvCanBack/pvBackStep` (Perfiles), sub-secciones de Ajustes (`setSub/subOpen`) y `retHub` ("set"|"perf"|"fr") para volver a la pantalla de entradas desde la que se abrió.
Hoja reutilizable: `#dlgSimA` (título `h3`, cuerpo `#simABody`, botón fijo `.sim-ok`). Se usa para Ranking, Compartir, chat de comentarios, Seguir a un amigo, Cómo comparar, etc.

### Pantalla principal
- **Header:** logo · selector de cartera (círculo con tu foto si es tuya; la del amigo si es de un amigo; si no, la inicial) · ícono de amigos con punto de novedades (solo si seguís a alguien) · lupa · ojo (ocultar montos) · menú.
- **Resumen (celu, desde 1.39.3):** CCL/MEP/$ arriba a la izquierda (no moverlo: no le gustó a la derecha); el total grande con la ganancia total chica al lado (sin flecha ni etiqueta y, desde 1.39.8, sin "+" y con "$" en vez de "US$": "$ 1.980 (22,50%)"; el "−" sí queda); abajo "Hoy $ 72,00 (0,98%) ›" (monto y %, sin "+"; desde 1.39.7 volvió el monto, lo pidió Hernán) y "Ver detalle ⌄" a la derecha (tiene que decir "Ver detalle"). A Hernán no le gusta tener mucha info y muchos botones en poco espacio: se probaron cuadritos, pastillas y renglones con etiqueta y no gustaron. "Hoy" queda así "hasta que lo mejoremos". En la compu se ven KPIs en columnas.
- **Cómo te fue hoy (hoja `#dlgSimA`, `dayOpen`):** total del día en US$ y %, contra el S&P 500 y cada acción ordenada por % (más de 8: 4 arriba y 4 abajo con "Ver las N"). Se abre tocando "Hoy" o el aviso de cierre (deep link `#hoy`).
- **Evolución** (gráfico 1M/3M/1A/Todo).
- **Pestañas:** Acciones · Renta fija · Vendidas · **Efectivo**. En el celu van sin número para que entren en una línea; en la compu, con número.
- **Detalle de cada posición:** arriba, en gris chico, el nombre de la empresa (desde 1.39.5; viene en el campo `n` de `/history`, sacado de Yahoo, limpio de "Inc."/"Corporation" con `cleanName`, guardado en `cartera.names.v1`). Después invertido, valor, precio de compra y actual; el resto en **"Ver más"** (recuerda si lo abriste); "¿Qué pasó con X?" (IA + noticias), Editar, Eliminar.
- **Vendidas:** "¿Y si no vendías?" (lo que valdría hoy).
- **Efectivo:** plata sin invertir por broker, "Cargar o cambiar".
- **"✦ Preguntale a tu cartera ›":** una línea chica al final de la lista (antes era una caja grande y no le gustó).
- **FAB "+ Posición".** `body` tiene `padding-bottom` de 88 px solo en la principal (en las otras pantallas no, para no dejar scroll vacío).
- **Bienvenida** (cartera vacía): Importar de mi broker · Cargar a mano · Ver un ejemplo (cartera demo + tour guiado; barra "Salir del ejemplo").

### Menú (cajón)
1. **Tarjeta con tu foto y nombre → Ajustes**
2. Actualizar precios (solo en la compu; en el celu se desliza hacia abajo)
3. Reportes
4. Proyección
5. **Rendimiento ›** → Comparar · Ranking · Compartir mi rendimiento (cada una es su pantalla u hoja de siempre)
6. **Amigos ›** (con badge) → Movimientos de amigos · Seguir a un amigo · Compartir mi cartera · Invitar a Holdy
7. Cerrar sesión · versión

Los botones viejos (`btnAsk`, `btnCash`, `btnFeed`, `btnRank`, `btnShare`, `btnCmp`, `btnPush`, `btnProfAdm`, `btnSettings`) siguen en el HTML **ocultos** porque sus listeners se reusan con `.click()`.

### Ajustes (`#dlgSet`, una lista de secciones)
- **Tarjeta "Tu perfil"** → nombre que ven tus amigos, foto (se recorta y achica a 160×160 JPEG), **año de nacimiento** (completa la edad en Proyección; no lo ven los amigos).
- **Perfiles** (tus carteras: crear, importar, compartir) · **Avisos** · **Seguridad** (cuenta Google y email, aclara que no hay contraseña propia; bloqueo con huella/cara/PIN vía WebAuthn con "Pedirla de nuevo: siempre/1 min/5 min"; "Abrir con montos ocultos"; Cerrar sesión) · **Comparar con el S&P 500** (método, ver §8) · **Datos y copias** (sincronización + exportar/importar/Excel).

### Proyección (`simView`)
- **Primera vez:** preguntas de a una (`simWizard`): qué querés saber (Ahorro / Meta / Renta) → edad → con cuánto arrancás (se completa con la cartera) → cuánto ponés, cuánto querés juntar o cobrar → edad de retiro o cantidad de años → "Ver mi proyección". Se pueden saltar. **"?"** chiquito al lado del título para repetirlas. `simIn.guided`.
- **Pantalla normal:** recuadro verde **arriba y fijo** junto con el título (`.sim-top` sticky), con una frase que explica el cálculo y dos números con nombre:
  - **Ahorro:** "Con US$ X + US$ Y/mes hasta los N" → A los N tenés · Gastás por mes hasta los M.
  - **Meta:** "Para juntar US$ X en N años (año)" + "≈ US$ … de hoy" → Tenés que poner por mes · Vos ponés en total / el mercado suma.
  - **Renta:** "Para cobrar US$ X/mes de los N a los M" + "≈ … /mes de hoy" → Tenés que poner por mes · Necesitás juntar.
  - Debajo: modos · "TUS DATOS" (barras y campos editables; edades en una barra con 3 perillas Hoy/Retiro/Hasta; 100 = ∞ "para siempre") · "Invertís en": SPY, VUAA, **Nasdaq 100 (QQQ)**, Conservadora, Personalizado.
- **Montos:** grandes en dólares del año en cuestión y en chico "≈ de hoy". Renta se carga en dólares de ese año (`simIn.liveN`). Rendimientos reales (sin inflación): SPY 6,5% σ17%, VUAA 6,7%, QQQ 7,5% σ24%, bonos 2% σ6%; inflación 2,5%. Caso normal = mediana de 2.000 simulaciones. **El gasto en retiro ya mantiene el poder de compra** (sube con la inflación); Hernán no lo sabía, pero decidió no agregar texto.
- **Se sacó y no se vuelve a poner:** "De dónde sale", "¿Cómo se calcula?", la hoja de "Ajustar" (ahora todo está en la pantalla) y el resultado abajo (se probó y no gustó).

### Rendimiento
- **Comparar (`cmpView`):** selectores Perfil/Contra (carteras, S&P 500, Nasdaq 100), períodos 1M…5A/Todo, gráfico, veredicto, "¿Por qué?" y tabla. A Hernán le gusta así: **un intento de unificarlo con Ranking no le gustó y se revirtió.**
- **Ranking (hoja):** Este mes / Este año / Todo; tu cartera, amigos, S&P 500 y Nasdaq 100; compartir como imagen.
- **Compartir mi rendimiento (hoja):** imagen 1080×1350 con % (sin montos), mejor y peor acción.

### Amigos y social
- **Compartir mi cartera:** código `ABCDE-FGHJK`; "Copiar" y **"Enviar…"**, que manda "Te comparto mi cartera en Holdy 📈 Tocá el link y se agrega sola: https://holdy.pages.dev/seguir/?c=CÓDIGO". Ese link tiene su propia imagen de vista previa. Quien lo toca: si ya entró, se le abre la confirmación para agregarla; si no, se le abre el login de Google y después se agrega (`cartera.follow.v1`, `followPending()`). El dueño configura qué ve cada persona (todo o solo %, tipos, broker, ventas, vencimiento) y puede revocar.
- **Seguir a un amigo:** hoja para pegar el código.
- **Invitar a Holdy:** abre el menú de compartir del celu con un mensaje y el link a la landing (vista previa `og.jpg`).
- **Movimientos de amigos (feed):** tarjetas compactas ("**Juan** compró por primera vez **NVDA**", "hace 2 días · +9% desde que compró"). Las del mismo día, persona y tipo van agrupadas ("vendió AMD y WMT"); la clave social es la del ticker alfabéticamente primero. Tus movimientos dicen "Compraste…" (sin "Vos"). Tocar foto o nombre abre el **perfil del amigo** (rendimiento mes/año/todo, en qué invierte en %, últimos movimientos, "Ver su cartera completa"). Los badges de nuevo y "visto" se guardan por clave.
- **Reacciones y comentarios:** emojis; los 2 últimos comentarios con "Ver los N anteriores"; "Ver más" en textos largos.
- **Chat del movimiento (hoja):** tus mensajes a la derecha sin nombre ni foto, con la hora abajo; los demás con foto y nombre; hora tipo "14:32", "ayer 14:32" o "12/10 14:32"; separador "NUEVOS"; responder (cita), ❤️ me gusta (sin aviso, para ahorrar escrituras), borrar con doble toque (el autor o el dueño); **"La tiene · +12%"** si quien comenta tiene ese ticker (se puede desactivar, solo %). Polling cada 4 s con chat abierto y cada 15 s con el feed (se frena si la app no está a la vista). El aviso de un comentario abre directo ese chat.
- **Descartado:** filtro Todos/Amigos/Míos y nota "Por qué lo hice" (se hicieron y se sacaron).

### Reportes (`rptView`)
Período (mes, año, desde el inicio, personalizado), qué incluye (resultado, gráfico, lo que más se movió, cómo está repartida, cobros, compras y ventas, mes a mes sin signo "+"), vista previa y **PDF**. KPI **"Contra el S&P 500"** según el método (§8). Si falta algo, dice qué: "no se pudo traer el S&P 500" o "sin historial de tu cartera en el período". El S&P se pide aparte, con reintento (`spyHist`).

### Otras
- **Preguntale a tu cartera (`askView`):** chips de ejemplo; al abrir con el teclado no se esconde el título (viewport `interactive-widget=resizes-content`).
- **Plata sin invertir:** ahora es la pestaña Efectivo. El `dlgCash` se cierra con ✕.
- **Cambiar de cartera con una pantalla abierta** rearma Reportes, Proyección (toma el valor nuevo), Preguntale (borra la conversación), Comparar y Avisos (`screensForProfile`).
- **Ocultar montos (ojo)**, bloqueo con huella, Excel (SheetJS bajo demanda), exportar/importar JSON.

---

## 8. Comparar con el S&P 500: dos métodos (Ajustes)

`cartera.cmpm.v1` = `"pme"` (por defecto) o `"twr"`. Se usa en Reportes, Comparar y Ranking, y cada pantalla muestra una línea chica con el método y "Cambiar".

- **Con tu plata (PME, "cartera espejo"):** cada peso **nuevo** que pusiste va al índice ese mismo día. Las ventas **no** salen: esa plata sigue siendo tuya y, si quedó parada, en el índice habría seguido rindiendo. Las compras hechas con plata de ventas no cuentan como plata nueva. Para un período, la espejo arranca con tu valor al inicio. Funciones: `cmpCurve(ev,hist,today,withCash=true)` → puntos `[día, %, valor, plata nueva]`; `pmeSeries(pts,bench,r0)` → `{p (cuánto le ganás), last{real,sh,put,ex}, real, shadow (% sobre lo que pusiste)}`.
  - **Comparar** con un índice: dos líneas, "Tu cartera" y "Misma plata en S&P 500" (punteada), en % sobre lo que pusiste. Veredicto en plata: "Si todo lo que pusiste hubiera ido al S&P 500, hoy tendrías US$ X. Tenés US$ Y (con US$ Z de ventas sin reinvertir): le ganaste por US$ D (+%)". Con amigos, solo %.
  - **Ranking:** cada uno contra su propia espejo ("+6,2% vs S&P 500"); el S&P no aparece porque es la base.
  - **Reportes:** "Con todo en el S&P 500 tendrías US$ X (vos US$ Y) · %".
- **Solo % (TWR):** rendimiento ponderado por tiempo, el estándar para comparar gestores (`withCash=false`).
- El análisis tiene nombre: **PME (Public Market Equivalent)**, versiones de Long–Nickels y Kaplan–Schoar.

---

## 9. Importar y tipos de activos

- **IBKR:** CSV de Flex Query, pegado o automático (token del usuario en el Worker, cron diario).
- **Balanz:** Excel y CSV del celu.
- **IOL:** Excel de "Operaciones finalizadas" (en realidad es HTML). Soporta el **formato viejo** ("Tipo Mov.", "Nro. de boleto", "Concert.") y el **nuevo** ("Tipo Transacción", "Boleto", "Fecha Transacción", "Simbolo", "Cantidad", "Moneda", "Precio Ponderado"). Los CEDEARs se convierten a la acción con el precio de cada fecha; ignora cauciones y FCIs.
- **CEDEARs:** se guardan como la acción de EE.UU. (cantidad en acciones) con nota `CEDEAR 1:R {ced:...} {cb}`. Se valúan a dólar CCL. `CED_SUG` tiene las relaciones (listado de octubre de 2026).
- **Acciones argentinas con ADR** (`LOCAL_ADR`): YPFD→YPF 1, PAMP→PAM 25, GGAL 10, BMA 10, BBAR 3, SUPV 5, CEPU 10, EDN 20, TGSU2→TGS 5, CRES→CRESY 10, IRSA→IRS 10, LOMA 5, TECO2→TEO 5. Se guardan como CEDEAR del ADR con marca `{loc:PAMP|25}`; en la lista se muestra el ticker local y en el detalle "Acciones PAMP: 100 · = 4 ADR PAM". Puede diferir 1–3% de lo que muestra el broker. Al cargar a mano: botón "CEDEAR o acción AR". TGNO4 no tiene ADR y queda afuera.
- **Pendiente sugerido (no pedido):** CEDEARs cuyo ticker local difiere del de EE.UU., por ejemplo DISN→DIS y NOKA→NOK.
- **Bonos:** precio de data912 (o a la par), cupones y vencimientos, pagos para confirmar. **FCIs:** cuotaparte de la CNV.

---

## 10. Cómo probar (sin configurar nada)

1. **Clonar:** `git clone https://github.com/hernansson/holdy && cd holdy`.
2. **Servir:** `python3 -m http.server 8893` en la raíz → `http://localhost:8893/app/`. Si el servidor se cae, levantarlo de nuevo.
3. **Playwright** (Chromium ya está instalado; `require('/opt/npm-tools/node_modules/playwright')`):
   - Sesión falsa: `addInitScript(()=>localStorage.setItem('cartera.auth.v1',JSON.stringify({session:'a'.repeat(64),name:'Hernán Suzuki',email:'h@x'})))`.
   - **Mockear el Worker** con `p.route(/workers\.dev/, …)`. `/history` devuelve series falsas `{data:{TK:{currency:'USD',pts:[[fecha,precio],…]}}}`; `/quote` devuelve `{c,d,t,currency}`; `/fx/` simula el social en `global.FX`; `/me/profile` guarda el PUT; el resto, `{}`.
   - Para tener datos: `.wel-b >> nth=2` (Ver un ejemplo) y saltear el tour con `.tour-card .linkbtn`. También se pueden cargar perfiles directo en `cartera.profiles.v2` (amigos = `readOnly:true, syncCode:'…'`; propias compartidas = `sync:{code:'…'}`).
   - Aceptar los `confirm()` con `p.on('dialog',d=>d.accept())`, porque Playwright los cancela solo.
   - Revisar con capturas en 390×844 (celu), 412×915, 360, 690×830 (fold), 900×1200 (tablet), 1180 y 1440 (compu).
   - Chequeo de sintaxis: extraer los `<script>` y hacer `new Function(code)` sobre cada uno.
4. **Worker local de verdad** (el que encontró el bug de la foto):
   ```bash
   mkdir wl && cp worker/worker.js wl/ && cd wl
   printf 'name="x"\nmain="worker.js"\ncompatibility_date="2026-10-03"\n[[kv_namespaces]]\nbinding="HOLDY_KV"\nid="local1"\n' > wrangler.toml
   S=$(printf 'a%.0s' $(seq 64)); H=$(printf %s "$S" | sha256sum | cut -d' ' -f1)
   npx -y wrangler@4 kv key put --local --binding HOLDY_KV "s:$H" '{"sub":"u1","email":"h@x","name":"Hernán"}'
   npx -y wrangler@4 dev --port 8787 &
   curl -H "Authorization: Bearer $S" localhost:8787/me/profile
   ```
   Ojo: `pkill -f "wrangler.*dev"` mata también la shell que lo ejecuta; matar el proceso por PID.

---

## 11. Claves de localStorage (todas `cartera.*`)

`auth.v1` (sesión) · `profiles.v2` (carteras: `{active, profiles:[…], tomb}`) · `ui.v1` · `prices.v1` · `sim.v1` (Proyección, `guided`, `liveN`…) · `rpt.v1` · `feed.v2` (movimientos vistos) · `fxseen.v1` (comentarios leídos) · `fxh.v1` (mostrar "la tiene") · `me.v1` (tu perfil: n, ph, by, t) · `follow.v1` (invitación pendiente) · `cmpm.v1` (método de comparación) · `lock.v1` (huella `{id,t,d}`) · `hideOpen.v1` · `push.v1` · `ced.v1` · `evo.v1`/`evoR.v1` · `fci.v1` · `fiq.v1` · `divq.v1` · `ibkr.v1` · `lastBackup.v1` · `snooze*` · `created.v1` · `finnhubKey.v1` · `positions.v1` (viejo).

---

## 12. Ideas descartadas (no volver a proponer)

Reportes por email · pantalla de análisis de bonos · rebalanceo · exposición · comparación Argentina · calendario de balances · impuestos · confirmaciones de operaciones · watchlist/diario · Schwab · "probar pendientes" · proyección vs real · alertas de precio · más brokers (no hay archivos de ejemplo) · resumen mensual (lo cubren los Reportes) · logros · racha de aportes · desafío entre amigos · importar desde foto · TIR · timing · comisiones · punto de equilibrio · bot de Telegram · IOL automático · backtesting · encuesta "¿La comprarías?" · tocar el ticker en el feed · filtro del feed · nota "por qué lo hice" · "escribiendo…" y "visto por" en el chat (gastan escrituras) · unificar Ranking y Comparar · resultado de Proyección abajo · caja grande de "Preguntale" · PIN propio de Holdy.

## 13. Pendiente y para más adelante

- **Club de inversión:** quedó para "la siguiente etapa"; hay que diseñarlo con él.
- **Optimización de KV del chat** (§6), cuando él lo pida.
- **Widget en el celu:** no es posible como app web en Android/iPhone. Se le ofreció hacer accesos directos al mantener apretado el ícono (sin respuesta) o envolver Holdy en una app de Android con widget nativo (proyecto grande).
- **Equivalencias DISN→DIS y NOKA→NOK** de CEDEARs (§9), ofrecido.
- **Edad de retiro en el perfil**, para completar la Proyección (idea mencionada).
- **Login de Google:** la app sigue en modo "Prueba"; para abrirla a cualquiera hay que publicarla en Google Auth Platform.
- **Avisos que no saltan en pantalla (heads-up):** depende de la importancia del canal en Android; no se puede forzar desde la web y él no quiere que los usuarios cambien ajustes de Chrome.
