/* sonos-client.js — envoltorio delgado sobre la Control API y el flujo OAuth de Sonos.
   Basado en la documentación pública (docs.sonos.com) consultada el 13/10. Hay un par
   de detalles que esa documentación no confirma con certeza (ver comentarios "OJO
   VERIFICAR" abajo) — quedan marcados a propósito para probarlos contra una cuenta
   Sonos real apenas Jose tenga las credenciales de desarrollador, en vez de darlos
   por buenos sin haberlos visto funcionar.

   Variables de entorno que necesita (Netlify → Site settings → Environment variables):
     SONOS_CLIENT_ID      — "Key" de la integración, de integration.sonos.com
     SONOS_CLIENT_SECRET  — "Secret" de la misma integración
     SONOS_REDIRECT_URI   — debe ser EXACTAMENTE la URL registrada en Sonos, ej:
                             https://<tu-sitio>.netlify.app/.netlify/functions/api-sonos-auth?action=callback
     PUBLIC_SITE_URL      — la URL pública de este sitio (para armar queueBaseUrl), ej:
                             https://<tu-sitio>.netlify.app
*/

const AUTH_BASE = 'https://api.sonos.com/login/v3/oauth';
const TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const CONTROL_BASE = 'https://api.ws.sonos.com/control/api/v1';
const SCOPE = 'playback-control-all'; // único scope que existe hoy en la API de Sonos

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error('Falta configurar la variable de entorno ' + name + ' en Netlify.');
  return v;
}

/* Lee la respuesta del endpoint de tokens de Sonos y deja evidencia en los logs
   de Netlify de lo que Sonos contestó DE VERDAD — es justo lo que este proyecto
   todavía no ha visto nunca (ver "OJO VERIFICAR" en CLAUDE.md).
   - Si falla: registra status + cuerpo completo (una respuesta de error no trae
     tokens) y los incluye en el mensaje, para verlo también en la pantalla del
     callback durante la prueba.
   - Si funciona: registra SOLO los NOMBRES de los campos y expires_in/token_type/
     scope, NUNCA los valores de access_token ni refresh_token. */
async function readTokenResponse(res, etiqueta) {
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { _no_json: true }; }
  if (!res.ok) {
    console.error('[sonos] ' + etiqueta + ' FALLÓ — status ' + res.status + ' — cuerpo: ' + text.slice(0, 1000));
    throw new Error('Sonos ' + etiqueta + ' falló (HTTP ' + res.status + '): ' + (json.error_description || json.error || text.slice(0, 300) || 'sin cuerpo'));
  }
  console.log('[sonos] ' + etiqueta + ' OK — campos recibidos: ' + Object.keys(json).join(', ')
    + ' | expires_in=' + json.expires_in + ' token_type=' + json.token_type + ' scope=' + json.scope);
  return json; // se espera { access_token, refresh_token, expires_in, ... }
}

/* Paso 1 del login OAuth: armar la URL a la que se redirige al dueño de la cuenta
   Sonos para que autorice esta integración. 'state' viaja de ida y vuelta tal cual
   — lo usamos para llevar client_id/station_id de PonMusic y no perderlos en el camino. */
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: env('SONOS_CLIENT_ID'),
    response_type: 'code',
    state: state,
    scope: SCOPE,
    redirect_uri: env('SONOS_REDIRECT_URI'),
  });
  return AUTH_BASE + '?' + params.toString();
}

/* Paso 2: Sonos redirige de vuelta con ?code=...&state=... — se cambia ese code
   por un access_token + refresh_token. OJO VERIFICAR: la documentación pública no
   muestra los nombres exactos de los campos de la respuesta ni el formato preciso
   del header Authorization — aquí se asume el estándar OAuth2 (Basic base64(id:secret)
   y campos access_token/refresh_token/expires_in), que es lo normal, pero hay que
   confirmarlo con una prueba real antes de confiar en esto a ciegas. */
async function exchangeCodeForToken(code) {
  const basic = Buffer.from(env('SONOS_CLIENT_ID') + ':' + env('SONOS_CLIENT_SECRET')).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: env('SONOS_REDIRECT_URI'),
  });
  const res = await fetch(TOKEN_URL + '?' + params.toString(), {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
  });
  return await readTokenResponse(res, 'token exchange');
}

async function refreshAccessToken(refreshToken) {
  const basic = Buffer.from(env('SONOS_CLIENT_ID') + ':' + env('SONOS_CLIENT_SECRET')).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL + '?' + params.toString(), {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
  });
  return await readTokenResponse(res, 'refresh token');
}

