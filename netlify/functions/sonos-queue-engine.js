/* sonos-queue-engine.js — la misma lógica de "qué suena después" que ya existe en
   el reproductor del navegador (js/app.js: buildQueue/refillQueue/pickRandomSong/
   checkFrequencyAds/getActiveSchedule), pero corriendo acá, al servicio del modelo
   de "Cloud Queue" de Sonos: Sonos nos PREGUNTA (GET /itemWindow) por una ventana
   de pistas alrededor de una posición, y nosotros la generamos y se la damos —
   no hay "push" de nuestro lado.

   LIMITACIÓN CONOCIDA DE ESTA PRIMERA VERSIÓN (dejada a propósito, ver CLAUDE.md):
   - Solo se portó el modo de anuncios por FRECUENCIA ("cada N canciones"). El modo
     por FECHA/HORA EXACTA (ads con mode:'time') no está implementado todavía —
     encaja mal con un modelo donde Sonos puede pedir pistas con minutos de
     anticipación, y necesita diseño aparte.
   - getActiveSchedule() solo mira el Reloj asignado al canal AHORA MISMO al pedir
     una ventana nueva — si la programación semanal cambia de Reloj a mitad de una
     ventana ya generada, esa parte de la cola no se vuelve a calcular (igual que
     en el navegador: una vez armada la cola, sigue como estaba).
   - Sin tiendas (storeId): el filtro "a qué tiendas aplica este anuncio" asume
     "todas" cuando el grupo Sonos no está ligado a una Tienda puntual de PonMusic.

   Cada posición de la cola (itemId) es un número entero, como texto ("0","1",...).
   Una vez generada una posición, se guarda en sonos_playback_state.queue_items y
   nunca se vuelve a recalcular — así Sonos puede volver a pedirla (ej. al navegar
   hacia atrás) y siempre recibe lo mismo.
*/
const { getSupabase } = require('./db');

/* "Ahora" en la zona horaria de las tiendas.
   Las Netlify Functions corren en UTC. Los Relojes y la Programación se definen con la
   hora de la tienda (ej. "08:00–12:00" en Bolivia); el navegador las evaluaba con la hora
   local, pero acá, sin esto, se habrían evaluado en UTC (4 horas de diferencia).
   Se devuelve un Date cuyos getters locales (getDay, getHours, toTimeString...) muestran
   la hora de pared de esa zona — así el resto del código no cambia.
   Zona: variable de entorno SONOS_TIMEZONE (por defecto America/La_Paz, UTC-4). */
