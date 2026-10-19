const { getSupabase } = require('./db');

const H = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  let sb;
  try { sb = getSupabase(); } catch(e) { return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) }; }
  const id = event.queryStringParameters?.id;
  const brand = event.queryStringParameters?.brand || 'ponmusic';
  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await sb.from('clients').select('*').eq('brand', brand).order('created_at');
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify(data || []) };
    }
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);
      const { data: client, error: ce } = await sb.from('clients').insert([body]).select().single();
      if (ce) throw ce;
      await sb.from('client_data').insert([{
        client_id: client.id,
        categories: [], classifications: [], clocks: [], channels: [], schedule: []
      }]);
      return { statusCode: 200, headers: H, body: JSON.stringify(client) };
    }
    if (event.httpMethod === 'PUT' && id) {
      const body = JSON.parse(event.body);
      const { data, error } = await sb.from('clients').update(body).eq('id', id).select().single();
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    }
    if (event.httpMethod === 'DELETE' && id) {
      const { error } = await sb.from('clients').delete().eq('id', id);
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Método no permitido' }) };
  } catch (e) {
    console.error('api-clients error:', e);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
