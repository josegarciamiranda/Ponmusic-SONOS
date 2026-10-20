/* api-sonos-cloudqueue.js — los endpoints que SONOS llama directamente sobre
   nuestro servidor (nosotros nunca llamamos a estos, Sonos sí):
     GET  .../context      → política de reproducción del canal (puede saltar, etc.)
     GET  .../itemWindow   → la ventana de pistas alrededor de una posición
     GET  .../version      → para que Sonos sepa si hay que refrescar
     POST .../timePlayed   → informes de lo reproducido (Sonos los manda si el contexto lo
                             pide; hay que contestar 204 sin cuerpo — ver más abajo)

   Esta es la URL que se registra como 'queueBaseUrl' al llamar a loadCloudQueue
   (ver sonos-client.js). Sonos le pega los sufijos /context, /itemWindow, /version y
   /timePlayed solo — por eso esta función despacha según cómo termina event.path, en vez
   de tener funciones separadas (así comparten una sola URL base, como pide Sonos).

   Identificar A QUÉ GRUPO/CANAL corresponde cada pedido: Sonos no manda el groupId
   en estos pedidos (solo en el loadCloudQueue inicial). Por eso el queueBaseUrl que
   le damos a Sonos incluye el sonos_group_id en la propia URL, ej:
     https://TU-SITIO/.netlify/functions/api-sonos-cloudqueue/GROUPID/v2.0
   y acá lo leemos de ahí.

   AUTENTICACIÓN: loadCloudQueue recibe un token por grupo (sonos.queueAuthToken). Sonos
   lo reenvía en el header Authorization. Variable opcional SONOS_QUEUE_AUTH_MODE:
     'log'     (por defecto) → si el header no calza, se REGISTRA una advertencia en los logs
                               pero se atiende igual. Es lo seguro para la PRIMERA prueba real,
                               porque aún no se ha visto cómo manda Sonos ese header.
     'enforce'               → si no calza, responde 401. Activarlo después de confirmar en los
                               logs que llega "auth=OK" en los pedidos reales de Sonos.

   VERSIONES: el contenido de una posición ya generada nunca cambia (la cola solo crece),
   así que queueVersion es CONSTANTE. Antes dependía de updated_at, que cambia en cada
   pedido; Sonos lo habría visto como "la cola cambió" y la habría vuelto a pedir sin parar.
*/
const { getSupabase } = require('./db');
const sonos = require('./sonos-client');
const { loadChannelContext, ensureQueueUpTo, toCloudQueueTrack } = require('./sonos-queue-engine');
const H = { 'Content-Type':'application/json' };

const CONTEXT_VERSION = 'v1';
const QUEUE_VERSION = 'q1';

exports.handler = async (event) => {
  try {
    const path = event.path || '';
    const method = event.httpMethod || 'GET';
    const m = path.match(/\/api-sonos-cloudqueue\/([^/]+)\/v2\.0\/(context|itemWindow|version|timePlayed)\b/);
    const q = event.queryStringParameters || {};
    const hdr = event.headers || {};
    const groupId = m && m[1], endpoint = m && m[2];

    // Evidencia de lo que Sonos realmente manda (nunca se ha visto con un parlante real).
    let authState = 'sin-grupo';
    if (groupId) {
      authState = sonos.checkQueueAuth(groupId, hdr['authorization']) ? 'OK' : (hdr['authorization'] ? 'NO-CALZA' : 'AUSENTE');
    }
    console.log('[sonos-cq] ' + method + ' ' + path + ' | query=' + JSON.stringify(q) + ' | auth=' + authState
      + ' | ua=' + (hdr['user-agent'] || '-'));

    if (!m) return { statusCode:404, headers:H, body: JSON.stringify({ error: 'Ruta de Cloud Queue no reconocida: ' + path }) };

    if (authState !== 'OK') {
      console.warn('[sonos-cq] ADVERTENCIA: el header Authorization no calza (' + authState + ') para el grupo ' + groupId);
      if (process.env.SONOS_QUEUE_AUTH_MODE === 'enforce') {
        return { statusCode:401, headers:H, body: JSON.stringify({ error: 'No autorizado' }) };
      }
    }

    // Informes de reproducción: Sonos exige respuesta 204 SIN cuerpo (devolver un JSON
    // inesperado hace que desactive los informes durante esa pista).
    if (endpoint === 'timePlayed') {
      console.log('[sonos-cq] timePlayed body: ' + String(event.body || '').slice(0, 500));
      return { statusCode:204, headers:{}, body:'' };
    }

    const sb = getSupabase();
    const { data: stateRow } = await sb.from('sonos_playback_state').select('*').eq('sonos_group_id', groupId).maybeSingle();
    if (!stateRow) return { statusCode:404, headers:H, body: JSON.stringify({ error: 'Este grupo Sonos todavía no está configurado en sonos_playback_state.' }) };

    if (endpoint === 'version') {
      return { statusCode:200, headers:H, body: JSON.stringify({
        contextVersion: CONTEXT_VERSION,
        queueVersion: QUEUE_VERSION,
      }) };
    }

    if (endpoint === 'context') {
      return { statusCode:200, headers:H, body: JSON.stringify({
        contextVersion: CONTEXT_VERSION,
        queueVersion: QUEUE_VERSION,
        container: { type: 'playlist', name: 'PonMusic', id: { serviceId: 'ponmusic', objectId: stateRow.channel_id || 'default' } },
        reports: { sendUpdateAfterMillis: 30000, sendPlaybackActions: true },
        playbackPolicies: {
          canSkip: false, limitedSkips: true, canSkipToItem: false, canSkipBack: false,
          canSeek: false, canRepeat: false, canRepeatOne: false, canCrossfade: false,
          canShuffle: false, showNNextTracks: 10, showNPreviousTracks: 2,
        },
      }) };
    }

    // itemWindow
    const itemId = q.itemId;
    const centerIndex = (itemId === undefined || itemId === '') ? 0 : (parseInt(itemId, 10) || 0);
    const prevSize = parseInt(q.previousWindowSize, 10) || 0;
    const nextSize = parseInt(q.upcomingWindowSize, 10) || 10;
    const lo = Math.max(0, centerIndex - prevSize);
    const hi = centerIndex + nextSize;

    const ctx = await loadChannelContext(sb, stateRow.client_id);
    const freshState = await ensureQueueUpTo(sb, stateRow, ctx, hi);
    const items = freshState.queue_items || [];
    if (items.length === 0) {
      console.warn('[sonos-cq] itemWindow sin pistas: el canal no tiene Reloj activo ahora o no tiene canciones con URL.');
    }

    const windowItems = [];
    for (let i = lo; i <= Math.min(hi, items.length - 1); i++) {
      const it = items[i];
      if (!it) continue;
      windowItems.push({ id: String(i), deleted: false, policies: { canSkip: false, canCrossfade: false }, track: toCloudQueueTrack(it) });
    }

    return { statusCode:200, headers:H, body: JSON.stringify({
      includesBeginningOfQueue: lo === 0,
      includesEndOfQueue: false, // la cola se sigue extendiendo sola, nunca "se acaba"
      contextVersion: CONTEXT_VERSION,
      queueVersion: QUEUE_VERSION,
      items: windowItems,
    }) };
  } catch (e) {
    console.error('api-sonos-cloudqueue error:', e);
    return { statusCode:500, headers:H, body: JSON.stringify({ error: e.message }) };
  }
};