async function sonosFetch(path, accessToken, options) {
  options = options || {};
  const res = await fetch(CONTROL_BASE + path, {
    method: options.method || 'GET',
    headers: Object.assign({
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    }, options.headers || {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error('Sonos Control API ' + path + ' → ' + res.status + ': ' + (json.fault && json.fault.errorCode || text));
  return json;
}

const getHouseholds = (accessToken) => sonosFetch('/households', accessToken);
const getGroups = (accessToken, householdId) => sonosFetch('/households/' + householdId + '/groups', accessToken);

/* Abre (o reusa) una sesión de reproducción para un grupo de parlantes — hace
   falta antes de poder cargar nada en él. */
const createPlaybackSession = (accessToken, groupId, appContext) => sonosFetch(
  '/groups/' + groupId + '/playbackSession', accessToken,
  { method: 'POST', body: { appId: 'com.ponmusic.sonos-integration', appContext: appContext } }
);

/* Le dice a Sonos "a partir de ahora, para este grupo, pide la cola de reproducción
   a MI servidor" (nuestro endpoint Cloud Queue: api-sonos-cloudqueue.js). A partir de
   aquí Sonos va a llamar solo a /context, /itemWindow y /version de ese queueBaseUrl
   — nuestro servidor ya no empuja nada, solo contesta cuando Sonos pregunta. */
const loadCloudQueue = (accessToken, sessionId, queueBaseUrl, httpAuthorization) => sonosFetch(
  '/playbackSessions/' + sessionId + '/playbackSession/loadCloudQueue', accessToken,
  { method: 'POST', body: {
    queueBaseUrl: queueBaseUrl,
    httpAuthorization: httpAuthorization,
    itemId: '',          // vacío = empezar desde el principio de la cola
    playOnCompletion: true,
  } }
);

/* Devuelve un access_token que sirve AHORA MISMO para esta conexión — si el
   guardado ya venció (o vence en menos de 2 minutos, para no ir muy al límite),
   lo renueva con el refresh_token y guarda el nuevo en sonos_connections antes
   de devolverlo. Centralizar esto acá evita que cada función tenga que acordarse
   de hacerlo por su cuenta. */
async function getValidAccessToken(sb, connection) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 2 * 60 * 1000) return connection.access_token;
  const fresh = await refreshAccessToken(connection.refresh_token);
  const newExpiresAt = new Date(Date.now() + (fresh.expires_in || 3600) * 1000).toISOString();
  await sb.from('sonos_connections').update({
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || connection.refresh_token, // Sonos puede o no rotar el refresh_token
    token_expires_at: newExpiresAt,
    updated_at: new Date().toISOString(),
  }).eq('id', connection.id);
  return fresh.access_token;
}

/* ---- Firmas HMAC (seguridad) ---------------------------------------------------
   Se usa SONOS_CLIENT_SECRET como llave: ya existe, solo la conoce nuestro servidor,
   y así no hace falta una variable de entorno ni una columna nuevas.

   1) 'state' del OAuth: antes viajaba sin firmar (base64 de un JSON), así que cualquiera
      podía armar un state con el client_id de OTRO negocio y, al autorizar con su propia
      cuenta Sonos, pisar la conexión de ese negocio. Ahora va firmado y caduca.
   2) Token de la Cola en la nube: antes loadCloudQueue mandaba 'Bearer ponmusic-internal'
      (igual para todos y nunca validado). Ahora es un token por grupo, derivado con HMAC. */
const crypto = require('crypto');

function hmac(text) {
  return crypto.createHmac('sha256', env('SONOS_CLIENT_SECRET')).update(text).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signState(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return payload + '.' + hmac('state:' + payload);
}

/* Devuelve el objeto original, o lanza Error si la firma no calza o ya caducó. */
function verifyState(signed, maxAgeMs) {
  const i = String(signed || '').lastIndexOf('.');
  if (i < 1) throw new Error('state sin firma');
  const payload = signed.slice(0, i), sig = signed.slice(i + 1);
  if (!safeEqual(sig, hmac('state:' + payload))) throw new Error('firma de state inválida');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!obj.t || Date.now() - obj.t > (maxAgeMs || 30 * 60 * 1000)) throw new Error('state caducado');
  return obj;
}

/* Token que Sonos nos devolverá en el header Authorization al pedir la cola de ESTE grupo. */
function queueAuthToken(groupId) {
  return 'Bearer ' + hmac('queue:' + groupId);
}
function checkQueueAuth(groupId, headerValue) {
  return !!headerValue && safeEqual(headerValue, queueAuthToken(groupId));
}

module.exports = {
  buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken, getValidAccessToken,
  getHouseholds, getGroups, createPlaybackSession, loadCloudQueue,
  signState, verifyState, queueAuthToken, checkQueueAuth,
};
