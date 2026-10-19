/* api-playlog.js — Registro de reproducción por canal
   POST /.netlify/functions/api-playlog                → sube un lote de eventos de reproducción (desde el cliente)
   GET  /.netlify/functions/api-playlog?list=dates&channel_id=xxx  → días con registros disponibles para ese canal
   GET  /.netlify/functions/api-playlog?channel_id=xxx&date=YYYY-MM-DD → detalle de reproducciones de ese día
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) return { statusCode:200, headers:H, body:JSON.stringify({ ok:true, inserted:0 }) };
      const rows = entries.map(e => ({
        id: e.id,
        channel_id: e.channel_id || null,
        channel_name: e.channel_name || null,
        client_id: e.client_id || null,
        client_name: e.client_name || null,
        log_date: e.log_date,
        log_time: e.log_time,
        type: e.type || null,
        title: e.title || '',
        artist: e.artist || '',
        category: e.category || '',
      })).filter(r => r.id && r.log_date && r.log_time);
      if (rows.length === 0) return { statusCode:200, headers:H, body:JSON.stringify({ ok:true, inserted:0 }) };
      const { error } = await sb.from('playback_logs').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true, inserted: rows.length }) };
    }

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const channelId = q.channel_id;
      if (!channelId) return { statusCode:400, headers:H, body:JSON.stringify({ error:'channel_id requerido' }) };

      if (q.list === 'dates') {
        const { data, error } = await sb.from('playback_logs').select('log_date').eq('channel_id', channelId);
        if (error) throw error;
        const dates = [...new Set((data || []).map(r => r.log_date))].sort().reverse();
        return { statusCode:200, headers:H, body:JSON.stringify({ dates }) };
      }

      const date = q.date;
      if (!date) return { statusCode:400, headers:H, body:JSON.stringify({ error:'date requerido' }) };
      const { data, error } = await sb.from('playback_logs').select('*').eq('channel_id', channelId).eq('log_date', date).order('log_time');
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
    }

    return { statusCode:405, headers:H, body:JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-playlog error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
