/* offline-db.js
   Guarda en IndexedDB toda la configuración necesaria para reproducir offline:
   - Metadatos de canciones (título, artista, duración, URL)
   - Datos del admin (categorías, relojes, canales, programación)
   - Anuncios del cliente (metadatos + programación)
   Los archivos mp3 se guardan en Cache API (gestionado por sw.js)
*/
const OfflineDB = (() => {
  const DB_NAME = 'maa_offline_v1';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('songs')) {
          db.createObjectStore('songs', { keyPath: 'id' });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
    return dbPromise;
  }

  async function setConfig(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite');
      tx.objectStore('config').put({ key, value, updatedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getConfig(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function setSong(song) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ ...song, cachedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getSong(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readonly');
      const req = tx.objectStore('songs').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function getAllSongs() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readonly');
      const req = tx.objectStore('songs').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function removeSong(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function clearSongs() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  /* Lista las claves del store 'config' que empiezan con un prefijo dado
     (usado para el registro diario de reproducción: 'playlog_2026-08-13', etc.) */
  async function getKeysWithPrefix(prefix) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').openCursor();
      const keys = [];
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (typeof cursor.key === 'string' && cursor.key.indexOf(prefix) === 0) keys.push(cursor.key);
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  return { setConfig, getConfig, setSong, getSong, getAllSongs, removeSong, clearSongs, getKeysWithPrefix };
})();
