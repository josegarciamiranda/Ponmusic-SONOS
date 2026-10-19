/* api-connection-report.js — Informe de conexión de Tiendas por período.
   GET /.netlify/functions/api-connection-report?station_id=xxx&from=ISO&to=ISO
   → [{ store_id, username, store_name, online, uptimePct, disconnections,
        downtimeMinutes, longestDowntimeMinutes }, ...]  (todas las tiendas de la estación)
*/
const { getSupabase } = require('./db');
const { computeStoreUptime } = require('./connection-report');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Expose-Headers':'X-Report-Note' };
const ONLINE_THRESHOLD_MS = 260000; // mismo umbral que usa Monitoreo en vivo

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  try {
    const q = event.queryStringParameters || {};
    const stationId = q.station_id, fromStr = q.from, toStr = q.to;
    if (!stationId || !fromStr || !toStr) return { statusCode:400, headers:H, body:JSON.stringify({error:'station_id, from y to son requeridos'}) };
    const from = new Date(fromStr), to = new Date(toStr);
    const now = new Date();

    // El ajuste de "caída todavía en curso" (más abajo) SOLO tiene sentido si el informe
    // llega hasta el presente (ej. "Hoy"). Para un informe de un día YA CERRADO en el
    // pasado (ayer, rango personalizado, etc.), el estado "en este instante" no dice nada
    // sobre cómo estuvo la tienda ESE día, así que no debe usarse — si se usa, cualquier
    // consulta hecha de madrugada (con las tiendas lógicamente cerradas/offline) termina
    // marcando el día entero como caído por error.
    const reportIncludesNow = to.getTime() >= now.getTime();

    // Los datos de conexión solo son confiables desde que este código corregido empezó a
    // recibir avisos reales (se anota solo, ver api-presence.js). Si el período pedido
    // empieza antes de eso, mejor decir "todavía no hay datos" que mostrar números que
    // podrían estar mal por el bug anterior (cortes que no quedaron bien registrados).
    const { data: settingRows } = await sb.from('system_settings').select('value').eq('key', 'reliable_since').limit(1);
    const reliableSince = settingRows && settingRows[0] ? new Date(settingRows[0].value) : null;
    if (!reliableSince || to.getTime() < reliableSince.getTime()) {
      // Todo el rango pedido es anterior a que el sistema corregido empezara a registrar —
      // no hay forma de mostrar nada confiable para este período.
      return { statusCode:200, headers:H, body:JSON.stringify({
        notReady: true,
        reliableSince: reliableSince ? reliableSince.toISOString() : null,
        message: reliableSince
          ? 'Todavía no hay suficientes datos confiables para este período. Los datos de conexión son confiables recién a partir del ' + reliableSince.toLocaleString('es-PE',{timeZone:'America/Lima'}) + '.'
          : 'Todavía no hay datos de conexión registrados con el sistema corregido. Esperá a que algún dispositivo mande su primer aviso.'
      }) };
    }
    // El rango pedido empieza ANTES de reliable_since pero termina después: en vez de
    // bloquear el informe entero (lo que confunde — la mayor parte del período SÍ es
    // confiable), se recorta el inicio a reliable_since y se avisa qué parte quedó afuera.
    let partialNote = null;
    if (from.getTime() < reliableSince.getTime()) {
      partialNote = 'Este informe solo incluye desde el ' + reliableSince.toLocaleString('es-PE',{timeZone:'America/Lima'}) + ' en adelante — antes de esa hora el sistema corregido todavía no tenía datos confiables.';
      from.setTime(reliableSince.getTime());
    }

    const { data: storesRaw, error: se } = await sb.from('stores').select('*').eq('station_id', stationId);
    if (se) throw se;
    // Las tiendas "Inactiva" no participan del informe de conexión.
    const stores = (storesRaw || []).filter(s => !s.inactive);
    if (stores.length === 0) return { statusCode:200, headers:H, body:JSON.stringify([]) };

    const storeIds = stores.map(s => s.id);

    const { data: presenceRows, error: pe } = await sb.from('client_presence').select('*').in('store_id', storeIds).order('last_seen', { ascending: false });
    if (pe) throw pe;
    const presenceByStore = {};
    // Puede haber varias filas de presencia por tienda (dispositivo reiniciado, caché
    // borrado, etc. generan un id nuevo y dejan la fila vieja huérfana). Ya vienen
    // ordenadas de más reciente a más vieja, así que nos quedamos con la primera de
    // cada tienda e ignoramos el resto — mismo criterio que usa Monitoreo en vivo.
    (presenceRows || []).forEach(r => { if (!presenceByStore[r.store_id]) presenceByStore[r.store_id] = r; });

    // Traemos también un poco antes de 'from' para saber si ya venía caída al empezar el período.
    const lookback = new Date(from.getTime() - 24*60*60*1000);
    const { data: events, error: ee } = await sb.from('connection_events').select('*')
      .in('store_id', storeIds).gte('event_time', lookback.toISOString()).lte('event_time', to.toISOString())
      .order('event_time', { ascending: true });
    if (ee) throw ee;
    const eventsByStore = {};
    (events || []).forEach(ev => { (eventsByStore[ev.store_id] = eventsByStore[ev.store_id] || []).push(ev); });

    const result = stores.map(store => {
      const presence = presenceByStore[store.id];
      const isOnline = !!presence && (now.getTime() - new Date(presence.last_seen).getTime() < ONLINE_THRESHOLD_MS);
      const storeEvents = (eventsByStore[store.id] || []).filter(ev => new Date(ev.event_time) <= to);
      const metrics = computeStoreUptime(storeEvents, from, to, store.oper_start, store.oper_end, reportIncludesNow && !isOnline, store.timezone || 'America/Lima', presence ? new Date(presence.last_seen) : null);
      return {
        store_id: store.id,
        username: store.username || '—',
        store_name: store.name || '—',
        group_name: store.group_name || null,
        zone: store.zone || null,
        online: reportIncludesNow ? isOnline : !metrics.endedDown,
        uptimePct: metrics.uptimePct,
        disconnections: metrics.disconnections,
        downtimeMinutes: metrics.downtimeMinutes,
        longestDowntimeMinutes: metrics.longestDowntimeMinutes,
      };
    });

    const headers = partialNote ? Object.assign({}, H, { 'X-Report-Note': encodeURIComponent(partialNote) }) : H;
    return { statusCode:200, headers, body:JSON.stringify(result) };
  } catch (e) {
    console.error('api-connection-report error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
