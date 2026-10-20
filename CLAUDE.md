# PonMusic + Sonos — contexto del proyecto

Este archivo existe para que quien retome este proyecto (Claude Code, u otra persona)
tenga de entrada todo el contexto sin tener que preguntar desde cero. Léelo completo
antes de tocar nada.

## Qué es esto y por qué existe como proyecto aparte

Este es un **fork** de PonMusic (el sistema de música/anuncios para tiendas retail de
Jose Garcia, josegarciamiranda@gmail.com — ver `ponmusiconline`, el proyecto
original que sirve a ~150 tiendas reales). Un cliente nuevo tiene parlantes **Sonos
Amp** instalados en sus locales y no quiere ningún dispositivo adicional visible — ni
tablet, ni caja, nada. Este fork le agrega esa integración.

**Por qué es un proyecto separado y no una rama del original**: Jose fue explícito —
no quiere arriesgar NADA de lo que ya funciona en producción para 150 tiendas reales.
Así que esto vive en su propio repo git, su propio sitio Netlify, y **su propia base
de datos Supabase**, completamente aislados. Nada de lo que se haga acá puede romper
el sistema original.

## La restricción de fondo que define toda la arquitectura

**Un Sonos Amp no es una computadora — no corre código de terceros.** No puede
ejecutar la app PWA que usan las tiendas normales de PonMusic (no hay Service Worker,
no hay IndexedDB, no hay descarga offline). Por eso, para este cliente, el servidor
(no el navegador de nadie) es quien decide qué suena y cuándo, y usa la API de Sonos
para controlarlo remotamente. Esto tiene una consecuencia aceptada explícitamente por
el cliente: **se pierde toda la resiliencia offline** (el colchón de 15 min, Mis
Descargas) — si se corta el internet de la tienda, el Sonos simplemente deja de
sonar, sin caché local de respaldo. El cliente ya confirmó que lo acepta a cambio de
no tener hardware visible.

## Cómo funciona la integración con Sonos (modelo "Cloud Queue")

Sonos NO funciona empujando comandos ("toca esta canción ahora") ni avisándonos
cuando termina una pista. Funciona al revés — un modelo de **"pull"**:

1. Una sola vez, el dueño de la cuenta Sonos autoriza a PonMusic (OAuth) —
   `netlify/functions/api-sonos-auth.js`.
2. Se asigna qué grupo de parlantes Sonos suena qué Canal/Playlist de PonMusic —
   panel nuevo "Sonos" en Administrador-Cliente (`js/app.js`:
   `renderSonosPanel`/`bindSonosPanel`), respaldado por
   `netlify/functions/api-sonos-connect.js`. Esto abre una "sesión de reproducción"
   en Sonos y le dice "para este grupo, pide la cola de reproducción a esta URL mía".
3. A partir de ahí, **Sonos mismo** llama periódicamente a tres endpoints nuestros
   (`netlify/functions/api-sonos-cloudqueue.js`):
   - `GET .../context` — políticas de reproducción (puede saltar, etc.)
   - `GET .../itemWindow` — "dame las próximas N pistas desde la posición X" — acá
     es donde se genera la música/anuncios bajo demanda.
   - `GET .../version` — para que Sonos sepa si hay que refrescar.
4. `netlify/functions/sonos-queue-engine.js` genera cada posición de la cola la
   primera vez que se pide, y la deja guardada en `sonos_playback_state.queue_items`
   (Supabase) — así una posición ya generada siempre devuelve lo mismo si Sonos
   vuelve a pedirla.

La lógica de "qué sigue" (reloj musical con rotación de estilos, anti-repetición,
anuncios cada N canciones) es un **port fiel** de la que ya usa el reproductor del
navegador en `ponmusiconline` (`buildQueue`/`refillQueue`/`pickRandomSong`/
`checkFrequencyAds`/`getActiveSchedule` en su `js/app.js`), adaptada para correr en
el servidor en vez de en un navegador.

## ⚠️ Lo que NO está verificado todavía contra una cuenta Sonos real

Todo este código se escribió consultando la documentación pública de
developer.sonos.com/docs.sonos.com (13/10), pero **nunca se probó contra un Sonos de
verdad** porque no hay credenciales de desarrollador ni un dispositivo físico
disponibles desde donde se escribió esto. Antes de confiar en que esto funciona,
hay que probarlo end-to-end y revisar con cuidado, en particular:

- **`sonos-client.js` → `exchangeCodeForToken`/`refreshAccessToken`**: se asume que
  la respuesta trae los campos estándar de OAuth2 (`access_token`, `refresh_token`,
  `expires_in`) y que el header de autenticación es `Basic base64(client_id:secret)`
  — la documentación pública no confirma ninguno de los dos con un ejemplo real.
