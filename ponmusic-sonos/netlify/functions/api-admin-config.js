/* api-admin-config.js — Credenciales del Administrador Principal + Verificación en dos pasos (TOTP)
   POST /.netlify/functions/api-admin-config?action=login
        body: { username, password, totpCode?, trustToken?, trustDevice? }
        → { ok:true, trustToken? } si coincide todo (trustToken nuevo si trustDevice=true)
        → { ok:false, needsTotp:true } si user/pass ok pero falta el código (2FA activo, sin dispositivo confiable válido)
        → 401 si user/pass no coincide, o el código TOTP es incorrecto
   POST ?action=change        body:{oldUsername,oldPassword,newUsername,newPassword}
   POST ?action=totp_status   body:{username,password} → { enabled:boolean }
   POST ?action=totp_setup    body:{username,password} → { secret, otpauthUri } (genera uno nuevo, no lo activa aún)
   POST ?action=totp_confirm  body:{username,password,secret,totpCode} → activa 2FA si el código coincide
   POST ?action=totp_disable  body:{username,password} → desactiva 2FA (también borra los dispositivos confiados)
   POST ?action=forget_devices body:{username,password} → revoca todos los dispositivos confiados
*/
const { getSupabase } = require('./db');
const { generateSecret, verifyTOTP, buildOtpAuthUri, generateDeviceToken } = require('./totp');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };
const TRUST_DAYS = 30;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  if (event.httpMethod !== 'POST') return { statusCode:405, headers:H, body:JSON.stringify({error:'Método no permitido'}) };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }

  const action = event.queryStringParameters ? event.queryStringParameters.action : null;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  try {
    // Asegura que exista la fila 'main' (por si la migración no se corrió a tiempo)
    const { data: rows, error: ge } = await sb.from('admin_config').select('*').eq('id','main').limit(1);
    if (ge) throw ge;
    let cfg = rows && rows[0];
    if (!cfg) {
      const { data: created, error: ce } = await sb.from('admin_config').insert([{ id:'main', username:'admin', password:'admin123' }]).select().single();
      if (ce) throw ce;
      cfg = created;
    }

    function credsOk(u,p){ return u===cfg.username && p===cfg.password; }

    async function isTrustedDevice(token){
      if (!token) return false;
      const { data: d } = await sb.from('admin_trusted_devices').select('*').eq('token', token).limit(1);
      const row = d && d[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return false;
      sb.from('admin_trusted_devices').update({ last_used_at: new Date().toISOString() }).eq('id', row.id).then(()=>{}, ()=>{});
      return true;
    }

    if (action === 'login') {
      if (!credsOk(body.username, body.password)) {
        return { statusCode:401, headers:H, body:JSON.stringify({ error:'Usuario o contraseña incorrectos.' }) };
      }
      let deviceAlreadyTrusted = false;
      if (cfg.totp_secret) {
        deviceAlreadyTrusted = await isTrustedDevice(body.trustToken);
        if (!deviceAlreadyTrusted) {
          if (!body.totpCode) {
            return { statusCode:200, headers:H, body:JSON.stringify({ ok:false, needsTotp:true }) };
          }
          if (!verifyTOTP(cfg.totp_secret, body.totpCode)) {
            return { statusCode:401, headers:H, body:JSON.stringify({ error:'Código de verificación incorrecto.' }) };
          }
        }
      }
      let newTrustToken = null;
      // Solo se emite un token nuevo si el dispositivo NO estaba ya confiado
      // (si no, cada login desde un dispositivo confiado iría acumulando filas de más).
      if (cfg.totp_secret && body.trustDevice && !deviceAlreadyTrusted) {
        newTrustToken = generateDeviceToken();
        const expiresAt = new Date(Date.now() + TRUST_DAYS*24*60*60*1000).toISOString();
        await sb.from('admin_trusted_devices').insert([{ id:'dev_'+Date.now()+'_'+Math.random().toString(36).slice(2,8), token:newTrustToken, expires_at:expiresAt }]);
      }
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true, trustToken:newTrustToken }) };
    }

    if (action === 'change') {
      if (body.oldUsername !== cfg.username || body.oldPassword !== cfg.password) {
        return { statusCode:401, headers:H, body:JSON.stringify({ error:'La contraseña actual no coincide.' }) };
      }
      if (!body.newUsername || !body.newPassword) {
        return { statusCode:400, headers:H, body:JSON.stringify({ error:'Usuario y contraseña nuevos son obligatorios.' }) };
      }
      const { error: ue } = await sb.from('admin_config').update({ username: body.newUsername, password: body.newPassword }).eq('id','main');
      if (ue) throw ue;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    if (action === 'totp_status') {
      if (!credsOk(body.username, body.password)) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      if (!cfg.totp_secret) return { statusCode:200, headers:H, body:JSON.stringify({ enabled:false }) };
      const otpauthUri = buildOtpAuthUri(cfg.totp_secret, cfg.username, 'PonMusic Admin');
      return { statusCode:200, headers:H, body:JSON.stringify({ enabled:true, secret: cfg.totp_secret, otpauthUri }) };
    }

    if (action === 'totp_setup') {
      if (!credsOk(body.username, body.password)) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const secret = generateSecret();
      const otpauthUri = buildOtpAuthUri(secret, cfg.username, 'PonMusic Admin');
      return { statusCode:200, headers:H, body:JSON.stringify({ secret, otpauthUri }) };
    }

    if (action === 'totp_confirm') {
      if (!credsOk(body.username, body.password)) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      if (!body.secret || !verifyTOTP(body.secret, body.totpCode)) {
        return { statusCode:401, headers:H, body:JSON.stringify({error:'El código no coincide. Verifica la hora de tu dispositivo e inténtalo de nuevo.'}) };
      }
      const { error: ue } = await sb.from('admin_config').update({ totp_secret: body.secret }).eq('id','main');
      if (ue) throw ue;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    if (action === 'totp_disable') {
      if (!credsOk(body.username, body.password)) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const { error: ue } = await sb.from('admin_config').update({ totp_secret: null }).eq('id','main');
      if (ue) throw ue;
      await sb.from('admin_trusted_devices').delete().neq('id',''); // ya no hace falta confiar en nada si 2FA está apagado
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    if (action === 'forget_devices') {
      if (!credsOk(body.username, body.password)) return { statusCode:401, headers:H, body:JSON.stringify({error:'Usuario o contraseña incorrectos.'}) };
      const { error: de } = await sb.from('admin_trusted_devices').delete().neq('id','');
      if (de) throw de;
      return { statusCode:200, headers:H, body:JSON.stringify({ ok:true }) };
    }

    return { statusCode:400, headers:H, body:JSON.stringify({ error:'action inválido' }) };
  } catch (e) {
    console.error('api-admin-config error:', e);
    return { statusCode:500, headers:H, body:JSON.stringify({ error:e.message }) };
  }
};
