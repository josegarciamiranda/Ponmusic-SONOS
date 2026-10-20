/* api-sonos-auth.js — flujo de autorización OAuth con Sonos, por Negocio/Estación.

   GET  ?action=start&client_id=xxx&station_id=yyy
       → redirige al navegador a la pantalla de login de Sonos (el dueño de los
         parlantes inicia sesión con SU cuenta Sonos y autoriza a PonMusic).
   GET  ?action=callback&code=xxx&state=yyy
       → Sonos redirige aquí después de la autorización. Cambia el code por
         tokens y los guarda en sonos_connections. Esta URL (con ?action=callback)
         tiene que ser EXACTAMENTE la que registraste como redirect_uri en
         integration.sonos.com y en la variable de entorno SONOS_REDIRECT_URI.
*/
const { getSupabase } = require('./db');
const sonos = require('./sonos-client');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  const q = event.queryStringParameters || {};

  try {
    if (q.action === 'start') {
      if (!q.client_id) return { statusCode:400, headers:H, body:JSON.stringify({error:'client_id requerido'}) };
      // El 'state' lleva client_id/station_id de ida y vuelta — Sonos nos lo
      // devuelve tal cual en el callback, así sabemos para quién era esta conexión
      // sin tener que guardar nada en una sesión de servidor mientras tanto.
      const state = Buffer.from(JSON.stringify({ client_id: q.client_id, station_id: q.station_id || null, t: Date.now() })).toString('base64url');
      const url = sonos.buildAuthorizeUrl(state);
      return { statusCode:302, headers: Object.assign({}, H, { Location: url }) };
    }

    if (q.action === 'callback') {
      if (q.error) {
        // El dueño de la cuenta Sonos canceló la autorización, o algo falló del lado de Sonos.
        return { statusCode:200, headers:{'Content-Type':'text/html; charset=utf-8'}, body: htmlResult(false, 'Sonos reportó: ' + q.error) };
      }
      if (!q.code || !q.state) return { statusCode:400, headers:H, body:JSON.stringify({error:'code y state requeridos'}) };

      let state;
      try { state = JSON.parse(Buffer.from(q.state, 'base64url').toString('utf8')); }
      catch (e) { return { statusCode:400, headers:H, body:JSON.stringify({error:'state inválido'}) }; }

      const tokenResp = await sonos.exchangeCodeForToken(q.code);
      // OJO VERIFICAR: se asume que la respuesta trae access_token/refresh_token/expires_in
      // (estándar OAuth2) — confirmar con el primer intento real contra Sonos.
      const accessToken = tokenResp.access_token;
      const refreshToken = tokenResp.refresh_token;
      const expiresInSec = tokenResp.expires_in || 3600;
      if (!accessToken || !refreshToken) {
        return { statusCode:200, headers:{'Content-Type':'text/html; charset=utf-8'}, body: htmlResult(false, 'Sonos no devolvió los tokens esperados — revisar el formato real de la respuesta (ver sonos-client.js).') };
      }

      const households = await sonos.getHouseholds(accessToken).catch(() => ({ households: [] }));
      const household = (households.households || [])[0] || null;

      const sb = getSupabase();
      const id = 'sonos_' + state.client_id + (state.station_id ? '_' + state.station_id : '');
      const row = {
        id,
        client_id: state.client_id,
        station_id: state.station_id,
        sonos_household_id: household ? household.id : null,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
        status: 'conectado',
        last_error: null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('sonos_connections').upsert([row], { onConflict: 'id' });
      if (error) throw error;

      return { statusCode:200, headers:{'Content-Type':'text/html; charset=utf-8'}, body: htmlResult(true, household ? ('Conectado a: ' + (household.name || household.id)) : 'Conectado (sin información de hogar).') };
    }

    return { statusCode:400, headers:H, body:JSON.stringify({error:'action inválido'}) };
  } catch (e) {
    console.error('api-sonos-auth error:', e);
    return { statusCode:200, headers:{'Content-Type':'text/html; charset=utf-8'}, body: htmlResult(false, e.message) };
  }
};

/* Página mínima que ve el dueño del Sonos justo después de autorizar — no hace
   falta nada elaborado, es un paso que pasa una sola vez. */
function htmlResult(ok, message) {
  return '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">'
    + '<h2>' + (ok ? '✅ Conectado con Sonos' : '⚠️ No se pudo conectar') + '</h2>'
    + '<p>' + message.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</p>'
    + '<p style="color:#888;">Puedes cerrar esta ventana y volver a PonMusic.</p>'
    + '</body></html>';
}