- **`api-sonos-cloudqueue.js`**: la forma exacta de la ruta que Sonos usa para
  llamar a `/context`/`/itemWindow`/`/version` (si usa `/v2.0/` o alguna otra
  versión, y si realmente antepone el `sonos_group_id` tal como se armó acá en
  `queueBaseUrl`) debe confirmarse con el primer intento real.
- Los nombres de campo de la respuesta de `itemWindow` (`track.mediaUrl`,
  `track.artist.name`, etc.) vienen de un ejemplo de la documentación, no de un
  schema formal — revisar si Sonos los acepta tal cual.

**No asumas que "está listo" solo porque el código compila.** La forma correcta de
avanzar es: crear la cuenta de desarrollador Sonos, probar el flujo OAuth primero
(aislado, viendo qué responde de verdad `/login/v3/oauth/access`), y recién después
probar `loadCloudQueue` + `itemWindow` con una sola canción de prueba antes de
conectar un grupo real.

## Pasos manuales pendientes (requieren cuentas propias de Jose — no se pueden hacer desde acá)

1. **Cuenta de desarrollador Sonos**: crear una integración en
   https://integration.sonos.com (gratis). De ahí salen `SONOS_CLIENT_ID` y
   `SONOS_CLIENT_SECRET`, y ahí también se registra el `redirect_uri` exacto (tiene
   que calzar carácter por carácter con `SONOS_REDIRECT_URI`).
2. **Sitio Netlify nuevo** (separado de `musica-anuncios`/`ponmusiconline`) apuntando
   a este repo.
3. **Proyecto Supabase nuevo**, completamente aparte del de producción. Correr
   `SUPABASE_schema_completo_sonos.sql` ahí (un solo archivo, reconstruye todas las
   tablas desde cero, incluidas las 2 nuevas de Sonos al final).
4. **Variables de entorno en Netlify** (Site settings → Environment variables):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` → del proyecto Supabase nuevo (paso 3).
   - `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET` → del paso 1.
   - `SONOS_REDIRECT_URI` → `https://<tu-sitio>.netlify.app/.netlify/functions/api-sonos-auth?action=callback`
   - `PUBLIC_SITE_URL` → `https://<tu-sitio>.netlify.app`
5. Entrar como Administrador Principal (admin/admin123 por defecto — **cambiar esta
   clave de inmediato**, ver el comentario en el .sql), crear el Negocio del cliente
   Sonos marcado como "Administrador de Cliente" (`is_client_admin`/`is_exec`), su
   Playlist/Canal y Reloj musical con algo de contenido de prueba.
6. Entrar como ese cliente → pestaña "Sonos" → Conectar con Sonos → asignar el grupo
   de parlantes al Canal.

## Arquitectura heredada (igual que en el proyecto original)

- **Frontend**: JS/HTML/CSS vanilla, sin build step. `js/*.js`, `index.html`,
  `style.css`.
- **Backend**: Netlify Functions, `netlify/functions/*.js`.
- **Audio**: Cloudflare R2 (sin cambios).
- El panel de Administrador Principal y Administrador-Cliente (biblioteca, estilos,
  playlists, clasificación, relojes, programación, anuncios, monitoreo) es idéntico
  al original — no se tocó nada de eso, solo se agregó la pestaña "Sonos".

## Convención de commits

Igual que en el proyecto original: mensajes largos que explican el POR QUÉ, no solo
el qué — para poder entender un bug o una decisión meses después sin tener que
releer todo el código.

## Siguiente paso recomendado

Probar el flujo OAuth contra una cuenta Sonos real de prueba ANTES de intentar nada
más — es la parte con más incertidumbre (ver sección de arriba). Si eso funciona,
seguir con un solo grupo de parlantes y una sola canción de prueba antes de darle
el canal completo del cliente.

## Cambios posteriores a la v1 (v2, 19/10)

- `netlify/functions/sonos-client.js`: `exchangeCodeForToken`/`refreshAccessToken`
  ahora registran en los logs de Netlify la respuesta REAL de Sonos (status + cuerpo
  si falla; solo NOMBRES de campos si funciona, nunca los tokens). El request a Sonos
  NO cambió (los parámetros siguen yendo en la query string). Si el primer intento
  real falla por el formato, la variante preparada (parámetros en el cuerpo del POST)
  está en `extras/sonos-client.VARIANTE-cuerpo-POST.js` del paquete de entrega.
  Sigue sin probarse contra Sonos real.
