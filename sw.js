/* sw.js - Service Worker para Música & Anuncios Offline
   Intercepta peticiones de audio y las sirve desde Cache API si están descargadas.
   Para archivos no cacheados, intenta la red y los cachea al vuelo.
*/
const CACHE_AUDIO = 'maa-audio-v1';
const CACHE_APP   = 'ponmusic-sonos-app-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/js/api.js',
  '/js/app.js',
  '/js/r2.js',
  '/js/offline-db.js',
  '/js/sync.js',
  '/img/logo-ponmusic.png',
  '/img/logo-spotmusic.jpg',
  '/img/favicon.png',
  '/img/favicon-32.png',
];

/* ---- Install: cachear shell de la app ---- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_APP).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

/* ---- Activate: limpiar cachés viejas ---- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_AUDIO && k !== CACHE_APP)
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ---- Fetch: servir desde caché o red ---- */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Archivos de audio desde R2 (pub-*.r2.dev) → caché primero
  if (url.hostname.endsWith('.r2.dev') && url.pathname.endsWith('.mp3')) {
    event.respondWith(cacheFirstAudio(event.request));
    return;
  }

  // App shell → caché primero, red como fallback
  if (url.pathname.match(/\.(html|css|js)$/) || url.pathname === '/') {
    event.respondWith(cacheFirst(CACHE_APP, event.request));
    return;
  }

  // Netlify Functions → red primero, sin caché (datos dinámicos)
  if (url.pathname.startsWith('/.netlify/functions/')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // Todo lo demás → red
  event.respondWith(fetch(event.request).catch(() => new Response('Offline', { status: 503 })));
});

async function cacheFirstAudio(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  // No está en caché — intentar red
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_AUDIO);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('Audio no disponible offline', { status: 503 });
  }
}

async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('No disponible offline', { status: 503 });
  }
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Sin conexión' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ---- Mensajes desde la app ---- */
self.addEventListener('message', event => {
  const { type, urls, songId } = event.data || {};
  // Usar event.ports[0] para responder via MessageChannel
  const port = (event.ports && event.ports[0]) || null;

  if (type === 'CACHE_SONG') {
    event.waitUntil(cacheSong(urls, songId, port));
  }

  if (type === 'REMOVE_SONG') {
    event.waitUntil(removeSong(urls));
  }

  if (type === 'CACHE_STATUS') {
    event.waitUntil(getCacheStatus(port));
  }
});

async function cacheSong(urls, songId, port) {
  const cache = await caches.open(CACHE_AUDIO);
  let ok = false;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response);
        ok = true;
        break;
      }
    } catch (e) {}
  }
  if (port) {
    port.postMessage({ type: 'SONG_CACHED', songId, ok });
  }
}

async function removeSong(urls) {
  const cache = await caches.open(CACHE_AUDIO);
  for (const url of urls) {
    await cache.delete(url);
  }
}

async function getCacheStatus(port) {
  try {
    const cache = await caches.open(CACHE_AUDIO);
    const keys = await cache.keys();
    let totalBytes = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const blob = await res.blob();
        totalBytes += blob.size;
      }
    }
    if (port) port.postMessage({
      type: 'CACHE_STATUS_RESULT',
      count: keys.length,
      bytes: totalBytes,
      urls: keys.map(k => k.url)
    });
  } catch (e) {
    if (port) port.postMessage({ type: 'CACHE_STATUS_RESULT', count: 0, bytes: 0, urls: [] });
  }
}
