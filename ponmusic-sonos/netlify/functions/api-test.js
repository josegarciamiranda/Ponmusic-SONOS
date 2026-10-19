/* Endpoint de diagnóstico: /.netlify/functions/api-test
   Verifica que las variables de entorno estén configuradas y que
   Supabase responda correctamente.
*/
const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const result = { env: {}, supabase: null, error: null };

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const r2Account = process.env.R2_ACCOUNT_ID;
  const r2Bucket = process.env.R2_BUCKET_NAME;
  const r2Public = process.env.R2_PUBLIC_URL;

  result.env = {
    SUPABASE_URL: url ? '✓ presente' : '✗ FALTA',
    SUPABASE_SERVICE_KEY: serviceKey ? '✓ presente' : '✗ FALTA',
    R2_ACCOUNT_ID: r2Account ? '✓ presente' : '✗ FALTA',
    R2_BUCKET_NAME: r2Bucket ? '✓ presente' : '✗ FALTA',
    R2_PUBLIC_URL: r2Public ? '✓ presente' : '✗ FALTA',
  };

  if (!url || !serviceKey) {
    result.error = 'Variables de Supabase no configuradas en Netlify.';
    return { statusCode: 500, headers, body: JSON.stringify(result) };
  }

  try {
    const sb = createClient(url, serviceKey);
    const { data, error } = await sb.from('library').select('count').limit(1);
    if (error) throw error;
    result.supabase = '✓ Conexión exitosa a Supabase';
  } catch (e) {
    result.error = 'Error conectando a Supabase: ' + e.message;
  }

  return {
    statusCode: result.error ? 500 : 200,
    headers,
    body: JSON.stringify(result, null, 2)
  };
};