function nowInTZ(tz) {
  const zone = tz || process.env.SONOS_TIMEZONE || 'America/La_Paz';
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

function localDateStrInTZ(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const DAYS = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];

function isPlaylistBlockId(id){ return typeof id==='string' && id.indexOf('ch_')===0; }

function getSongPoolForBlock(cd, blockId){
  if (isPlaylistBlockId(blockId)) {
    const content = (cd.playlistContent||[]).filter(p=>p.playlistId===blockId);
    const ids = {};
    content.forEach(p=>{
      if (p.type==='song') ids[p.refId]=true;
      else if (p.type==='style') cd.classifications.filter(c=>c.categoryId===p.refId).forEach(c=>{ids[c.songId]=true;});
    });
    return Object.keys(ids);
  }
  return cd.classifications.filter(c=>c.categoryId===blockId).map(c=>c.songId);
}

function getBlockLabel(cd, blockId){
  if (isPlaylistBlockId(blockId)) { const ch=cd.channels.find(c=>c.id===blockId); return ch?ch.name:'?'; }
  const cat = cd.categories.find(c=>c.id===blockId);
  return cat?cat.name:'?';
}

function getActiveSchedule(cd, channelId, now){
  if (!channelId) return null;
  const dayName = DAYS[(now.getDay()+6)%7], hhmm = now.toTimeString().slice(0,5), todayStr = localDateStrInTZ(now);
  const exception = cd.schedule.find(s=>s.channelId===channelId && s.date===todayStr && s.start<=hhmm && hhmm<s.end);
  if (exception) return exception;
  return cd.schedule.find(s=>s.channelId===channelId && !s.date && s.day===dayName && s.start<=hhmm && hhmm<s.end) || null;
}

function isFreqScheduleActiveNow(s, now){
  if (s.dates && s.dates.length>0) { if (s.dates.indexOf(localDateStrInTZ(now))===-1) return false; }
  if (s.startTime && s.endTime) { const hhmm=now.toTimeString().slice(0,5); if (hhmm<s.startTime||hhmm>s.endTime) return false; }
  return true;
}

function scheduleAppliesToStore(s, storeId){
  if (!s.storeIds || s.storeIds.length===0) return true;
  return !!storeId && s.storeIds.indexOf(storeId)!==-1;
}

function pickAdsForTrigger(s, adsList, seqIndexes){
  const ids = (s.adIds && s.adIds.length) ? s.adIds : (s.adId ? [s.adId] : []);
  const pool = ids.map(id=>adsList.find(a=>a.id===id)).filter(Boolean);
  if (pool.length===0) return [];
  const n = Math.min(parseInt(s.countPerTrigger,10)||1, pool.length);
  if (s.order==='random') {
    const shuffled = pool.slice();
    for (let i=shuffled.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }
    return shuffled.slice(0,n);
  }
  const start = seqIndexes[s.id]||0, result=[];
  for (let k=0;k<n;k++) result.push(pool[(start+k)%pool.length]);
  seqIndexes[s.id] = (start+n)%pool.length;
  return result;
}

function pickRandomSong(library, cd, blockId, recentPlayed){
  const allIds = getSongPoolForBlock(cd, blockId).filter(id=>library.find(m=>m.id===id && m.url));
  if (allIds.length===0) return null;
  const recent = recentPlayed[blockId]||[];
  const maxRecent = Math.max(1, Math.floor(allIds.length/2));
  let available = allIds.filter(id=>recent.indexOf(id)===-1);
  if (available.length===0) { recentPlayed[blockId]=[]; available=allIds; }
  const id = available[Math.floor(Math.random()*available.length)];
  if (!recentPlayed[blockId]) recentPlayed[blockId]=[];
  recentPlayed[blockId].push(id);
  if (recentPlayed[blockId].length>maxRecent) recentPlayed[blockId].shift();
  return library.find(m=>m.id===id) || null;
}

function toCloudQueueTrack(item){
  return {
    name: item.title,
    mediaUrl: item.url,
    contentType: 'audio/mpeg',
    durationMillis: Math.round((item.duration||0)*1000),
    artist: { name: item.artist || '' },
  };
}

/* Carga todo lo que hace falta de Supabase para un canal de un Negocio, en el
   mismo formato que ya usa el navegador (client_data, library filtrada por marca,
   anuncios del cliente). */
async function loadChannelContext(sb, clientId) {
  const [{ data: clientRow }, { data: cdRow }, { data: adsRow }] = await Promise.all([
    sb.from('clients').select('*').eq('id', clientId).maybeSingle(),
    sb.from('client_data').select('*').eq('client_id', clientId).maybeSingle(),
    sb.from('client_ads').select('*').eq('client_id', clientId).maybeSingle(),
  ]);
  const brand = (clientRow && clientRow.brand) || 'ponmusic';
  const { data: libraryRows } = await sb.from('library').select('*').eq('brand', brand);
  const cd = cdRow || { categories:[], classifications:[], clocks:[], channels:[], schedule:[], playlistContent:[] };
  const clientAds = adsRow ? { ads: adsRow.ads||[], adSchedule: adsRow.ad_schedule||[] } : { ads:[], adSchedule:[] };
  return { cd, library: libraryRows||[], clientAds };
}

/* Genera UN ítem más de cola (canción o anuncio) a partir del estado persistido,
   y devuelve { item, newState } — newState son los campos mutables a guardar. */
function generateNextItem(ctx, channelId, storeId, state) {
  const now = nowInTZ();
  const recentPlayed = Object.assign({}, state.recent_played||{});
  const freqCounters = Object.assign({}, state.freq_counters||{});
  const seqIndexes = Object.assign({}, state.seq_indexes||{});
  let clockPointer = state.clock_pointer||0;

  // 1) ¿Hay un anuncio de frecuencia que ya debe sonar antes de la próxima canción?
  //    (se revisa ANTES de generar la canción, igual que checkFrequencyAds() se
  //    llama al terminar la canción anterior — el efecto es el mismo: el anuncio
  //    queda encolado antes de que siga la música).
  const liveAds = ctx.clientAds;
  if (liveAds.adSchedule && liveAds.adSchedule.length && liveAds.ads && liveAds.ads.length) {
    const freqSchedules = liveAds.adSchedule.filter(s=>s.mode==='frequency' && isFreqScheduleActiveNow(s, now) && scheduleAppliesToStore(s, storeId));
    for (const s of freqSchedules) {
      const everyN = parseInt(s.everyN,10)||1;
      const count = (freqCounters[s.id]||0) + 1;
      if (count >= everyN) {
        freqCounters[s.id] = 0;
        const ads = pickAdsForTrigger(s, liveAds.ads, seqIndexes);
        if (ads.length) {
          // Una posición de cola = un ítem. Si countPerTrigger>1, el primero va en 'item' y el
          // resto en 'extra' (ensureQueueUpTo los agrega seguidos). Antes los extras se perdían.
          const toItem = (ad) => ({ title: ad.title, artist: 'Anuncio', url: ad.url, duration: ad.duration||0, isAd: true });
          return {
            item: toItem(ads[0]),
            extra: ads.slice(1).map(toItem),
            newState: { recent_played: recentPlayed, freq_counters: freqCounters, seq_indexes: seqIndexes, clock_pointer: clockPointer },
          };
        }
      } else {
        freqCounters[s.id] = count;
      }
    }
  }

  // 2) Canción normal según el Reloj activo del canal ahora mismo.
  const sched = getActiveSchedule(ctx.cd, channelId, now);
  const clock = sched ? ctx.cd.clocks.find(c=>c.id===sched.clockId) : null;
  if (!clock || !clock.sequence || clock.sequence.length===0) {
    return { item: null, newState: { recent_played: recentPlayed, freq_counters: freqCounters, seq_indexes: seqIndexes, clock_pointer: clockPointer } };
  }
  const catId = clock.sequence[clockPointer % clock.sequence.length];
  clockPointer += 1;
  const song = pickRandomSong(ctx.library, ctx.cd, catId, recentPlayed);
  if (!song) {
    return { item: null, newState: { recent_played: recentPlayed, freq_counters: freqCounters, seq_indexes: seqIndexes, clock_pointer: clockPointer } };
  }
  return {
    item: { title: song.title, artist: song.artist||'', url: song.url, duration: song.duration||0, isAd: false, categoryName: getBlockLabel(ctx.cd, catId) },
    newState: { recent_played: recentPlayed, freq_counters: freqCounters, seq_indexes: seqIndexes, clock_pointer: clockPointer },
  };
}

/* Asegura que queue_items tenga al menos (targetIndex+1) elementos, generando y
   persistiendo los que falten. Devuelve la fila de sonos_playback_state ya al día. */
async function ensureQueueUpTo(sb, stateRow, ctx, targetIndex) {
  const items = (stateRow.queue_items || []).slice();
  let state = stateRow;
  let guard = 0;
  while (items.length <= targetIndex && guard < (targetIndex + 50)) {
    guard++;
    const { item, extra, newState } = generateNextItem(ctx, stateRow.channel_id, null, state);
    state = Object.assign({}, state, newState);
    if (item) { items.push(item); if (extra && extra.length) extra.forEach(x => items.push(x)); }
    else break; // no hay nada que programar (sin reloj / sin canciones) — no insistir en bucle
  }
  const updated = {
    queue_items: items,
    clock_pointer: state.clock_pointer,
    recent_played: state.recent_played,
    freq_counters: state.freq_counters,
    seq_indexes: state.seq_indexes,
    updated_at: new Date().toISOString(),
  };
  await sb.from('sonos_playback_state').update(updated).eq('sonos_group_id', stateRow.sonos_group_id);
  return Object.assign({}, stateRow, updated);
}

module.exports = { loadChannelContext, ensureQueueUpTo, toCloudQueueTrack, nowInTZ, generateNextItem, getActiveSchedule };
