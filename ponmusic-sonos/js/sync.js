/* sync.js - Gestor de sincronización offline
   Descarga al dispositivo solo las canciones que le corresponden al cliente
   según sus categorías activas, más sus propios anuncios.
*/
const OfflineSync = (() => {

  let _onProgress = null;
  let _cancelRequested = false;

  function onProgress(cb) { _onProgress = cb; }

  function emit(state) { if (_onProgress) _onProgress(state); }

  /* Registrar el Service Worker */
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      // Esperar controller activo (puede tardar en primer registro)
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const h = () => { resolve(); navigator.serviceWorker.removeEventListener('controllerchange', h); };
          navigator.serviceWorker.addEventListener('controllerchange', h);
          setTimeout(resolve, 3000); // timeout de seguridad
        });
      }
      // A partir de aquí, cualquier cambio de "quién controla la página" significa
      // que se instaló una versión NUEVA de la app en segundo plano — recargamos
      // solos, sin que nadie tenga que borrar caché a mano en cada dispositivo.
      // Así, una tienda que queda con la pantalla prendida varios días seguidos
      // igual termina viendo la última versión apenas el navegador la detecta.
      let _autoReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_autoReloaded) return;
        _autoReloaded = true;
        window.location.reload();
      });
      // Revisar activamente si hay versión nueva cada 30 minutos — un dispositivo
      // que nunca navega ni cierra pestaña también necesita este empujón, ya que
      // el navegador por sí solo no siempre revisa seguido si la pestaña sigue abierta.
      setInterval(() => { reg.update().catch(() => {}); }, 30 * 60 * 1000);
      return true;
    } catch (e) {
      console.warn('SW registro fallido:', e);
      return false;
    }
  }

  /* Obtener el SW activo desde controller o desde registration */
  async function getActiveSW() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      return navigator.serviceWorker.controller;
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (reg) return reg.active || reg.waiting || reg.installing;
    } catch(e) {}
    return null;
  }

  /* Enviar mensaje al SW y esperar respuesta */
  async function swMessage(msg) {
    const sw = await getActiveSW();
    if (!sw) return null;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => resolve(e.data);
      sw.postMessage(msg, [channel.port2]);
    });
  }

  /* Obtener estado del caché de audio */
  async function getCacheStatus() {
    const result = await swMessage({ type: 'CACHE_STATUS' });
    if (!result) return { count: 0, bytes: 0, urls: [] };
    return result;
  }

  /* Formatear bytes a texto legible */
  function formatBytes(bytes) {
    if (bytes === 0) return '0 MB';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* Calcular qué canciones debe descargar este cliente:
     - Solo las categorías que usan los relojes del CANAL asignado al cliente
       (canal → programación → reloj → secuencia de categorías)
     - Sus propios anuncios
  */
  /* Devuelve los IDs de canciones que hacen falta para el canal de este cliente,
     resolviendo tanto bloques de tipo Estilo como de tipo Playlist en la secuencia
     del Reloj Musical asignado (misma lógica que usa el motor de reproducción en vivo). */
  function getRelevantSongIds(adminData, client) {
    const relevant = new Set();
    if (!client || !client.channel_id) return relevant;
    const categoryIds = new Set(), playlistIds = new Set();
    (adminData.schedule || []).forEach(s => {
      if (s.channelId !== client.channel_id) return;
      const clock = (adminData.clocks || []).find(c => c.id === s.clockId);
      if (!clock) return;
      (clock.sequence || []).forEach(blockId => {
        if (typeof blockId === 'string' && blockId.indexOf('ch_') === 0) playlistIds.add(blockId);
        else categoryIds.add(blockId);
      });
    });
    // Canciones de los Estilos usados directamente en el reloj
    (adminData.classifications || []).forEach(c => {
      if (categoryIds.has(c.categoryId)) relevant.add(c.songId);
    });
    // Canciones de los bloques de tipo Playlist (Estilos completos + canciones sueltas armadas en Clasificación)
    (adminData.playlistContent || []).forEach(p => {
      if (!playlistIds.has(p.playlistId)) return;
      if (p.type === 'song') relevant.add(p.refId);
      else if (p.type === 'style') {
        (adminData.classifications || []).forEach(c => { if (c.categoryId === p.refId) relevant.add(c.songId); });
      }
    });
    return relevant;
  }

  /* Descargar una canción al caché vía Service Worker */
  async function downloadSong(song) {
    const sw = await getActiveSW();
    if (!sw) return false;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => resolve(e.data && e.data.ok === true);
      sw.postMessage({ type: 'CACHE_SONG', songId: song.id, urls: [song.url] }, [channel.port2]);
    });
  }

  /* Sincronización principal */
  async function sync(library, adminData, clientAds, client) {
    _cancelRequested = false;
    emit({ phase: 'preparing', message: 'Preparando sincronización...', progress: 0, total: 0, current: 0 });

    // 1. Registrar SW si no está activo
    const swReady = await registerSW();
    if (!swReady) {
      emit({ phase: 'error', message: 'Tu navegador no soporta modo offline. Prueba Chrome o Edge.' });
      return false;
    }

    // Esperar a que el SW tome control si es nuevo
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => setTimeout(r, 1000));
    }

    // 2. Calcular canciones necesarias (solo las de las categorías que usa el canal del cliente)
    // OJO: getRelevantSongIds trabaja solo con IDs de la Biblioteca — los anuncios son una
    // lista aparte (clientAds.ads) y se agregan siempre completos, sin filtrar por categorías.
    const neededIds = getRelevantSongIds(adminData, client);
    const neededSongs = library.filter(s => neededIds.has(s.id) && s.url);
    const neededSongIds = new Set(neededSongs.map(s => s.id));
    const adSongs = (clientAds.ads || []).filter(a => a.url);

    // Combinar canciones + anuncios
    const allToDownload = [
      ...neededSongs,
      ...adSongs.filter(a => !neededSongIds.has(a.id)) // evitar duplicados (por si algún ID coincidiera)
    ];
    const neededUrls = new Set(allToDownload.map(s => s.url));

    // 3. Podar del dispositivo lo que YA NO corresponde a este cliente
    //    (evita que quede mezclado el contenido de otro cliente que usó este mismo dispositivo)
    emit({ phase: 'preparing', message: 'Verificando contenido local...', progress: 0, total: 0, current: 0 });
    const cacheStatus = await getCacheStatus();
    const staleCachedUrls = cacheStatus.urls.filter(u => !neededUrls.has(u));
    if (staleCachedUrls.length > 0) {
      await swMessage({ type: 'REMOVE_SONG', urls: staleCachedUrls });
    }
    const savedSongs = await OfflineDB.getAllSongs();
    for (const s of savedSongs) {
      if (!neededUrls.has(s.url)) await OfflineDB.removeSong(s.id);
    }

    const total = allToDownload.length;

    // Guardar SIEMPRE la config del cliente actual (aunque no tenga nada que descargar),
    // para que quede como dueño exclusivo de los datos offline de este dispositivo.
    // Nota: la info de sesión para el login offline (usuario/contraseña/tienda) se guarda
    // aparte, en el propio flujo de login — aquí solo guardamos lo necesario para reproducir.
    async function saveClientConfig() {
      await OfflineDB.setConfig('adminData', adminData);
      await OfflineDB.setConfig('clientAds', clientAds);
      await OfflineDB.setConfig('lastSync', new Date().toISOString());
      await OfflineDB.setConfig('librarySnapshot', allToDownload.map(s => ({
        id: s.id, title: s.title, artist: s.artist, duration: s.duration, url: s.url, type: s.type
      })));
    }

    if (total === 0) {
      await saveClientConfig();
      emit({ phase: 'done', message: 'No hay canciones ni anuncios para sincronizar. Verifica las categorías y "Mis Anuncios".', progress: 100, total: 0, current: 0 });
      return true;
    }

    // 4. Ver qué ya está en caché
    const cachedUrls = new Set(cacheStatus.urls);
    const pending = allToDownload.filter(s => !cachedUrls.has(s.url));

    // Aparte de "cuántos archivos", mostramos también cuántos son canciones y cuántos
    // son anuncios — así se puede confirmar a simple vista, sin abrir herramientas de
    // desarrollador, que los anuncios sí entraron a la sincronización.
    const adIdSet = new Set(adSongs.map(a => a.id));
    const songsFoundCount = neededSongs.length, adsFoundCount = adSongs.length;
    console.log('[Mis Descargas] Canciones encontradas:', songsFoundCount, '| Anuncios encontrados:', adsFoundCount, adSongs.map(a => ({ id: a.id, title: a.title, url: a.url })));

    emit({
      phase: 'downloading',
      message: `Descargando ${pending.length} de ${total} archivos (${total - pending.length} ya descargados) — ${songsFoundCount} canción(es), ${adsFoundCount} anuncio(s) detectado(s)...`,
      progress: 0, total: pending.length, current: 0
    });

    // 5. Descargar los que faltan
    let downloaded = 0;
    let errors = 0;
    let adsDownloaded = 0;
    const failedAdTitles = [];

    for (let i = 0; i < pending.length; i++) {
      if (_cancelRequested) {
        emit({ phase: 'cancelled', message: 'Sincronización cancelada.', progress: Math.round((i / pending.length) * 100), total: pending.length, current: i });
        return false;
      }

      const song = pending[i];
      const isAdItem = adIdSet.has(song.id);
      emit({
        phase: 'downloading',
        message: `Descargando${isAdItem ? ' 📢 anuncio' : ''}: ${song.title || song.id}`,
        progress: Math.round((i / pending.length) * 100),
        total: pending.length,
        current: i + 1
      });

      const ok = await downloadSong(song);
      if (ok) {
        downloaded++;
        if (isAdItem) adsDownloaded++;
        // Guardar metadatos en IndexedDB
        await OfflineDB.setSong({
          id: song.id, title: song.title || '', artist: song.artist || '',
          duration: song.duration || 0, url: song.url,
          type: song.type || (isAdItem ? 'anuncio' : 'cancion')
        });
      } else {
        errors++;
        if (isAdItem) failedAdTitles.push(song.title || song.id);
        console.warn('[Mis Descargas] Error descargando:', isAdItem ? '(anuncio) ' : '', song.title || song.id, song.url);
      }
    }

    // 6. Guardar configuración offline en IndexedDB
    emit({ phase: 'saving', message: 'Guardando configuración offline...', progress: 95, total: pending.length, current: pending.length });
    await saveClientConfig();

    const finalStatus = await getCacheStatus();
    const adsSummary = adsFoundCount > 0
      ? ` Anuncios: ${adsDownloaded}/${adsFoundCount} descargado(s)${failedAdTitles.length ? ' — falló: ' + failedAdTitles.join(', ') : ''}.`
      : ' (No se detectó ningún anuncio propio para descargar.)';
    emit({
      phase: 'done',
      message: `Sincronización completa. ${downloaded} archivo(s) nuevos descargados.${errors > 0 ? ' ' + errors + ' error(es).' : ''}${adsSummary}`,
      progress: 100,
      total: pending.length,
      current: downloaded,
      cacheCount: finalStatus.count,
      cacheBytes: formatBytes(finalStatus.bytes)
    });

    return true;
  }

  function cancel() { _cancelRequested = true; }

  /* Cargar configuración guardada offline */
  async function loadOfflineConfig() {
    const [adminData, clientAds, clientInfo, lastSync, librarySnapshot] = await Promise.all([
      OfflineDB.getConfig('adminData'),
      OfflineDB.getConfig('clientAds'),
      OfflineDB.getConfig('clientInfo'),
      OfflineDB.getConfig('lastSync'),
      OfflineDB.getConfig('librarySnapshot'),
    ]);
    return { adminData, clientAds, clientInfo, lastSync, librarySnapshot };
  }

  /* Verificar si hay datos offline disponibles */
  async function hasOfflineData() {
    const lastSync = await OfflineDB.getConfig('lastSync');
    return !!lastSync;
  }

  /* Limpiar todo el caché offline */
  async function clearAll() {
    const cache = await caches.open('maa-audio-v1');
    const keys = await cache.keys();
    await Promise.all(keys.map(k => cache.delete(k)));
    await OfflineDB.clearSongs();
    await OfflineDB.setConfig('lastSync', null);
    await OfflineDB.setConfig('adminData', null);
    await OfflineDB.setConfig('clientAds', null);
    await OfflineDB.setConfig('librarySnapshot', null);
  }

  return {
    registerSW, sync, cancel, onProgress,
    getCacheStatus, formatBytes,
    loadOfflineConfig, hasOfflineData, clearAll
  };
})();
