/* netlify/functions/r2-delete.js
   Elimina un archivo de Cloudflare R2.
*/
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Variables de entorno R2 no configuradas.' }) };
  }

  let key;
  try { ({ key } = JSON.parse(event.body)); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error eliminando archivo: ' + err.message }) };
  }
};
