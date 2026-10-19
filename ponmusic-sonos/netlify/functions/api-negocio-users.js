/* api-negocio-users.js — Usuarios del nivel Negocio (Administrador de Cliente).
   Hasta 5 por negocio, todos con el mismo nivel de acceso — sirve para que
   varias personas puedan estar conectadas a la vez sin chocar con la regla
   de "un usuario, un dispositivo".
   GET    ?client_id=xxx        → lista los usuarios de ese negocio
   POST                          → crea un usuario (rechaza si ya hay 5)
   PUT    ?id=xxx                 → edita un usuario
   DELETE ?id=xxx                 → elimina un usuario
   POST   ?action=login          → { username, password } → { user, client }
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };
const MAX_USERS_PER_NEGOCIO = 5;

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
      const { data: rows, error: se } = await sb.from('negocio_users').select('*').eq('username', username).eq('password', password).limit(1);
      if (se) throw se;
      if (!rows || rows.length === 0) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const user = rows[0];
      const { data: clientRows, error: ce } = await sb.from('clients').select('*').eq('id', user.client_id).limit(1);
      if (ce) throw ce;
      const client = (clientRows && clientRows[0]) || null;
      if (client && client.status === 'bloqueada') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta bloqueada por falta de pago.'}) };
      if (client && client.status === 'suspendida') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta suspendida. Contacta al administrador.'}) };
      return { statusCode:200, headers:H, body:JSON.stringify({ user, client }) };
    }

    if (event.httpMethod === 'GET') {
      const clientId = q.client_id;
      if (!clientId) return { statusCode:400, headers:H, body:JSON.stringify({error:'client_id requerido'}) };
      const { data, error } = await sb.from('negocio_users').select('*').eq('client_id', clientId).order('created_at');
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data || []) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { count, error: ce } = await sb.from('negocio_users').select('id', { count: 'exact', head: true }).eq('client_id', body.client_id);
      if (ce) throw ce;
      if ((count || 0) >= MAX_USERS_PER_NEGOCIO) {
        return { statusCode:400, headers:H, body:JSON.stringify({error:'Este negocio ya tiene el máximo de '+MAX_USERS_PER_NEGOCIO+' usuarios.'}) };
      }
      const { data, error } = await sb.from('negocio_users').insert([body]).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'PUT' && q.id) {
      const body = JSON.parse(event.body || '{}');
      const { data, error } = await sb.from('negocio_users').update(body).eq('id', q.id).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }

    if (event.httpMethod === 'DELETE' && q.id) {
      const { error } = await sb.from('negocio_users').delete().eq('id', q.id);
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:405, headers:H, body:JSON.stringify({ error:'Método no permitido' }) };
  } catch (e) {
    console.error('api-negocio-users error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
