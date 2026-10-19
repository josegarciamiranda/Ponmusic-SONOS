/* api-stores.js — Tiendas, ahora dentro de una Estación
   GET    /.netlify/functions/api-stores?station_id=xxx       → lista las tiendas de esa estación
   POST   /.netlify/functions/api-stores                      → crea una tienda
   PUT    /.netlify/functions/api-stores?id=xxx                → edita una tienda
   DELETE /.netlify/functions/api-stores?id=xxx                → elimina una tienda
   POST   /.netlify/functions/api-stores?action=login          → login de dependiente de tienda
          body: { username, password } → devuelve { store, station, client } si coincide
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'POST' && q.action === 'login') {
      const body = JSON.parse(event.body || '{}');
      const { username, password } = body;
      if (!username || !password) return { statusCode:400, headers:H, body:JSON.stringify({error:'username y password requeridos'}) };
      const { data: storeRows, error: se } = await sb.from('stores').select('*').eq('username', username).eq('password', password).limit(1);
      if (se) throw se;
      if (!storeRows || storeRows.length === 0) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const store = storeRows[0];
      if (store.inactive) return { statusCode:403, headers:H, body:JSON.stringify({error:'Esta tienda está inactiva. Contacta al administrador.'}) };
      let station = null;
      if (store.station_id) {
        const { data: stationRows } = await sb.from('stations').select('*').eq('id', store.station_id).limit(1);
        station = (stationRows && stationRows[0]) || null;
      }
      const clientId = station ? station.client_id : store.client_id;
      const { data: clientRows, error: ce } = await sb.from('clients').select('*').eq('id', clientId).limit(1);
      if (ce) throw ce;
      const client = (clientRows && clientRows[0]) || null;
      if (client && client.status === 'bloqueada') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta bloqueada por falta de pago.'}) };
      if (client && client.status === 'suspendida') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta suspendida. Contacta al administrador.'}) };
      return { statusCode:200, headers:H, body:JSON.stringify({ store, station, client }) };
    }

    if (event.httpMethod === 'GET') {
      const stationId = q.station_id;
      if (!stationId) return { statusCode:400, headers:H, body:JSON.stringify({error:'station_id requerido'}) };
      const { data, error } = await sb.from('stores').select('*').eq('station_id', stationId).order('created_at');
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { data, error } = await sb.from('stores').insert([body]).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'PUT' && q.id) {
      const body = JSON.parse(event.body || '{}');
      const { data, error } = await sb.from('stores').update(body).eq('id', q.id).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'DELETE' && q.id) {
      const { error } = await sb.from('stores').delete().eq('id', q.id);
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:405, headers:H, body:JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-stores error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
