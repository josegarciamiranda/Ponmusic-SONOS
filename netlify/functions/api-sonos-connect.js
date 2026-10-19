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
      const groupsResp = await sonos.getGroups(accessToken, conn.sonos_household_id);
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

      const accessToken = await sonos.getValidAccessToken(sb, conn);
      const session = await sonos.createPlaybackSession(accessToken, sonos_group_id, 'ponmusic:' + client_id);
      const queueBaseUrl = publicSiteUrl() + '/.netlify/functions/api-sonos-cloudqueue/' + sonos_group_id + '/v2.0';
      await sonos.loadCloudQueue(accessToken, session.sessionId, queueBaseUrl, 'Bearer ponmusic-internal');

      const row = {
        sonos_group_id, connection_id: conn.id, client_id, station_id: station_id || null, channel_id,
        queue_items: [], clock_pointer: 0, recent_played: {}, freq_counters: {}, seq_indexes: {},
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('sonos_playback_state').upsert([row], { onConflict: 'sonos_group_id' });
      if (error) throw error;

      return { statusCode:200, headers:H, body: JSON.stringify({ ok:true, sessionId: session.sessionId }) };
    }

    return { statusCode:405, headers:H, body: JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-sonos-connect error:', e);
    return { statusCode:500, headers:H, body: JSON.stringify({ error: e.message }) };
  }
};
