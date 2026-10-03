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
- **Perfiles**: podés tener varios (botón con el nombre arriba). "Compartir" genera un link con una foto de ese perfil; quien lo abre (o lo pega en Perfiles) lo agrega en solo lectura. No hay servidor: el link contiene los datos (cantidades y precios de compra) y no se actualiza solo; para mostrar cambios hay que mandar un link nuevo.
- **Recordatorio de respaldo** si pasaron más de 2 semanas sin exportar, y botón **Instalar app** en Ajustes cuando el navegador lo permite (Android/Chrome).
