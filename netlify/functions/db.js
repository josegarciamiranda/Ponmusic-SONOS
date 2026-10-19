const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Variables SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas en Netlify Environment Variables.');
  return createClient(url, key);
}

module.exports = { getSupabase };
