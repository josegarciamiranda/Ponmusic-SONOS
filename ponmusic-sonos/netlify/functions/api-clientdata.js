const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }
  const id = event.queryStringParameters?.id;
  const action = event.queryStringParameters?.action;
  try {
    if (event.httpMethod === 'POST' && action === 'login') {
      const { username, password } = JSON.parse(event.body);
      const { data:clients, error } = await sb.from('clients').select('*').eq('username',username).eq('password',password).limit(1);
      if (error) throw error;
      if (!clients||clients.length===0) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const client = clients[0];
      if (client.status==='bloqueada') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta bloqueada por falta de pago.'}) };
      if (client.status==='suspendida') return { statusCode:403, headers:H, body:JSON.stringify({error:'Cuenta suspendida. Contacta al administrador.'}) };
      return { statusCode:200, headers:H, body:JSON.stringify({client}) };
    }
    if (event.httpMethod === 'GET' && id) {
      const { data, error } = await sb.from('client_data').select('*').eq('client_id',id).maybeSingle();
      if (error) throw error;
      if (!data) {
        const empty = { client_id:id, categories:[], classifications:[], clocks:[], channels:[], schedule:[] };
        const { data:created, error:ce } = await sb.from('client_data').insert([empty]).select().single();
        if (ce) throw ce;
        return { statusCode:200, headers:H, body:JSON.stringify(created) };
      }
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }
    if (event.httpMethod === 'PUT' && id) {
      const body = JSON.parse(event.body);
      const { data, error } = await sb.from('client_data').update(body).eq('client_id',id).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify(data) };
    }
    return { statusCode:405, headers:H, body:JSON.stringify({error:'Método no permitido'}) };
  } catch(e) {
    console.error('api-clientdata error:',e);
    return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) };
  }
};
