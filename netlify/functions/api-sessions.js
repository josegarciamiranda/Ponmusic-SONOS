/* api-sessions.js — VARIANTE DE UN USUARIO / UN DISPOSITIVO
   Si alguien intenta iniciar sesión con un usuario que ya tiene una sesión activa
   (con heartbeat reciente), se rechaza el login con un error claro.
   Si el dispositivo que sí tenía la sesión activa deja de mandar heartbeat (se cerró,
   perdió conexión, etc.) por más de HEARTBEAT_TIMEOUT_MS, la sesión se considera
   libre y cualquiera puede volver a entrar con esas credenciales.
   Si un nuevo login reemplaza una sesión activa a la fuerza (mismo usuario, otro
   dispositivo, después del timeout), el dispositivo viejo recibe 'session_replaced'
   en su siguiente heartbeat y se desconecta solo.
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };
/* El dispositivo manda su aviso ("sigo aquí") cada 180s (ver startHeartbeat en app.js).
   Este tiempo tiene que ser bastante mayor a eso — si no, durante la segunda mitad de
   cada ciclo de 180s el sistema cree que la sesión "ya se fue" aunque siga conectada,
   y deja entrar a otro dispositivo con las mismas credenciales, desconectando al real. */
const HEARTBEAT_TIMEOUT_MS = 420000; // sin heartbeat en 420s (7 min, > 2x los 180s del aviso) -> la sesión se considera libre

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  if (event.httpMethod !== 'POST') return { statusCode:405, headers:H, body:JSON.stringify({error:'Método no permitido'}) };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  const action = event.queryStringParameters ? event.queryStringParameters.action : null;
  let body = {};
  try { body = JSON.parse(event.body||'{}'); } catch(e) {}

  try {
    if (action === 'login') {
      if (!body.username) return { statusCode:400, headers:H, body:JSON.stringify({error:'username requerido'}) };
      const { data:rows, error:ge } = await sb.from('sessions').select('*').eq('username', body.username).limit(1);
      if (ge) throw ge;
      const existing = rows && rows[0];
      const now = Date.now();
      if (existing && (now - new Date(existing.last_heartbeat).getTime()) < HEARTBEAT_TIMEOUT_MS) {
        return { statusCode:409, headers:H, body:JSON.stringify({error:'Ya hay un usuario conectado con estas credenciales. Ciérralo o inténtalo con otro usuario.'}) };
      }
      const token = generateToken();
      const { error:ue } = await sb.from('sessions').upsert([{ username: body.username, token: token, last_heartbeat: new Date().toISOString() }], { onConflict:'username' });
      if (ue) throw ue;
      return { statusCode:200, headers:H, body:JSON.stringify({ token }) };
    }

    if (action === 'heartbeat') {
      if (!body.username || !body.token) return { statusCode:400, headers:H, body:JSON.stringify({error:'username y token requeridos'}) };
      const { data:rows, error:ge } = await sb.from('sessions').select('*').eq('username', body.username).limit(1);
      if (ge) throw ge;
      const existing = rows && rows[0];
      if (!existing || existing.token !== body.token) {
        return { statusCode:409, headers:H, body:JSON.stringify({error:'session_replaced'}) };
      }
      const { error:ue } = await sb.from('sessions').update({ last_heartbeat: new Date().toISOString() }).eq('username', body.username);
      if (ue) throw ue;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    if (action === 'logout') {
      if (!body.username) return { statusCode:400, headers:H, body:JSON.stringify({error:'username requerido'}) };
      await sb.from('sessions').delete().eq('username', body.username);
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:400, headers:H, body:JSON.stringify({error:'action inválido'}) };

  } catch(e) {
    console.error('api-sessions (un dispositivo) error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) };
  }
};
