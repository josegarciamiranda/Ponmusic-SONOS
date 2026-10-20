/* api-sonos-connect.js — paso 2 de la configuración (después del OAuth de
   api-sonos-auth.js): elegir qué grupo de parlantes Sonos suena qué Canal de
   PonMusic, y decirle a Sonos que empiece a pedirnos la cola a nosotros.

   GET  ?action=groups&client_id=xxx
       → lista los grupos de parlantes Sonos disponibles para ese Negocio
         (para mostrarlos en un <select> en el panel de administración).
   POST { client_id, station_id, sonos_group_id, channel_id }
       → crea sonos_playback_state para ese grupo+canal, abre una sesión de
         reproducción en Sonos, y le manda loadCloudQueue apuntando a nuestro
         endpoint Cloud Queue. A partir de acá Sonos empieza a sonar solo.
*/
const { getSupabase } = require('./db');
const sonos = require('./sonos-client');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

function publicSiteUrl() {
  const v = process.env.PUBLIC_SITE_URL;
  if (!v) throw new Error('Falta configurar PUBLIC_SITE_URL en Netlify Environment Variables.');
  return v.replace(/\/$/, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  const sb = getSupabase();

  try {
    if (event.httpMethod === 'GET' && (event.queryStringParameters||{}).action === 'status') {
      const clientId = event.queryStringParameters.client_id;
      const { data: conn } = await sb.from('sonos_connections').select('*').eq('client_id', clientId).maybeSingle();
      const { data: states } = await sb.from('sonos_playback_state').select('*').eq('client_id', clientId);
      return { statusCode:200, headers:H, body: JSON.stringify({
        connection: conn ? { status: conn.status, household_id: conn.sonos_household_id, last_error: conn.last_error } : null,
        groups: states || [],
      }) };
    }

    if (event.httpMethod === 'GET' && (event.queryStringParameters||{}).action === 'groups') {
      const clientId = event.queryStringParameters.client_id;
      const { data: conn } = await sb.from('sonos_connections').select('*').eq('client_id', clientId).maybeSingle();
      if (!conn || conn.status !== 'conectado') return { statusCode:200, headers:H, body: JSON.stringify({ connected:false, groups:[] }) };
      const accessToken = await sonos.getValidAccessToken(sb, conn);
      // Si en el callback OAuth no había hogar (p. ej. la cuenta aún no tenía parlantes), el
      // household_id quedó NULL. Se vuelve a pedir aquí y se guarda, en vez de fallar para siempre.
      let householdId = conn.sonos_household_id;
      if (!householdId) {
        const hh = await sonos.getHouseholds(accessToken);
        const first = (hh.households || [])[0];
        if (!first) return { statusCode:200, headers:H, body: JSON.stringify({ connected:true, groups:[], note:'La cuenta Sonos autorizada no tiene ningún hogar/parlante todavía.' }) };
        householdId = first.id;
        await sb.from('sonos_connections').update({ sonos_household_id: householdId, updated_at: new Date().toISOString() }).eq('id', conn.id);
      }
      const groupsResp = await sonos.getGroups(accessToken, householdId);
      return { statusCode:200, headers:H, body: JSON.stringify({ connected:true, groups: groupsResp.groups||[] }) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body||'{}');
      const { client_id, station_id, sonos_group_id, channel_id } = body;
      if (!client_id || !sonos_group_id || !channel_id) {
        return { statusCode:400, headers:H, body: JSON.stringify({ error:'client_id, sonos_group_id y channel_id son requeridos' }) };
      }
      const { data: conn } = await sb.from('sonos_connections').select('*').eq('client_id', client_id).maybeSingle();
      if (!conn || conn.status !== 'conectado') return { statusCode:400, headers:H, body: JSON.stringify({ error:'Este Negocio todavía no autorizó la conexión con Sonos.' }) };

      // ORDEN IMPORTANTE: la fila de estado se guarda ANTES de hablar con Sonos. En cuanto
      // Sonos recibe loadCloudQueue empieza a pedir /context e /itemWindow de inmediato; si la
      // fila todavía no existe, esos primeros pedidos recibirían 404 y la carga fallaría.
      const row = {
        sonos_group_id, connection_id: conn.id, client_id, station_id: station_id || null, channel_id,
        queue_items: [], clock_pointer: 0, recent_played: {}, freq_counters: {}, seq_indexes: {},
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('sonos_playback_state').upsert([row], { onConflict: 'sonos_group_id' });
      if (error) throw error;

      const accessToken = await sonos.getValidAccessToken(sb, conn);
      const session = await sonos.createPlaybackSession(accessToken, sonos_group_id, 'ponmusic:' + client_id);
      // Evidencia para la primera prueba real: qué campos devuelve Sonos al crear la sesión
      // (la documentación no muestra el nombre exacto del campo del id de sesión).
      console.log('[sonos] playbackSession creada — campos: ' + Object.keys(session || {}).join(', '));
      const sessionId = session.sessionId || session.id;
      if (!sessionId) throw new Error('Sonos no devolvió un id de sesión (campos recibidos: ' + Object.keys(session || {}).join(', ') + ')');
      const queueBaseUrl = publicSiteUrl() + '/.netlify/functions/api-sonos-cloudqueue/' + sonos_group_id + '/v2.0';
      // Token propio de este grupo (HMAC): Sonos lo reenviará en el header Authorization
      // y api-sonos-cloudqueue.js lo comprueba.
      const loadResp = await sonos.loadCloudQueue(accessToken, sessionId, queueBaseUrl, sonos.queueAuthToken(sonos_group_id));
      console.log('[sonos] loadCloudQueue OK — respuesta: ' + JSON.stringify(loadResp).slice(0, 300));

      return { statusCode:200, headers:H, body: JSON.stringify({ ok:true, sessionId: sessionId }) };
    }

    return { statusCode:405, headers:H, body: JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-sonos-connect error:', e);
    return { statusCode:500, headers:H, body: JSON.stringify({ error: e.message }) };
  }
};
