/* api-stations.js — Estaciones (nivel intermedio entre Negocio y Tienda)
   GET    /.netlify/functions/api-stations?client_id=xxx   → lista las estaciones de ese negocio
   POST   /.netlify/functions/api-stations                 → crea una estación
   PUT    /.netlify/functions/api-stations?id=xxx           → edita una estación
   DELETE /.netlify/functions/api-stations?id=xxx           → elimina una estación (y de paso sus tiendas, para no dejar huérfanas)
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const clientId = q.client_id;
      if (!clientId) return { statusCode:400, headers:H, body:JSON.stringify({error:'client_id requerido'}) };
      const { data, error } = await sb.from('stations').select('*').eq('client_id', clientId).order('created_at');
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { data, error } = await sb.from('stations').insert([body]).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'PUT' && q.id) {
      const body = JSON.parse(event.body || '{}');
      const { data, error } = await sb.from('stations').update(body).eq('id', q.id).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'DELETE' && q.id) {
      await sb.from('stores').delete().eq('station_id', q.id);
      const { error } = await sb.from('stations').delete().eq('id', q.id);
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:405, headers:H, body:JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-stations error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