- `js/app.js` + `sw.js`: se quitó el selector PonMusic/SpotMusic del panel de admin
  (este fork tiene una sola marca). `getAdminBrand()` devuelve siempre `'ponmusic'`;
  la columna `brand` y el motor de la cola no cambian. `CACHE_APP` pasó a
  `ponmusic-sonos-app-v2`. `style.css` y `img/logo-spotmusic.jpg` quedan sin uso
  pero NO borrar el logo mientras `sw.js` lo liste en `APP_SHELL`.
- El audio usa un bucket R2 PROPIO de este proyecto (no el de producción). Variables
  R2 requeridas: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`, `R2_PUBLIC_URL` (el bucket debe ser público para que Sonos lea
  las canciones, y con CORS que permita PUT desde el sitio).
- Pendiente antes de producción: firmar/validar el `state` del OAuth, y comprobar el
  `httpAuthorization` en `api-sonos-cloudqueue.js` (hoy se envía pero no se valida).
- Seguridad: la clave del admin viene como `admin123`; cambiarla con
  `extras/cambiar_clave_admin.sql` antes de desplegar.

## Revisión previa a la prueba con el cliente (v3, 20/10)

**Verificado con Sonos real (20/10, cuenta de prueba sin parlantes):** el OAuth completo.
`/login/v3/oauth/access` devuelve `access_token, expires_in (86399 s ≈ 24 h), refresh_token,
scope (playback-control-all), token_type (Bearer)`. El request (parámetros en la query string +
Basic auth) era correcto; la variante con cuerpo POST NO hace falta. Fila en `sonos_connections`
con `status=conectado`, `sonos_household_id` NULL (la cuenta no tenía parlantes) y vencimiento a 24 h.
El refresh del token sigue SIN probarse (se podrá probar pasado el vencimiento).

**RIESGO ABIERTO (el más importante):** la documentación de Sonos ("About Cloud Queue API") dice que
la Cola en la nube es "para integraciones de contenido únicamente"; la integración creada es de
CONTROL (Direct Control Integration). `loadCloudQueue` sí figura en la referencia de la Control API
y no declara requisitos, pero NO está confirmado que una integración de control pueda usarlo.
Además Sonos avisa que hay licencia aparte para socios de contenido con cuentas comerciales.
Hay que preguntarle a Sonos (soporte de developer.sonos.com) o descubrirlo con el primer
`loadCloudQueue` real (401/403 = permisos). `loadStreamUrl` solo sirve para emisoras en vivo.

**Cambios de esta versión** (32 pruebas simuladas en `scratchpad/test/run.js`, sin Sonos real):
- `api-sonos-connect.js`: la fila `sonos_playback_state` se guarda ANTES de `loadCloudQueue`
  (Sonos pide la cola de inmediato; antes habría recibido 404). Completa el household si quedó
  NULL. Registra los campos de la sesión creada (el nombre del id de sesión no está confirmado).
- `api-sonos-cloudqueue.js`: endpoint `POST /timePlayed` → 204 sin cuerpo; `queueVersion`
  constante (antes cambiaba en cada pedido y Sonos habría recargado sin parar); registros
  `[sonos-cq]` de cada petición; validación del header Authorization.
- `sonos-client.js`: `signState/verifyState` (state del OAuth firmado con HMAC, caduca a 30 min) y
  `queueAuthToken/checkQueueAuth` (token por grupo, derivado de SONOS_CLIENT_SECRET).
- `api-sonos-auth.js`: usa el state firmado; rechaza states falsificados antes de llamar a Sonos.
- `sonos-queue-engine.js`: horarios evaluados en la zona de las tiendas (`SONOS_TIMEZONE`, por
  defecto America/La_Paz; las funciones de Netlify corren en UTC); los anuncios extra de
  `countPerTrigger>1` ya no se pierden.

**Variables de entorno opcionales nuevas:** `SONOS_TIMEZONE` (ej. America/Lima) y
`SONOS_QUEUE_AUTH_MODE` (por defecto modo "log": solo advierte si el header no calza; pasar a
`enforce` cuando los logs muestren `auth=OK` en pedidos reales de Sonos).

**Sigue sin verificar con parlante real:** esquema exacto de `itemWindow` (no se pudo abrir el
esquema completo en la documentación), campo del id de sesión, que Sonos reenvíe el header
Authorization, reproducción de los MP3 (16–48 kHz; VBR necesita tabla Xing) y el efecto de
`createSession` (termina la sesión existente del grupo: probar con la tienda cerrada).

**Pendientes de seguridad:** las funciones de PonMusic no autentican al llamador (diseño heredado);
tokens de Sonos en texto plano; repo público; `r2.dev` es solo para pruebas (usar dominio propio).
