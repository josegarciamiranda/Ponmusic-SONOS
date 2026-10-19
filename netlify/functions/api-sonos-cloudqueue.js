/* api-sonos-cloudqueue.js — los 3 endpoints que SONOS llama directamente sobre
   nuestro servidor (nosotros nunca llamamos a estos, Sonos sí):
     GET .../context      → política de reproducción del canal (puede saltar, etc.)
     GET .../itemWindow   → la ventana de pistas alrededor de una posición
     GET .../version      → para que Sonos sepa si hay que refrescar

   Esta es la URL que se registra como 'queueBaseUrl' al llamar a loadCloudQueue
   (ver sonos-client.js). Sonos le pega los sufijos /context, /itemWindow, /version
   solo — por eso esta función despacha según cómo termina event.path, en vez de
   tener tres funciones separadas (así comparten una sola URL base, como pide Sonos).

   Identificar A QUÉ GRUPO/CANAL corresponde cada pedido: Sonos no manda el groupId
   en estos pedidos (solo en el loadCloudQueue inicial). Por eso el queueBaseUrl que
   le damos a Sonos incluye el sonos_group_id en la propia URL, ej:
     https://TU-SITIO/.netlify/functions/api-sonos-cloudqueue/GROUPID/v2.0
   y acá lo leemos de ahí.
*/
const { getSupabase } = require('./db');
const { loadChannelContext, ensureQueueUpTo, toCloudQueueTrack } = require('./sonos-queue-engine');
const H = { 'Content-Type':'application/json' };

exports.handler = async (event) => {
  try {
    const path = event.path || '';
    const m = path.match(/\/api-sonos-cloudqueue\/([^/]+)\/v2\.0\/(context|itemWindow|version)\b/);
    if (!m) return { statusCode:404, headers:H, body: JSON.stringify({ error: 'Ruta de Cloud Queue no reconocida: ' + path }) };
    const groupId = m[1], endpoint = m[2];
    const q = event.queryStringParameters || {};

    const sb = getSupabase();
    const { data: stateRow } = await sb.from('sonos_playback_state').select('*').eq('sonos_group_id', groupId).maybeSingle();
    if (!stateRow) return { statusCode:404, headers:H, body: JSON.stringify({ error: 'Este grupo Sonos todavía no está configurado en sonos_playback_state.' }) };

    if (endpoint === 'version') {
      return { statusCode:200, headers:H, body: JSON.stringify({
        contextVersion: 'v1',
        queueVersion: String((stateRow.queue_items||[]).length) + '_' + new Date(stateRow.updated_at).getTime(),
      }) };
    }

    if (endpoint === 'context') {
      return { statusCode:200, headers:H, body: JSON.stringify({
        contextVersion: 'v1',
        queueVersion: String((stateRow.queue_items||[]).length),
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

    const windowItems = [];
    for (let i = lo; i <= Math.min(hi, items.length - 1); i++) {
      const it = items[i];
      if (!it) continue;
      windowItems.push({ id: String(i), deleted: false, policies: { canSkip: false, canCrossfade: false }, track: toCloudQueueTrack(it) });
    }

    return { statusCode:200, headers:H, body: JSON.stringify({
      includesBeginningOfQueue: lo === 0,
      includesEndOfQueue: false, // la cola se sigue extendiendo sola, nunca "se acaba"
      contextVersion: 'v1',
      queueVersion: String(items.length),
      items: windowItems,
    }) };
  } catch (e) {
    console.error('api-sonos-cloudqueue error:', e);
    return { statusCode:500, headers:H, body: JSON.stringify({ error: e.message }) };
  }
};
