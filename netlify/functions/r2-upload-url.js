/* netlify/functions/r2-upload-url.js
   Genera una URL firmada (presigned PUT) para que el navegador suba
   un archivo mp3 directamente a Cloudflare R2 sin exponer credenciales.
*/
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Variables de entorno R2 no configuradas en Netlify.' })
    };
  }

  let key, contentType;
  try {
    ({ key, contentType } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  if (!key || !key.endsWith('.mp3')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Key inválido' }) };
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'audio/mpeg',
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 }); // 5 minutos
    const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ uploadUrl, publicUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Error generando URL firmada: ' + err.message }),
    };
  }
};
