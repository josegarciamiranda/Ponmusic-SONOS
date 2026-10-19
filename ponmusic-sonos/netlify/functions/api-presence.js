/* api-presence.js — Monitoreo de conexión de clientes
   POST   /.netlify/functions/api-presence               → "estoy aquí" (heartbeat de un dispositivo)
   GET    /.netlify/functions/api-presence?client_id=xxx  → lista de dispositivos conectados de ese cliente
   POST   /.netlify/functions/api-presence?action=by_store_ids  body:{store_ids:[...]}
                                                           → lista de presencia filtrada por IDs de Tienda,
                                                             igual que GET ?store_ids=... pero mandando la
                                                             lista en el cuerpo del pedido en vez de la URL
                                                             (con ~150-200 tiendas la URL puede superar el
                                                             límite de longitud que imponen Netlify/AWS/CDN
                                                             y la lista quedaría cortada en silencio).
   DELETE /.netlify/functions/api-presence?id=deviceId    → borra el registro de ese dispositivo (logout)

   De paso, cada aviso compara contra el último aviso conocido de ese dispositivo: si pasó
   más tiempo del esperado, asume que estuvo desconectado en el medio y dos eventos quedan
   anotados en connection_events (uno de 'disconnect' aproximado a la última vez que se supo
   de él, y uno de 'connect' ahora) — así se arma solo el historial para los informes, sin
   necesitar ningún proceso corriendo aparte.
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };
const GAP_THRESHOLD_MS = 150000; // la presencia se manda cada 120s; más de esto entre avisos = hubo un corte real

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  try {
    if (event.httpMethod === 'POST') {
      const action = event.queryStringParameters ? event.queryStringParameters.action : null;
      const body = JSON.parse(event.body || '{}');

      // Consulta de presencia por lista de IDs de Tienda, vía POST (no GET) para no
      // depender de la longitud de la URL — ver comentario del encabezado del archivo.
      if (action === 'by_store_ids') {
        const ids = Array.isArray(body.store_ids) ? body.store_ids.map(String).map(s=>s.trim()).filter(Boolean) : [];
        if (ids.length === 0) return { statusCode:200, headers:H, body:JSON.stringify([]) };
        const { data, error } = await sb.from('client_presence').select('*').in('store_id', ids).order('last_seen', { ascending:false });
        if (error) throw error;
        return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
      }

      if (!body.device_id || !body.client_id) return { statusCode:400, headers:H, body:JSON.stringify({error:'device_id y client_id requeridos'}) };
      const now = new Date();

      // La PRIMERA vez que este código corregido recibe un aviso real, anota el instante
      // exacto como "desde cuándo los datos de conexión son confiables". No hace falta
      // configurarlo a mano: si ya existe, este insert simplemente falla en silencio (ya
      // está puesto) y no pasa nada. Los informes van a usar esta fecha para negarse a
      // mostrar números de períodos anteriores a este momento.
      sb.from('system_settings').insert([{ key:'reliable_since', value: now.toISOString() }]).then(()=>{}, ()=>{});

      // Solo las Tiendas (con store_id) generan historial de conexión — el ejecutivo no se monitorea.
      if (body.store_id) {
        try {
          // Importante: comparamos contra el último aviso conocido de ESTA TIENDA (por
          // store_id), no del mismo identificador de dispositivo. Si el dispositivo se
          // reinicia o se le borra la caché, genera un id nuevo — comparar solo contra
          // "su" fila anterior haría que el corte real que hubo antes de reiniciarse
          // quedara invisible (el id nuevo no tiene con qué compararse). Mirando la
          // última vez que se supo CUALQUIER COSA de esta tienda (sin importar qué
          // dispositivo la mandó) capturamos el corte real igual.
          const { data: prevRows } = await sb.from('client_presence').select('last_seen').eq('store_id', body.store_id).order('last_seen', { ascending:false }).limit(1);
          const prev = prevRows && prevRows[0];
          const events = [];
          if (!prev) {
            events.push({ id:'ce_'+Date.now()+'_'+Math.random().toString(36).slice(2,8), store_id:body.store_id, station_id:body.station_id||null, client_id:body.client_id, event_type:'connect', event_time: now.toISOString() });
          } else {
            const gap = now.getTime() - new Date(prev.last_seen).getTime();
            if (gap > GAP_THRESHOLD_MS) {
              events.push({ id:'ce_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+'d', store_id:body.store_id, station_id:body.station_id||null, client_id:body.client_id, event_type:'disconnect', event_time: new Date(prev.last_seen).toISOString() });
              events.push({ id:'ce_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+'c', store_id:body.store_id, station_id:body.station_id||null, client_id:body.client_id, event_type:'connect', event_time: now.toISOString() });
            }
          }
          if (events.length) await sb.from('connection_events').insert(events);
          // Limpieza de eventos viejos (>3 meses) — con baja probabilidad en cada aviso,
          // para no pegarle a la base de datos en cada uno de los miles de avisos por día.
          if (Math.random() < 0.0005) {
            const cutoff = new Date(now.getTime() - 90*24*60*60*1000).toISOString();
            sb.from('connection_events').delete().lt('event_time', cutoff).then(()=>{}, ()=>{});
          }
        } catch (evErr) {
          console.warn('[connection_events] no se pudo registrar (no bloquea el heartbeat):', evErr && evErr.message);
        }
      }

      // Limpieza de dispositivos abandonados (ej. el tablet se reinició y generó un id
      // nuevo, dejando el viejo "congelado" para siempre) — mismo criterio de baja
      // probabilidad que arriba, para no pegarle a la base en cada uno de los miles de
      // avisos por día.
      if (Math.random() < 0.0005) {
        const staleCutoff = new Date(now.getTime() - 7*24*60*60*1000).toISOString();
        sb.from('client_presence').delete().lt('last_seen', staleCutoff).then(()=>{}, ()=>{});
      }

      // Identidad de la fila: si es una Tienda, se identifica por la TIENDA (store_id),
      // no por el dispositivo — así, sin importar cuántas veces se reinicie el dispositivo,
      // se recargue la caché o alguien entre "a probar" desde otra máquina, siempre se
      // actualiza la MISMA fila. Antes, cada dispositivo nuevo creaba una fila separada, y
      // al cerrar esa sesión de prueba se borraba solo esa fila — dejando reaparecer una
      // fila vieja y desactualizada de otro dispositivo anterior para la misma tienda.
      // (Un ejecutivo, que no tiene store_id, sigue identificándose por dispositivo.)
      const row = {
        id: body.store_id ? ('store_' + body.store_id) : body.device_id,
        client_id: body.client_id,
        store_id: body.store_id || null,
        store_name: body.store_name || null,
        username: body.username || null,
        business_name: body.business_name || null,
        station_id: body.station_id || null,
        station_name: body.station_name || null,
        channel_name: body.channel_name || null,
        connected_since: body.connected_since || now.toISOString(),
        is_playing: !!body.is_playing,
        now_playing: body.now_playing || null,
        last_seen: now.toISOString(),
      };
      const { error } = await sb.from('client_presence').upsert([row], { onConflict: 'id' });
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const clientId = q.client_id || null;
      const storeIdsRaw = q.store_ids || null;
      if (!clientId && !storeIdsRaw) return { statusCode:400, headers:H, body:JSON.stringify({error:'client_id o store_ids requerido'}) };
      // Preferimos filtrar por store_id (lista real y confiable de Tiendas, la misma que
      // usa el Informe) en vez de por client_id: el client_id que quedó grabado en la fila
      // de presencia es un dato de conveniencia tomado en el momento del aviso, y puede no
      // coincidir con el negocio actual de la tienda (sesión vieja, reasignación, etc.) —
      // eso hacía que Monitoreo En Vivo perdiera de vista tiendas que sí estaban conectadas.
      let query = sb.from('client_presence').select('*');
      if (storeIdsRaw) {
        const ids = storeIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return { statusCode:200, headers:H, body:JSON.stringify([]) };
        query = query.in('store_id', ids);
      } else {
        query = query.eq('client_id', clientId);
      }
      const { data, error } = await query.order('last_seen', { ascending:false });
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters ? event.queryStringParameters.id : null;
      if (!id) return { statusCode:400, headers:H, body:JSON.stringify({error:'id requerido'}) };
      const { error } = await sb.from('client_presence').delete().eq('id', id);
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:405, headers:H, body:JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-presence error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
