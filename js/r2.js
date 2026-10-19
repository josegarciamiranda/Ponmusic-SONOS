/* r2.js - Cliente para subir y eliminar archivos en Cloudflare R2
   via Netlify Functions (sin exponer credenciales en el frontend).
   La URL pública de cada archivo se guarda en los metadatos (localStorage).
*/
const R2Storage = (() => {

  async function upload(file, songId, onProgress) {
    const key = `${songId}.mp3`;

    // 1. Pedir URL firmada al backend (Netlify Function)
    const res = await fetch('/.netlify/functions/r2-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, contentType: file.type || 'audio/mpeg' }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error ${res.status} obteniendo URL de subida`);
    }

    const { uploadUrl, publicUrl } = await res.json();

    // 2. Subir el archivo directamente a R2 con XMLHttpRequest (permite progreso)
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`R2 upload failed: HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Error de red al subir a R2'));
      xhr.send(file);
    });

    return publicUrl; // URL pública permanente del archivo en R2
  }

  async function remove(songId) {
    const key = `${songId}.mp3`;
    try {
      const res = await fetch('/.netlify/functions/r2-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) console.warn('R2 delete warning:', await res.text());
    } catch (e) {
      console.warn('R2 delete error (archivo puede quedar huérfano):', e.message);
    }
  }

  return { upload, remove };
})();
