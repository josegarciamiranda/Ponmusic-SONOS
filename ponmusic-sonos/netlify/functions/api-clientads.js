/* GET  /.netlify/functions/api-clientads?id=xxx           → obtiene anuncios del cliente
   PUT  /.netlify/functions/api-clientads?id=xxx           → guarda anuncios del cliente
   GET  /.netlify/functions/api-clientads?action=version&id=xxx → solo la fecha de última
        modificación (consulta liviana, para saber si vale la pena traer todo de nuevo)
*/
const { getSupabase } = require('./db');
const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:H, body:'' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) }; }
  const q = event.queryStringParameters || {};
  const id = q.id;
  try {
    if (event.httpMethod === 'GET' && q.action === 'version' && id) {
      const { data, error } = await sb.from('client_ads').select('updated_at').eq('client_id',id).maybeSingle();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ updated_at: data ? data.updated_at : null }) };
    }
    if (event.httpMethod === 'GET' && id) {
      const { data, error } = await sb.from('client_ads').select('*').eq('client_id',id).maybeSingle();
      if (error) throw error;
      if (!data) {
        const empty = { client_id:id, ads:[], ad_schedule:[], updated_at:new Date().toISOString() };
        const { data:created, error:ce } = await sb.from('client_ads').insert([empty]).select().single();
        if (ce) throw ce;
        return { statusCode:200, headers:H, body:JSON.stringify({ads:created.ads||[],adSchedule:created.ad_schedule||[],updated_at:created.updated_at}) };
      }
      return { statusCode:200, headers:H, body:JSON.stringify({ads:data.ads||[],adSchedule:data.ad_schedule||[],updated_at:data.updated_at}) };
    }
    if (event.httpMethod === 'PUT' && id) {
      const body = JSON.parse(event.body);
      const { data, error } = await sb.from('client_ads')
        .update({ ads:body.ads||[], ad_schedule:body.adSchedule||[], updated_at:new Date().toISOString() })
        .eq('client_id',id).select().single();
      if (error) throw error;
      return { statusCode:200, headers:H, body:JSON.stringify({ads:data.ads||[],adSchedule:data.ad_schedule||[],updated_at:data.updated_at}) };
    }
    return { statusCode:405, headers:H, body:JSON.stringify({error:'Método no permitido'}) };
  } catch(e) {
    console.error('api-clientads error:',e);
    return { statusCode:500, headers:H, body:JSON.stringify({error:e.message}) };
  }
};
