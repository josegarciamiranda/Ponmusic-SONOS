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
      const { data, error } = await sb.from('library').select('*').eq('brand', brand).order('title');
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify(data || []) };
    }
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);
      const { data, error } = await sb.from('library').insert([body]).select().single();
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    }
    if (event.httpMethod === 'PUT' && id) {
      const body = JSON.parse(event.body);
      const { data, error } = await sb.from('library').update(body).eq('id', id).select().single();
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    }
    if (event.httpMethod === 'DELETE' && id) {
      const { error } = await sb.from('library').delete().eq('id', id);
      if (error) throw error;
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Método no permitido' }) };
  } catch (e) {
    console.error('api-library error:', e);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
