/* app.js - Música y Anuncios OFFLINE v1 */

if (localStorage.getItem('maa_state_v1')) localStorage.removeItem('maa_state_v1');

// Las credenciales del Administrador ahora viven en Supabase (tabla admin_config),
// editables desde el propio panel. Ver api-admin-config.js.
const DAYS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];

let appState = {
  session: null,
  library: [],
  clients: [],
  clientData: null,
  clientAds: null,
  isOnline: navigator.onLine,
  offlineReady: false,
};

let _adminDataCache = null;

/* ===== HELPERS ===== */
function uid(p) { return (p||'id')+'_'+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); }
function escapeHtml(s) { return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatDuration(sec) { if(!sec&&sec!==0)return'—'; sec=Math.round(sec); return Math.floor(sec/60)+':'+(sec%60).toString().padStart(2,'0'); }

/* Fecha en el uso horario LOCAL del dispositivo (no UTC) — usamos esto en vez de
   .toISOString() en todo lo relacionado a programación/horarios, para que la
   fecha y la hora siempre estén en el mismo huso horario y nunca se desincronicen
   cerca de la medianoche (que es justo cuando .toISOString() ya cambió de día en
   UTC mientras el reloj local todavía marca el día anterior, o viceversa). */
function localDateStr(d){
  d=d||new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

/* ===== Registro de reproducción por canal (se sube al servidor para que el
   Administrador pueda descargarlo — el cliente ya no lo ve ni lo descarga) ===== */
function todayDateStr(){return localDateStr();}

async function logPlayback(item,channel,client){
  try{
    var now=new Date();
    var entry={
      id:uid('log'),
      channel_id:channel?channel.id:null,
      channel_name:channel?channel.name:'',
      client_id:client?client.id:null,
      client_name:client?client.name:'',
      log_date:localDateStr(now),
      log_time:now.toTimeString().slice(0,8),
      type:item.isAd?'Anuncio':'Canción',
      title:item.title||'(sin título)',
      artist:item.artist||'',
      category:item.categoryName||''
    };
    var pending=(await OfflineDB.getConfig('playlog_pending'))||[];
    pending.push(entry);
    await OfflineDB.setConfig('playlog_pending',pending);
    flushPlaylogQueue(); // intento de envío inmediato si hay internet (no bloqueante)
  }catch(e){/* nunca bloquear la reproducción por un error de log */}
}

var _flushingPlaylog=false;
async function flushPlaylogQueue(){
  if(_flushingPlaylog||!appState.isOnline)return;
  _flushingPlaylog=true;
  try{
    var pending=(await OfflineDB.getConfig('playlog_pending'))||[];
    if(pending.length>0){
      var batch=pending.slice(0,300);
      await API.playlog.push(batch);
      var remaining=pending.slice(batch.length);
      await OfflineDB.setConfig('playlog_pending',remaining);
    }
  }catch(e){/* se reintentará en el próximo evento online / próxima reproducción */}
  _flushingPlaylog=false;
}

function downloadTextFile(filename,text){
  var blob=new Blob([text],{type:'text/plain;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},200);
}

function slugify(s){return String(s||'canal').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')||'canal';}

function buildAdminPlaylogText(channelName,dateStr,entries){
  var lines=[];
  lines.push('REGISTRO DE REPRODUCCIÓN — '+dateStr);
  lines.push('Canal: '+channelName);
  lines.push('Total de reproducciones: '+entries.length);
  lines.push('----------------------------------------------------');
  entries.forEach(function(e){
    lines.push(e.log_time+'  ['+e.type+']  '+e.title+(e.artist?' — '+e.artist:'')+(e.category?'  ('+e.category+')':'')+(e.client_name?'  · '+e.client_name:''));
  });
  lines.push('----------------------------------------------------');
  lines.push('Generado el '+new Date().toLocaleString());
  return lines.join('\r\n');
}
function formatDate(d) { return d?new Date(d).toLocaleDateString():'—'; }
function capitalize(s) { return s?s.charAt(0).toUpperCase()+s.slice(1):s; }
function typeLabel(t) { return t==='cancion'?'Canción':t==='anuncio'?'Anuncio':'Jingle'; }

function toast(msg, duration) {
  duration = duration || 3000;
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  document.body.appendChild(el); setTimeout(function(){el.remove();},duration);
}

function setLoading(msg) {
  document.getElementById('app').innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;color:var(--ink-soft);"><div style="font-size:28px;">♫</div><div>'+(msg||'Cargando...')+'</div></div>';
}

/* ===== ONLINE/OFFLINE DETECTOR ===== */
window.addEventListener('online',  function(){ appState.isOnline=true;  updateOnlineBadge(); toast('✓ Conexión restaurada. Puedes sincronizar.'); flushPlaylogQueue(); });
window.addEventListener('offline', function(){ appState.isOnline=false; updateOnlineBadge(); toast('⚡ Sin conexión — reproduciendo desde almacenamiento local.'); });

function updateOnlineBadge() {
  const badge = document.getElementById('onlineBadge');
  if (!badge) return;
  badge.textContent = appState.isOnline ? '🟢 Online' : '🔴 Offline';
  badge.style.color = appState.isOnline ? '#1F7A41' : '#B5483C';
}

/* ===== UPLOAD PROGRESS ===== */
function showUploadBar(current,total,filename) {
  let bar=document.getElementById('uploadBar');
  if(!bar){bar=document.createElement('div');bar.id='uploadBar';bar.className='upload-bar';document.body.appendChild(bar);}
  bar.innerHTML='<span>Subiendo '+current+' de '+total+': <b>'+escapeHtml(filename)+'</b></span><div class="ubar-track"><div class="ubar-fill" id="ubarFill"></div></div><span id="ubarPct">0%</span>';
}
function updateUploadBarPct(pct) {
  var f=document.getElementById('ubarFill'),l=document.getElementById('ubarPct');
  if(f)f.style.width=Math.round(pct*100)+'%'; if(l)l.textContent=Math.round(pct*100)+'%';
}
function hideUploadBar() { var b=document.getElementById('uploadBar');if(b)b.remove(); }

/* ===== HEARTBEAT ===== */
var _heartbeatTimer = null;
function startHeartbeat(username, token) {
  stopHeartbeat();
  _heartbeatTimer = setInterval(async function() {
    if (!appState.isOnline) return;
    try {
      await API.sessions.heartbeat(username, token);
    } catch(e) {
      if (e.message && e.message.indexOf('session_replaced') !== -1) {
        stopHeartbeat(); destroyPlayerEngine();
        appState.session = null; saveSession();
        alert('Tu sesión fue iniciada en otro dispositivo. Serás desconectado.');
        go('/login'); render();
      }
    }
  }, 180000);
}
function stopHeartbeat() { if(_heartbeatTimer){clearInterval(_heartbeatTimer);_heartbeatTimer=null;} }

/* ===== PRESENCIA / MONITOREO (para que el admin vea online, dispositivos y qué se está reproduciendo) ===== */
function getDeviceId(){
  var id=null;
  try{id=localStorage.getItem('maa_device_id');}catch(e){}
  if(!id){id=uid('dev');try{localStorage.setItem('maa_device_id',id);}catch(e){}}
  return id;
}
var _presenceTimer=null;
var lastPlayerSnapshot=null; // actualizado por updatePlayerUI, lo lee el heartbeat de presencia
function startPresenceHeartbeat(){
  stopPresenceHeartbeat();
  var deviceId=getDeviceId();
  var sessionConnectedSince=new Date().toISOString(); // se fija una sola vez al abrir esta conexión
  function ping(){
    if(!appState.isOnline)return;
    var info=getEffectiveInfo();
    if(!info)return;
    var snap=lastPlayerSnapshot;
    API.presence.ping({
      device_id:deviceId,
      client_id:info.id,
      station_id:info.station_id||null,
      station_name:info.station_name||null,
      store_id:info.store_id||null,
      store_name:info.store_name||null,
      username:info.username,
      business_name:info.business_name,
      channel_name:info.channel_name,
      connected_since:sessionConnectedSince,
      is_playing:!!(snap&&snap.playing),
      now_playing:(snap&&snap.playing&&snap.title)?snap.title:null,
    }).catch(function(e){console.error('[Monitoreo] Error enviando presencia:',e&&e.message);});
  }
  ping();
  _presenceTimer=setInterval(ping,120000);
}
function stopPresenceHeartbeat(){
  if(_presenceTimer){clearInterval(_presenceTimer);_presenceTimer=null;}
  // Ya NO se borra la fila de presencia al cerrar sesión: ahora hay una sola fila por
  // tienda (identificada por store_id, no por dispositivo — ver api-presence.js), así
  // que borrarla dejaría a la tienda como "sin conexión registrada" en vez de mostrar
  // correctamente "Desconectado desde [la hora real en que se cerró la sesión]". Al dejar
  // de mandar avisos, la fila simplemente se pone vieja sola y pasa a offline por su cuenta.
}

/* ===== SESSION ===== */
function saveSession() {
  if(appState.session) sessionStorage.setItem('maa_session',JSON.stringify(appState.session));
  else sessionStorage.removeItem('maa_session');
}

/* ===== ROUTER ===== */
function go(route){window.location.hash=route;}
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', function(){
  OfflineSync.registerSW();
  try{var s=sessionStorage.getItem('maa_session');if(s){appState.session=JSON.parse(s);if(appState.session&&appState.session.role==='client'&&appState.session.username&&appState.session.sessionToken){startHeartbeat(appState.session.username,appState.session.sessionToken);}if(appState.session&&appState.session.role==='client'&&appState.session.kind==='store'){startPresenceHeartbeat();}}}catch(e){}
  render();
});
function currentRoute(){return(window.location.hash||'#/login').replace('#','');}

/* ===== Estación activa (para el ejecutivo, que puede tener varias) ===== */
var ACTIVE_STATION_KEY='maa_active_station';
function getActiveStationId(clientId){
  try{var saved=JSON.parse(localStorage.getItem(ACTIVE_STATION_KEY)||'{}');return saved[clientId]||null;}catch(e){return null;}
}
function setActiveStationId(clientId,stationId){
  try{var saved=JSON.parse(localStorage.getItem(ACTIVE_STATION_KEY)||'{}');saved[clientId]=stationId;localStorage.setItem(ACTIVE_STATION_KEY,JSON.stringify(saved));}catch(e){}
}

/* ===== Tienda activa DENTRO de la Estación elegida (solo para escuchar en el Reproductor) ===== */
var ACTIVE_INSTATION_STORE_KEY='maa_active_instation_store';
function getActiveInStationStoreId(stationId){
  try{var saved=JSON.parse(localStorage.getItem(ACTIVE_INSTATION_STORE_KEY)||'{}');return saved[stationId]||null;}catch(e){return null;}
}
function setActiveInStationStoreId(stationId,storeId){
  try{var saved=JSON.parse(localStorage.getItem(ACTIVE_INSTATION_STORE_KEY)||'{}');saved[stationId]=storeId;localStorage.setItem(ACTIVE_INSTATION_STORE_KEY,JSON.stringify(saved));}catch(e){}
}

/* Cachea, por estación, la lista de tiendas que tiene (para el selector del
   Reproductor y para "Tiendas objetivo" en Mis Anuncios). Se llena en render(). */
var _execStationStoresCache={};
async function loadStationStoresForExec(stationId){
  if(!stationId)return;
  try{_execStationStoresCache[stationId]=await API.stores.list(stationId);}
  catch(e){_execStationStoresCache[stationId]=[];}
}

/* Normaliza la sesión (ejecutivo con varias Estaciones, o dependiente de una
   sola Tienda) a una única forma que el resto de la app usa sin preguntarse
   en qué nivel de la cadena Negocio → Estación → Tienda está parado. */
function getEffectiveInfo(){
  var s=appState.session;
  if(!s||s.role!=='client')return null;
  if(s.kind==='store'){
    var st=s.store||{},station=s.station||{},cl=s.client||{};
    return {
      id:cl.id||station.client_id||st.client_id,
      business_name:cl.business_name||st.name,
      logo_data:cl.logo_data||null,
      brand:cl.brand||'ponmusic',
      station_id:station.id||null,
      station_name:station.name||null,
      station_logo:station.logo_data||null,
      channel_id:st.channel_id||null,
      channel_name:st.channel_name||null,
      store_id:st.id,
      store_name:st.name,
      store_logo:st.logo_data||null,
      only_player:!!st.only_player,
      is_exec:false,
      stations:station?[station]:[],
      stationStores:[st],
      username:s.username
    };
  }
  var c=s.client||{};
  var stations=s.stations||[];
  var activeStationId=getActiveStationId(c.id)||(stations[0]&&stations[0].id)||null;
  var activeStation=stations.find(function(x){return x.id===activeStationId;})||stations[0]||null;
  var stationStores=(activeStation&&_execStationStoresCache[activeStation.id])||[];
  var activeStoreId=(activeStation&&getActiveInStationStoreId(activeStation.id))||(stationStores[0]&&stationStores[0].id)||null;
  var activeStore=stationStores.find(function(x){return x.id===activeStoreId;})||stationStores[0]||null;
  return {
    id:c.id,
    business_name:c.business_name,
    logo_data:c.logo_data||null,
    brand:c.brand||'ponmusic',
    station_id:activeStation?activeStation.id:null,
    station_name:activeStation?activeStation.name:null,
    station_logo:activeStation?activeStation.logo_data:null,
    channel_id:activeStore?activeStore.channel_id:null,
    channel_name:activeStore?activeStore.channel_name:null,
    store_id:activeStore?activeStore.id:null,
    store_name:activeStore?activeStore.name:null,
    store_logo:activeStore?activeStore.logo_data:null,
    only_player:!!(activeStore&&activeStore.only_player),
    is_exec:true,
    stations:stations,
    stationStores:stationStores,
    username:s.username
  };
}

/* ===== Marca única (ponmusic) =====
   En el sistema original (ponmusiconline) el admin alterna entre dos marcas,
   PonMusic y SpotMusic, con datos separados. Este fork es solo para Sonos y
   tiene UNA sola marca, así que se quitó el selector.
   Se mantiene la columna 'brand' en la base de datos y las llamadas a
   getAdminBrand() a propósito: el motor de la cola de Sonos
   (sonos-queue-engine.js) filtra la biblioteca por brand y usa 'ponmusic'
   por defecto, y así nada de eso necesita cambiar. Aquí devuelve siempre
   'ponmusic', e ignora cualquier valor viejo guardado en localStorage. */
function getAdminBrand(){
  return 'ponmusic';
}
/* 'ponmusic' usa la misma clave de siempre (__admin__) para no perder los datos ya existentes.
   Cualquier otra marca (ej. 'spotmusic') usa su propia clave, con su propio set de datos desde cero. */
function getAdminDataKey(brand){
  brand=brand||'ponmusic';
  return brand==='ponmusic'?'__admin__':('__admin__'+'_'+brand);
}

async function render() {
  const route=currentRoute();
  const app=document.getElementById('app');
  if(!appState.session){app.classList.remove('brand-spotmusic');app.innerHTML=renderLogin();bindLogin();return;}
  if(appState.session.role==='admin'){
    setLoading('Cargando datos...');
    var brand=getAdminBrand();
    app.classList.toggle('brand-spotmusic',brand==='spotmusic');
    try{[appState.library,appState.clients]=await Promise.all([API.library.getAll(brand),API.clients.getAll(brand)]);}
    catch(e){toast('Error: '+e.message);}
    app.innerHTML=renderAdminShell(route);bindAdminShell(route);return;
  }
  if(appState.session.role==='client'){
    var info=getEffectiveInfo();
    if(appState.isOnline){
      setLoading('Cargando...');
      try{
        // Si es ejecutivo y aún no tenemos las tiendas de la Estación activa en caché, cárgalas primero
        // (para que store_id/channel_id/store_logo queden completos al recalcular info).
        if(info.is_exec&&info.station_id&&!_execStationStoresCache[info.station_id]){
          await loadStationStoresForExec(info.station_id);
          info=getEffectiveInfo();
        }
        const [lib,cAds,adminRaw]=await Promise.all([
          API.library.getAll(info.brand),
          info.station_id?API.clientAds.get(info.station_id):Promise.resolve({ads:[],adSchedule:[]}),
          API.clientData.get(getAdminDataKey(info.brand)),
        ]);
        appState.library=lib;
        appState.clientAds=cAds||{ads:[],adSchedule:[]};
        _adsLastKnownUpdatedAt=cAds&&cAds.updated_at?cAds.updated_at:null;
        _adminDataCache={categories:adminRaw.categories||[],classifications:adminRaw.classifications||[],clocks:adminRaw.clocks||[],channels:adminRaw.channels||[],schedule:adminRaw.schedule||[],playlistContent:adminRaw.playlistContent||[]};
        // Guardar snapshot offline en segundo plano
        OfflineDB.setConfig('adminData',_adminDataCache).catch(function(){});
        OfflineDB.setConfig('clientAds',appState.clientAds).catch(function(){});
      }catch(e){
        toast('Error online, cargando desde almacenamiento local...');
        await loadOfflineFallback(info);
      }
    } else {
      setLoading('Cargando desde almacenamiento local...');
      await loadOfflineFallback(info);
    }
    startAdsSmartPoll(info.station_id);
    app.classList.remove('brand-spotmusic'); // el cliente/tienda siempre ve el mismo diseño, sin importar la marca del admin que lo creó
    app.innerHTML=renderClientShell(route,info);bindClientShell(route,info);return;
  }
}

async function loadOfflineFallback(client) {
  const cfg = await OfflineSync.loadOfflineConfig();
  if(cfg.adminData) _adminDataCache=cfg.adminData;
  else _adminDataCache={categories:[],classifications:[],clocks:[],channels:[],schedule:[],playlistContent:[]};
  appState.clientAds = cfg.clientAds || {ads:[],adSchedule:[]};
  // Cargar metadatos de canciones desde IndexedDB
  const songs = await OfflineDB.getAllSongs();
  appState.library = songs;
  appState.offlineReady = !!cfg.lastSync;
}

async function saveClientAds(){
  if(!appState.session||appState.session.role!=='client')return;
  var info=getEffectiveInfo();
  if(!info||!info.station_id)return;
  try{await API.clientAds.save(info.station_id,appState.clientAds);}
  catch(e){toast('Sin conexión — cambios guardados localmente.');await OfflineDB.setConfig('clientAds',appState.clientAds);}
}

function getAdminData(){
  if(!_adminDataCache) _adminDataCache={categories:[],classifications:[],clocks:[],channels:[],schedule:[],playlistContent:[]};
  return _adminDataCache;
}

/* ===== Cambiar usuario/contraseña del Administrador Principal ===== */
function openChangeCredsModal(){
  var existing=document.getElementById('credsModalBg');
  if(existing)existing.remove();
  var wrap=document.createElement('div');
  wrap.innerHTML='<div class="modal-bg" id="credsModalBg"><div class="modal">'
    +'<h3>Cambiar credenciales de Administrador</h3>'
    +'<p class="muted" style="margin-top:-6px;">Debes confirmar tu contraseña actual para poder cambiarla.</p>'
    +'<div class="field"><label>Contraseña actual</label><input type="password" id="credsOldPass"></div>'
    +'<div class="field"><label>Nuevo usuario</label><input type="text" id="credsNewUser" value="'+escapeHtml((appState.session&&appState.session.adminUsername)||'admin')+'"></div>'
    +'<div class="field"><label>Nueva contraseña</label><input type="password" id="credsNewPass"></div>'
    +'<div class="field"><label>Confirmar nueva contraseña</label><input type="password" id="credsNewPass2"></div>'
    +'<div id="credsErr" class="login-error"></div>'
    +'<div class="modal-actions" style="margin-bottom:4px;"><button class="btn" id="credsCancel">Cerrar</button><button class="btn btn-primary" id="credsSave">Guardar</button></div>'
    +'<div class="section-title" style="margin-top:18px;">Verificación en dos pasos</div>'
    +'<p class="muted" style="font-size:11.5px;margin:-6px 0 10px;">Usa la "Contraseña actual" de arriba. Un código de 6 dígitos de tu app de verificación (Google Authenticator, Authy, etc.) se te pedirá además de tu contraseña al iniciar sesión como Administrador.</p>'
    +'<div id="totpBox"><button class="btn btn-sm" id="btnTotpCheck">Verificar estado</button></div>'
    +'</div></div>';
  document.body.appendChild(wrap.firstChild);
  var bg=document.getElementById('credsModalBg');
  document.getElementById('credsCancel').onclick=function(){bg.remove();};
  bg.onclick=function(e){if(e.target===bg)bg.remove();};
  document.getElementById('credsSave').onclick=async function(){
    var errBox=document.getElementById('credsErr');errBox.textContent='';
    var oldPass=document.getElementById('credsOldPass').value;
    var newUser=document.getElementById('credsNewUser').value.trim();
    var newPass=document.getElementById('credsNewPass').value;
    var newPass2=document.getElementById('credsNewPass2').value;
    if(!newUser||!newPass){errBox.textContent='Completa usuario y contraseña nuevos.';return;}
    if(newPass!==newPass2){errBox.textContent='Las contraseñas nuevas no coinciden.';return;}
    try{
      var oldUser=(appState.session&&appState.session.adminUsername)||'admin';
      await API.adminConfig.change(oldUser,oldPass,newUser,newPass);
      appState.session.adminUsername=newUser;saveSession();
      bg.remove();render();toast('✓ Credenciales actualizadas.');
    }catch(e){errBox.textContent=e.message||'Error al cambiar las credenciales.';}
  };

  var totpBox=document.getElementById('totpBox');
  function currentUser(){return(appState.session&&appState.session.adminUsername)||'admin';}
  function currentPass(){return document.getElementById('credsOldPass').value;}

  function renderTotpOff(){
    totpBox.innerHTML='<div class="muted" style="margin-bottom:8px;">Estado: <b style="color:var(--ink);">Desactivada</b></div>'
      +'<button class="btn btn-sm btn-primary" id="btnTotpEnable">Activar verificación en dos pasos</button>';
    document.getElementById('btnTotpEnable').onclick=startTotpSetup;
  }
  function renderTotpOn(otpauthUri,secret){
    totpBox.innerHTML='<div class="muted" style="margin-bottom:8px;">Estado: <b style="color:#1F7A41;">Activada ✓</b></div>'
      +'<button class="btn btn-sm" id="btnShowQrAgain" style="margin-right:6px;">Ver código QR (para agregarlo a otro celular)</button>'
      +'<button class="btn btn-sm" id="btnForgetDevices" style="margin-right:6px;">Olvidar todos los dispositivos confiados</button>'
      +'<button class="btn btn-sm btn-danger" id="btnTotpDisable">Desactivar</button>'
      +'<div id="totpQrShareBox" style="margin-top:14px;"></div>';
    document.getElementById('btnTotpDisable').onclick=async function(){
      if(!confirm('¿Desactivar la verificación en dos pasos? Solo hará falta usuario y contraseña para entrar.'))return;
      try{await API.adminConfig.totpDisable(currentUser(),currentPass());localStorage.removeItem('maa_admin_trust_token');toast('Verificación en dos pasos desactivada.');renderTotpOff();}
      catch(e){toast('Error: '+e.message);}
    };
    document.getElementById('btnForgetDevices').onclick=async function(){
      if(!confirm('¿Olvidar todos los dispositivos confiados? La próxima vez que entres desde cualquier equipo (incluido este) te va a volver a pedir el código.'))return;
      try{await API.adminConfig.forgetDevices(currentUser(),currentPass());localStorage.removeItem('maa_admin_trust_token');toast('✓ Todos los dispositivos confiados fueron olvidados.');}
      catch(e){toast('Error: '+e.message);}
    };
    document.getElementById('btnShowQrAgain').onclick=function(){
      var box=document.getElementById('totpQrShareBox');
      box.innerHTML='<p class="muted" style="font-size:12px;">Que la otra persona escanee este mismo código con SU celular — a partir de ahí, su app también va a generar códigos válidos para esta cuenta, sin afectar el tuyo.</p>'
        +'<div id="totpQrShare" style="background:#fff;padding:10px;border-radius:8px;display:inline-block;"></div>'
        +'<p class="muted" style="font-size:11.5px;margin:8px 0 4px;">¿No puede escanear? Que escriba esta clave manualmente en su app:</p>'
        +'<code style="display:block;background:var(--bg-soft);padding:8px 10px;border-radius:6px;font-size:13px;letter-spacing:1px;word-break:break-all;">'+secret+'</code>';
      /* global QRCode */
      new QRCode(document.getElementById('totpQrShare'),{text:otpauthUri,width:180,height:180,colorDark:'#0A0A0A',colorLight:'#ffffff'});
    };
  }

  document.getElementById('btnTotpCheck').onclick=async function(){
    if(!currentPass()){toast('Escribe tu contraseña actual arriba primero.');return;}
    try{
      var r=await API.adminConfig.totpStatus(currentUser(),currentPass());
      if(r.enabled)renderTotpOn(r.otpauthUri,r.secret);else renderTotpOff();
    }catch(e){toast('Error: '+(e.message||'contraseña incorrecta'));}
  };

  async function startTotpSetup(){
    if(!currentPass()){toast('Escribe tu contraseña actual arriba primero.');return;}
    try{
      var r=await API.adminConfig.totpSetup(currentUser(),currentPass());
      totpBox.innerHTML='<p class="muted" style="font-size:12px;">Escanea este código con tu app de verificación:</p>'
        +'<div id="totpQr" style="background:#fff;padding:10px;border-radius:8px;display:inline-block;"></div>'
        +'<p class="muted" style="font-size:11.5px;margin:8px 0 4px;">¿No puedes escanear? Escribe esta clave manualmente:</p>'
        +'<code style="display:block;background:var(--bg-soft);padding:8px 10px;border-radius:6px;font-size:13px;letter-spacing:1px;word-break:break-all;">'+r.secret+'</code>'
        +'<div class="field" style="margin-top:14px;"><label>Código de 6 dígitos generado por tu app</label><input type="text" id="totpConfirmCode" inputmode="numeric" maxlength="6" placeholder="000000"></div>'
        +'<button class="btn btn-sm btn-primary" id="btnTotpConfirm">Confirmar y activar</button>'
        +'<button class="btn btn-sm" id="btnTotpCancelSetup" style="margin-left:6px;">Cancelar</button>';
      /* global QRCode */
      new QRCode(document.getElementById('totpQr'),{text:r.otpauthUri,width:180,height:180,colorDark:'#0A0A0A',colorLight:'#ffffff'});
      document.getElementById('btnTotpCancelSetup').onclick=renderTotpOff;
      document.getElementById('btnTotpConfirm').onclick=async function(){
        var code=document.getElementById('totpConfirmCode').value.trim();
        if(!/^\d{6}$/.test(code)){toast('Ingresa el código de 6 dígitos.');return;}
        try{
          await API.adminConfig.totpConfirm(currentUser(),currentPass(),r.secret,code);
          toast('✓ Verificación en dos pasos activada.');renderTotpOn();
        }catch(e){toast('Error: '+e.message);}
      };
    }catch(e){toast('Error: '+(e.message||'contraseña incorrecta'));}
  }
}

function logout(){
  destroyPlayerEngine(); stopHeartbeat(); stopPresenceHeartbeat(); stopMonitoringAutoRefresh(); stopAdsSmartPoll();
  _execStationStoresCache={};
  if(appState.session&&appState.session.role==='client'&&appState.session.username&&appState.isOnline){
    API.sessions.logout(appState.session.username,appState.session.sessionToken).catch(function(){});
  }
  appState.session=null;appState.library=[];appState.clients=[];
  appState.clientData=null;appState.clientAds=null;
  saveSession();go('/login');render();
}

/* ===== LOGIN ===== */
function renderLogin(error){
  return '<div class="topbar"><div class="brand"><img src="img/logo-ponmusic.png" alt="PonMusic" class="brand-logo"></div></div>'
  +'<div class="login-wrap"><div class="login-card">'
  +'<div class="login-visual login-visual-minimal">'
  +'<img src="img/logo-ponmusic.png" alt="PonMusic" class="login-visual-logo">'
  +'<h2>MÚSICA Y ANUNCIOS PARA TUS LOCALES</h2>'
  +'</div>'
  +'<div class="login-form-side">'
  +'<div class="login-tabs"><button id="tabClient" class="active">Cliente</button><button id="tabAdmin">Administrador</button></div>'
  +'<form id="loginForm">'
  +'<div class="field"><label>Usuario</label><input type="text" id="loginUser" autocomplete="username" required/></div>'
  +'<div class="field"><label>Contraseña</label><div class="pass-field-wrap">'
  +'<input type="password" id="loginPass" autocomplete="current-password" required/>'
  +'<button type="button" class="pass-toggle-btn" id="loginPassToggle" tabindex="-1" aria-label="Mostrar contraseña">👁</button>'
  +'</div></div>'
  +'<div class="field" id="loginTotpField" style="display:none;"><label>Código de verificación (6 dígitos)</label><input type="text" id="loginTotp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000">'
  +'<div style="display:flex;align-items:center;gap:6px;margin-top:8px;"><input type="checkbox" id="loginTrustDevice" checked style="width:auto;"><label for="loginTrustDevice" style="margin:0;text-transform:none;font-weight:400;font-size:12.5px;color:var(--ink-soft);">Confiar en este dispositivo por 30 días (no marcar en equipos compartidos)</label></div>'
  +'</div>'
  +'<button type="submit" class="btn btn-primary" style="width:100%" id="loginBtn">Ingresar</button>'
  +'<div id="loginErr" class="login-error">'+(error?escapeHtml(error):'')+'</div>'
  +'</form>'
  +'</div>'
  +'</div></div>';
}

/* ===== Desbloqueo de autoplay =====
   Los navegadores (sobre todo móviles/Safari) solo permiten reproducir audio
   con sonido si detectan una acción real del usuario justo antes. Como el login
   pasa por varios pasos asíncronos antes de empezar a reproducir, ese permiso
   se puede "perder" en el camino. Truco estándar: reproducir un clip silencioso
   en el mismo clic de "Ingresar" para dejar el elemento <audio> habilitado —
   así, cuando más adelante se asigna la canción real, el navegador ya lo permite. */
var SILENT_AUDIO_SRC='data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA/+MYxAAAAANIAAAAAExBTUUzLjk4LjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function unlockAudioForAutoplay(){
  try{
    var el=getOrCreateAudioEl();
    el.muted=false;
    el.src=SILENT_AUDIO_SRC;
    var p=el.play();
    if(p&&p.catch)p.catch(function(){});
  }catch(e){}
}

function bindLogin(){
  var mode='client';
  var tabClient=document.getElementById('tabClient'),tabAdmin=document.getElementById('tabAdmin');
  var passInput=document.getElementById('loginPass'),passToggle=document.getElementById('loginPassToggle');
  function resetPassVisibility(){
    if(!passInput||!passToggle)return;
    passInput.type='password';
    passToggle.textContent='👁';
    passToggle.setAttribute('aria-label','Mostrar contraseña');
  }
  tabClient.onclick=function(){
    mode='client';tabClient.classList.add('active');tabAdmin.classList.remove('active');
    if(passToggle)passToggle.style.display='';
  };
  tabAdmin.onclick=function(){
    mode='admin';tabAdmin.classList.add('active');tabClient.classList.remove('active');
    if(passToggle)passToggle.style.display='none'; // por seguridad, el admin no puede revelar su contraseña en pantalla
    resetPassVisibility();
  };
  if(passToggle){
    passToggle.onclick=function(){
      var showing=passInput.type==='text';
      passInput.type=showing?'password':'text';
      passToggle.textContent=showing?'👁':'🙈';
      passToggle.setAttribute('aria-label',showing?'Mostrar contraseña':'Ocultar contraseña');
    };
  }
  document.getElementById('loginForm').onsubmit=async function(e){
    e.preventDefault();
    unlockAudioForAutoplay(); // debe ejecutarse de forma síncrona, dentro del mismo clic
    var user=document.getElementById('loginUser').value.trim();
    var pass=document.getElementById('loginPass').value;
    var errBox=document.getElementById('loginErr');
    var btn=document.getElementById('loginBtn');
    btn.disabled=true;btn.textContent='Ingresando...';
    try{
      if(mode==='admin'){
        if(!appState.isOnline){
          if(errBox)errBox.textContent='El Administrador necesita conexión a internet para iniciar sesión.';
        }else{
          var totpField=document.getElementById('loginTotpField');
          var totpCode=document.getElementById('loginTotp').value.trim();
          var trustDevice=document.getElementById('loginTrustDevice')?document.getElementById('loginTrustDevice').checked:true;
          var savedTrustToken=localStorage.getItem('maa_admin_trust_token')||undefined;
          try{
            var result=await API.adminConfig.login(user,pass,totpCode||undefined,savedTrustToken,trustDevice);
            if(result&&result.needsTotp){
              totpField.style.display='';
              document.getElementById('loginTotp').focus();
              if(errBox)errBox.textContent='Ingresa el código de tu app de verificación.';
            }else{
              if(result&&result.trustToken)localStorage.setItem('maa_admin_trust_token',result.trustToken);
              appState.session={role:'admin',adminUsername:user};appState.library=[];appState.clients=[];
              saveSession();go('/admin/clients');render();
            }
          }catch(err){if(errBox)errBox.textContent=err.message||'Usuario o contraseña incorrectos.';}
        }
      }else{
        if(!appState.isOnline){
          // Login offline: verificar contra datos guardados localmente
          const savedClient=await OfflineDB.getConfig('clientInfo');
          if(savedClient&&savedClient.username===user&&savedClient.password===pass){
            if(savedClient.kind==='store'){
              appState.session={role:'client',kind:'store',store:savedClient.store,station:savedClient.station,client:savedClient.client,username:user,sessionToken:null};
              saveSession();startPresenceHeartbeat(); // solo las Tiendas se monitorean
            }else{
              appState.session={role:'client',kind:'exec',client:savedClient.client,stations:savedClient.stations||[],username:user,sessionToken:null};
              saveSession();
            }
            go('/client/player');render();
          }else{
            if(errBox)errBox.textContent='Sin conexión y no hay sesión guardada para este usuario.';
          }
        }else{
          try{
            // 1) Verificar credenciales como usuario del Negocio (ejecutivo)
            var execCred=null;
            try{execCred=await API.negocioUsers.login(user,pass);}catch(e){execCred=null;}

            if(execCred){
              // Las credenciales SÍ son correctas: de aquí en adelante, cualquier error
              // que ocurra es real (ej. problema de sesión) y se muestra tal cual —
              // no se disfraza como "usuario o contraseña incorrectos".
              var client=execCred.client;
              const stationList=await API.stations.list(client.id).catch(function(){return[];});
              const sessionResult=await API.sessions.login(user);
              await OfflineDB.setConfig('clientInfo',{username:user,password:pass,kind:'exec',client:client,stations:stationList});
              appState.session={role:'client',kind:'exec',client:client,stations:stationList,username:user,sessionToken:sessionResult.token};
              appState.library=[];appState.clientAds=null;
              saveSession();startHeartbeat(user,sessionResult.token);
              // El ejecutivo NO se monitorea en Monitoreo — solo interesa saber si la Tienda está conectada.
              go('/client/player');render();
            }else{
              // 2) No coincidió como ejecutivo -> probar como dependiente de una Tienda específica
              const{store,station,client:storeClient}=await API.stores.login(user,pass);
              const sessionResult2=await API.sessions.login(user);
              await OfflineDB.setConfig('clientInfo',{username:user,password:pass,kind:'store',store:store,station:station,client:storeClient});
              appState.session={role:'client',kind:'store',store:store,station:station,client:storeClient,username:user,sessionToken:sessionResult2.token};
              appState.library=[];appState.clientAds=null;
              saveSession();startHeartbeat(user,sessionResult2.token);
              startPresenceHeartbeat(); // aquí sí: es una Tienda, es lo que Monitoreo debe registrar
              go('/client/player');render();
            }
          }catch(err){if(errBox)errBox.textContent=err.message||'Usuario o contraseña incorrectos.';}
        }
      }
    }finally{
      if(document.getElementById('loginBtn')){btn.disabled=false;btn.textContent='Ingresar';}
    }
  };
}

/* ===== ADMIN SHELL ===== */
const ADMIN_STEPS=[
  {key:'clients',num:'A',label:'Clientes',route:'/admin/clients'},
  {key:'library',num:'B',label:'Biblioteca',route:'/admin/library'},
  {key:'categories',num:'C',label:'Estilos',route:'/admin/categories'},
  {key:'channels',num:'D',label:'Playlists',route:'/admin/channels'},
  {key:'classify',num:'E',label:'Clasificación',route:'/admin/classify'},
  {key:'clocks',num:'F',label:'Relojes Musicales',route:'/admin/clocks'},
  {key:'schedule',num:'G',label:'Programación',route:'/admin/schedule'},
  {key:'player',num:'H',label:'Reproductor',route:'/admin/player'},
  {key:'logs',num:'I',label:'Registros',route:'/admin/logs'},
  {key:'monitoring',num:'J',label:'Monitoreo',route:'/admin/monitoring'},
];

function renderAdminShell(route){
  var active=ADMIN_STEPS.find(function(s){return route.startsWith(s.route);})||ADMIN_STEPS[0];
  return '<div class="topbar"><div class="brand"><img src="img/logo-ponmusic.png" alt="PonMusic" class="brand-logo"></div>'
  +'<div class="brand-badges"><span class="bpill red">Panel Administrativo</span><span class="bpill yellow">Sistema Activo</span></div>'
  +'<div class="userbox"><span>Administrador: <b>'+escapeHtml((appState.session&&appState.session.adminUsername)||'admin')+'</b></span><button class="btn btn-sm" id="btnChangeCreds">🔑 Credenciales</button><button class="btn btn-sm" id="btnLogout">Cerrar sesión</button></div>'
  +'</div>'
  +'<div class="layout"><div class="sidebar">'
  +ADMIN_STEPS.map(function(s){return'<div class="step '+(s.key===active.key?'active':'')+'" data-go="'+s.route+'"><span class="num">'+s.num+'</span>'+s.label+'</div>';}).join('')
  +'</div><div class="main" id="adminMain"></div></div>';
}

async function bindAdminShell(route){
  document.getElementById('btnLogout').onclick=logout;
  document.getElementById('btnChangeCreds').onclick=openChangeCredsModal;
  document.querySelectorAll('.sidebar .step').forEach(function(el){el.onclick=function(){go(el.dataset.go);render();};});
  if(!_adminDataCache){
    try{var d=await API.clientData.get(getAdminDataKey(getAdminBrand()));_adminDataCache={categories:d.categories||[],classifications:d.classifications||[],clocks:d.clocks||[],channels:d.channels||[],schedule:d.schedule||[],playlistContent:d.playlistContent||[]};}
    catch(e){_adminDataCache={categories:[],classifications:[],clocks:[],channels:[],schedule:[],playlistContent:[]};}
  }
  var main=document.getElementById('adminMain');
  if(!route.startsWith('/admin/monitoring'))stopMonitoringAutoRefresh();
  if(route.startsWith('/admin/library')){main.innerHTML=renderAdminLibrary();bindAdminLibrary();}
  else if(route.startsWith('/admin/categories')){main.innerHTML=renderCategories(getAdminData());bindCategories(getAdminData(),true);}
  else if(route.startsWith('/admin/classify')){main.innerHTML=renderClassify(getAdminData());bindClassify(getAdminData(),true);}
  else if(route.startsWith('/admin/clocks')){main.innerHTML=renderClocks(getAdminData());bindClocks(getAdminData(),true);}
  else if(route.startsWith('/admin/channels')){main.innerHTML=renderChannels(getAdminData());bindChannels(getAdminData(),true);}
  else if(route.startsWith('/admin/schedule')){main.innerHTML=renderSchedule(getAdminData());bindSchedule(getAdminData(),true);}
  else if(route.startsWith('/admin/player')){main.innerHTML=renderAdminPlayer();bindAdminPlayer();}
  else if(route.startsWith('/admin/logs')){main.innerHTML=renderAdminLogs();bindAdminLogs();}
  else if(route.startsWith('/admin/monitoring')){main.innerHTML=renderAdminMonitoring();bindAdminMonitoring();}
  else{main.innerHTML=renderAdminClients();bindAdminClients();}
}

async function saveAdminData(){
  try{await API.clientData.save(getAdminDataKey(getAdminBrand()),_adminDataCache);}
  catch(e){toast('Sin conexión — cambios guardados localmente.');await OfflineDB.setConfig('adminData',_adminDataCache);}
}

/* ===== ADMIN CLIENTS ===== */
function renderAdminClients(){
  var rows=appState.clients.map(function(c){
    return'<tr><td><b>'+escapeHtml(c.business_name)+'</b><br><span class="muted">'+escapeHtml(c.username)+'</span></td>'
    +'<td><span class="badge '+c.status+'">'+capitalize(c.status)+'</span></td>'
    +'<td>'+formatDate(c.created_at)+'</td>'
    +'<td style="white-space:nowrap;">'
    +'<button class="btn btn-sm" data-edit="'+c.id+'">Editar</button>'
    +(c.status!=='activa'?'<button class="btn btn-sm" data-activate="'+c.id+'">Activar</button>':'<button class="btn btn-sm" data-suspend="'+c.id+'">Suspender</button>')
    +(c.status!=='bloqueada'?'<button class="btn btn-sm" data-block="'+c.id+'">Bloquear</button>':'')
    +'<button class="btn btn-sm btn-danger" data-del="'+c.id+'">Eliminar</button>'
    +'</td></tr>';
  }).join('');
  return'<div class="flex-between"><div><h1>Clientes</h1><p class="subtitle">Gestiona las cuentas SaaS.</p></div>'
  +'<button class="btn btn-primary" id="btnNewClient">+ Nuevo cliente</button></div>'
  +'<div class="panel">'+(appState.clients.length===0?'<div class="empty">Aún no hay clientes.</div>'
  +'':'<table><thead><tr><th>Negocio</th><th>Estado</th><th>Creado</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table>')
  +'</div><div id="clientModalRoot"></div>';
}

function bindAdminClients(){
  document.getElementById('btnNewClient').onclick=function(){openClientModal(null);};
  document.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){openClientModal(b.dataset.edit);};});
  document.querySelectorAll('[data-activate]').forEach(function(b){b.onclick=function(){setClientStatus(b.dataset.activate,'activa');};});
  document.querySelectorAll('[data-suspend]').forEach(function(b){b.onclick=function(){setClientStatus(b.dataset.suspend,'suspendida');};});
  document.querySelectorAll('[data-block]').forEach(function(b){b.onclick=function(){setClientStatus(b.dataset.block,'bloqueada');};});
  document.querySelectorAll('[data-del]').forEach(function(b){b.onclick=async function(){
    if(!confirm('¿Eliminar esta cuenta?'))return;
    try{await API.clients.remove(b.dataset.del);appState.clients=appState.clients.filter(function(c){return c.id!==b.dataset.del;});render();}
    catch(e){toast('Error: '+e.message);}
  };});
}

async function setClientStatus(id,status){
  try{await API.clients.update(id,{status:status});var c=appState.clients.find(function(c){return c.id===id;});if(c)c.status=status;render();toast('Estado actualizado.');}
  catch(e){toast('Error: '+e.message);}
}

/* ===== Monitoreo de conexión (online, dispositivos, última actividad) ===== */
function timeAgo(iso){
  var diffMs=Date.now()-new Date(iso).getTime();
  var mins=Math.floor(diffMs/60000);
  if(mins<1)return'hace unos segundos';
  if(mins===1)return'hace 1 minuto';
  if(mins<60)return'hace '+mins+' minutos';
  var hrs=Math.floor(mins/60);
  if(hrs===1)return'hace 1 hora';
  if(hrs<24)return'hace '+hrs+' horas';
  var days=Math.floor(hrs/24);
  return days===1?'hace 1 día':'hace '+days+' días';
}

function openClientModal(id){
  var editing=id?appState.clients.find(function(c){return c.id===id;}):null;
  var adminData=getAdminData();
  var pendingLogoData=editing?(editing.logo_data||null):null;
  var root=document.getElementById('clientModalRoot');
  root.innerHTML='<div class="modal-bg"><div class="modal" style="max-height:88vh;overflow-y:auto;"><h3>'+(editing?'Editar negocio':'Nuevo negocio')+'</h3>'
  +'<div class="field" style="display:flex;gap:14px;align-items:center;">'
  +'<div class="client-logo-preview" id="mLogoPreview" title="Subir logo (.jpg)" style="margin:0;flex-shrink:0;">'
  +(pendingLogoData?'<img src="'+pendingLogoData+'" alt="Logo">':'<span class="logo-plus">+</span>')
  +'</div>'
  +'<div><label style="margin-bottom:2px;">Logotipo del Negocio (.jpg)</label><div class="muted" style="font-size:11.5px;">Clic en el recuadro para subir/cambiar.</div>'
  +'<input type="file" id="mLogoInput" accept="image/jpeg,.jpg,.jpeg" style="display:none"></div>'
  +'</div>'
  +'<div class="field"><label>Nombre del negocio</label><input id="mBiz" type="text" value="'+(editing?escapeHtml(editing.business_name):'')+'"></div>'
  +'<div class="field"><label>Vencimiento</label><input id="mExp" type="date" value="'+(editing&&editing.expires_at?editing.expires_at.slice(0,10):'')+'"></div>'
  +'<div class="modal-actions" style="margin-bottom:4px;"><button class="btn" id="mCancel">Cerrar</button><button class="btn btn-primary" id="mSave">'+(editing?'Guardar datos del negocio':'Crear negocio')+'</button></div>'
  +'<div class="section-title" style="margin-top:16px;">Usuarios del negocio (hasta 5, mismo acceso)</div>'
  +'<p class="muted" style="font-size:11.5px;margin:-6px 0 10px;">Todos ven y administran lo mismo — sirve para que varias personas puedan estar conectadas a la vez, sin chocar con la regla de "un usuario, un dispositivo".</p>'
  +renderNegocioUsersPlaceholder(editing)
  +'<div class="section-title" style="margin-top:20px;">Estaciones y sus Tiendas</div>'
  +'<p class="muted" style="font-size:11.5px;margin:-6px 0 10px;">La Estación es solo una agrupación (sin login propio). El usuario/contraseña y el Playlist se configuran dentro de cada Tienda.</p>'
  +renderStationsSectionPlaceholder(editing)
  +'</div></div>';
  _editingStationId=null;_editingNegocioUserId=null;_pendingStationLogo=null;
  if(editing){
    loadNegocioUsersSection(editing.id);
    loadStationsSection(editing.id,adminData);
  }
  var mLogoPreview=document.getElementById('mLogoPreview'),mLogoInput=document.getElementById('mLogoInput');
  mLogoPreview.onclick=function(){mLogoInput.click();};
  mLogoInput.onchange=function(){
    var file=mLogoInput.files[0];mLogoInput.value='';
    if(!file)return;
    var isJpg=/\.jpe?g$/i.test(file.name)||file.type==='image/jpeg';
    if(!isJpg){toast('Solo se permiten archivos .jpg');return;}
    resizeImageToDataUrl(file,320,0.82,function(dataUrl){
      pendingLogoData=dataUrl;
      mLogoPreview.innerHTML='<img src="'+dataUrl+'" alt="Logo">';
    });
  };
  document.getElementById('mCancel').onclick=function(){root.innerHTML='';render();};
  document.getElementById('mSave').onclick=async function(){
    var biz=document.getElementById('mBiz').value.trim();
    var exp=document.getElementById('mExp').value;
    if(!biz){toast('Ponle un nombre al negocio.');return;}
    try{
      if(editing){
        var updated=await API.clients.update(editing.id,{business_name:biz,expires_at:exp||null,logo_data:pendingLogoData});
        var idx=appState.clients.findIndex(function(c){return c.id===editing.id;});if(idx>=0)appState.clients[idx]=updated;
        toast('✓ Datos del negocio actualizados.'); // el modal queda abierto para seguir editando usuarios/estaciones
      }else{
        var nc=await API.clients.add({id:uid('cli'),business_name:biz,status:'activa',expires_at:exp||null,logo_data:pendingLogoData,brand:getAdminBrand()});
        appState.clients.push(nc);
        toast('✓ Negocio creado. Ábrelo de nuevo con "Editar" para agregarle usuarios y estaciones.');
        root.innerHTML='';render();
      }
    }catch(e){toast('Error: '+e.message);}
  };
}

/* ===== Usuarios del Negocio (hasta 5, mismo nivel de acceso) ===== */
function renderNegocioUsersPlaceholder(editing){
  if(!editing)return'<div class="muted" style="font-size:12px;margin:4px 0 14px;">Primero crea el negocio; luego ábrelo de nuevo con "Editar" para agregarle usuarios.</div>';
  return'<div class="field" id="negocioUsersSection"><div class="muted" style="font-size:12px;">Cargando usuarios...</div></div>';
}

var _editingNegocioUserId=null;
async function loadNegocioUsersSection(clientId){
  var box=document.getElementById('negocioUsersSection');
  if(!box)return;
  try{
    var userList=await API.negocioUsers.list(clientId);
    if(!box.isConnected)return;
    renderNegocioUsersList(box,clientId,userList);
  }catch(e){
    if(box.isConnected)box.innerHTML='<div class="muted">Error cargando usuarios: '+escapeHtml(e.message)+'</div>';
  }
}

function renderNegocioUsersList(box,clientId,userList){
  var rows=userList.map(function(u){
    return'<tr data-nurow="'+u.id+'" style="cursor:pointer;" title="Clic para editar"><td><b>'+escapeHtml(u.username||'—')+'</b></td>'
    +'<td><button class="btn btn-sm btn-danger" data-delnu="'+u.id+'">Eliminar</button></td></tr>';
  }).join('');
  var atMax=userList.length>=5;
  box.innerHTML=(userList.length?'<table style="margin-bottom:12px;"><thead><tr><th>Usuario</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="muted" style="margin-bottom:10px;">Aún no hay usuarios.</div>')
  +'<div id="nuFormTitle" class="muted" style="font-size:11.5px;margin-bottom:6px;">'+(atMax?'Máximo de 5 usuarios alcanzado — elimina uno para poder agregar otro.':'Nuevo usuario:')+'</div>'
  +(atMax?'':'<div class="row" style="align-items:flex-end;">'
    +'<div class="field" style="margin-bottom:0;"><label>Usuario</label><input type="text" id="newNuUser"></div>'
    +'<div class="field" style="margin-bottom:0;"><label>Contraseña</label><input type="text" id="newNuPass"></div>'
    +'<button class="btn btn-primary" type="button" id="btnAddNu" style="flex:0 0 auto;">+ Agregar</button>'
    +'<button class="btn" type="button" id="btnCancelNuEdit" style="flex:0 0 auto;display:none;">Cancelar</button>'
    +'</div>');

  document.querySelectorAll('[data-nurow]').forEach(function(tr){
    tr.addEventListener('click',function(e){
      if(e.target.closest('[data-delnu]'))return;
      var u=userList.find(function(x){return x.id===tr.dataset.nurow;});
      if(!u)return;
      _editingNegocioUserId=u.id;
      var uEl=document.getElementById('newNuUser'),pEl=document.getElementById('newNuPass');
      if(uEl)uEl.value=u.username||'';
      if(pEl)pEl.value=u.password||'';
      var t=document.getElementById('nuFormTitle');if(t)t.textContent='Editando: '+(u.username||'')+':';
      var b=document.getElementById('btnAddNu');if(b)b.textContent='💾 Guardar';
      var c=document.getElementById('btnCancelNuEdit');if(c)c.style.display='';
    });
  });
  var cancelBtn=document.getElementById('btnCancelNuEdit');
  if(cancelBtn)cancelBtn.onclick=function(){_editingNegocioUserId=null;loadNegocioUsersSection(clientId);};
  document.querySelectorAll('[data-delnu]').forEach(function(b){
    b.onclick=async function(){
      if(!confirm('¿Eliminar este usuario?'))return;
      try{await API.negocioUsers.remove(b.dataset.delnu);toast('Usuario eliminado.');_editingNegocioUserId=null;loadNegocioUsersSection(clientId);}
      catch(e){toast('Error: '+e.message);}
    };
  });
  var btnAdd=document.getElementById('btnAddNu');
  if(btnAdd)btnAdd.onclick=async function(){
    var user=document.getElementById('newNuUser').value.trim();
    var pass=document.getElementById('newNuPass').value;
    if(!user||!pass){toast('Completa usuario y contraseña.');return;}
    try{
      if(_editingNegocioUserId){
        await API.negocioUsers.update(_editingNegocioUserId,{username:user,password:pass});
        toast('✓ Usuario actualizado.');
      }else{
        await API.negocioUsers.add({id:uid('nu'),client_id:clientId,username:user,password:pass});
        toast('✓ Usuario agregado.');
      }
      _editingNegocioUserId=null;
      loadNegocioUsersSection(clientId);
    }catch(e){toast('Error: '+e.message+(e.message.indexOf('máximo')>-1?'':''));}
  };
}

/* ===== Estaciones (agrupación, sin login propio) — y sus Tiendas anidadas ===== */
function renderStationsSectionPlaceholder(editing){
  if(!editing)return'<div class="muted" style="font-size:12px;margin:4px 0 14px;">Primero crea el negocio; luego ábrelo de nuevo con "Editar" para agregarle estaciones.</div>';
  return'<div class="field" id="stationsSection"><div class="muted" style="font-size:12px;">Cargando estaciones...</div></div>';
}

var _editingStationId=null,_pendingStationLogo=null;
async function loadStationsSection(clientId,adminData){
  var box=document.getElementById('stationsSection');
  if(!box)return;
  try{
    var stationList=await API.stations.list(clientId);
    if(!box.isConnected)return;
    renderStationsList(box,clientId,adminData,stationList);
  }catch(e){
    if(box.isConnected)box.innerHTML='<div class="muted">Error cargando estaciones: '+escapeHtml(e.message)+'</div>';
  }
}

function renderStationsList(box,clientId,adminData,stationList){
  var rows=stationList.map(function(st){
    return'<tr data-strow="'+st.id+'">'
    +'<td style="cursor:pointer;" data-expandst="'+st.id+'"><b>'+escapeHtml(st.name||'—')+'</b> <span class="muted">▾ Ver tiendas</span></td>'
    +'<td style="white-space:nowrap;"><button class="btn btn-sm" data-editst="'+st.id+'">Editar</button><button class="btn btn-sm btn-danger" data-delst="'+st.id+'">Eliminar</button></td></tr>'
    +'<tr data-stdetail="'+st.id+'" style="display:none;"><td colspan="2" style="background:var(--bg-soft);padding:12px;border-radius:8px;"><div id="storesWrapFor_'+st.id+'"></div></td></tr>';
  }).join('');
  box.innerHTML=(stationList.length?'<table style="margin-bottom:12px;"><thead><tr><th>Estación</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="muted" style="margin-bottom:10px;">Aún no hay estaciones creadas.</div>')
  +'<div id="stFormTitle" class="muted" style="font-size:11.5px;margin-bottom:6px;">Nueva estación:</div>'
  +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">'
  +'<div class="client-logo-preview" id="stLogoPreview" title="Subir logo (.jpg)" style="margin:0;width:52px;height:52px;flex-shrink:0;">'
  +(_pendingStationLogo?'<img src="'+_pendingStationLogo+'" alt="Logo">':'<span class="logo-plus" style="font-size:18px;">+</span>')
  +'</div>'
  +'<input type="file" id="newStLogoInput" accept="image/jpeg,.jpg,.jpeg" style="display:none">'
  +'<div class="field" style="margin-bottom:0;flex:1;"><label>Nombre</label><input type="text" id="newStName" placeholder="Estación Norte"></div>'
  +'</div>'
  +'<div class="row" style="align-items:flex-end;">'
  +'<button class="btn btn-primary" type="button" id="btnAddStation" style="flex:0 0 auto;">+ Agregar estación</button>'
  +'<button class="btn" type="button" id="btnCancelStationEdit" style="flex:0 0 auto;display:none;">Cancelar edición</button>'
  +'</div>';

  function resetStationForm(){
    _editingStationId=null;_pendingStationLogo=null;
    loadStationsSection(clientId,adminData);
  }

  var logoPrev=document.getElementById('stLogoPreview'),logoInput=document.getElementById('newStLogoInput');
  logoPrev.onclick=function(){logoInput.click();};
  logoInput.onchange=function(){
    var file=logoInput.files[0];logoInput.value='';
    if(!file)return;
    var isJpg=/\.jpe?g$/i.test(file.name)||file.type==='image/jpeg';
    if(!isJpg){toast('Solo se permiten archivos .jpg');return;}
    resizeImageToDataUrl(file,240,0.82,function(dataUrl){
      _pendingStationLogo=dataUrl;
      logoPrev.innerHTML='<img src="'+dataUrl+'" alt="Logo">';
    });
  };

  document.querySelectorAll('[data-expandst]').forEach(function(td){
    td.onclick=function(){
      var stId=td.dataset.expandst;
      var detailRow=document.querySelector('tr[data-stdetail="'+stId+'"]');
      if(!detailRow)return;
      var isOpen=detailRow.style.display!=='none';
      document.querySelectorAll('tr[data-stdetail]').forEach(function(r){r.style.display='none';});
      if(!isOpen){
        detailRow.style.display='';
        var wrap=document.getElementById('storesWrapFor_'+stId);
        if(wrap)loadStoresSectionForStation(stId,clientId,adminData,wrap);
      }
    };
  });

  document.querySelectorAll('[data-editst]').forEach(function(b){
    b.onclick=function(){
      var st=stationList.find(function(x){return x.id===b.dataset.editst;});
      if(!st)return;
      _editingStationId=st.id;_pendingStationLogo=st.logo_data||null;
      document.getElementById('newStName').value=st.name||'';
      logoPrev.innerHTML=_pendingStationLogo?'<img src="'+_pendingStationLogo+'" alt="Logo">':'<span class="logo-plus" style="font-size:18px;">+</span>';
      document.getElementById('stFormTitle').textContent='Editando: '+(st.name||'')+':';
      document.getElementById('btnAddStation').textContent='💾 Guardar estación';
      document.getElementById('btnCancelStationEdit').style.display='';
    };
  });
  document.getElementById('btnCancelStationEdit').onclick=resetStationForm;

  document.querySelectorAll('[data-delst]').forEach(function(b){
    b.onclick=async function(){
      if(!confirm('¿Eliminar esta estación? Se eliminarán también todas sus tiendas.'))return;
      try{await API.stations.remove(b.dataset.delst);toast('Estación eliminada.');_editingStationId=null;loadStationsSection(clientId,adminData);}
      catch(e){toast('Error: '+e.message);}
    };
  });

  document.getElementById('btnAddStation').onclick=async function(){
    var name=document.getElementById('newStName').value.trim();
    if(!name){toast('Ponle un nombre a la estación.');return;}
    try{
      if(_editingStationId){
        await API.stations.update(_editingStationId,{name:name,logo_data:_pendingStationLogo});
        toast('✓ Estación actualizada.');
      }else{
        await API.stations.add({id:uid('station'),client_id:clientId,name:name,logo_data:_pendingStationLogo});
        toast('✓ Estación agregada.');
      }
      _editingStationId=null;_pendingStationLogo=null;
      loadStationsSection(clientId,adminData);
    }catch(e){toast('Error: '+e.message);}
  };
}

/* Tiendas dentro de UNA estación específica (versión anidada, con ids únicos por estación) */
async function loadStoresSectionForStation(stationId,clientId,adminData,wrapEl){
  wrapEl.innerHTML='<div class="muted" style="font-size:12px;">Cargando tiendas...</div>';
  try{
    var storeList=await API.stores.list(stationId);
    renderStoresListForStation(wrapEl,stationId,clientId,adminData,storeList);
  }catch(e){
    wrapEl.innerHTML='<div class="muted">Error cargando tiendas: '+escapeHtml(e.message)+'</div>';
  }
}

function renderStoresListForStation(wrapEl,stationId,clientId,adminData,storeList){
  var chanOpts=adminData.channels.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  var zoneSuggestions=Array.from(new Set(storeList.map(function(s){return s.zone;}).filter(Boolean))).sort();
  var zoneOptionsHtml=zoneSuggestions.map(function(z){return'<option value="'+escapeHtml(z)+'">';}).join('');
  var rows=storeList.map(function(s){
    var chan=adminData.channels.find(function(c){return c.id===s.channel_id;});
    var groupZone=(s.group_name?escapeHtml(s.group_name):'—')+(s.zone?' · '+escapeHtml(s.zone):'');
    return'<tr data-storerow="'+s.id+'" style="cursor:pointer;'+(s.inactive?'opacity:.55;':'')+'" title="Clic para ver/editar todos sus datos">'
    +'<td><b>'+escapeHtml(s.name||'—')+'</b>'+(s.inactive?' <span class="badge suspendida">Inactiva</span>':'')+'</td><td>'+escapeHtml(chan?chan.name:'Sin playlist')+'</td><td>'+escapeHtml(s.username||'—')+'</td>'
    +'<td class="muted" style="font-size:12px;">'+groupZone+'</td>'
    +'<td>'+(s.only_player?'<span class="badge suspendida">Solo Reproductor</span>':'<span class="badge activa">+ Descargas</span>')+'</td>'
    +'<td><button class="btn btn-sm btn-danger" data-delstore="'+s.id+'">Eliminar</button></td></tr>';
  }).join('');
  wrapEl.innerHTML=(storeList.length?'<table style="margin-bottom:12px;"><thead><tr><th>Nombre</th><th>Playlist</th><th>Usuario</th><th>Región · Zona</th><th>Funciones</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="muted" style="margin-bottom:10px;">Aún no hay tiendas en esta estación.</div>')
  +'<div class="muted" style="font-size:11.5px;margin-bottom:6px;" data-stformtitle>Nueva tienda:</div>'
  +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">'
  +'<div class="client-logo-preview" data-storelogopreview title="Subir logo (.jpg)" style="margin:0;width:44px;height:44px;flex-shrink:0;"><span class="logo-plus" style="font-size:16px;">+</span></div>'
  +'<input type="file" data-storelogoinput accept="image/jpeg,.jpg,.jpeg" style="display:none">'
  +'<span class="muted" style="font-size:11px;">Logo de la tienda (opcional)</span>'
  +'</div>'
  +'<div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;"><label>Nombre</label><input type="text" data-newname placeholder="Tienda A"></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Playlist</label><select data-newchannel><option value="">Sin playlist</option>'+chanOpts+'</select></div>'
  +'</div>'
  +'<div class="row" style="align-items:flex-end;margin-top:8px;">'
  +'<div class="field" style="margin-bottom:0;"><label>Usuario</label><input type="text" data-newuser></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Contraseña</label><input type="text" data-newpass></div>'
  +'</div>'
  +'<div class="row" style="align-items:flex-end;margin-top:8px;">'
  +'<div class="field" style="margin-bottom:0;"><label>Región</label><select data-newgroup><option value="">Sin región</option><option value="Lima">Lima</option><option value="Provincias">Provincias</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Zona</label><input type="text" data-newzone list="storeZoneSuggestions" placeholder="Ej: San Isidro"><datalist id="storeZoneSuggestions">'+zoneOptionsHtml+'</datalist></div>'
  +'</div>'
  +'<p class="muted" style="font-size:11px;margin:-4px 0 8px;">Región y Zona se usan para filtrar el Monitoreo por región de tiendas (ej. todas las de Lima, o solo una Zona).</p>'
  +'<div class="row" style="align-items:flex-end;margin-top:8px;">'
  +'<div class="field" style="margin-bottom:0;"><label>Horario de operación desde</label><input type="time" data-neworapstart></div>'
  +'<div class="field" style="margin-bottom:0;"><label>hasta</label><input type="time" data-neworapend></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Zona horaria de la tienda</label><select data-newtimezone>'
  +'<option value="America/Lima">Perú — Lima (UTC-5)</option>'
  +'<option value="America/Costa_Rica">Costa Rica (UTC-6)</option>'
  +'<option value="America/New_York">USA — Este / Nueva York (cambia con horario de verano)</option>'
  +'<option value="America/Chicago">USA — Central / Chicago (cambia con horario de verano)</option>'
  +'<option value="America/Denver">USA — Montaña / Denver (cambia con horario de verano)</option>'
  +'<option value="America/Los_Angeles">USA — Pacífico / Los Ángeles (cambia con horario de verano)</option>'
  +'</select></div>'
  +'</div>'
  +'<p class="muted" style="font-size:11px;margin:-4px 0 8px;">El horario "desde/hasta" se interpreta en la hora local de la tienda (según la zona horaria elegida). Deja ambos vacíos para 24 horas (por defecto). Se usa para que el informe de Monitoreo no "castigue" caídas fuera de este horario.</p>'
  +'<div class="field" style="display:flex;align-items:center;gap:8px;background:#fff;padding:10px 12px;border-radius:8px;margin-top:8px;">'
  +'<input type="checkbox" data-newonlyplayer style="width:auto;">'
  +'<label style="margin:0;text-transform:none;font-weight:600;color:var(--ink);">Solo Reproductor (sin acceso a "Mis Descargas")</label>'
  +'</div>'
  +'<div class="field" style="display:flex;align-items:center;gap:8px;background:#fff;padding:10px 12px;border-radius:8px;margin-top:8px;">'
  +'<input type="checkbox" data-newinactive style="width:auto;">'
  +'<label style="margin:0;text-transform:none;font-weight:600;color:var(--ink);">Inactiva (la tienda queda creada pero sin funcionamiento: no reproduce, no genera Monitoreo, y no puede iniciar sesión)</label>'
  +'</div>'
  +'<div class="row" style="align-items:flex-end;margin-top:8px;">'
  +'<button class="btn btn-primary" type="button" data-btnaddstore style="flex:0 0 auto;">+ Agregar tienda</button>'
  +'<button class="btn" type="button" data-btncancelstore style="flex:0 0 auto;display:none;">Cancelar edición</button>'
  +'</div>';

  var editingStoreId=null,pendingStoreLogo=null;
  function resetForm(){loadStoresSectionForStation(stationId,clientId,adminData,wrapEl);}

  var logoPrev=wrapEl.querySelector('[data-storelogopreview]'),logoInput=wrapEl.querySelector('[data-storelogoinput]');
  logoPrev.onclick=function(){logoInput.click();};
  logoInput.onchange=function(){
    var file=logoInput.files[0];logoInput.value='';
    if(!file)return;
    var isJpg=/\.jpe?g$/i.test(file.name)||file.type==='image/jpeg';
    if(!isJpg){toast('Solo se permiten archivos .jpg');return;}
    resizeImageToDataUrl(file,200,0.82,function(dataUrl){
      pendingStoreLogo=dataUrl;
      logoPrev.innerHTML='<img src="'+dataUrl+'" alt="Logo">';
    });
  };

  wrapEl.querySelectorAll('[data-storerow]').forEach(function(tr){
    tr.addEventListener('click',function(e){
      if(e.target.closest('[data-delstore]'))return;
      var s=storeList.find(function(x){return x.id===tr.dataset.storerow;});
      if(!s)return;
      editingStoreId=s.id;pendingStoreLogo=s.logo_data||null;
      wrapEl.querySelector('[data-newname]').value=s.name||'';
      wrapEl.querySelector('[data-newchannel]').value=s.channel_id||'';
      wrapEl.querySelector('[data-newuser]').value=s.username||'';
      wrapEl.querySelector('[data-newpass]').value=s.password||'';
      wrapEl.querySelector('[data-newonlyplayer]').checked=!!s.only_player;
      wrapEl.querySelector('[data-newinactive]').checked=!!s.inactive;
      wrapEl.querySelector('[data-neworapstart]').value=s.oper_start||'';
      wrapEl.querySelector('[data-neworapend]').value=s.oper_end||'';
      wrapEl.querySelector('[data-newtimezone]').value=s.timezone||'America/Lima';
      wrapEl.querySelector('[data-newgroup]').value=s.group_name||'';
      wrapEl.querySelector('[data-newzone]').value=s.zone||'';
      logoPrev.innerHTML=pendingStoreLogo?'<img src="'+pendingStoreLogo+'" alt="Logo">':'<span class="logo-plus" style="font-size:16px;">+</span>';
      wrapEl.querySelector('[data-stformtitle]').textContent='Editando: '+(s.name||'tienda')+':';
      wrapEl.querySelector('[data-btnaddstore]').textContent='💾 Guardar tienda';
      wrapEl.querySelector('[data-btncancelstore]').style.display='';
    });
  });

  wrapEl.querySelector('[data-btncancelstore]').onclick=resetForm;

  wrapEl.querySelectorAll('[data-delstore]').forEach(function(b){
    b.onclick=async function(){
      if(!confirm('¿Eliminar esta tienda? El dependiente ya no podrá entrar.'))return;
      try{await API.stores.remove(b.dataset.delstore);toast('Tienda eliminada.');loadStoresSectionForStation(stationId,clientId,adminData,wrapEl);}
      catch(e){toast('Error: '+e.message);}
    };
  });

  wrapEl.querySelector('[data-btnaddstore]').onclick=async function(){
    var name=wrapEl.querySelector('[data-newname]').value.trim();
    var channelId=wrapEl.querySelector('[data-newchannel]').value||null;
    var user=wrapEl.querySelector('[data-newuser]').value.trim();
    var pass=wrapEl.querySelector('[data-newpass]').value;
    var onlyPlayer=wrapEl.querySelector('[data-newonlyplayer]').checked;
    var inactiveFlag=wrapEl.querySelector('[data-newinactive]').checked;
    var operStart=wrapEl.querySelector('[data-neworapstart]').value||null;
    var operEnd=wrapEl.querySelector('[data-neworapend]').value||null;
    var timezone=wrapEl.querySelector('[data-newtimezone]').value||'America/Lima';
    var groupName=wrapEl.querySelector('[data-newgroup]').value||null;
    var zone=wrapEl.querySelector('[data-newzone]').value.trim()||null;
    if((operStart&&!operEnd)||(!operStart&&operEnd)){toast('Completa "desde" y "hasta" del horario, o deja ambos vacíos.');return;}
    if(!name||!user||!pass){toast('Completa nombre, usuario y contraseña de la tienda.');return;}
    var chan=channelId?adminData.channels.find(function(c){return c.id===channelId;}):null;
    try{
      if(editingStoreId){
        await API.stores.update(editingStoreId,{name:name,channel_id:channelId,channel_name:chan?chan.name:null,username:user,password:pass,only_player:onlyPlayer,inactive:inactiveFlag,logo_data:pendingStoreLogo,oper_start:operStart,oper_end:operEnd,timezone:timezone,group_name:groupName,zone:zone});
        toast('✓ Tienda actualizada.');
      }else{
        await API.stores.add({id:uid('store'),station_id:stationId,client_id:clientId,name:name,channel_id:channelId,channel_name:chan?chan.name:null,username:user,password:pass,only_player:onlyPlayer,inactive:inactiveFlag,logo_data:pendingStoreLogo,oper_start:operStart,oper_end:operEnd,timezone:timezone,group_name:groupName,zone:zone});
        toast('✓ Tienda agregada.');
      }
      editingStoreId=null;pendingStoreLogo=null;
      loadStoresSectionForStation(stationId,clientId,adminData,wrapEl);
    }catch(e){toast('Error: '+e.message);}
  };
}

/* Redimensiona una imagen a un data URL JPEG liviano (evita guardar fotos pesadas) */
function resizeImageToDataUrl(file,maxDim,quality,cb){
  var reader=new FileReader();
  reader.onload=function(){
    var img=new Image();
    img.onload=function(){
      var w=img.width,h=img.height;
      if(w>h){if(w>maxDim){h=Math.round(h*maxDim/w);w=maxDim;}}
      else{if(h>maxDim){w=Math.round(w*maxDim/h);h=maxDim;}}
      var canvas=document.createElement('canvas');
      canvas.width=w;canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      cb(canvas.toDataURL('image/jpeg',quality));
    };
    img.src=reader.result;
  };
  reader.readAsDataURL(file);
}

/* ===== ADMIN LIBRARY ===== */
/* Tabla con orden al clic en el encabezado (como el Explorador de archivos).
   columns: [{key,label}]; data: array de objetos; rowRenderFn: function(item)->html <tr>.
   Vuelve a pintar solo esa tabla (no toda la página) cada vez que se cambia el orden. */
function makeSortableTable(containerId,columns,data,rowRenderFn,initialSortKey,afterRenderFn){
  var sortKey=initialSortKey||columns[0].key,sortDir=1;
  function render(){
    var sorted=data.slice().sort(function(a,b){
      var av=a[sortKey],bv=b[sortKey];
      if(typeof av==='number'&&typeof bv==='number')return(av-bv)*sortDir;
      return String(av==null?'':av).localeCompare(String(bv==null?'':bv),'es',{numeric:true})*sortDir;
    });
    var thead='<tr>'+columns.map(function(c){
      var arrow=c.key===sortKey?(sortDir===1?' ▲':' ▼'):'';
      return'<th data-sortcol="'+c.key+'" style="cursor:pointer;user-select:none;white-space:nowrap;">'+escapeHtml(c.label)+arrow+'</th>';
    }).join('')+'</tr>';
    var tbody=sorted.map(rowRenderFn).join('');
    var el=document.getElementById(containerId);
    if(!el)return;
    el.innerHTML=(sorted.length===0?'<div class="empty">Sin datos.</div>':'<table><thead>'+thead+'</thead><tbody>'+tbody+'</tbody></table>');
    el.querySelectorAll('[data-sortcol]').forEach(function(th){
      th.onclick=function(){
        var key=th.dataset.sortcol;
        if(key===sortKey)sortDir*=-1;else{sortKey=key;sortDir=1;}
        render();
      };
    });
    if(afterRenderFn)afterRenderFn();
  }
  render();
}

function formatShortDate(iso){
  try{return new Date(iso).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});}
  catch(e){return'—';}
}

function renderAdminLibrary(){
  var needsBackfill=appState.library.filter(function(m){return!m.genre||!m.composer;}).length;
  return'<h1>Biblioteca Musical Global</h1>'
  +'<p class="subtitle">Repositorio final de todo el audio en bruto · <b>'+appState.library.length+' archivo(s) en total</b>. Este es solo el gran almacén — para subir archivos nuevos, hazlo desde la sección Estilos.</p>'
  +(needsBackfill>0?'<div class="panel"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
    +'<button class="btn" id="btnBackfillGenre">🎨 Completar Estilo/Compositores de '+needsBackfill+' archivo(s)</button>'
    +'<span class="muted" style="font-size:12px;">Relee el tag ID3 real de cada mp3 en R2 y guarda su Estilo (género) y Compositores si los trae.</span>'
    +'</div></div>':'')
  +'<div class="panel" style="margin-top:18px;" id="libraryTableWrap">'+renderLibraryTable(true)+'</div>'
  +'<div id="editMetaRoot"></div>';
}

/* Relee el tag ID3 real (desde el mp3 ya alojado en R2) de todos los archivos que
   todavía no tienen Estilo y/o Compositores guardados, y completa lo que falte. */
async function backfillGenreFromId3(){
  var targets=appState.library.filter(function(m){return(!m.genre||!m.composer)&&m.url;});
  if(targets.length===0){toast('No hay archivos pendientes.');return;}
  if(!window.jsmediatags){toast('El lector de metadata no cargó. Recarga la página.');return;}
  var btn=document.getElementById('btnBackfillGenre');
  if(btn)btn.disabled=true;
  var done=0,found=0;
  for(var i=0;i<targets.length;i++){
    var m=targets[i];
    if(btn)btn.textContent='Actualizando... ('+(i+1)+'/'+targets.length+')';
    try{
      var tag=await new Promise(function(resolve){
        window.jsmediatags.read(m.url,{onSuccess:resolve,onError:function(){resolve(null);}});
      });
      var t=(tag&&tag.tags)||{};
      var data={};
      if(!m.genre&&t.genre&&String(t.genre).trim())data.genre=String(t.genre).trim();
      var composerRaw=t.composer||(t.TCOM&&t.TCOM.data)||''; // jsmediatags no da atajo .composer
      if(!m.composer&&composerRaw&&String(composerRaw).trim())data.composer=String(composerRaw).trim();
      if(Object.keys(data).length>0){
        var updated=await API.library.update(m.id,data);
        var idx=appState.library.findIndex(function(x){return x.id===m.id;});
        if(idx>=0)appState.library[idx]=updated;
        found++;
      }
    }catch(e){/* seguimos con el resto aunque uno falle */}
    done++;
  }
  toast('✓ '+done+' archivo(s) revisado(s). Se completó algún dato en '+found+' de ellos.');
  render();
}

function renderLibraryTable(adminMode){
  var search=window.__libSearch||'';
  var q=search.toLowerCase();
  var items=appState.library.slice().filter(function(m){
    return!q
      ||m.title.toLowerCase().includes(q)
      ||(m.artist||'').toLowerCase().includes(q)
      ||(m.composer||'').toLowerCase().includes(q)
      ||(m.genre||'').toLowerCase().includes(q)
      ||(m.filename||'').toLowerCase().includes(q);
  });
  window.__libItemsFiltered=items; // para que bindLibraryTableEvents arme la tabla ordenable después del innerHTML
  return'<div class="search-row">'
  +'<input type="text" id="libSearchInput" placeholder="Buscar por título, artista, compositor, estilo o archivo — Enter para buscar" value="'+escapeHtml(search)+'">'
  +'<button class="btn btn-primary" id="btnLibSearch" style="flex:0 0 auto;">Buscar</button>'
  +(search?'<button class="btn" id="btnLibSearchClear" style="flex:0 0 auto;">✕ Limpiar</button>':'')
  +'</div>'
  +'<div class="muted" style="margin:-8px 0 12px;font-size:12.5px;">Mostrando '+items.length+' de '+appState.library.length+' archivo(s). Clic en un encabezado para ordenar.</div>'
  +'<div id="libSortableWrap"></div>';
}

function buildLibrarySortableTable(adminMode){
  var items=window.__libItemsFiltered||[];
  var columns=[
    {key:'filename',label:'Nombre Archivo'},{key:'title',label:'Título'},{key:'artist',label:'Artista'},
    {key:'composer',label:'Compositores'},{key:'genre',label:'Estilo'},{key:'duration',label:'Duración'},
    {key:'type',label:'Tipo'},{key:'added_at',label:'Fecha de ingreso'},{key:'',label:'Acciones'}
  ];
  makeSortableTable('libSortableWrap',columns,items,function(m){
    return'<tr><td class="muted" style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+escapeHtml(m.filename||'')+'">'+escapeHtml(m.filename||'—')+'</td>'
    +'<td><b>'+escapeHtml(m.title)+'</b></td><td>'+escapeHtml(m.artist||'—')+'</td><td>'+escapeHtml(m.composer||'—')+'</td><td>'+escapeHtml(m.genre||'—')+'</td><td>'+formatDuration(m.duration)+'</td>'
    +'<td><span class="tag-type '+m.type+'">'+typeLabel(m.type)+'</span></td>'
    +'<td class="muted" style="font-size:12px;white-space:nowrap;">'+formatShortDate(m.added_at)+'</td>'
    +'<td style="white-space:nowrap;">'
    +'<button class="btn btn-sm" data-preview="'+m.id+'">▶ Escuchar</button>'
    +(adminMode?'<button class="btn btn-sm" data-editmeta="'+m.id+'">Editar</button><button class="btn btn-sm btn-danger" data-delmeta="'+m.id+'">Eliminar</button>':'')
    +'</td></tr>';
  },'title',function(){bindLibraryRowButtons();});
}

function bindLibraryRowButtons(){
  document.querySelectorAll('[data-preview]').forEach(function(b){b.onclick=function(){previewAudio(b.dataset.preview,appState.library);};});
  document.querySelectorAll('[data-editmeta]').forEach(function(b){b.onclick=function(){openMetaModal(b.dataset.editmeta);};});
  document.querySelectorAll('[data-delmeta]').forEach(function(b){b.onclick=async function(){
    if(!confirm('¿Eliminar este archivo?'))return;
    try{await deleteLibrarySongs([b.dataset.delmeta]);refreshLibraryTable();}
    catch(e){toast('Error: '+e.message);}
  };});
}

/* Vuelve a pintar SOLO la tabla (filtro local, sin ir al servidor) y re-conecta sus botones. */
function refreshLibraryTable(){
  var wrap=document.getElementById('libraryTableWrap');
  if(!wrap)return;
  var searchHadFocus=document.activeElement&&document.activeElement.id==='libSearchInput';
  var main=document.getElementById('adminMain');
  var scrollPos=main?main.scrollTop:0;
  wrap.innerHTML=renderLibraryTable(true);
  bindLibraryTableEvents(searchHadFocus);
  if(main)main.scrollTop=scrollPos;
}

function bindLibraryTableEvents(keepSearchFocus){
  var s=document.getElementById('libSearchInput');
  function applySearch(){window.__libSearch=s.value;refreshLibraryTable();}
  if(s){
    s.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();applySearch();}};
    // Solo devolvemos el foco si el usuario ya estaba escribiendo ahí — así una acción
    // cualquiera (Eliminar, Editar) no salta la página hacia arriba.
    if(keepSearchFocus){s.focus();s.setSelectionRange(s.value.length,s.value.length);}
  }
  var btnSearch=document.getElementById('btnLibSearch');
  if(btnSearch)btnSearch.onclick=applySearch;
  var btnClear=document.getElementById('btnLibSearchClear');
  if(btnClear)btnClear.onclick=function(){window.__libSearch='';refreshLibraryTable();};
  buildLibrarySortableTable(true);
}

function bindAdminLibrary(){
  bindLibraryTableEvents(false);
  var btnBackfillGenre=document.getElementById('btnBackfillGenre');
  if(btnBackfillGenre)btnBackfillGenre.onclick=backfillGenreFromId3;
}

/* Vuelve a leer el tag ID3 directamente desde la URL del archivo ya subido a R2,
   sin necesidad de volver a seleccionarlo/subirlo desde el dispositivo. */
function previewAudio(id,library){
  var meta=library.find(function(m){return m.id===id;});
  if(!meta||!meta.url){toast('Archivo sin URL.');return;}
  var existing=document.getElementById('previewModal');
  if(existing){existing.querySelector('audio').pause();existing.remove();}
  var modal=document.createElement('div');
  modal.id='previewModal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(35,40,43,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
  var box=document.createElement('div');
  box.style.cssText='background:#fff;border-radius:12px;padding:24px;width:360px;max-width:93vw;box-shadow:0 12px 40px rgba(0,0,0,.25);';
  var titleEl=document.createElement('div');titleEl.style.cssText='font-weight:700;font-size:15px;margin-bottom:3px;';titleEl.textContent=meta.title;
  var artistEl=document.createElement('div');artistEl.style.cssText='color:#6B6356;font-size:13px;margin-bottom:16px;';artistEl.textContent=meta.artist||'—';
  var audio=document.createElement('audio');audio.controls=true;audio.style.cssText='width:100%;margin-bottom:16px;display:block;';audio.preload='auto';audio.removeAttribute('crossorigin');
  var closeBtn=document.createElement('button');closeBtn.className='btn';closeBtn.style.cssText='width:100%;';closeBtn.textContent='✕ Cerrar';
  box.appendChild(titleEl);box.appendChild(artistEl);box.appendChild(audio);box.appendChild(closeBtn);
  modal.appendChild(box);document.body.appendChild(modal);
  audio.src=meta.url;audio.load();audio.play().catch(function(){});
  function closeModal(){audio.pause();audio.src='';modal.remove();}
  closeBtn.onclick=closeModal;modal.onclick=function(e){if(e.target===modal)closeModal();};
}

function extractAudioMeta(file){
  return new Promise(function(resolve){
    var fallbackTitle=file.name.replace(/\.mp3$/i,'');
    var result={title:fallbackTitle,artist:'',composer:'',genre:'',duration:0,filename:file.name};
    var durationDone=false,tagsDone=false;
    function maybeResolve(){if(durationDone&&tagsDone)resolve(result);}

    // Duración real vía elemento <audio>
    var url=URL.createObjectURL(file),audio=new Audio();
    audio.preload='metadata';audio.src=url;
    audio.onloadedmetadata=function(){result.duration=audio.duration||0;durationDone=true;URL.revokeObjectURL(url);maybeResolve();};
    audio.onerror=function(){durationDone=true;URL.revokeObjectURL(url);maybeResolve();};
    setTimeout(function(){if(!durationDone){durationDone=true;maybeResolve();}},6000);

    // Título / Artista / Compositor / Estilo (género ID3) leídos de la metadata real del propio archivo mp3
    if(window.jsmediatags){
      window.jsmediatags.read(file,{
        onSuccess:function(tag){
          var t=(tag&&tag.tags)||{};
          var composerRaw=t.composer||(t.TCOM&&t.TCOM.data)||''; // jsmediatags NO da atajo .composer, hay que leer el frame crudo TCOM
          if(t.title&&String(t.title).trim())result.title=String(t.title).trim();
          if(t.artist&&String(t.artist).trim())result.artist=String(t.artist).trim();
          if(composerRaw&&String(composerRaw).trim())result.composer=String(composerRaw).trim();
          if(t.genre&&String(t.genre).trim())result.genre=String(t.genre).trim();
          tagsDone=true;maybeResolve();
        },
        onError:function(){
          tagsDone=true;maybeResolve();
        }
      });
    }else{tagsDone=true;maybeResolve();}
    setTimeout(function(){if(!tagsDone){tagsDone=true;maybeResolve();}},6000);
  });
}

function openMetaModal(id){
  var m=appState.library.find(function(x){return x.id===id;});if(!m)return;
  var root=document.getElementById('editMetaRoot');
  root.innerHTML='<div class="modal-bg"><div class="modal"><h3>Editar información</h3>'
  +'<div class="field"><label>Nombre de archivo</label><input id="emFilename" type="text" value="'+escapeHtml(m.filename||'')+'"></div>'
  +'<div class="field"><label>Título</label><input id="emTitle" type="text" value="'+escapeHtml(m.title)+'"></div>'
  +'<div class="field"><label>Artista</label><input id="emArtist" type="text" value="'+escapeHtml(m.artist||'')+'"></div>'
  +'<div class="field"><label>Compositores</label><input id="emComposer" type="text" value="'+escapeHtml(m.composer||'')+'"></div>'
  +'<div class="field"><label>Estilo</label><input id="emGenre" type="text" value="'+escapeHtml(m.genre||'')+'"></div>'
  +'<div class="field"><label>Tipo</label><select id="emType">'
  +'<option value="cancion"'+(m.type==='cancion'?' selected':'')+'>Canción</option>'
  +'<option value="anuncio"'+(m.type==='anuncio'?' selected':'')+'>Anuncio</option>'
  +'<option value="jingle"'+(m.type==='jingle'?' selected':'')+'>Jingle</option>'
  +'</select></div>'
  +'<div class="modal-actions"><button class="btn" id="emCancel">Cancelar</button><button class="btn btn-primary" id="emSave">Guardar</button></div>'
  +'</div></div>';
  document.getElementById('emCancel').onclick=function(){root.innerHTML='';};
  document.getElementById('emSave').onclick=async function(){
    var filename=document.getElementById('emFilename').value.trim();
    var title=document.getElementById('emTitle').value.trim()||m.title;
    var artist=document.getElementById('emArtist').value.trim();
    var composer=document.getElementById('emComposer').value.trim();
    var genre=document.getElementById('emGenre').value.trim();
    var type=document.getElementById('emType').value;
    try{var updated=await API.library.update(id,{title:title,artist:artist,composer:composer,genre:genre,filename:filename,type:type});Object.assign(m,updated);root.innerHTML='';refreshLibraryTable();toast('Actualizado.');}
    catch(e){toast('Error: '+e.message);}
  };
}

/* ===== CATEGORIAS, RELOJES, CANALES, PROGRAMACION (reusan funciones genéricas) ===== */
function renderCategories(cd){
  var rows=cd.categories.map(function(c){
    var count=cd.classifications.filter(function(x){return x.categoryId===c.id;}).length;
    return'<tr data-catrow="'+c.id+'"><td><b class="cat-name-click" data-catnameclick="'+c.id+'" title="Clic para ver los archivos de este estilo">'+escapeHtml(c.name)+' <span class="muted" style="font-weight:400;font-size:11px;">▾</span></b></td><td>'+count+' canción(es)</td>'
    +'<td style="white-space:nowrap;">'
    +'<label class="btn btn-sm btn-primary" style="cursor:pointer;display:inline-block;">+ Subir archivos'
    +'<input type="file" accept="audio/mpeg,audio/mp3,.mp3" multiple style="display:none" data-catupload="'+c.id+'"></label> '
    +'<button class="btn btn-sm" data-renamecat="'+c.id+'">Renombrar</button>'
    +'<button class="btn btn-sm btn-danger" data-delcat="'+c.id+'">Eliminar</button></td></tr>';
  }).join('');
  return'<h1>Estilos</h1><p class="subtitle">Crea un estilo y sube sus archivos directamente aquí (botón, o arrastrando sobre la fila) — quedan clasificados al instante, sin pasar por Biblioteca. Clic en el nombre de un estilo para ver su listado de archivos.</p>'
  +'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;"><label>Nuevo estilo</label><input type="text" id="newCatName" placeholder="Ej: 80s, Rock..."></div>'
  +'<button class="btn btn-primary" id="btnAddCat" style="flex:0 0 auto;">+ Agregar</button></div></div>'
  +'<div class="panel" style="margin-top:18px;">'
  +(cd.categories.length===0?'<div class="empty">Aún no hay estilos.</div>'
  :'<table><thead><tr><th>Estilo</th><th>Canciones</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table>')+'</div>';
}

function bindCategories(cd,isAdmin){
  var save=isAdmin?saveAdminData:saveClientAds;
  document.querySelectorAll('[data-catnameclick]').forEach(function(el){
    el.onclick=function(){
      var catId=el.dataset.catnameclick;
      var existing=document.querySelector('tr[data-catdetail="'+catId+'"]');
      document.querySelectorAll('tr[data-catdetail]').forEach(function(r){r.remove();});
      if(existing)return; // ya estaba abierto: al quitarlo (arriba) queda cerrado, no reabrir
      var row=document.querySelector('tr[data-catrow="'+catId+'"]');
      if(!row)return;
      var songIds=cd.classifications.filter(function(c){return c.categoryId===catId;}).map(function(c){return c.songId;});
      var songs=appState.library.filter(function(m){return songIds.indexOf(m.id)!==-1;});
      songs.sort(function(a,b){return a.title.localeCompare(b.title);});
      var listHtml=songs.length===0?'<div class="muted" style="padding:6px 4px;">Sin archivos clasificados aquí todavía.</div>'
        :songs.map(function(s){return'<div class="queue-item"><span>'+escapeHtml(s.title)+(s.artist?' <span class="muted">— '+escapeHtml(s.artist)+'</span>':'')+'</span><span class="qi-cat">'+formatDuration(s.duration)+'</span></div>';}).join('');
      var tr=document.createElement('tr');
      tr.setAttribute('data-catdetail',catId);
      var td=document.createElement('td');
      td.colSpan=3;
      td.style.background='var(--bg-soft)';
      td.innerHTML='<div style="padding:8px 6px;max-height:300px;overflow-y:auto;">'+listHtml+'</div>';
      tr.appendChild(td);
      row.parentNode.insertBefore(tr,row.nextSibling);
    };
  });
  document.getElementById('btnAddCat').onclick=async function(){
    var input=document.getElementById('newCatName'),name=input.value.trim();
    if(!name){toast('Escribe un nombre.');return;}
    cd.categories.push({id:uid('cat'),name:name});await save();render();toast('Estilo creado.');
  };
  document.querySelectorAll('[data-catupload]').forEach(function(inp){
    inp.onchange=function(){
      var files=Array.from(inp.files); // copiar ANTES de limpiar el input
      inp.value='';
      handleCategoryFiles(files,inp.dataset.catupload);
    };
  });
  document.querySelectorAll('tr[data-catrow]').forEach(function(row){
    row.addEventListener('dragover',function(e){e.preventDefault();row.classList.add('dragover');});
    row.addEventListener('dragleave',function(){row.classList.remove('dragover');});
    row.addEventListener('drop',function(e){
      e.preventDefault();row.classList.remove('dragover');
      handleCategoryFiles(Array.from(e.dataTransfer.files),row.dataset.catrow);
    });
  });
  document.querySelectorAll('[data-renamecat]').forEach(function(b){b.onclick=async function(){
    var cat=cd.categories.find(function(c){return c.id===b.dataset.renamecat;});
    var name=prompt('Nuevo nombre:',cat.name);
    if(name&&name.trim()){cat.name=name.trim();await save();render();}
  };});
  document.querySelectorAll('[data-delcat]').forEach(function(b){b.onclick=async function(){
    if(!confirm('¿Eliminar este estilo?'))return;
    var catId=b.dataset.delcat;
    var songIds=cd.classifications.filter(function(c){return c.categoryId===catId;}).map(function(c){return c.songId;});
    cd.categories=cd.categories.filter(function(c){return c.id!==catId;});
    cd.classifications=cd.classifications.filter(function(c){return c.categoryId!==catId;});
    cd.clocks.forEach(function(cl){cl.sequence=cl.sequence.filter(function(id){return id!==catId;});});
    cd.playlistContent=(cd.playlistContent||[]).filter(function(p){return!(p.type==='style'&&p.refId===catId);});
    await save();
    if(songIds.length>0&&confirm('¿Quieres borrar también '+(songIds.length===1?'el archivo':'los '+songIds.length+' archivos')+' de la Biblioteca? Esta acción no se puede deshacer.')){
      await deleteLibrarySongs(songIds);
    }
    render();
  };});
}

/* Elimina uno o varios archivos de la Biblioteca por completo (R2 + tabla library + clasificaciones).
   IMPORTANTE: también limpia los vínculos en cd.classifications y cd.playlistContent — si no se
   hace esto, el conteo de "canción(es)" de un Estilo queda "pegado" con archivos que ya no existen. */
async function deleteLibrarySongs(songIds){
  var idSet={};songIds.forEach(function(id){idSet[id]=true;});
  for(var i=0;i<songIds.length;i++){
    var id=songIds[i];
    try{
      if(appState.isOnline)await R2Storage.remove(id);
      await API.library.remove(id);
      appState.library=appState.library.filter(function(m){return m.id!==id;});
    }catch(e){toast('Error eliminando un archivo: '+e.message);}
  }
  try{
    var cd=getAdminData();
    var beforeCount=cd.classifications.length+(cd.playlistContent||[]).length;
    cd.classifications=cd.classifications.filter(function(c){return!idSet[c.songId];});
    cd.playlistContent=(cd.playlistContent||[]).filter(function(p){return!(p.type==='song'&&idSet[p.refId]);});
    var afterCount=cd.classifications.length+(cd.playlistContent||[]).length;
    if(afterCount!==beforeCount)await saveAdminData();
  }catch(e){/* si falla la limpieza de vínculos, el archivo igual quedó eliminado de la Biblioteca */}
  toast('✓ '+songIds.length+' archivo(s) eliminado(s) de la Biblioteca.');
}

/* Sube archivos directamente a la biblioteca Y los clasifica en la categoría en un solo paso */
async function handleCategoryFiles(fileList,categoryId){
  var files=Array.from(fileList).filter(function(f){return/\.mp3$/i.test(f.name)||f.type==='audio/mpeg';});
  if(files.length===0){toast('Selecciona archivos .mp3 válidos.');return;}
  var cd=getAdminData();
  var uploaded=0,errors=0;
  for(var i=0;i<files.length;i++){
    var file=files[i];
    showUploadBar(i+1,files.length,file.name);updateUploadBarPct(0);
    try{
      var id=uid('song');
      var meta=await extractAudioMeta(file);
      var url=await R2Storage.upload(file,id,updateUploadBarPct);
      var song={id:id,title:meta.title,artist:meta.artist||'',composer:meta.composer||'',genre:meta.genre||'',filename:meta.filename||file.name,duration:meta.duration,type:'cancion',url:url,added_at:new Date().toISOString(),brand:getAdminBrand()};
      var saved=await API.library.add(song);
      appState.library.push(saved);
      cd.classifications.push({songId:saved.id,categoryId:categoryId});
      uploaded++;
    }catch(err){errors++;toast('Error subiendo "'+file.name+'": '+err.message);}
  }
  hideUploadBar();
  if(uploaded>0){
    try{await saveAdminData();}catch(e){}
    toast('✓ '+uploaded+' archivo(s) agregado(s) a este estilo.');
  }
  if(errors>0)toast('⚠ '+errors+' archivo(s) fallaron.');
  render();
}

function renderClassify(cd){
  if(cd.categories.length===0)return'<h1>Clasificación</h1><div class="empty">Primero crea Estilos.</div>';
  if(cd.channels.length===0)return'<h1>Clasificación</h1><div class="empty">Primero crea al menos un Playlist.</div>';
  var chOptions=cd.channels.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  return'<h1>Clasificación</h1><p class="subtitle">Arrastra un Estilo completo (carpeta) o canciones sueltas hacia el Playlist elegido — o usa los botones "Agregar".</p>'
  +'<div class="panel"><div class="field" style="max-width:280px;"><label>Playlist destino</label><select id="classifyChSelect">'+chOptions+'</select></div></div>'
  +'<div class="panel" style="margin-top:18px;"><div class="dnd-wrap">'
  +'<div class="dnd-col"><h3 style="margin:0 0 8px;">Estilos</h3>'
  +'<input type="text" id="classifySearch" placeholder="Buscar estilo..." style="margin-bottom:8px;"><div class="dnd-list" id="stylesList" data-zone="styles"></div></div>'
  +'<div class="dnd-col"><h3 style="margin:0 0 8px;">Playlist: <span id="chLabel"></span></h3><div class="dnd-list" id="playlistContentList" data-zone="playlist"></div></div>'
  +'</div></div>';
}

function bindClassify(cd,isAdmin){
  var save=isAdmin?saveAdminData:saveClientAds;
  cd.playlistContent=cd.playlistContent||[];
  var selectedChId=cd.channels[0].id;
  var select=document.getElementById('classifyChSelect');select.value=selectedChId;

  function songsOfStyle(catId){
    return cd.classifications.filter(function(cl){return cl.categoryId===catId;})
      .map(function(cl){return appState.library.find(function(m){return m.id===cl.songId;});})
      .filter(Boolean);
  }

  function renderLists(){
    var ch=cd.channels.find(function(c){return c.id===selectedChId;});
    document.getElementById('chLabel').textContent=ch?ch.name:'';
    var search=(document.getElementById('classifySearch').value||'').toLowerCase();
    var contentForCh=cd.playlistContent.filter(function(p){return p.playlistId===selectedChId;});
    var addedStyleIds=new Set(contentForCh.filter(function(p){return p.type==='style';}).map(function(p){return p.refId;}));
    var addedSongIds=new Set(contentForCh.filter(function(p){return p.type==='song';}).map(function(p){return p.refId;}));

    // ---- Columna izquierda: Estilos como carpetas desplegables ----
    var stylesList=document.getElementById('stylesList');
    var stylesToShow=cd.categories.filter(function(c){return!search||c.name.toLowerCase().includes(search);});
    stylesList.innerHTML=stylesToShow.length===0?'<div class="empty" style="padding:20px;">Sin resultados.</div>':
      stylesToShow.map(function(cat){
        var songs=songsOfStyle(cat.id);
        var styleAdded=addedStyleIds.has(cat.id);
        var songsHtml=songs.length===0?'<div class="muted" style="padding:6px 0 6px 30px;font-size:12px;">Sin canciones clasificadas aquí.</div>':
          songs.map(function(m){
            var songAdded=styleAdded||addedSongIds.has(m.id);
            return'<div class="dnd-item" draggable="true" data-song="'+m.id+'" style="padding-left:30px;">'
            +'<span>'+escapeHtml(m.title)+' <span class="tag-type '+m.type+'">'+typeLabel(m.type)+'</span></span>'
            +'<button class="btn btn-sm" data-addsong="'+m.id+'"'+(songAdded?' disabled':'')+'>'+(songAdded?'En esta Playlist':'Agregar')+'</button>'
            +'</div>';
          }).join('');
        return'<div class="style-folder">'
        +'<div class="dnd-item" draggable="true" data-style="'+cat.id+'" style="background:var(--bg-soft);font-weight:600;">'
        +'<span data-togglefolder="'+cat.id+'" style="cursor:pointer;">▤ '+escapeHtml(cat.name)+' <span class="muted" style="font-weight:400;">('+songs.length+')</span> <span class="muted" id="foldercaret_'+cat.id+'">▸</span></span>'
        +'<button class="btn btn-sm" data-addstyle="'+cat.id+'"'+(styleAdded?' disabled':'')+'>'+(styleAdded?'En esta Playlist':'Agregar carpeta')+'</button>'
        +'</div>'
        +'<div id="foldersongs_'+cat.id+'" style="display:none;">'+songsHtml+'</div>'
        +'</div>';
      }).join('');

    // ---- Columna derecha: contenido ya asignado a este Playlist ----
    var playlistList=document.getElementById('playlistContentList');
    var styleItems=contentForCh.filter(function(p){return p.type==='style';}).map(function(p){
      var cat=cd.categories.find(function(c){return c.id===p.refId;});
      var n=cat?songsOfStyle(cat.id).length:0;
      return'<div class="dnd-item"><span>▤ <b>'+escapeHtml(cat?cat.name:'(eliminado)')+'</b> <span class="muted">— carpeta completa, '+n+' canción(es)</span></span>'
      +'<button class="btn btn-sm" data-removestyle="'+p.refId+'">Quitar</button></div>';
    }).join('');
    var songItems=contentForCh.filter(function(p){return p.type==='song';}).map(function(p){
      var m=appState.library.find(function(x){return x.id===p.refId;});
      return'<div class="dnd-item"><span>'+escapeHtml(m?m.title:'(eliminada)')+'</span>'
      +'<button class="btn btn-sm" data-removesong="'+p.refId+'">Quitar</button></div>';
    }).join('');
    playlistList.innerHTML=(styleItems+songItems)||'<div class="empty" style="padding:20px;">Arrastra un Estilo completo o canciones sueltas aquí.</div>';

    bindDnd();
  }

  function bindDnd(){
    document.querySelectorAll('[data-togglefolder]').forEach(function(el){
      el.onclick=function(){
        var box=document.getElementById('foldersongs_'+el.dataset.togglefolder);
        var caret=document.getElementById('foldercaret_'+el.dataset.togglefolder);
        if(!box)return;
        var open=box.style.display!=='none';
        box.style.display=open?'none':'';
        if(caret)caret.textContent=open?'▸':'▾';
      };
    });
    document.querySelectorAll('[data-song]').forEach(function(item){item.ondragstart=function(e){e.dataTransfer.setData('text/plain','song:'+item.dataset.song);};});
    document.querySelectorAll('[data-style]').forEach(function(item){item.ondragstart=function(e){e.stopPropagation();e.dataTransfer.setData('text/plain','style:'+item.dataset.style);};});
    var zone=document.getElementById('playlistContentList');
    zone.ondragover=function(e){e.preventDefault();zone.classList.add('dragover');};
    zone.ondragleave=function(){zone.classList.remove('dragover');};
    zone.ondrop=function(e){
      e.preventDefault();zone.classList.remove('dragover');
      var data=e.dataTransfer.getData('text/plain')||'';
      if(data.indexOf('song:')===0)addSongToPlaylist(data.slice(5));
      else if(data.indexOf('style:')===0)addStyleToPlaylist(data.slice(6));
    };
    document.querySelectorAll('[data-addsong]').forEach(function(b){b.onclick=function(){addSongToPlaylist(b.dataset.addsong);};});
    document.querySelectorAll('[data-addstyle]').forEach(function(b){b.onclick=function(){addStyleToPlaylist(b.dataset.addstyle);};});
    document.querySelectorAll('[data-removesong]').forEach(function(b){b.onclick=function(){removeFromPlaylist('song',b.dataset.removesong);};});
    document.querySelectorAll('[data-removestyle]').forEach(function(b){b.onclick=function(){removeFromPlaylist('style',b.dataset.removestyle);};});
  }

  async function addSongToPlaylist(songId){
    if(!songId||cd.playlistContent.some(function(p){return p.playlistId===selectedChId&&p.type==='song'&&p.refId===songId;}))return;
    cd.playlistContent.push({playlistId:selectedChId,type:'song',refId:songId});await save();renderLists();
  }
  async function addStyleToPlaylist(catId){
    if(!catId||cd.playlistContent.some(function(p){return p.playlistId===selectedChId&&p.type==='style'&&p.refId===catId;}))return;
    cd.playlistContent.push({playlistId:selectedChId,type:'style',refId:catId});await save();renderLists();
    toast('✓ Carpeta completa agregada — si más adelante agregas más canciones a ese Estilo, entrarán a este Playlist automáticamente.');
  }
  async function removeFromPlaylist(type,refId){
    cd.playlistContent=cd.playlistContent.filter(function(p){return!(p.playlistId===selectedChId&&p.type===type&&p.refId===refId);});
    await save();renderLists();
  }

  select.onchange=function(){selectedChId=select.value;renderLists();};
  document.getElementById('classifySearch').oninput=renderLists;
  renderLists();
}

function renderClocks(cd){
  var clockOptions=cd.clocks.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  return'<h1>Relojes Musicales</h1><p class="subtitle">Construye una secuencia de Estilos y/o Playlists.</p>'
  +'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;"><label>Reloj musical</label><select id="clockSelect">'+(clockOptions||'<option value="">Sin relojes</option>')+'</select></div>'
  +'<button class="btn btn-primary" id="btnNewClock" style="flex:0 0 auto;">+ Nuevo reloj</button>'
  +'<button class="btn btn-danger" id="btnDelClock" style="flex:0 0 auto;">Eliminar</button></div></div>'
  +(cd.categories.length===0&&cd.channels.length===0?'<div class="empty" style="margin-top:18px;">Crea Estilos o Playlists primero.</div>'
  :'<div class="panel" style="margin-top:18px;"><div class="clock-builder">'
  +'<div>'
  +'<div class="section-title">Estilos <span class="muted">(clic o arrastra)</span></div><div class="cat-chip-list" id="catChips" style="margin-bottom:14px;"></div>'
  +'<div class="section-title">Playlists <span class="muted">(clic o arrastra)</span></div><div class="cat-chip-list" id="chChips"></div>'
  +'</div>'
  +'<div><div class="section-title">Secuencia del reloj</div><div class="clock-sequence" id="clockSeq"></div></div>'
  +'</div></div>');
}

function bindClocks(cd,isAdmin){
  var save=isAdmin?saveAdminData:saveClientAds;
  var currentClockId=cd.clocks.length?cd.clocks[0].id:null;
  var select=document.getElementById('clockSelect');
  function refreshSelect(){
    if(cd.clocks.length===0){select.innerHTML='<option value="">Sin relojes</option>';currentClockId=null;}
    else{select.innerHTML=cd.clocks.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
      if(!currentClockId||!cd.clocks.some(function(c){return c.id===currentClockId;}))currentClockId=cd.clocks[0].id;
      select.value=currentClockId;}
  }
  refreshSelect();
  function blockLabel(id){
    if(id.indexOf('ch_')===0){var ch=cd.channels.find(function(c){return c.id===id;});return ch?ch.name:null;}
    var cat=cd.categories.find(function(c){return c.id===id;});return cat?cat.name:null;
  }
  function renderBuilder(){
    var catChips=document.getElementById('catChips');
    catChips.innerHTML=cd.categories.map(function(c){return'<div class="cat-chip" draggable="true" data-cat="'+c.id+'">▤ '+escapeHtml(c.name)+'</div>';}).join('')||'<div class="muted" style="font-size:12px;">Sin Estilos.</div>';
    catChips.querySelectorAll('.cat-chip').forEach(function(chip){chip.ondragstart=function(e){e.dataTransfer.setData('text/plain',chip.dataset.cat);};chip.onclick=function(){addStep(chip.dataset.cat);};});
    var chChips=document.getElementById('chChips');
    chChips.innerHTML=cd.channels.map(function(c){return'<div class="cat-chip cat-chip-playlist" draggable="true" data-ch="'+c.id+'">▶ '+escapeHtml(c.name)+'</div>';}).join('')||'<div class="muted" style="font-size:12px;">Sin Playlists.</div>';
    chChips.querySelectorAll('.cat-chip').forEach(function(chip){chip.ondragstart=function(e){e.dataTransfer.setData('text/plain',chip.dataset.ch);};chip.onclick=function(){addStep(chip.dataset.ch);};});
    var seq=document.getElementById('clockSeq');
    var clock=cd.clocks.find(function(c){return c.id===currentClockId;});
    if(!clock){seq.innerHTML='<div class="empty" style="padding:20px;">Crea un reloj con "+ Nuevo reloj".</div>';return;}
    seq.innerHTML=clock.sequence.length===0?'<div class="empty" style="padding:20px;">Haz clic en un Estilo/Playlist o arrástralo aquí.</div>':
      clock.sequence.map(function(blockId,idx){
        var isPlaylist=blockId.indexOf('ch_')===0;
        var label=blockLabel(blockId);
        return'<div class="clock-step'+(isPlaylist?' clock-step-playlist':'')+'"><span class="pos">'+(idx+1)+'</span><span class="name">'+(isPlaylist?'▶ ':'▤ ')+(label?escapeHtml(label):'(eliminado)')+'</span>'
        +'<button class="remove-x" data-removestep="'+idx+'">✕</button></div>';
      }).join('');
    seq.ondragover=function(e){e.preventDefault();seq.classList.add('dragover');};
    seq.ondragleave=function(){seq.classList.remove('dragover');};
    seq.ondrop=function(e){e.preventDefault();seq.classList.remove('dragover');var blockId=e.dataTransfer.getData('text/plain');if(cd.categories.some(function(c){return c.id===blockId;})||cd.channels.some(function(c){return c.id===blockId;}))addStep(blockId);};
    seq.querySelectorAll('[data-removestep]').forEach(function(b){b.onclick=async function(){clock.sequence.splice(parseInt(b.dataset.removestep),1);await save();renderBuilder();};});
  }
  async function addStep(blockId){
    var clock=cd.clocks.find(function(c){return c.id===currentClockId;});if(!clock){toast('Crea un reloj primero.');return;}
    clock.sequence.push(blockId);await save();renderBuilder();
  }
  document.getElementById('btnNewClock').onclick=async function(){
    var name=prompt('Nombre del nuevo reloj:');if(!name||!name.trim())return;
    var nc={id:uid('clock'),name:name.trim(),sequence:[]};
    cd.clocks.push(nc);currentClockId=nc.id;await save();refreshSelect();renderBuilder();toast('Reloj creado.');
  };
  select.onchange=function(){if(select.value){currentClockId=select.value;renderBuilder();}};
  document.getElementById('btnDelClock').onclick=async function(){
    if(!currentClockId){toast('No hay reloj seleccionado.');return;}
    if(!confirm('¿Eliminar este reloj?'))return;
    cd.clocks=cd.clocks.filter(function(c){return c.id!==currentClockId;});
    cd.schedule=cd.schedule.filter(function(s){return s.clockId!==currentClockId;});
    currentClockId=cd.clocks.length?cd.clocks[0].id:null;
    await save();refreshSelect();renderBuilder();
  };
  renderBuilder();
}

function formatLongDuration(sec){
  if(!sec)return'0 min';
  sec=Math.round(sec);
  var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);
  return h>0?(h+'h '+m+'min'):(m+' min');
}

/* Canciones disponibles para un Playlist: lo arrastrado en Clasificación —
   Estilos completos (todas sus canciones, incluso las que se agreguen después)
   + canciones sueltas — sin duplicados. */
function getPlaylistSongs(channelId,cd){
  var content=(cd.playlistContent||[]).filter(function(p){return p.playlistId===channelId;});
  var ids={};
  content.forEach(function(p){
    if(p.type==='song')ids[p.refId]=true;
    else if(p.type==='style'){
      cd.classifications.filter(function(c){return c.categoryId===p.refId;}).forEach(function(c){ids[c.songId]=true;});
    }
  });
  return Object.keys(ids).map(function(id){return appState.library.find(function(m){return m.id===id;});}).filter(Boolean);
}

function renderChannels(cd){
  var rows=cd.channels.map(function(c){
    var songs=getPlaylistSongs(c.id,cd);
    var totalSec=songs.reduce(function(sum,s){return sum+(s.duration||0);},0);
    return'<tr><td><b>'+escapeHtml(c.name)+'</b></td>'
    +'<td class="muted">'+songs.length+' canción(es) · '+formatLongDuration(totalSec)+'</td>'
    +'<td><button class="btn btn-sm" data-renamech="'+c.id+'">Renombrar</button>'
    +'<button class="btn btn-sm btn-danger" data-delch="'+c.id+'">Eliminar</button></td></tr>';
  }).join('');
  return'<h1>Playlists</h1><p class="subtitle">Cada playlist representa una salida de programación.</p>'
  +'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;"><label>Nuevo playlist</label><input type="text" id="newChName" placeholder="Ej: Supermercado"></div>'
  +'<button class="btn btn-primary" id="btnAddCh" style="flex:0 0 auto;">+ Agregar</button></div></div>'
  +'<div class="panel" style="margin-top:18px;">'+(cd.channels.length===0?'<div class="empty">Aún no hay canales.</div>'
  :'<table><thead><tr><th>Playlist</th><th>Contenido</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table>')+'</div>';
}

function bindChannels(cd,isAdmin){
  var save=isAdmin?saveAdminData:saveClientAds;
  document.getElementById('btnAddCh').onclick=async function(){
    var input=document.getElementById('newChName'),name=input.value.trim();
    if(!name){toast('Escribe un nombre.');return;}
    cd.channels.push({id:uid('ch'),name:name});await save();render();
  };
  document.querySelectorAll('[data-renamech]').forEach(function(b){b.onclick=async function(){
    var ch=cd.channels.find(function(c){return c.id===b.dataset.renamech;});
    var name=prompt('Nuevo nombre:',ch.name);if(name&&name.trim()){ch.name=name.trim();await save();render();}
  };});
  document.querySelectorAll('[data-delch]').forEach(function(b){b.onclick=async function(){
    if(!confirm('¿Eliminar este playlist?'))return;
    var chId=b.dataset.delch;
    cd.channels=cd.channels.filter(function(c){return c.id!==chId;});
    cd.schedule=cd.schedule.filter(function(s){return s.channelId!==chId;});
    cd.playlistContent=(cd.playlistContent||[]).filter(function(p){return p.playlistId!==chId;});
    cd.clocks.forEach(function(cl){cl.sequence=cl.sequence.filter(function(id){return id!==chId;});});
    await save();render();
  };});
}

var _schedCalendar=null;
function getSchedCalendarState(){
  if(!_schedCalendar){
    var now=new Date();
    _schedCalendar={year:now.getFullYear(),month:now.getMonth(),selectedDates:new Set(),pendingAnchor:null};
  }
  return _schedCalendar;
}

function renderSchedule(cd){
  if(cd.channels.length===0||cd.clocks.length===0)return'<h1>Programación Musical</h1><div class="empty">Necesitas al menos un canal y un reloj musical.</div>';
  var chOptions=cd.channels.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  var clockOptions=cd.clocks.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  var dayOptions='<option value="weekdays">Lunes a Viernes</option><option value="alldays">Todos los días</option>'
    +DAYS.map(function(d){return'<option value="'+d+'">'+d+'</option>';}).join('');

  var recurring=cd.schedule.filter(function(s){return!s.date;});
  var exceptions=cd.schedule.filter(function(s){return!!s.date;});

  var byDay={};DAYS.forEach(function(d){byDay[d]=[];});
  recurring.forEach(function(s){if(byDay[s.day])byDay[s.day].push(s);});
  Object.values(byDay).forEach(function(list){list.sort(function(a,b){return a.start.localeCompare(b.start);});});
  var dayBlocks=DAYS.map(function(d){
    var items=byDay[d].map(function(s){
      var ch=cd.channels.find(function(c){return c.id===s.channelId;}),cl=cd.clocks.find(function(c){return c.id===s.clockId;});
      return'<div class="queue-item"><span>'+s.start+' – '+s.end+' &nbsp;·&nbsp; <b>'+escapeHtml(ch?ch.name:'?')+'</b> &nbsp;·&nbsp; '+escapeHtml(cl?cl.name:'?')+'</span>'
      +'<button class="remove-x" data-delsched="'+s.id+'">✕</button></div>';}).join('');
    return'<div class="panel"><div class="section-title">'+d+'</div>'+(items||'<div class="muted">Sin horarios.</div>')+'</div>';
  }).join('');

  var byDate={};
  exceptions.forEach(function(s){if(!byDate[s.date])byDate[s.date]=[];byDate[s.date].push(s);});
  var sortedDates=Object.keys(byDate).sort();
  Object.keys(byDate).forEach(function(d){byDate[d].sort(function(a,b){return a.start.localeCompare(b.start);});});
  var exceptionBlocks=sortedDates.map(function(d){
    var items=byDate[d].map(function(s){
      var ch=cd.channels.find(function(c){return c.id===s.channelId;}),cl=cd.clocks.find(function(c){return c.id===s.clockId;});
      return'<div class="queue-item"><span>'+s.start+' – '+s.end+' &nbsp;·&nbsp; <b>'+escapeHtml(ch?ch.name:'?')+'</b> &nbsp;·&nbsp; '+escapeHtml(cl?cl.name:'?')+'</span>'
      +'<button class="remove-x" data-delsched="'+s.id+'">✕</button></div>';
    }).join('');
    return'<div class="panel"><div class="section-title">'+formatDateLabel(d)+' <span class="badge suspendida" style="margin-left:6px;">Excepción</span></div>'+items+'</div>';
  }).join('');

  return'<h1>Programación Musical</h1><p class="subtitle">Asigna relojes musicales a cada playlist — de forma recurrente cada semana, o para una fecha específica (feriados, eventos especiales).</p>'

  +'<div class="panel"><div class="section-title">Recurrente (se repite cada semana)</div><div class="row">'
  +'<div class="field"><label>Día</label><select id="schDay">'+dayOptions+'</select></div>'
  +'<div class="field"><label>Hora inicio</label><input type="text" id="schStart" placeholder="08:00" value="08:00"></div>'
  +'<div class="field"><label>Hora fin</label><input type="text" id="schEnd" placeholder="12:00" value="12:00"></div>'
  +'</div><div class="row">'
  +'<div class="field"><label>Playlist</label><select id="schChannel">'+chOptions+'</select></div>'
  +'<div class="field"><label>Reloj musical</label><select id="schClock">'+clockOptions+'</select></div>'
  +'<div class="field" style="flex:0 0 auto;align-self:flex-end;"><button class="btn btn-primary" id="btnAddSched">+ Programar</button></div>'
  +'</div></div>'

  +'<div class="panel" style="margin-top:18px;"><div class="section-title">Excepción por fecha específica (feriados, eventos)</div>'
  +'<p class="muted" style="margin:-6px 0 12px;">Tiene prioridad sobre lo recurrente ese día puntual. Marca uno o varios días en el calendario.</p>'
  +'<div id="schedCalendarBox" style="margin-bottom:14px;"></div>'
  +'<div class="row">'
  +'<div class="field"><label>Hora inicio</label><input type="text" id="schExStart" placeholder="08:00" value="08:00"></div>'
  +'<div class="field"><label>Hora fin</label><input type="text" id="schExEnd" placeholder="12:00" value="12:00"></div>'
  +'</div><div class="row">'
  +'<div class="field"><label>Playlist</label><select id="schExChannel">'+chOptions+'</select></div>'
  +'<div class="field"><label>Reloj musical</label><select id="schExClock">'+clockOptions+'</select></div>'
  +'<div class="field" style="flex:0 0 auto;align-self:flex-end;"><button class="btn btn-primary" id="btnAddSchedEx">+ Programar excepción</button></div>'
  +'</div></div>'

  +'<div style="margin-top:18px;">'+dayBlocks+'</div>'
  +(exceptionBlocks?'<div style="margin-top:18px;">'+exceptionBlocks+'</div>':'');
}

function bindSchedule(cd,isAdmin){
  var save=isAdmin?saveAdminData:function(){};
  var timeRe=/^([01]\d|2[0-3]):([0-5]\d)$/;

  document.getElementById('btnAddSched').onclick=async function(){
    var dayVal=document.getElementById('schDay').value;
    var start=document.getElementById('schStart').value.trim();
    var end=document.getElementById('schEnd').value.trim();
    var channelId=document.getElementById('schChannel').value;
    var clockId=document.getElementById('schClock').value;
    if(!timeRe.test(start)||!timeRe.test(end)){toast('Usa formato HH:MM.');return;}
    if(start>=end){toast('La hora inicio debe ser anterior a la hora fin.');return;}
    var daysToUse;
    if(dayVal==='weekdays')daysToUse=['Lunes','Martes','Miércoles','Jueves','Viernes'];
    else if(dayVal==='alldays')daysToUse=DAYS.slice();
    else daysToUse=[dayVal];
    daysToUse.forEach(function(d){
      cd.schedule.push({id:uid('sch'),day:d,start:start,end:end,channelId:channelId,clockId:clockId});
    });
    await save();render();toast(daysToUse.length===1?'Horario programado.':'✓ Programado en '+daysToUse.length+' día(s).');
  };

  var calBox=document.getElementById('schedCalendarBox');
  if(calBox)refreshCalendar(calBox,getSchedCalendarState(),null);

  var btnAddSchedEx=document.getElementById('btnAddSchedEx');
  if(btnAddSchedEx)btnAddSchedEx.onclick=async function(){
    var cal=getSchedCalendarState();
    var dates=Array.from(cal.selectedDates);
    if(dates.length===0){toast('Marca al menos un día en el calendario.');return;}
    var start=document.getElementById('schExStart').value.trim();
    var end=document.getElementById('schExEnd').value.trim();
    var channelId=document.getElementById('schExChannel').value;
    var clockId=document.getElementById('schExClock').value;
    if(!timeRe.test(start)||!timeRe.test(end)){toast('Usa formato HH:MM.');return;}
    if(start>=end){toast('La hora inicio debe ser anterior a la hora fin.');return;}
    dates.forEach(function(d){
      cd.schedule.push({id:uid('sch'),date:d,start:start,end:end,channelId:channelId,clockId:clockId});
    });
    cal.selectedDates.clear();
    await save();render();toast('✓ Excepción programada en '+dates.length+' día(s).');
  };

  document.querySelectorAll('[data-delsched]').forEach(function(b){b.onclick=async function(){
    cd.schedule=cd.schedule.filter(function(s){return s.id!==b.dataset.delsched;});await save();render();
  };});
}

/* ===== ADMIN PLAYER ===== */
function renderAdminPlayer(){
  var adminData=getAdminData();
  if(adminData.channels.length===0)return'<h1>Reproductor</h1><div class="empty">Crea canales primero (sección F).</div>';
  var chOptions=adminData.channels.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  return renderPlayerUI(chOptions,null);
}
function bindAdminPlayer(){
  var adminData=getAdminData();
  var channelSelect=document.getElementById('playerChannel');
  var audioEl=getOrCreateAudioEl();
  if(playerEngine&&playerEngineClientId==='__admin__'){
    playerEngine.reconnectUI(updatePlayerUI);
    var savedCh=playerEngine.getChannelId();
    if(savedCh&&adminData.channels.some(function(c){return c.id===savedCh;}))channelSelect.value=savedCh;
  }else{
    destroyPlayerEngine();
    playerEngine=createPlayerEngine(adminData,null,audioEl,{onUpdate:updatePlayerUI});
    playerEngineClientId='__admin__';
    playerEngine.setChannel(channelSelect.value);
  }
  channelSelect.onchange=function(){playerEngine.setChannel(channelSelect.value);};
  document.getElementById('pPlay').onclick=function(){playerEngine.togglePlay();};
  document.getElementById('pNext').onclick=function(){playerEngine.skipNext();};
}

/* ===== Registros de reproducción (Administrador) =====
   Cada canal genera su propio archivo descargable por día, con lo que
   realmente reprodujeron los dispositivos de los clientes conectados a ese canal. */
function renderAdminLogs(){
  var adminData=getAdminData();
  if(adminData.channels.length===0)return'<h1>Registros</h1><div class="empty">Crea canales primero (sección F).</div>';
  var chanOpts=adminData.channels.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
  return'<h1>Registros de Reproducción</h1><p class="subtitle">Cada playlist activo genera su propio archivo descargable, día por día, con lo realmente reproducido en los dispositivos de tus clientes.</p>'
  +'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;"><label>Playlist</label><select id="logChannel"><option value="">Selecciona un playlist</option>'+chanOpts+'</select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Día</label><select id="logDate"><option value="">—</option></select></div>'
  +'<button class="btn btn-primary" id="btnDownloadLog" style="flex:0 0 auto;" disabled>⬇ Descargar .txt</button>'
  +'</div><div class="muted" id="logCount" style="margin-top:10px;"></div></div>';
}

function bindAdminLogs(){
  var chSel=document.getElementById('logChannel');
  if(!chSel)return;
  var dtSel=document.getElementById('logDate');
  var btn=document.getElementById('btnDownloadLog');
  var countEl=document.getElementById('logCount');

  async function refreshCount(){
    var chId=chSel.value,d=dtSel.value;
    if(!chId||!d){countEl.textContent='';btn.disabled=true;return;}
    countEl.textContent='Consultando...';
    try{
      var entries=await API.playlog.get(chId,d);
      countEl.textContent=entries.length+' reproducción(es) registrada(s) ese día.';
      btn.disabled=entries.length===0;
    }catch(e){countEl.textContent='Error consultando el registro: '+e.message;btn.disabled=true;}
  }

  chSel.onchange=async function(){
    var chId=chSel.value;
    btn.disabled=true;countEl.textContent='';
    if(!chId){dtSel.innerHTML='<option value="">—</option>';return;}
    dtSel.innerHTML='<option value="">Cargando...</option>';
    try{
      var res=await API.playlog.dates(chId);
      var dates=res.dates||[];
      if(dates.length===0){dtSel.innerHTML='<option value="">Sin registros aún</option>';return;}
      dtSel.innerHTML=dates.map(function(d,i){return'<option value="'+d+'"'+(i===0?' selected':'')+'>'+d+'</option>';}).join('');
      refreshCount();
    }catch(e){dtSel.innerHTML='<option value="">Error cargando fechas</option>';}
  };
  dtSel.onchange=refreshCount;

  btn.onclick=async function(){
    var chId=chSel.value,d=dtSel.value;
    if(!chId||!d)return;
    try{
      var entries=await API.playlog.get(chId,d);
      if(entries.length===0){toast('No hay reproducciones registradas ese día.');return;}
      var chanName=chSel.options[chSel.selectedIndex].text;
      var text=buildAdminPlaylogText(chanName,d,entries);
      downloadTextFile('registro_'+slugify(chanName)+'_'+d+'.txt',text);
      toast('✓ Registro descargado.');
    }catch(e){toast('Error: '+e.message);}
  };
}

/* ===== Monitoreo — estado de conexión de cada usuario/tienda ===== */
function formatClockTime(iso){
  try{return new Date(iso).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});}
  catch(e){return'—';}
}

var _monitoringInterval=null;
function stopMonitoringAutoRefresh(){
  if(_monitoringInterval){clearInterval(_monitoringInterval);_monitoringInterval=null;}
}

/* ===== Actualización "en vivo" de Mis Anuncios (sin recargar la página) =====
   Cada 90s se hace una consulta muy liviana (solo la fecha de última modificación).
   Si no cambió nada, no se descarga nada más — así 200 tiendas conectadas a la vez
   no generan una carga pesada de ancho de banda. Solo cuando SÍ hubo un cambio real
   (el Administrador de Cliente editó Mis Anuncios) se trae el paquete completo,
   y se actualiza el mismo objeto que el motor de audio ya está usando en vivo. */
var _adsPollTimer=null,_adsLastKnownUpdatedAt=null;
function startAdsSmartPoll(stationId){
  stopAdsSmartPoll();
  if(!stationId)return;
  _adsPollTimer=setInterval(async function(){
    if(!appState.isOnline)return;
    try{
      var v=await API.clientAds.version(stationId);
      if(v.updated_at&&v.updated_at!==_adsLastKnownUpdatedAt){
        var fresh=await API.clientAds.get(stationId);
        _adsLastKnownUpdatedAt=fresh.updated_at||v.updated_at;
        if(appState.clientAds){
          appState.clientAds.ads=fresh.ads||[];
          appState.clientAds.adSchedule=fresh.adSchedule||[];
        }else{
          appState.clientAds=fresh;
        }
        OfflineDB.setConfig('clientAds',appState.clientAds).catch(function(){});
      }
    }catch(e){/* se reintenta solo en el próximo ciclo */}
  },90000);
}
function stopAdsSmartPoll(){
  if(_adsPollTimer){clearInterval(_adsPollTimer);_adsPollTimer=null;}
}

/* Panel de Monitoreo genérico — lo usa tanto el Administrador (todos los clientes)
   como el Administrador de Cliente (solo su propio negocio). */
function renderLiveMonitoring(){
  return'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;" id="liveClientFieldWrap"></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Estación</label><select id="liveStationSelect"><option value="">Cargando...</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Región</label><select id="liveGroupSelect"><option value="">Todas</option><option value="Lima">Lima</option><option value="Provincias">Provincias</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Zona</label><select id="liveZoneSelect"><option value="">Todas</option></select></div>'
  +'</div></div>'
  +'<p class="subtitle" style="margin:10px 0 0;">Usuario / Tienda y su estado de conexión — se muestran todas las tiendas de la Estación (y Región/Zona) elegidos, estén o no conectadas. Se actualiza solo cada 60 segundos. Clic en un encabezado para ordenar.</p>'
  +'<div id="liveSummaryRow" style="margin:10px 0 14px;"></div>'
  +'<div id="liveResultBox"></div>';
}

async function bindLiveMonitoring(singleClient,allClients){
  stopMonitoringAutoRefresh();
  var currentClientId=singleClient?singleClient.id:null;
  var currentFilter='all'; // 'all' | 'online' | 'buffering' | 'offline'
  var lastRows=[];
  var groupSelect=document.getElementById('liveGroupSelect');
  var zoneSelect=document.getElementById('liveZoneSelect');
  var allStoresForStation=[];

  /* La lista de Zonas disponibles depende de la Región elegida (o de todas las tiendas
     de la Estación si la Región está en "Todas") — se arma sola con lo que ya cargaste
     en cada Tienda, sin necesidad de mantener un catálogo aparte. */
  function refreshZoneOptions(){
    var g=groupSelect.value;
    var pool=g?allStoresForStation.filter(function(s){return s.group_name===g;}):allStoresForStation;
    var zones=Array.from(new Set(pool.map(function(s){return s.zone;}).filter(Boolean))).sort();
    var current=zoneSelect.value;
    zoneSelect.innerHTML='<option value="">Todas</option>'+zones.map(function(z){return'<option value="'+escapeHtml(z)+'">'+escapeHtml(z)+'</option>';}).join('');
    if(zones.indexOf(current)!==-1)zoneSelect.value=current;
  }

  function renderSummaryAndFilter(){
    var onlineCount=lastRows.filter(function(r){return r.status==='online';}).length;
    var bufferingCount=lastRows.filter(function(r){return r.status==='buffering';}).length;
    var offlineCount=lastRows.filter(function(r){return r.status==='offline';}).length;
    document.getElementById('liveSummaryRow').innerHTML=
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
      +'<button class="btn btn-sm'+(currentFilter==='all'?' btn-primary':'')+'" data-livefilter="all">Todos ('+lastRows.length+')</button>'
      +'<button class="btn btn-sm'+(currentFilter==='online'?' btn-primary':'')+'" data-livefilter="online">🟢 Conectados ('+onlineCount+')</button>'
      +'<button class="btn btn-sm'+(currentFilter==='buffering'?' btn-primary':'')+'" data-livefilter="buffering">🟡 Reproduciendo sin conexión ('+bufferingCount+')</button>'
      +'<button class="btn btn-sm'+(currentFilter==='offline'?' btn-primary':'')+'" data-livefilter="offline">⚪ Desconectados ('+offlineCount+')</button>'
      +'</div>';
    document.querySelectorAll('[data-livefilter]').forEach(function(b){
      b.onclick=function(){currentFilter=b.dataset.livefilter;renderSummaryAndFilter();renderTable();};
    });
  }

  function renderTable(){
    var box=document.getElementById('liveResultBox');
    var filtered=lastRows.filter(function(r){
      if(currentFilter==='all')return true;
      return r.status===currentFilter;
    });
    if(filtered.length===0){box.innerHTML='<div class="empty">Nada que mostrar con este filtro.</div>';return;}
    box.innerHTML='<div id="liveSortableWrap"></div>';
    var columns=[{key:'label',label:'Usuario / Tienda'},{key:'stateTime',label:'Estado de la conexión'}];
    makeSortableTable('liveSortableWrap',columns,filtered,function(r){
      return'<tr><td>'+escapeHtml(r.label)+'</td><td>'+r.stateHtml+'</td></tr>';
    },'label');
  }

  async function loadLiveTable(){
    var stationId=document.getElementById('liveStationSelect').value;
    var box=document.getElementById('liveResultBox');
    if(!currentClientId){box.innerHTML='<div class="empty">Selecciona un Negocio.</div>';document.getElementById('liveSummaryRow').innerHTML='';return;}
    if(!box.dataset.loadedOnce)box.innerHTML='<div class="muted">Cargando...</div>';
    try{
      var stores=await getActiveStoresForSelection(stationId,currentClientId);
      allStoresForStation=stores;
      refreshZoneOptions();
      var g=groupSelect.value,z=zoneSelect.value;
      var filteredStores=stores.filter(function(s){
        if(g&&s.group_name!==g)return false;
        if(z&&s.zone!==z)return false;
        return true;
      });
      var presenceRows=stores.length?await API.presence.getByStoreIds(stores.map(function(s){return s.id;})):[];
      var presenceByStore={};
      // Puede haber varias filas de presencia para la misma tienda (si el dispositivo
      // "empezó de cero" más de una vez: reinicio, caché borrado, etc. — cada vez genera
      // un identificador de dispositivo nuevo, y el viejo queda huérfano). La API ya las
      // devuelve ordenadas de más reciente a más vieja, así que nos quedamos con la
      // PRIMERA que encontremos por tienda (la más fresca) e ignoramos las viejas.
      presenceRows.forEach(function(r){if(r.store_id&&!presenceByStore[r.store_id])presenceByStore[r.store_id]=r;});
      // ONLINE_THRESHOLD_MS: sin aviso reciente = perdió conexión con el servidor.
      // BUFFER_GRACE_MS: coincide con el colchón de reproducción offline (15 min) — dentro
      // de esa ventana, es MUY probable que la tienda siga sonando desde su caché local,
      // aunque no podamos confirmarlo con certeza (no hay forma de saberlo sin internet).
      var now=Date.now(),ONLINE_THRESHOLD_MS=260000,BUFFER_GRACE_MS=15*60*1000;
      lastRows=filteredStores.map(function(s){
        var p=presenceByStore[s.id];
        var msSince=p?now-new Date(p.last_seen).getTime():null;
        var online=!!p&&msSince<ONLINE_THRESHOLD_MS;
        var buffering=!!p&&!online&&msSince<BUFFER_GRACE_MS;
        var status=online?'online':(buffering?'buffering':'offline');
        var refTime=p?new Date(online?(p.connected_since||p.last_seen):p.last_seen).getTime():0;
        var stateHtml=online
          ?'🟢 Conectado desde '+formatClockTime(p.connected_since||p.last_seen)
          :buffering
            ?'🟡 Reproduciendo sin conexión (última señal hace '+Math.max(1,Math.round(msSince/60000))+' min)'
            :(p?'⚪ Desconectado desde '+formatClockTime(p.last_seen):'⚪ Sin conexión registrada');
        return{label:(s.username||'—')+' / '+(s.name||'—'),status:status,online:online,stateTime:refTime,stateHtml:stateHtml};
      });
      renderSummaryAndFilter();
      renderTable();
      box.dataset.loadedOnce='1';
    }catch(e){box.innerHTML='<div class="empty">Error: '+escapeHtml(e.message)+'</div>';}
  }

  groupSelect.onchange=function(){refreshZoneOptions();loadLiveTable();};
  zoneSelect.onchange=function(){loadLiveTable();};

  await setupClientStationSelector('liveClientFieldWrap','liveStationSelect',singleClient,allClients,function(clientId){
    currentClientId=clientId;
    groupSelect.value='';zoneSelect.innerHTML='<option value="">Todas</option>';
    document.getElementById('liveResultBox').dataset.loadedOnce='';
    loadLiveTable();
  });

  _monitoringInterval=setInterval(loadLiveTable,60000);
}

/* ===== CLIENT: SONOS (conectar los parlantes Sonos del cliente, sin dispositivo
   externo — ver CLAUDE.md sección "Integración Sonos" para el contexto completo) ===== */
function renderSonosPanel(){
  return '<h1>Sonos</h1>'
  +'<p class="subtitle">Conecta los parlantes Sonos del local para que reproduzcan tu programación directamente, sin ningún dispositivo adicional.</p>'
  +'<div class="panel" id="sonosStatusBox"><div class="muted">Cargando...</div></div>'
  +'<div class="panel" id="sonosSetupBox" style="margin-top:16px;display:none;"></div>';
}

async function bindSonosPanel(client){
  var statusBox=document.getElementById('sonosStatusBox');
  var setupBox=document.getElementById('sonosSetupBox');

  async function load(){
    try{
      var res=await API.sonos.status(client.id);
      if(!res.connection||res.connection.status!=='conectado'){
        statusBox.innerHTML='<p>Sonos no está conectado todavía.</p>'
          +'<a class="btn btn-primary" href="'+API.sonos.authStartUrl(client.id,client.station_id)+'">🔊 Conectar con Sonos</a>'
          +(res.connection&&res.connection.last_error?'<p class="muted" style="margin-top:10px;">Último error: '+escapeHtml(res.connection.last_error)+'</p>':'');
        setupBox.style.display='none';
        return;
      }
      statusBox.innerHTML='<p>✅ Conectado — hogar Sonos: <b>'+escapeHtml(res.connection.household_id||'—')+'</b></p>'
        +'<a class="btn btn-sm" href="'+API.sonos.authStartUrl(client.id,client.station_id)+'">Reconectar / cambiar cuenta</a>';

      var existing=res.groups||[];
      setupBox.style.display='';
      setupBox.innerHTML='<h3 style="margin-top:0;">Asignar parlantes a un Canal</h3><div class="muted" id="sonosGroupsLoading">Buscando parlantes...</div>';

      var groupsResp=await API.sonos.groups(client.id);
      var cd=await API.clientData.get(client.id);
      var chOptions=(cd.channels||[]).map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>';}).join('');
      if(!groupsResp.groups||groupsResp.groups.length===0){
        setupBox.innerHTML='<h3 style="margin-top:0;">Asignar parlantes a un Canal</h3><div class="empty">No se encontraron grupos de parlantes en esta cuenta Sonos.</div>';
        return;
      }
      if(!cd.channels||cd.channels.length===0){
        setupBox.innerHTML='<h3 style="margin-top:0;">Asignar parlantes a un Canal</h3><div class="empty">Primero el Administrador debe crear al menos un Playlist/Canal.</div>';
        return;
      }
      setupBox.innerHTML='<h3 style="margin-top:0;">Asignar parlantes a un Canal</h3>'
        +groupsResp.groups.map(function(g){
          var already=existing.find(function(e){return e.sonos_group_id===g.id;});
          return '<div class="row" style="align-items:center;margin-bottom:10px;">'
            +'<div style="min-width:220px;"><b>'+escapeHtml(g.name||g.id)+'</b>'+(already?' <span class="muted">(ya asignado)</span>':'')+'</div>'
            +'<select data-sonosgroup="'+g.id+'" style="margin-right:8px;">'+chOptions+'</select>'
            +'<button class="btn btn-sm" data-sonosassign="'+g.id+'">'+(already?'Actualizar':'Conectar')+'</button>'
            +'</div>';
        }).join('');
      if(existing.length){
        groupsResp.groups.forEach(function(g){
          var already=existing.find(function(e){return e.sonos_group_id===g.id;});
          if(already){var sel=setupBox.querySelector('[data-sonosgroup="'+g.id+'"]');if(sel)sel.value=already.channel_id;}
        });
      }
      setupBox.querySelectorAll('[data-sonosassign]').forEach(function(btn){
        btn.onclick=async function(){
          var groupId=btn.dataset.sonosassign;
          var sel=setupBox.querySelector('[data-sonosgroup="'+groupId+'"]');
          btn.disabled=true;btn.textContent='Conectando...';
          try{
            await API.sonos.connect({client_id:client.id,station_id:client.station_id||null,sonos_group_id:groupId,channel_id:sel.value});
            toast('✓ Parlante conectado. Debería empezar a sonar en un momento.');
            load();
          }catch(e){toast('Error: '+e.message);btn.disabled=false;btn.textContent='Conectar';}
        };
      });
    }catch(e){statusBox.innerHTML='<div class="empty">Error: '+escapeHtml(e.message)+'</div>';}
  }
  load();
}

function renderMonitoringTabs(activeTab){
  return'<div style="display:flex;gap:8px;margin-bottom:16px;">'
  +'<button class="btn btn-sm'+(activeTab==='live'?' btn-primary':'')+'" id="monTabLive">En vivo</button>'
  +'<button class="btn btn-sm'+(activeTab==='report'?' btn-primary':'')+'" id="monTabReport">Informe de conexión</button>'
  +'</div>';
}

function renderAdminMonitoring(){
  return'<h1>Monitoreo</h1>'+renderMonitoringTabs(_monitoringActiveTab)+'<div id="monitoringTabBody"></div>';
}
function bindAdminMonitoring(){
  function draw(){
    var body=document.getElementById('monitoringTabBody');
    stopMonitoringAutoRefresh();
    if(_monitoringActiveTab==='report'){
      body.innerHTML=renderConnectionReport();
      bindConnectionReport(null,appState.clients);
    }else{
      body.innerHTML=renderLiveMonitoring();
      bindLiveMonitoring(null,appState.clients);
    }
  }
  document.getElementById('monTabLive').onclick=function(){_monitoringActiveTab='live';refreshTabBtns();draw();};
  document.getElementById('monTabReport').onclick=function(){_monitoringActiveTab='report';refreshTabBtns();draw();};
  function refreshTabBtns(){
    document.getElementById('monTabLive').className='btn btn-sm'+(_monitoringActiveTab==='live'?' btn-primary':'');
    document.getElementById('monTabReport').className='btn btn-sm'+(_monitoringActiveTab==='report'?' btn-primary':'');
  }
  draw();
}

function bindClientMonitoringTabs(client){
  function draw(){
    var body=document.getElementById('monitoringTabBody');
    stopMonitoringAutoRefresh();
    if(_monitoringActiveTab==='report'){
      body.innerHTML=renderConnectionReport();
      bindConnectionReport(client,null);
    }else{
      body.innerHTML=renderLiveMonitoring();
      bindLiveMonitoring(client,null);
    }
  }
  document.getElementById('monTabLive').onclick=function(){_monitoringActiveTab='live';refreshTabButtons();draw();};
  document.getElementById('monTabReport').onclick=function(){_monitoringActiveTab='report';refreshTabButtons();draw();};
  function refreshTabButtons(){
    document.getElementById('monTabLive').className='btn btn-sm'+(_monitoringActiveTab==='live'?' btn-primary':'');
    document.getElementById('monTabReport').className='btn btn-sm'+(_monitoringActiveTab==='report'?' btn-primary':'');
  }
  draw();
}

var _monitoringActiveTab='live';

/* ===== Informe de conexión (histórico, por Estación y período) ===== */
function renderConnectionReport(){
  return'<div class="panel"><div class="row" style="align-items:flex-end;">'
  +'<div class="field" style="margin-bottom:0;" id="repClientFieldWrap"></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Estación</label><select id="repStationSelect"><option value="">Cargando...</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Región</label><select id="repGroupSelect"><option value="">Todas</option><option value="Lima">Lima</option><option value="Provincias">Provincias</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Zona</label><select id="repZoneSelect"><option value="">Todas</option></select></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Período</label><select id="repPeriodSelect">'
  +'<option value="today">Hoy</option><option value="last7">Últimos 7 días</option><option value="last30">Últimos 30 días</option><option value="month" selected>Este mes</option><option value="custom">Rango personalizado</option>'
  +'</select></div>'
  +'</div>'
  +'<div class="row" id="repCustomRangeRow" style="display:none;margin-top:8px;">'
  +'<div class="field" style="margin-bottom:0;"><label>Desde</label><input type="date" id="repFrom"></div>'
  +'<div class="field" style="margin-bottom:0;"><label>Hasta</label><input type="date" id="repTo"></div>'
  +'</div>'
  +'<div class="row" style="margin-top:10px;"><button class="btn btn-primary" id="btnRunReport" style="flex:0 0 auto;">Generar informe</button>'
  +'<button class="btn" id="btnExportXlsx" style="flex:0 0 auto;display:none;">⬇ Excel</button>'
  +'<button class="btn" id="btnExportPdf" style="flex:0 0 auto;display:none;">⬇ PDF</button></div>'
  +'</div>'
  +'<div id="reportResultBox" style="margin-top:18px;"></div>';
}

/* singleClient: si viene, es la vista del ejecutivo (una sola Estación posible por vez, sin selector de Negocio).
   allClients: si viene (vista admin), arma el selector Negocio->Estación con todos los clientes. */
/* Selector reutilizable Negocio->Estación. singleClient: vista del ejecutivo (ya trae sus
   estaciones). allClients: vista admin (arma también el desplegable de Negocio).
   onReady(clientId) se llama cada vez que cambia el contexto (Negocio, Estación, o al cargar). */
async function setupClientStationSelector(clientFieldWrapId,stationSelectId,singleClient,allClients,onReady){
  var stationSelect=document.getElementById(stationSelectId);
  var clientFieldWrap=document.getElementById(clientFieldWrapId);
  var stationsCache={};
  function fillStations(list){
    stationSelect.innerHTML='<option value="">Todas</option>'+list.map(function(s){return'<option value="'+s.id+'">'+escapeHtml(s.name||'Estación')+'</option>';}).join('');
  }
  async function loadStationsFor(clientId){
    if(!stationsCache[clientId])stationsCache[clientId]=await API.stations.list(clientId).catch(function(){return[];});
    fillStations(stationsCache[clientId]);
    if(onReady)onReady(clientId);
  }
  if(singleClient){
    fillStations(singleClient.stations||[]);
    /* Administrador de Cliente: no hay selector de Negocio (solo tiene uno), así que ese
       espacio se oculta por completo para que Estación/Región/Zona/Período se corran
       hacia la izquierda y no quede un hueco en blanco. */
    clientFieldWrap.style.display='none';
  }else{
    var selId=clientFieldWrapId+'_sel';
    clientFieldWrap.innerHTML='<label>Negocio</label><select id="'+selId+'">'+allClients.map(function(c){return'<option value="'+c.id+'">'+escapeHtml(c.business_name)+'</option>';}).join('')+'</select>';
    var clientSelect=document.getElementById(selId);
    clientSelect.onchange=function(){loadStationsFor(clientSelect.value);};
    if(allClients.length)await loadStationsFor(allClients[0].id);
  }
  stationSelect.onchange=function(){
    var cid=singleClient?singleClient.id:document.getElementById(clientFieldWrapId+'_sel').value;
    if(onReady)onReady(cid);
  };
  if(singleClient&&onReady)onReady(singleClient.id);
}

/* Trae las tiendas a considerar según lo elegido en el selector de Estación:
   una estación puntual, o (stationId==='') TODAS las estaciones del Negocio actual.
   Las tiendas marcadas "Inactiva" quedan siempre excluidas de Monitoreo. */
async function getActiveStoresForSelection(stationId,clientId){
  var stores;
  if(stationId){
    stores=await API.stores.list(stationId);
  }else{
    var stations=clientId?await API.stations.list(clientId).catch(function(){return[];}):[];
    var lists=await Promise.all(stations.map(function(st){return API.stores.list(st.id).catch(function(){return[];});}));
    stores=[].concat.apply([],lists);
  }
  return stores.filter(function(s){return!s.inactive;});
}

async function bindConnectionReport(singleClient,allClients){
  var stationSelect=document.getElementById('repStationSelect');
  var groupSelect=document.getElementById('repGroupSelect');
  var zoneSelect=document.getElementById('repZoneSelect');
  var allStoresForStation=[];

  function refreshZoneOptions(){
    var g=groupSelect.value;
    var pool=g?allStoresForStation.filter(function(s){return s.group_name===g;}):allStoresForStation;
    var zones=Array.from(new Set(pool.map(function(s){return s.zone;}).filter(Boolean))).sort();
    var current=zoneSelect.value;
    zoneSelect.innerHTML='<option value="">Todas</option>'+zones.map(function(z){return'<option value="'+escapeHtml(z)+'">'+escapeHtml(z)+'</option>';}).join('');
    if(zones.indexOf(current)!==-1)zoneSelect.value=current;
  }

  var currentReportClientId=singleClient?singleClient.id:null;
  await setupClientStationSelector('repClientFieldWrap','repStationSelect',singleClient,allClients,async function(clientId){
    currentReportClientId=clientId;
    var stationId=stationSelect.value;
    allStoresForStation=await getActiveStoresForSelection(stationId,currentReportClientId).catch(function(){return[];});
    groupSelect.value='';
    refreshZoneOptions();
  });

  groupSelect.onchange=refreshZoneOptions;

  var periodSelect=document.getElementById('repPeriodSelect');
  var customRow=document.getElementById('repCustomRangeRow');
  periodSelect.onchange=function(){customRow.style.display=periodSelect.value==='custom'?'':'none';};

  /* OJO — bug encontrado el 27/09: antes esta función armaba 'YYYY-MM-DDT00:00:00.000Z'
     pegándole la Z (UTC) a una fecha calendario que en realidad es la fecha LOCAL del
     navegador (localDateStr usa getFullYear/getMonth/getDate, que son hora local). Eso
     hacía que "medianoche local" y "medianoche UTC" NO fueran el mismo instante — con
     un usuario en UTC-4 (Bolivia), el rango de "Hoy" terminaba en realidad a las 19:59:59
     hora local (4 horas antes de la medianoche real), no a las 23:59:59.
     La consecuencia era grave y silenciosa: en connection-report.js, "reportIncludesNow"
     (¿el rango pedido llega hasta el presente?) se volvía FALSO en cuanto pasaban las
     ~20:00 hora local — y esa bandera es la que activa el cálculo de "sigue caída ahora
     mismo, aunque todavía no se registró el evento de desconexión". Con la bandera en
     falso, cualquier tienda que se hubiera desconectado y no vuelto a conectar ese día
     quedaba SIN ese tiempo de caída contado — mostrando 100% / 0 desconexiones aunque
     estuviera desconectada desde hace horas (exactamente el caso reportado: TQ3-FOOT
     desconectada desde las 15:34 y el informe mostrando 100%, 0, 0min, 0min).
     Arreglo: construir los límites del día con el constructor de Date (que sí interpreta
     año/mes/día/hora en la hora LOCAL del navegador) y convertir con toISOString(), que
     hace la conversión a UTC correctamente sin importar el huso horario del que use esta
     pantalla. */
  function startOfLocalDay(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate(),0,0,0,0);}
  function endOfLocalDay(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59,999);}
  function getRange(){
    var now=new Date();
    var todayEndIso=endOfLocalDay(now).toISOString();
    if(periodSelect.value==='today')return[startOfLocalDay(now).toISOString(),todayEndIso];
    if(periodSelect.value==='last7'){
      var d=new Date(now);d.setDate(d.getDate()-6);
      return[startOfLocalDay(d).toISOString(),todayEndIso];
    }
    if(periodSelect.value==='last30'){
      var d2=new Date(now);d2.setDate(d2.getDate()-29);
      return[startOfLocalDay(d2).toISOString(),todayEndIso];
    }
    if(periodSelect.value==='month'){
      var d3=new Date(now.getFullYear(),now.getMonth(),1);
      return[startOfLocalDay(d3).toISOString(),todayEndIso];
    }
    var f=document.getElementById('repFrom').value,t=document.getElementById('repTo').value;
    if(!f||!t)return null;
    var fp=f.split('-').map(Number),tp=t.split('-').map(Number);
    var fDate=new Date(fp[0],fp[1]-1,fp[2],0,0,0,0);
    var tDate=new Date(tp[0],tp[1]-1,tp[2],23,59,59,999);
    return[fDate.toISOString(),tDate.toISOString()];
  }

  var lastReportData=null,lastStationLabel='';

  document.getElementById('btnRunReport').onclick=async function(){
    var stationId=stationSelect.value;
    if(!currentReportClientId){toast('Selecciona un Negocio.');return;}
    var range=getRange();
    if(!range){toast('Completa el rango de fechas.');return;}
    var box=document.getElementById('reportResultBox');
    box.innerHTML='<div class="muted">Generando informe...</div>';
    try{
      var result;
      if(stationId){
        result=await API.connectionReport.get(stationId,range[0],range[1]);
      }else{
        // "Todas" las Estaciones: se pide el informe de cada una y se combinan.
        var stations=await API.stations.list(currentReportClientId).catch(function(){return[];});
        var chunks=await Promise.all(stations.map(function(st){return API.connectionReport.get(st.id,range[0],range[1]).catch(function(){return{rows:[],partialNote:null};});}));
        // Si CUALQUIERA de las estaciones dice "todavía no hay datos confiables", se
        // muestra ese aviso para el conjunto entero — mezclar estaciones confiables con
        // otras que no lo son daría una foto incompleta y engañosa.
        var notReadyChunk=chunks.find(function(c){return c&&c.notReady;});
        if(notReadyChunk)result=notReadyChunk;
        else{
          var firstNote=chunks.map(function(c){return c&&c.partialNote;}).find(function(n){return!!n;})||null;
          result={rows:[].concat.apply([],chunks.map(function(c){return(c&&c.rows)||[];})),partialNote:firstNote};
        }
      }
      if(result&&result.notReady){
        box.innerHTML='<div class="empty" style="line-height:1.6;">⏳ '+escapeHtml(result.message)+'</div>';
        document.getElementById('btnExportXlsx').style.display='none';
        document.getElementById('btnExportPdf').style.display='none';
        return;
      }
      var rows=result.rows;
      rows=rows.filter(function(r){return!r.inactive;});
      var g=groupSelect.value,z=zoneSelect.value;
      if(g)rows=rows.filter(function(r){return r.group_name===g;});
      if(z)rows=rows.filter(function(r){return r.zone===z;});
      lastReportData=rows;lastStationLabel=stationSelect.options[stationSelect.selectedIndex].textContent;
      var noteHtml=result.partialNote?'<div class="empty" style="line-height:1.6;margin-bottom:12px;">ℹ️ '+escapeHtml(result.partialNote)+'</div>':'';
      box.innerHTML=noteHtml+'<div id="reportBelowNote"></div>';
      renderReportTable(document.getElementById('reportBelowNote'),rows);
      document.getElementById('btnExportXlsx').style.display='';
      document.getElementById('btnExportPdf').style.display='';
    }catch(e){box.innerHTML='<div class="empty">Error: '+escapeHtml(e.message)+'</div>';}
  };

  function renderReportTable(box,rows){
    if(rows.length===0){box.innerHTML='<div class="empty">No hay tiendas con ese filtro.</div>';return;}
    rows.forEach(function(r){r.label=r.username+' / '+r.store_name;});
    box.innerHTML='<div id="reportSortableWrap"></div>';
    var columns=[
      {key:'online',label:''},{key:'label',label:'Usuario / Tienda'},{key:'uptimePct',label:'Uptime'},
      {key:'disconnections',label:'Desconexión'},{key:'downtimeMinutes',label:'Tiempo Desconexión'},{key:'longestDowntimeMinutes',label:'Mayor Desconexión'}
    ];
    makeSortableTable('reportSortableWrap',columns,rows,function(r){
      var dot=r.online?'🟢':'🔴';
      var pctColor=r.uptimePct>=95?'#1F7A41':(r.uptimePct>=80?'var(--amber)':'var(--red)');
      return'<tr><td>'+dot+'</td><td>'+escapeHtml(r.username)+' / '+escapeHtml(r.store_name)+'</td>'
      +'<td style="color:'+pctColor+';font-weight:700;">'+r.uptimePct+'%</td>'
      +'<td>'+r.disconnections+'</td><td>'+formatLongDuration(r.downtimeMinutes*60)+'</td><td>'+formatLongDuration(r.longestDowntimeMinutes*60)+'</td></tr>';
    },'label');
  }

  document.getElementById('btnExportXlsx').onclick=function(){
    if(!lastReportData)return;
    var wsData=[['En línea','Usuario / Tienda','Uptime %','Desconexión','Tiempo Desconexión (min)','Mayor Desconexión (min)']];
    lastReportData.forEach(function(r){wsData.push([r.online?'Conexión':'Desconexión',r.username+' / '+r.store_name,r.uptimePct,r.disconnections,r.downtimeMinutes,r.longestDowntimeMinutes]);});
    var ws=XLSX.utils.aoa_to_sheet(wsData);
    var wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Informe de conexión');
    XLSX.writeFile(wb,'informe-conexion-'+lastStationLabel.replace(/[^a-z0-9]+/gi,'-')+'.xlsx');
  };
  document.getElementById('btnExportPdf').onclick=function(){
    if(!lastReportData)return;
    var doc=new jspdf.jsPDF();
    doc.setFontSize(14);doc.text('Informe de conexión — '+lastStationLabel,14,16);
    doc.setFontSize(9);
    var y=26;
    doc.text('En línea',14,y);doc.text('Usuario / Tienda',34,y);doc.text('Uptime',110,y);doc.text('Desc.',130,y);doc.text('T. Desconexión',148,y);doc.text('Mayor Desc.',180,y);
    y+=6;
    lastReportData.forEach(function(r){
      if(y>280){doc.addPage();y=16;}
      doc.text(r.online?'Conexión':'Desconexión',14,y);
      doc.text((r.username+' / '+r.store_name).slice(0,38),34,y);
      doc.text(r.uptimePct+'%',110,y);
      doc.text(String(r.disconnections),130,y);
      doc.text(formatLongDuration(r.downtimeMinutes*60),148,y);
      doc.text(formatLongDuration(r.longestDowntimeMinutes*60),180,y);
      y+=6;
    });
    doc.save('informe-conexion-'+lastStationLabel.replace(/[^a-z0-9]+/gi,'-')+'.pdf');
  };
}

/* ===== CLIENT SHELL ===== */
function renderClientShell(route,client){
  var steps=[{key:'player',num:1,label:'Reproductor',route:'/client/player'}];
  if(!client.only_player)steps.push({key:'downloads',num:steps.length+1,label:'Mis Descargas',route:'/client/downloads'});
  if(client.is_exec)steps.push({key:'ads',num:steps.length+1,label:'Mis Anuncios',route:'/client/ads'});
  if(client.is_exec)steps.push({key:'monitoring',num:steps.length+1,label:'Monitoreo',route:'/client/monitoring'});
  if(client.is_exec)steps.push({key:'sonos',num:steps.length+1,label:'Sonos',route:'/client/sonos'});
  var active=steps.find(function(s){return route.startsWith(s.route);})||steps[0];
  var stationSelector='';
  if(client.is_exec){
    if(client.stations.length===0){
      stationSelector='<span class="badge bloqueada" style="font-size:11px;">Sin estaciones configuradas</span>';
    }else{
      stationSelector='<select id="stationSelector" style="width:auto;padding:6px 10px;font-size:12.5px;">'
      +client.stations.map(function(s){return'<option value="'+s.id+'"'+(s.id===client.station_id?' selected':'')+'>'+escapeHtml(s.name||'Estación')+'</option>';}).join('')
      +'</select>';
    }
  }
  var clientLogoSrc='img/logo-ponmusic.png';
  var clientLogoAlt='PonMusic';
  return'<div class="topbar">'
  +'<div class="brand"><img src="'+clientLogoSrc+'" alt="'+clientLogoAlt+'" class="brand-logo"></div>'
  +'<div class="userbox">'
  +'<span><b>'+escapeHtml(client.business_name)+'</b>'+(client.is_exec?(client.station_name?' · '+escapeHtml(client.station_name):''):(' · '+escapeHtml(client.station_name||'')+' / '+escapeHtml(client.store_name||'')))+'</span>'
  +stationSelector
  +'<span id="onlineBadge" style="font-size:12px;font-weight:700;">'+(appState.isOnline?'🟢 Online':'🔴 Offline')+'</span>'
  +(playerEngine&&playerEngineClientId===(client.id+':'+(client.station_id||'')+':'+(client.store_id||''))?'<span class="badge activa" style="font-size:11px;">▶ Reproduciendo</span>':'')
  +'<button class="btn btn-sm" id="btnLogout">Cerrar sesión</button>'
  +'</div></div>'
  +'<div class="layout"><div class="sidebar">'
  +steps.map(function(s){return'<div class="step '+(s.key===active.key?'active':'')+'" data-go="'+s.route+'"><span class="num">'+s.num+'</span>'+s.label+'</div>';}).join('')
  +renderClientLogoBox(client)
  +'</div><div class="main" id="clientMain"></div></div>';
}

/* ===== Logotipo (solo lectura): usa el de la Tienda si tiene, si no el de la
   Estación, si no el del Negocio — el más específico disponible en cada caso. */
function renderClientLogoBox(client){
  var logo=client.store_logo||client.station_logo||client.logo_data;
  if(!logo)return'';
  return'<div class="sidebar-logo-wrap">'
  +'<div class="sidebar-divider"></div>'
  +'<div class="client-logo-preview readonly"><img src="'+logo+'" alt="Logo"></div>'
  +'</div>';
}

function bindClientShell(route,client){
  document.getElementById('btnLogout').onclick=logout;
  document.querySelectorAll('.sidebar .step').forEach(function(el){el.onclick=function(){go(el.dataset.go);render();};});
  var sel=document.getElementById('stationSelector');
  if(sel){
    sel.onchange=async function(){
      setActiveStationId(client.id,sel.value);
      if(!_execStationStoresCache[sel.value])await loadStationStoresForExec(sel.value);
      destroyPlayerEngine();
      render();
    };
  }
  var main=document.getElementById('clientMain');
  if(!route.startsWith('/client/monitoring'))stopMonitoringAutoRefresh();
  if(route.startsWith('/client/downloads')&&!client.only_player){main.innerHTML=renderDownloads(client);bindDownloads(client);}
  else if(route.startsWith('/client/ads')&&client.is_exec){main.innerHTML=renderClientAds(client);bindClientAds(client);}
  else if(route.startsWith('/client/monitoring')&&client.is_exec){main.innerHTML='<h1>Monitoreo</h1>'+renderMonitoringTabs(_monitoringActiveTab)+'<div id="monitoringTabBody"></div>';bindClientMonitoringTabs(client);}
  else if(route.startsWith('/client/sonos')&&client.is_exec){main.innerHTML=renderSonosPanel();bindSonosPanel(client);}
  else{main.innerHTML=renderClientPlayer(client);bindClientPlayer(client);}
}

/* ===== CLIENT: MIS DESCARGAS ===== */
function renderDownloads(client){
  if(client.is_exec&&!client.store_id)return'<h1>Mis Descargas</h1><div class="empty">Selecciona una tienda arriba para descargar su contenido.</div>';
  return'<h1>Mis Descargas</h1>'
  +'<p class="subtitle">Descarga la música de <b>'+escapeHtml(client.store_name?client.store_name:'tu playlist')+'</b> al dispositivo para reproducir sin internet.</p>'
  +'<div class="panel" id="syncStatusPanel">'
  +'<div class="section-title">Estado de almacenamiento local</div>'
  +'<div id="syncStatus"><div class="muted">Verificando...</div></div>'
  +'</div>'
  +'<div class="panel" style="margin-top:18px;">'
  +'<div class="section-title">Acciones</div>'
  +'<div class="row" style="flex-wrap:wrap;gap:10px;">'
  +(appState.isOnline
    ?'<button class="btn btn-primary" id="btnSync">⬇ Sincronizar ahora</button>'
    :'<button class="btn" disabled>⬇ Sincronizar (sin conexión)</button>')
  +'<button class="btn btn-danger" id="btnClearCache">🗑 Limpiar almacenamiento</button>'
  +'</div>'
  +'<div id="syncProgress" style="margin-top:16px;display:none;">'
  +'<div class="ubar-track" style="margin-bottom:8px;"><div class="ubar-fill" id="syncFill"></div></div>'
  +'<div id="syncMsg" style="font-size:13px;color:var(--ink-soft);"></div>'
  +'</div>'
  +'</div>';
}

function bindDownloads(client){
  // Mostrar estado actual
  updateDownloadStatus();

  OfflineSync.onProgress(function(state){
    var fill=document.getElementById('syncFill');
    var msg=document.getElementById('syncMsg');
    var prog=document.getElementById('syncProgress');
    if(!fill||!msg)return;
    prog.style.display='block';
    fill.style.width=(state.progress||0)+'%';
    msg.textContent=state.message||'';
    if(state.phase==='done'||state.phase==='error'||state.phase==='cancelled'){
      setTimeout(function(){updateDownloadStatus();},1000);
    }
  });

  var btnSync=document.getElementById('btnSync');
  if(btnSync){
    btnSync.onclick=async function(){
      btnSync.disabled=true;btnSync.textContent='Sincronizando...';
      try{
        var adminData=getAdminData();
        await OfflineSync.sync(appState.library,adminData,appState.clientAds||{ads:[],adSchedule:[]},client);
      }finally{
        if(document.getElementById('btnSync')){btnSync.disabled=false;btnSync.textContent='⬇ Sincronizar ahora';}
      }
    };
  }

  var btnClear=document.getElementById('btnClearCache');
  if(btnClear){
    btnClear.onclick=async function(){
      if(!confirm('¿Eliminar todo el almacenamiento offline? Necesitarás volver a sincronizar para usar sin internet.'))return;
      await OfflineSync.clearAll();
      toast('Almacenamiento offline eliminado.');
      updateDownloadStatus();
    };
  }
}

async function updateDownloadStatus(){
  var panel=document.getElementById('syncStatus');
  if(!panel)return;
  var status=await OfflineSync.getCacheStatus();
  var lastSync=await OfflineDB.getConfig('lastSync');
  var hasData=await OfflineSync.hasOfflineData();
  var lastSyncText=lastSync?'Última sincronización: '+new Date(lastSync).toLocaleString():'Nunca sincronizado';
  // Anuncios propios: cuántos hay registrados (Mis Anuncios) vs. cuántos quedaron
  // efectivamente en el almacenamiento local, para detectar a simple vista si alguno
  // no llegó a descargarse.
  var savedClientAds=await OfflineDB.getConfig('clientAds');
  var adsRegistered=(savedClientAds&&savedClientAds.ads)?savedClientAds.ads.length:0;
  var cachedUrlSet={};(status.urls||[]).forEach(function(u){cachedUrlSet[u]=true;});
  var adsCached=adsRegistered?(savedClientAds.ads.filter(function(a){return a.url&&cachedUrlSet[a.url];}).length):0;
  var adsLine=adsRegistered
    ?'<div class="muted" style="font-size:12px;margin-top:4px;">Anuncios propios: '+adsCached+' de '+adsRegistered+' disponibles offline'+(adsCached<adsRegistered?' ⚠️':'')+'</div>'
    :'<div class="muted" style="font-size:12px;margin-top:4px;">Anuncios propios: ninguno registrado en "Mis Anuncios"</div>';
  panel.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:center;">'
  +'<div style="min-width:260px;"><div style="font-size:15px;font-weight:700;color:#1F7A41;">'+(hasData?'✓ Sincronización y Descarga Completadas':'')+'</div>'+adsLine+'</div>'
  +'<div><div class="section-title" style="margin-bottom:4px;">Espacio usado</div><div style="font-size:22px;font-weight:700;color:var(--teal);">'+OfflineSync.formatBytes(status.bytes)+'</div></div>'
  +'<div><div class="section-title" style="margin-bottom:4px;">Estado</div>'
  +'<div style="font-size:14px;font-weight:700;color:'+(hasData?'#1F7A41':'#B5483C')+'">'
  +(hasData?'✓ Listo para funcionar offline':'✗ No disponible offline')+'</div>'
  +'<div class="muted" style="font-size:12px;">'+lastSyncText+'</div>'
  +'</div></div>';
}

/* ===== CLIENT: MIS ANUNCIOS ===== */
function formatDateLabel(dateStr){
  try{
    var d=new Date(dateStr+'T00:00:00');
    var label=d.toLocaleDateString('es-ES',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    return label.charAt(0).toUpperCase()+label.slice(1);
  }catch(e){return dateStr;}
}

/* Un anuncio "cada N canciones" puede opcionalmente restringirse a ciertos días
   del calendario y/o un rango de horas. Sin restricción configurada, está activo siempre. */
function isFreqScheduleActiveNow(s){
  var now=new Date();
  if(s.dates&&s.dates.length>0){
    var todayStr=localDateStr(now);
    if(s.dates.indexOf(todayStr)===-1)return false;
  }
  if(s.startTime&&s.endTime){
    var hhmm=now.toTimeString().slice(0,5);
    if(hhmm<s.startTime||hhmm>s.endTime)return false;
  }
  return true;
}

/* ===== Calendario visual para programar anuncios (clic para marcar días, con saltos) ===== */
var MONTH_NAMES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
var WEEKDAY_LETTERS=['L','M','X','J','V','S','D'];
var _adCalendar=null;
function getAdCalendarState(){
  if(!_adCalendar){
    var now=new Date();
    _adCalendar={year:now.getFullYear(),month:now.getMonth(),selectedDates:new Set(),pendingAnchor:null};
  }
  return _adCalendar;
}

function renderCalendarWidget(cal){
  var year=cal.year,month=cal.month;
  var first=new Date(year,month,1);
  var startOffset=(first.getDay()+6)%7; // 0=lunes
  var daysInMonth=new Date(year,month+1,0).getDate();
  var todayStr=localDateStr();
  var cells='';
  for(var i=0;i<startOffset;i++)cells+='<div class="cal-cell cal-empty"></div>';
  for(var day=1;day<=daysInMonth;day++){
    var ds=year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    var selected=cal.selectedDates.has(ds);
    var isAnchor=cal.pendingAnchor===ds;
    var isPast=ds<todayStr;
    cells+='<div class="cal-cell'+(selected?' cal-selected':'')+(isAnchor?' cal-anchor':'')+(isPast?' cal-past':'')+'" data-caldate="'+ds+'">'+day+'</div>';
  }
  var statusText=cal.pendingAnchor
    ?'Haz clic en otro día para pintar el rango'
    :cal.selectedDates.size+' día(s) seleccionado(s)';
  return'<div class="cal-widget">'
  +'<div class="cal-header"><button type="button" class="btn btn-sm" id="calPrev">‹</button>'
  +'<b>'+MONTH_NAMES[month]+' '+year+'</b>'
  +'<button type="button" class="btn btn-sm" id="calNext">›</button></div>'
  +'<div class="cal-grid cal-weekdays">'+WEEKDAY_LETTERS.map(function(w){return'<div class="cal-cell cal-wd">'+w+'</div>';}).join('')+'</div>'
  +'<div class="cal-grid">'+cells+'</div>'
  +'<div class="flex-between" style="margin-top:10px;margin-bottom:0;"><span class="muted" id="calSelCount">'+statusText+'</span>'
  +'<button type="button" class="btn btn-sm" id="calClear">Limpiar selección</button></div>'
  +'<p class="muted" style="font-size:11px;margin:8px 0 0;">Clic en un día para marcarlo; clic en un segundo día para pintar todo el rango entre ambos. Clic en un día ya marcado lo destickea individualmente.</p>'
  +'</div>';
}

function refreshCalendar(container,cal,onChange){
  container.innerHTML=renderCalendarWidget(cal);
  container.querySelector('#calPrev').onclick=function(){cal.month--;if(cal.month<0){cal.month=11;cal.year--;}refreshCalendar(container,cal,onChange);};
  container.querySelector('#calNext').onclick=function(){cal.month++;if(cal.month>11){cal.month=0;cal.year++;}refreshCalendar(container,cal,onChange);};
  container.querySelector('#calClear').onclick=function(){cal.selectedDates.clear();cal.pendingAnchor=null;refreshCalendar(container,cal,onChange);if(onChange)onChange();};
  container.querySelectorAll('[data-caldate]').forEach(function(cell){
    cell.onclick=function(){
      var ds=cell.dataset.caldate;
      if(cal.selectedDates.has(ds)){
        // Ya estaba marcado: lo destickeamos individualmente (sirve para excluir días sueltos dentro de un rango).
        cal.selectedDates.delete(ds);
        if(cal.pendingAnchor===ds)cal.pendingAnchor=null;
      }else if(cal.pendingAnchor){
        // Segundo clic: pintar todo el rango entre el ancla y este día (en cualquier orden).
        var a=cal.pendingAnchor<ds?cal.pendingAnchor:ds;
        var b=cal.pendingAnchor<ds?ds:cal.pendingAnchor;
        for(var d=new Date(a+'T00:00:00');d<=new Date(b+'T00:00:00');d.setDate(d.getDate()+1)){
          cal.selectedDates.add(localDateStr(d));
        }
        cal.pendingAnchor=null;
      }else{
        // Primer clic: marca este día y queda como ancla, a la espera de un segundo clic para completar el rango.
        cal.selectedDates.add(ds);
        cal.pendingAnchor=ds;
      }
      refreshCalendar(container,cal,onChange);
      if(onChange)onChange();
    };
  });
}

function describeStoreTargeting(storeIds,stores){
  if(!storeIds||storeIds.length===0)return'Todas las tiendas';
  var names=storeIds.map(function(id){var s=stores.find(function(x){return x.id===id;});return s?s.name:'?';});
  return names.length+' tienda(s): '+names.join(', ');
}
function describeAdSet(adIds,adsList){
  var ids=(adIds&&adIds.length)?adIds:[];
  var titles=ids.map(function(id){var a=adsList.find(function(x){return x.id===id;});return a?a.title:'?';});
  if(titles.length===0)return'?';
  if(titles.length<=2)return titles.join(' + ');
  return titles.length+' anuncios';
}

function renderClientAds(client){
  if(!client.station_id)return'<h1>Mis Anuncios</h1><div class="empty">Selecciona una Estación arriba para administrar sus anuncios (o pide al administrador que te asigne al menos una).</div>';
  var ads=appState.clientAds||{ads:[],adSchedule:[]};
  var adSchedule=ads.adSchedule||[];
  var stores=client.stationStores||[];
  var timeSchedule=adSchedule.filter(function(s){return s.mode!=='frequency';});
  var freqSchedule=adSchedule.filter(function(s){return s.mode==='frequency';});
  var adCheckboxes=(ads.ads||[]).map(function(a){
    return'<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">'
    +'<input type="checkbox" class="ad-pick-check" data-adcheck="'+a.id+'" style="width:auto;">'
    +'<label style="margin:0;text-transform:none;font-weight:400;flex:1;">'+escapeHtml(a.title)+' <span class="muted">('+formatDuration(a.duration)+')</span></label>'
    +'</div>';
  }).join('');
  var storeCheckboxes=stores.map(function(s){
    return'<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">'
    +'<input type="checkbox" class="ad-store-check" data-storecheck="'+s.id+'" style="width:auto;">'
    +'<label style="margin:0;text-transform:none;font-weight:400;">'+escapeHtml(s.name||'Tienda')+'</label>'
    +'</div>';
  }).join('');

  // Agrupar la programación por "tanda" (todo lo creado en un mismo clic de "+ Programar"),
  // para poder verla y borrarla como un solo bloque en vez de horario por horario.
  var batches={};
  timeSchedule.forEach(function(s){
    var bId=s.batchId||s.id;
    if(!batches[bId])batches[bId]=[];
    batches[bId].push(s);
  });
  var batchList=Object.keys(batches).map(function(bId){
    var entries=batches[bId];
    var dates=Array.from(new Set(entries.map(function(e){return e.date;}))).sort();
    var times=Array.from(new Set(entries.map(function(e){return e.time;}))).sort();
    return{
      batchId:bId,
      adLabel:describeAdSet(entries[0].adIds,ads.ads||[]),
      storeLabel:describeStoreTargeting(entries[0].storeIds,stores),
      countPerTrigger:entries[0].countPerTrigger||1,order:entries[0].order||'sequence',
      dateCount:dates.length,dateFrom:dates[0],dateTo:dates[dates.length-1],
      timeCount:times.length,timeFrom:times[0],timeTo:times[times.length-1],
      total:entries.length
    };
  }).sort(function(a,b){return(a.dateFrom||'').localeCompare(b.dateFrom||'');});
  var batchRows=batchList.map(function(b){
    var dateLabel=b.dateCount>1?b.dateCount+' días ('+formatDateLabel(b.dateFrom)+' – '+formatDateLabel(b.dateTo)+')':formatDateLabel(b.dateFrom);
    var timeLabel=b.timeCount>1?b.timeCount+' horarios ('+b.timeFrom+'–'+b.timeTo+')':b.timeFrom;
    return'<tr><td><b>'+escapeHtml(b.adLabel)+'</b><div class="muted" style="font-size:11px;">'+(b.countPerTrigger)+' por vez · '+(b.order==='random'?'aleatorio':'secuencia')+'</div></td>'
    +'<td>'+escapeHtml(b.storeLabel)+'</td>'
    +'<td>'+dateLabel+'</td><td>'+timeLabel+'</td><td class="muted">'+b.total+' horario(s)</td>'
    +'<td><button class="btn btn-sm btn-danger" data-delbatch="'+b.batchId+'" data-batchcount="'+b.total+'">🗑 Eliminar todo</button></td></tr>';
  }).join('');

  var byDate={};
  timeSchedule.forEach(function(s){var d=s.date||'—';if(!byDate[d])byDate[d]=[];byDate[d].push(s);});
  var sortedDates=Object.keys(byDate).sort();
  Object.keys(byDate).forEach(function(d){byDate[d].sort(function(a,b){return a.time.localeCompare(b.time);});});
  var dateBlocks=sortedDates.map(function(d){
    var items=byDate[d].map(function(s){
      return'<div class="queue-item"><span>'+s.time+' &nbsp;·&nbsp; <b>'+escapeHtml(describeAdSet(s.adIds,ads.ads||[]))+'</b> <span class="muted">('+escapeHtml(describeStoreTargeting(s.storeIds,stores))+')</span></span>'
      +'<button class="remove-x" data-delad="'+s.id+'">✕</button></div>';
    }).join('');
    return'<div class="panel"><div class="section-title">'+formatDateLabel(d)+'</div>'+items+'</div>';
  }).join('');
  var freqItems=freqSchedule.map(function(s){
    var restriction='';
    if(s.dates&&s.dates.length)restriction+=' · '+s.dates.length+' día(s)'+(s.dates.length<=3?' ('+s.dates.map(formatDateLabel).join(', ')+')':'');
    if(s.startTime&&s.endTime)restriction+=' · '+s.startTime+'–'+s.endTime;
    return'<div class="queue-item"><span>Cada '+s.everyN+' canción(es)'+restriction+' &nbsp;·&nbsp; <b>'+escapeHtml(describeAdSet(s.adIds,ads.ads||[]))+'</b> <span class="muted">('+(s.countPerTrigger||1)+' por vez, '+(s.order==='random'?'aleatorio':'secuencia')+' · '+escapeHtml(describeStoreTargeting(s.storeIds,stores))+')</span></span>'
    +'<button class="remove-x" data-delad="'+s.id+'">✕</button></div>';
  }).join('');

  return'<h1>Mis Anuncios</h1>'
  +(appState.isOnline?''
  :'<div style="background:var(--amber-soft);color:var(--amber);padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;">⚡ Sin conexión — puedes ver tus anuncios pero no subir nuevos hasta tener internet.</div>')
  +'<div class="panel">'
  +(appState.isOnline
    ?'<div class="section-title">Subir nuevos anuncios</div>'
    +'<div class="dropzone" id="dropAds"><div style="font-size:22px;margin-bottom:4px;">⬆</div>'
    +'Arrastra archivos .mp3 o haz clic para seleccionar'
    +'<input type="file" id="fileInputAds" accept="audio/mpeg,.mp3" multiple style="display:none"></div>'
    :'<div class="muted">Sube anuncios cuando tengas conexión.</div>')
  +'</div>'
  +'<div class="panel" style="margin-top:18px;"><div class="section-title">Mis archivos de anuncio</div>'
  +((ads.ads||[]).length===0?'<div class="empty">Aún no tienes anuncios.</div>'
  :'<table><thead><tr><th>Título</th><th>Duración</th><th>Acciones</th></tr></thead><tbody>'
  +(ads.ads||[]).map(function(a){return'<tr><td><b>'+escapeHtml(a.title)+'</b></td><td>'+formatDuration(a.duration)+'</td>'
    +'<td><button class="btn btn-sm" data-previewad="'+a.id+'">▶ Escuchar</button>'
    +'<button class="btn btn-sm btn-danger" data-delad2="'+a.id+'">Eliminar</button></td></tr>';}).join('')
  +'</tbody></table>')
  +'</div>'
  +'<div class="panel" style="margin-top:18px;"><div class="section-title">Programar anuncio(s)</div>'
  +((ads.ads||[]).length===0?'<div class="muted">Primero sube al menos un anuncio.</div>'
  :'<div class="field"><label>Tiendas objetivo</label>'
    +'<div style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="adStoreAll" checked style="width:auto;">'
    +'<label for="adStoreAll" style="margin:0;text-transform:none;font-weight:600;color:var(--ink);">Todas las tiendas</label></div>'
    +(stores.length>0?'<div id="adStoreIndividualWrap" style="display:none;padding:8px 0 0 24px;border-left:2px solid var(--bg-soft);margin-top:6px;">'+storeCheckboxes+'</div>'
      :'<p class="muted" style="font-size:11.5px;margin:6px 0 0;">Aún no tienes tiendas creadas.</p>')
    +'</div>'
  +'<div class="field" style="max-width:320px;"><label>Modo de programación</label><select id="adMode">'
    +'<option value="time">Fecha y hora específica</option>'
    +'<option value="frequency">Repetir cada N canciones</option>'
    +'</select></div>'
  +'<div id="adCalendarBox" style="margin-bottom:14px;"></div>'
  +'<div class="row"><div class="field"><label>Hora desde</label><input type="time" id="adTimeFrom" value="11:30"></div>'
  +'<div class="field"><label>Hora hasta (opcional)</label><input type="time" id="adTimeTo"></div>'
  +'<div class="field" id="adIntervalField"><label>Repetir cada (dentro del rango)</label><select id="adInterval">'
    +'<option value="">Una sola vez</option>'
    +'<option value="10">Cada 10 minutos</option><option value="15">Cada 15 minutos</option>'
    +'<option value="20">Cada 20 minutos</option><option value="30">Cada 30 minutos</option>'
    +'<option value="60">Cada 60 minutos</option>'
    +'</select></div></div>'
  +'<div class="row" id="adRowFreq" style="display:none;"><div class="field" style="max-width:220px;"><label>Repetir cada</label><select id="adEveryN">'
    +[1,2,3,4,5,6].map(function(n){return'<option value="'+n+'">'+n+' canción(es)</option>';}).join('')
    +'</select></div></div>'
  +'<div class="field"><label>Anuncios a programar (marca uno o varios)</label><div id="adCheckList" style="border:1px solid var(--bg-soft);border-radius:8px;padding:8px 12px;max-height:220px;overflow-y:auto;">'+adCheckboxes+'</div></div>'
  +'<div class="row"><div class="field" style="max-width:220px;"><label>Cuántos anuncios por vez</label><select id="adCountPerTrigger"><option value="1">1</option></select></div>'
  +'<div class="field" style="max-width:220px;"><label>Orden</label><select id="adOrder"><option value="sequence">En secuencia</option><option value="random">Aleatorio</option></select></div>'
  +'<div class="field" style="flex:0 0 auto;align-self:flex-end;"><button class="btn btn-primary" id="btnAddAdSched">+ Programar</button></div></div>'
  +'<p class="muted" id="adModeHint" style="margin:10px 0 0;font-size:12px;"></p>')
  +'</div>'
  +(batchList.length>0?'<div class="panel" style="margin-top:18px;"><div class="section-title">Programaciones creadas (fecha y hora)</div>'
    +'<p class="muted" style="margin:-6px 0 12px;">Cada fila es una tanda completa — bórrala de un solo clic sin tener que borrar horario por horario.</p>'
    +'<table><thead><tr><th>Anuncio(s)</th><th>Tiendas</th><th>Días</th><th>Horarios</th><th></th><th></th></tr></thead><tbody>'+batchRows+'</tbody></table></div>':'')
  +(freqSchedule.length>0?'<div class="panel" style="margin-top:18px;"><div class="section-title">Anuncios por frecuencia</div>'+freqItems+'</div>':'')
  +(dateBlocks?'<div class="panel" style="margin-top:18px;"><div class="section-title">Detalle día por día</div>'+dateBlocks+'</div>':'');
}

function bindClientAds(client){
  var stores=client.stationStores||[];
  var drop=document.getElementById('dropAds'),input=document.getElementById('fileInputAds');
  if(drop){
    drop.onclick=function(){input.click();};
    drop.ondragover=function(e){e.preventDefault();drop.classList.add('drag');};
    drop.ondragleave=function(){drop.classList.remove('drag');};
    drop.ondrop=function(e){e.preventDefault();drop.classList.remove('drag');uploadClientAds(e.dataTransfer.files,client);};
    input.onchange=function(){uploadClientAds(input.files,client);};
  }
  document.querySelectorAll('[data-previewad]').forEach(function(b){b.onclick=function(){
    var ad=(appState.clientAds.ads||[]).find(function(a){return a.id===b.dataset.previewad;});
    if(ad)previewAudio(ad.id,appState.clientAds.ads.map(function(a){return Object.assign({},a);}));
  };});
  document.querySelectorAll('[data-delad2]').forEach(function(b){b.onclick=async function(){
    if(!confirm('¿Eliminar este anuncio?'))return;
    var id=b.dataset.delad2;
    if(appState.isOnline)await R2Storage.remove(id);
    appState.clientAds.ads=(appState.clientAds.ads||[]).filter(function(a){return a.id!==id;});
    appState.clientAds.adSchedule=(appState.clientAds.adSchedule||[]).filter(function(s){return!(s.adIds&&s.adIds.length===1&&s.adIds[0]===id);}); // limpia programaciones que quedaron sin ningún anuncio
    appState.clientAds.adSchedule.forEach(function(s){if(s.adIds)s.adIds=s.adIds.filter(function(x){return x!==id;});});
    await saveClientAds();render();toast('Anuncio eliminado.');
  };});

  var calBox=document.getElementById('adCalendarBox');
  if(calBox)refreshCalendar(calBox,getAdCalendarState(),null);

  // Tiendas objetivo: "Todas" oculta/deschequea la lista individual; destickear "Todas" la muestra.
  var storeAll=document.getElementById('adStoreAll'),storeIndivWrap=document.getElementById('adStoreIndividualWrap');
  if(storeAll){
    storeAll.onchange=function(){
      if(storeIndivWrap)storeIndivWrap.style.display=storeAll.checked?'none':'';
      if(storeAll.checked)document.querySelectorAll('.ad-store-check').forEach(function(cb){cb.checked=false;});
    };
  }

  // Actualiza el menú "Cuántos por vez" según cuántos anuncios estén tickeados.
  function updateCountPerTriggerOptions(){
    var checkedCount=document.querySelectorAll('.ad-pick-check:checked').length;
    var sel=document.getElementById('adCountPerTrigger');
    if(!sel)return;
    var prev=sel.value;
    var max=Math.max(1,checkedCount);
    sel.innerHTML='';
    for(var n=1;n<=max;n++){
      var opt=document.createElement('option');opt.value=n;opt.textContent=n;
      sel.appendChild(opt);
    }
    if(prev&&parseInt(prev,10)<=max)sel.value=prev;
  }
  document.querySelectorAll('.ad-pick-check').forEach(function(cb){cb.onchange=updateCountPerTriggerOptions;});
  updateCountPerTriggerOptions();

  var adMode=document.getElementById('adMode');
  var rowFreq=document.getElementById('adRowFreq'),intervalField=document.getElementById('adIntervalField');
  var hint=document.getElementById('adModeHint');
  function updateModeUI(){
    if(!adMode)return;
    if(adMode.value==='frequency'){
      rowFreq.style.display='';intervalField.style.display='none';
      hint.textContent='Los días y el rango de horas son opcionales aquí: si no marcas nada, se repite "cada N canciones" en cualquier momento. Si marcas días y/u horario, solo se repetirá dentro de esa ventana.';
    }else{
      rowFreq.style.display='none';intervalField.style.display='';
      hint.textContent='Marca al menos un día en el calendario. Deja "Hora hasta" vacío para una sola hora exacta, o complétala junto con "Repetir cada" para que suene varias veces dentro de ese rango.';
    }
  }
  if(adMode){adMode.onchange=updateModeUI;updateModeUI();}

  var btnAdd=document.getElementById('btnAddAdSched');
  if(btnAdd)btnAdd.onclick=async function(){
    var mode=document.getElementById('adMode').value;
    var adIds=Array.from(document.querySelectorAll('.ad-pick-check:checked')).map(function(cb){return cb.dataset.adcheck;});
    if(adIds.length===0){toast('Marca al menos un anuncio.');return;}
    var countPerTrigger=parseInt(document.getElementById('adCountPerTrigger').value,10)||1;
    var order=document.getElementById('adOrder').value;
    var storeAllChecked=document.getElementById('adStoreAll')?document.getElementById('adStoreAll').checked:true;
    var storeIds=storeAllChecked?null:Array.from(document.querySelectorAll('.ad-store-check:checked')).map(function(cb){return cb.dataset.storecheck;});
    if(!storeAllChecked&&storeIds.length===0){toast('Marca "Todas las tiendas" o al menos una tienda específica.');return;}

    var cal=getAdCalendarState();
    var dates=Array.from(cal.selectedDates).sort();
    var timeFrom=document.getElementById('adTimeFrom').value;
    var timeTo=document.getElementById('adTimeTo').value;
    var timeRe=/^([01]\d|2[0-3]):([0-5]\d)$/;
    appState.clientAds.adSchedule=appState.clientAds.adSchedule||[];

    if(mode==='frequency'){
      var everyN=parseInt(document.getElementById('adEveryN').value,10)||1;
      if(timeFrom&&!timeRe.test(timeFrom)){toast('Hora "desde" inválida.');return;}
      if(timeTo&&!timeRe.test(timeTo)){toast('Hora "hasta" inválida.');return;}
      if(timeFrom&&timeTo&&timeTo<=timeFrom){toast('La hora "hasta" debe ser posterior a "desde".');return;}
      appState.clientAds.adSchedule.push({
        id:uid('ads'),mode:'frequency',everyN:everyN,adIds:adIds,countPerTrigger:countPerTrigger,order:order,storeIds:storeIds,
        dates:dates.length?dates:null,
        startTime:(timeFrom&&timeTo)?timeFrom:null,
        endTime:(timeFrom&&timeTo)?timeTo:null
      });
      await saveClientAds();render();
      toast((dates.length||(timeFrom&&timeTo))?'✓ Programado con restricción de días/horario.':'✓ Programado sin restricción (cualquier día y hora).');
      return;
    }

    // mode === 'time'
    if(dates.length===0){toast('Marca al menos un día en el calendario.');return;}
    if(!timeFrom||!timeRe.test(timeFrom)){toast('Selecciona una hora "desde" válida.');return;}
    if(timeTo&&!timeRe.test(timeTo)){toast('Hora "hasta" inválida.');return;}
    var intervalRaw=document.getElementById('adInterval').value;
    var interval=intervalRaw?parseInt(intervalRaw,10):null;

    var timesToUse=[timeFrom];
    if(timeTo&&interval){
      if(timeTo<=timeFrom){toast('La hora "hasta" debe ser posterior a "desde".');return;}
      timesToUse=[];
      var startMin=parseInt(timeFrom.slice(0,2),10)*60+parseInt(timeFrom.slice(3),10);
      var endMin=parseInt(timeTo.slice(0,2),10)*60+parseInt(timeTo.slice(3),10);
      for(var m=startMin;m<=endMin;m+=interval){
        var hh=String(Math.floor(m/60)).padStart(2,'0'),mm=String(m%60).padStart(2,'0');
        timesToUse.push(hh+':'+mm);
      }
    }

    var MAX_ENTRIES=1000; // límite de seguridad para no crear miles de filas por accidente
    var count=0,stop=false;
    var batchId=uid('adbatch'); // identifica toda esta tanda para poder borrarla de un solo clic
    for(var i=0;i<dates.length&&!stop;i++){
      for(var j=0;j<timesToUse.length;j++){
        if(count>=MAX_ENTRIES){stop=true;break;}
        appState.clientAds.adSchedule.push({id:uid('ads'),mode:'time',date:dates[i],time:timesToUse[j],adIds:adIds,countPerTrigger:countPerTrigger,order:order,storeIds:storeIds,batchId:batchId});
        count++;
      }
    }
    await saveClientAds();render();
    toast('✓ Programado: '+count+' horario(s) en '+dates.length+' día(s).'+(stop?' (se alcanzó el límite de seguridad)':''));
  };
  document.querySelectorAll('[data-delbatch]').forEach(function(b){b.onclick=async function(){
    var n=b.dataset.batchcount;
    if(!confirm('¿Eliminar TODA esta programación? Se borrarán '+n+' horario(s) de una sola vez.'))return;
    appState.clientAds.adSchedule=(appState.clientAds.adSchedule||[]).filter(function(s){return(s.batchId||s.id)!==b.dataset.delbatch;});
    await saveClientAds();render();toast('✓ Programación eliminada ('+n+' horario(s)).');
  };});
  document.querySelectorAll('[data-delad]').forEach(function(b){b.onclick=async function(){
    appState.clientAds.adSchedule=(appState.clientAds.adSchedule||[]).filter(function(s){return s.id!==b.dataset.delad;});
    await saveClientAds();render();
  };});
}

async function uploadClientAds(fileList,client){
  if(!appState.isOnline){toast('Sin conexión — sube anuncios cuando tengas internet.');return;}
  var files=Array.from(fileList).filter(function(f){return/\.mp3$/i.test(f.name)||f.type==='audio/mpeg';});
  if(files.length===0){toast('Selecciona archivos .mp3.');return;}
  var uploaded=0;
  for(var i=0;i<files.length;i++){
    var file=files[i];showUploadBar(i+1,files.length,file.name);updateUploadBarPct(0);
    try{
      var id=uid('ad');var meta=await extractAudioMeta(file);
      var url=await R2Storage.upload(file,id,updateUploadBarPct);
      if(!appState.clientAds.ads)appState.clientAds.ads=[];
      appState.clientAds.ads.push({id:id,title:meta.title,duration:meta.duration,url:url});
      await saveClientAds();uploaded++;
    }catch(err){toast('Error subiendo "'+file.name+'": '+err.message);}
  }
  hideUploadBar();if(uploaded>0)toast('✓ '+uploaded+' anuncio(s) subido(s).');render();
}

/* ===== CLIENT PLAYER ===== */
function renderClientPlayer(client){
  if(client.is_exec&&client.stations.length===0)return'<h1>Reproductor</h1><div class="empty">Aún no tienes estaciones asignadas. Contacta al administrador.</div>';
  if(client.is_exec&&client.stationStores.length===0)return'<h1>Reproductor</h1><div class="empty">Esta estación todavía no tiene tiendas creadas.</div>';
  var storePicker='';
  if(client.is_exec&&client.stationStores.length>1){
    storePicker='<div class="panel" style="margin-bottom:18px;"><div class="field" style="max-width:300px;margin-bottom:0;"><label>Tienda a escuchar (dentro de '+escapeHtml(client.station_name||'esta estación')+')</label><select id="inStationStoreSelector">'
    +client.stationStores.map(function(s){return'<option value="'+s.id+'"'+(s.id===client.store_id?' selected':'')+'>'+escapeHtml(s.name||'Tienda')+'</option>';}).join('')
    +'</select></div></div>';
  }
  if(!client.channel_id)return storePicker+'<div class="empty">Esta tienda todavía no tiene un playlist asignado.</div>';
  return storePicker
  +(appState.isOnline?'':'<p class="subtitle" style="color:var(--amber);font-weight:700;">⚡ Modo Offline — reproduciendo desde almacenamiento local.</p>')
  +renderPlayerUI(null,client.channel_name);
}

function bindClientPlayer(client){
  var stationStoreSel=document.getElementById('inStationStoreSelector');
  if(stationStoreSel){
    stationStoreSel.onchange=function(){
      setActiveInStationStoreId(client.station_id,stationStoreSel.value);
      destroyPlayerEngine();
      render();
    };
  }
  if(!client.channel_id)return;
  var audioEl=getOrCreateAudioEl();
  var adminData=getAdminData();
  var engineKey=client.id+':'+(client.station_id||'')+':'+(client.store_id||'');
  if(playerEngine&&playerEngineClientId===engineKey){
    playerEngine.reconnectUI(updatePlayerUI);
  }else{
    destroyPlayerEngine();
    var nameParts=[client.business_name];
    if(client.station_name)nameParts.push(client.station_name);
    if(client.store_name)nameParts.push(client.store_name);
    var logName=nameParts.join(' - ');
    playerEngine=createPlayerEngine(adminData,appState.clientAds,audioEl,{onUpdate:updatePlayerUI,enableLog:true,client:{id:client.id,name:logName},storeId:client.store_id||null});
    playerEngineClientId=engineKey;
    playerEngine.setChannel(client.channel_id);
  }
  document.getElementById('pPlay').onclick=function(){playerEngine.togglePlay();};
  document.getElementById('pNext').onclick=function(){playerEngine.skipNext();};
}

function renderPlayerUI(chOptions,fixedChannelName){
  return(chOptions?'<div class="panel" style="margin-bottom:18px;"><div class="field" style="max-width:300px;margin-bottom:0;"><label>Canal activo</label><select id="playerChannel">'+chOptions+'</select></div></div>':'')
  +'<div class="player-card">'
  +'<div class="now-cat" id="pCategory">—</div>'
  +'<h2 id="pTitle">Cargando...</h2>'
  +'<div class="artist" id="pArtist" style="display:none;"></div>'
  +'<div id="pError" style="display:none;color:#B5483C;font-weight:600;font-size:13px;margin:6px 0;padding:8px 10px;background:rgba(181,72,60,0.08);border-radius:8px;"></div>'
  +'<div class="progress-track"><div class="progress-fill" id="pProgress"></div></div>'
  +'<div class="time-row"><span id="pElapsed">0:00</span><span id="pRemaining">0:00</span></div>'
  +'<div class="player-controls">'
  +'<button id="pPlay" class="play">▶</button>'
  +'<button id="pNext">⏭</button>'
  +'</div>'
  +'<div class="next-info"><div>Siguiente: <b id="pNextTitle">—</b> <span id="pNextArtist" class="muted"></span></div></div>'
  +'</div>';
}

/* ===== PLAYER ENGINE ===== */
var playerEngine=null,playerEngineClientId=null,globalAudioEl=null;

function getOrCreateAudioEl(){
  if(!globalAudioEl){globalAudioEl=document.createElement('audio');globalAudioEl.style.display='none';globalAudioEl.removeAttribute('crossorigin');document.body.appendChild(globalAudioEl);}
  return globalAudioEl;
}

function destroyPlayerEngine(){
  if(playerEngine){playerEngine.destroy();playerEngine=null;playerEngineClientId=null;}
  if(globalAudioEl){globalAudioEl.pause();globalAudioEl.removeAttribute('src');globalAudioEl.load();}
}

function updatePlayerUI(snapshot){
  lastPlayerSnapshot=snapshot;
  var g=function(id){return document.getElementById(id);};if(!g('pTitle'))return;
  g('pCategory').textContent=snapshot.genre||'—';
  g('pTitle').textContent=snapshot.title||'—';
  var artistEl=g('pArtist');
  if(snapshot.artist){artistEl.textContent=snapshot.artist;artistEl.style.display='';}
  else{artistEl.textContent='';artistEl.style.display='none';}
  var errEl=g('pError');
  if(errEl){
    if(snapshot.errorMsg){errEl.textContent='⚠️ '+snapshot.errorMsg;errEl.style.display='';}
    else{errEl.textContent='';errEl.style.display='none';}
  }
  var prog=g('pProgress');if(prog)prog.style.width=(snapshot.progressPct||0)+'%';
  var el=g('pElapsed');if(el)el.textContent=formatDuration(snapshot.elapsed||0);
  var rem=g('pRemaining');if(rem)rem.textContent='-'+formatDuration(snapshot.remaining||0);
  g('pPlay').textContent=snapshot.playing?'⏸':'▶';
  g('pNextTitle').textContent=snapshot.nextTitle||'—';
  var naEl=g('pNextArtist');if(naEl)naEl.textContent=snapshot.nextArtist?('— '+snapshot.nextArtist):'';
  var q=g('pQueue');
  if(q){
    q.innerHTML=(snapshot.queue||[]).length===0
      ?'<div class="muted">'+(snapshot.queueMsg||'Sin programación activa para este playlist ahora.')+'</div>'
      :snapshot.queue.map(function(item){return'<div class="queue-item"><span>'+escapeHtml(item.title)+'</span><span class="qi-cat">'+escapeHtml(item.category)+'</span></div>';}).join('');
  }
}

function createPlayerEngine(cd,clientAds,audioEl,callbacks){
  var channelId=null,queue=[],playing=false,tickTimer=null,adTimer=null,uiCallback=callbacks.onUpdate;
  var enableLog=!!callbacks.enableLog;
  var logClient=callbacks.client||null;
  var storeId=callbacks.storeId||null; // tienda activa: para filtrar qué programación de anuncios le aplica
  var PRELOAD_COUNT=3,preloadPool=[],recentPlayed={},firedAds=new Set(),freqCounters={},seqIndexes={};

  function initPool(){for(var i=0;i<PRELOAD_COUNT;i++){var a=document.createElement('audio');a.preload='auto';a.style.display='none';a.removeAttribute('crossorigin');document.body.appendChild(a);preloadPool.push({audio:a,url:'',ready:false});}}
  initPool();

  function preloadNext(){
    queue.slice(1,1+PRELOAD_COUNT).forEach(function(item,i){
      var slot=preloadPool[i];if(!item||!item.url)return;if(slot.url===item.url)return;
      slot.url=item.url;slot.ready=false;slot.audio.src=item.url;slot.audio.load();
      slot.audio.oncanplaythrough=function(){slot.ready=true;};
    });
    for(var i=queue.slice(1,1+PRELOAD_COUNT).length;i<PRELOAD_COUNT;i++){
      if(preloadPool[i].url){preloadPool[i].url='';preloadPool[i].ready=false;preloadPool[i].audio.removeAttribute('src');preloadPool[i].audio.load();}
    }
  }

  /* ===== Colchón de reproducción sin internet (redundancia automática, ~15 min) =====
     Independiente de "Mis Descargas": mientras hay conexión, va guardando en caché las
     próximas canciones de la cola (más allá de las 3 que se precargan para no cortar entre
     tema y tema), hasta cubrir BUFFER_TARGET_SECONDS de música por delante. Si internet se
     corta, ese tramo ya guardado sigue sonando sin que nadie note nada. El Service Worker
     (sw.js) ya guarda en caché cualquier audio que pase por fetch(), así que alcanza con
     "pedir" la URL en segundo plano — no hace falta mensajería especial con el SW.
     Los ANUNCIOS del cliente (Mis Anuncios) se cachean aquí también, aparte de la cola:
     a diferencia de una canción, un anuncio no entra a la cola con anticipación — recién
     se inserta en el momento exacto en que le toca sonar (cada N canciones, o a una hora
     programada). Si justo en ese momento no hay señal y el anuncio nunca sonó antes
     (nunca se cacheó "al vuelo"), su audio no está disponible y la reproducción queda
     en silencio. Por eso el colchón cachea TODOS los anuncios activos del cliente de
     entrada, sin esperar a que les toque el turno. */
  var BUFFER_TARGET_SECONDS=15*60,DEFAULT_SONG_SECONDS=210,_bufferedUrls={};
  /* userPaused: true SOLO cuando el usuario apretó el botón de Pausa a propósito.
     El watchdog de recuperación automática (más abajo) respeta esta bandera: si el
     usuario pausó, se queda pausado hasta que él mismo le dé Play de nuevo — no se
     reinicia solo. Si en cambio la música se detuvo por un corte de señal, userPaused
     sigue en false y el watchdog sí puede reanudar. */
  var userPaused=false;
  function warmUrl(url){
    if(!url||_bufferedUrls[url])return;
    _bufferedUrls[url]=true;
    fetch(url).catch(function(){/* reintenta solo en el próximo ciclo */delete _bufferedUrls[url];});
  }
  function maintainRollingBuffer(){
    if(navigator.onLine===false)return; // sin conexión: no hay nada que buscar ahora mismo
    var covered=0,i=0;
    while(covered<BUFFER_TARGET_SECONDS&&i<queue.length){
      var item=queue[i];
      if(item&&item.url){warmUrl(item.url);covered+=item.duration||DEFAULT_SONG_SECONDS;}
      i++;
    }
    // Si la cola no alcanza a cubrir los 15 min (temas muy cortos o pocos), se pide más.
    if(covered<BUFFER_TARGET_SECONDS&&queue.length<30)refillQueue();
    // Anuncios del cliente: se cachean todos de entrada (son pocos), sin depender de la cola.
    var liveAds=appState.clientAds;
    if(liveAds&&liveAds.ads&&liveAds.ads.length)liveAds.ads.forEach(function(ad){warmUrl(ad.url);});
  }
  var bufferTimer=setInterval(maintainRollingBuffer,60000);

  function isPlaylistBlockId(id){return typeof id==='string'&&id.indexOf('ch_')===0;}

  /* El "pool" de canciones de un bloque de la secuencia de un Reloj:
     - Si es un Estilo (cat_...): las canciones clasificadas ahí, como siempre.
     - Si es un Playlist (ch_...): lo armado en Clasificación para ese Playlist
       (Estilos completos arrastrados + canciones sueltas arrastradas). */
  function getSongPoolForBlock(blockId){
    if(isPlaylistBlockId(blockId)){
      var content=(cd.playlistContent||[]).filter(function(p){return p.playlistId===blockId;});
      var ids={};
      content.forEach(function(p){
        if(p.type==='song')ids[p.refId]=true;
        else if(p.type==='style'){
          cd.classifications.filter(function(c){return c.categoryId===p.refId;}).forEach(function(c){ids[c.songId]=true;});
        }
      });
      return Object.keys(ids);
    }
    return cd.classifications.filter(function(c){return c.categoryId===blockId;}).map(function(c){return c.songId;});
  }

  function getBlockLabel(blockId){
    if(isPlaylistBlockId(blockId)){
      var ch=cd.channels.find(function(c){return c.id===blockId;});
      return ch?ch.name:'?';
    }
    var cat=cd.categories.find(function(c){return c.id===blockId;});
    return cat?cat.name:'?';
  }

  function pickRandomSong(blockId){
    var allIds=getSongPoolForBlock(blockId).filter(function(id){return appState.library.find(function(m){return m.id===id&&m.url;});});
    if(allIds.length===0)return null;
    var recent=recentPlayed[blockId]||[];
    var maxRecent=Math.max(1,Math.floor(allIds.length/2));
    var available=allIds.filter(function(id){return!recent.includes(id);});
    if(available.length===0){recentPlayed[blockId]=[];available=allIds;}
    var id=available[Math.floor(Math.random()*available.length)];
    if(!recentPlayed[blockId])recentPlayed[blockId]=[];
    recentPlayed[blockId].push(id);
    if(recentPlayed[blockId].length>maxRecent)recentPlayed[blockId].shift();
    return appState.library.find(function(m){return m.id===id;})||null;
  }

  function getActiveSchedule(){
    if(!channelId)return null;
    var now=new Date(),dayName=DAYS[(now.getDay()+6)%7],hhmm=now.toTimeString().slice(0,5),todayStr=localDateStr(now);
    // 1) Excepciones de fecha específica (prioridad — ej. Navidad, feriados)
    var exception=cd.schedule.find(function(s){return s.channelId===channelId&&s.date===todayStr&&s.start<=hhmm&&hhmm<s.end;});
    if(exception)return exception;
    // 2) Programación semanal recurrente normal
    return cd.schedule.find(function(s){return s.channelId===channelId&&!s.date&&s.day===dayName&&s.start<=hhmm&&hhmm<s.end;})||null;
  }

  /* ¿Esta programación de anuncios aplica a la tienda que está sonando ahora mismo?
     Sin tiendas marcadas (storeIds vacío/null) significa "todas las tiendas". */
  function scheduleAppliesToStore(s){
    if(!s.storeIds||s.storeIds.length===0)return true;
    return!!storeId&&s.storeIds.indexOf(storeId)!==-1;
  }

  /* Elige cuántos anuncios tocan en este disparo (countPerTrigger), en el orden
     configurado: 'random' (sin repetir dentro del mismo disparo) o 'sequence'
     (rotación que avanza y se recuerda entre disparo y disparo, por programación). */
  function pickAdsForTrigger(s,adsList){
    var ids=(s.adIds&&s.adIds.length)?s.adIds:(s.adId?[s.adId]:[]); // compat con datos antiguos de un solo anuncio
    var pool=ids.map(function(id){return adsList.find(function(a){return a.id===id;});}).filter(Boolean);
    if(pool.length===0)return[];
    var n=Math.min(parseInt(s.countPerTrigger,10)||1,pool.length);
    if(s.order==='random'){
      var shuffled=pool.slice();
      for(var i=shuffled.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var tmp=shuffled[i];shuffled[i]=shuffled[j];shuffled[j]=tmp;}
      return shuffled.slice(0,n);
    }
    var start=seqIndexes[s.id]||0,result=[];
    for(var k=0;k<n;k++)result.push(pool[(start+k)%pool.length]);
    seqIndexes[s.id]=(start+n)%pool.length;
    return result;
  }

  function getClientAdNow(){
    var liveAds=appState.clientAds;
    if(!liveAds||!liveAds.adSchedule||!liveAds.ads)return null;
    if(liveAds.adSchedule.length===0||liveAds.ads.length===0)return null;
    var now=new Date(),dateStr=localDateStr(now),hhmm=now.toTimeString().slice(0,5);
    var sched=liveAds.adSchedule.find(function(s){return s.mode!=='frequency'&&s.date===dateStr&&s.time===hhmm&&scheduleAppliesToStore(s);});
    if(!sched)return null;
    var ads=pickAdsForTrigger(sched,liveAds.ads);
    return ads.length?{ads:ads,schedId:sched.id}:null;
  }

  /* Anuncios programados por frecuencia ("cada N canciones"). Se llama una vez
     por cada canción normal que termina de sonar (no cuenta anuncios). */
  function checkFrequencyAds(){
    var liveAds=appState.clientAds;
    if(!liveAds||!liveAds.adSchedule||!liveAds.ads)return;
    var freqSchedules=liveAds.adSchedule.filter(function(s){return s.mode==='frequency'&&isFreqScheduleActiveNow(s)&&scheduleAppliesToStore(s);});
    if(freqSchedules.length===0)return;
    var toFire=[];
    freqSchedules.forEach(function(s){
      var everyN=parseInt(s.everyN,10)||1;
      var count=(freqCounters[s.id]||0)+1;
      if(count>=everyN){
        freqCounters[s.id]=0;
        toFire=toFire.concat(pickAdsForTrigger(s,liveAds.ads));
      }else{
        freqCounters[s.id]=count;
      }
    });
    if(toFire.length>0)insertClientAds(toFire); // si coinciden varios, se encolan uno tras otro
  }

  function buildQueue(count){
    var sched=getActiveSchedule();queue=[];queue.__reason='no_schedule';
    if(!sched)return;
    var clock=cd.clocks.find(function(c){return c.id===sched.clockId;});
    if(!clock||clock.sequence.length===0){queue.__reason='empty_clock';return;}
    var idx=0,guard=0;
    while(queue.length<count&&guard<count*20+20){
      guard++;
      var catId=clock.sequence[idx%clock.sequence.length];idx++;
      var song=pickRandomSong(catId);
      if(song)queue.push({songId:song.id,title:song.title,artist:song.artist||'',genre:song.genre||'',url:song.url,duration:song.duration||0,categoryName:getBlockLabel(catId),isAd:false});
    }
    queue.__ptr=idx;
    if(queue.length===0)queue.__reason='no_songs';else queue.__reason=null;
    preloadNext();
    maintainRollingBuffer();
  }

  function refillQueue(){
    var sched=getActiveSchedule();
    if(!sched){queue=[];queue.__reason='no_schedule';return;}
    var clock=cd.clocks.find(function(c){return c.id===sched.clockId;});
    if(!clock||clock.sequence.length===0)return;
    var guard=0;
    while(queue.length<10&&guard<200){
      guard++;
      var ptr=queue.__ptr||0,catId=clock.sequence[ptr%clock.sequence.length];queue.__ptr=ptr+1;
      var song=pickRandomSong(catId);
      if(song)queue.push({songId:song.id,title:song.title,artist:song.artist||'',genre:song.genre||'',url:song.url,duration:song.duration||0,categoryName:getBlockLabel(catId),isAd:false});
    }
    if(queue.length===0)queue.__reason='no_songs';
    preloadNext();
    maintainRollingBuffer();
  }

  function emitEmpty(){
    var msgs={no_schedule:'Sin programación activa para este playlist ahora mismo',empty_clock:'El reloj asignado no tiene estilos (sección E)',no_songs:'Los estilos del reloj no tienen canciones clasificadas (sección D)'};
    uiCallback({title:msgs[queue.__reason||'no_schedule'],artist:'',genre:'—',queue:[],queueMsg:msgs[queue.__reason||'no_schedule']});
  }

  function emit(){
    var item=queue[0],next=queue[1];
    var elapsed=audioEl.currentTime||0,dur=audioEl.duration||0;
    uiCallback({
      title:item?item.title:'—',artist:item?item.artist:'',
      genre:item?(item.isAd?'📢 Anuncio':(item.genre||'—')):'—',
      elapsed:elapsed,remaining:Math.max(dur-elapsed,0),progressPct:dur?(elapsed/dur)*100:0,playing:playing,
      nextTitle:next?next.title:'—',nextArtist:next?(next.isAd?'':(next.artist||'')):'',
      queue:queue.slice(0,10).map(function(q){return{title:q.title,category:q.isAd?'📢 Anuncio':q.categoryName};}),
      errorMsg:lastErrorMsg||null,
    });
  }

  /* Diagnóstico visible cuando un archivo (canción o anuncio) no arranca: en vez de
     quedar en silencio sin explicación, se revisa directamente el Cache Storage del
     navegador (accesible también desde la página, no solo desde el Service Worker)
     para confirmar si ese archivo puntual está o no guardado localmente, y se muestra
     el motivo en el propio reproductor. */
  var lastErrorMsg=null;
  function diagnosePlaybackFailure(item,reason){
    lastErrorMsg='No se pudo reproducir "'+(item.title||'?')+'" ('+reason+'). Verificando almacenamiento local...';
    emit();
    if(!('caches'in window)){lastErrorMsg='No se pudo reproducir "'+(item.title||'?')+'" ('+reason+'). Este navegador no soporta almacenamiento offline.';emit();return;}
    caches.open('maa-audio-v1').then(function(cache){return cache.match(item.url);}).then(function(hit){
      lastErrorMsg='No se pudo reproducir "'+(item.title||'?')+'" ('+reason+'). '
        +(hit?'El archivo SÍ está en el almacenamiento local — puede ser un problema del formato o de la memoria del dispositivo.'
              :'El archivo NO está en el almacenamiento local (nunca se descargó). Ve a "Mis Descargas" y sincroniza de nuevo.');
      emit();
    }).catch(function(){});
  }
  /* Recuperación automática: cuando el navegador rechaza el audio servido a través del
     Service Worker ("no supported source"), casi siempre es porque a esa respuesta le
     falta o le llega mal el encabezado Content-Type — el archivo en sí SÍ está bien
     guardado. Como solución, se toma el archivo directamente del Cache Storage (accesible
     también desde la página) y se arma un Blob de audio con el tipo correcto a mano, sin
     pasar por el Service Worker — así se evita el problema de cabecera por completo. */
  var _fallbackTriedUrl=null;
  function tryPlayFromCacheBlob(item,onDone){
    if(!('caches'in window)){onDone(false);return;}
    caches.open('maa-audio-v1').then(function(cache){return cache.match(item.url);}).then(function(resp){
      if(!resp){onDone(false);return;}
      resp.blob().then(function(blob){
        var blobUrl=URL.createObjectURL(new Blob([blob],{type:'audio/mpeg'}));
        audioEl.removeAttribute('crossorigin');audioEl.src=blobUrl;audioEl.load();
        var p=audioEl.play();
        if(p===undefined){onDone(false);return;}
        p.then(function(){
          playing=true;lastErrorMsg=null;emit();preloadNext();
          if(enableLog){var chanObj=(cd.channels||[]).find(function(c){return c.id===channelId;});logPlayback(item,{id:channelId,name:chanObj?chanObj.name:''},logClient);}
          onDone(true);
        }).catch(function(){URL.revokeObjectURL(blobUrl);onDone(false);});
      }).catch(function(){onDone(false);});
    }).catch(function(){onDone(false);});
  }
  function handlePlaybackFailure(item,reason){
    if(_fallbackTriedUrl===item.url){diagnosePlaybackFailure(item,reason);return;} // ya se intentó la recuperación para este mismo archivo
    _fallbackTriedUrl=item.url;
    tryPlayFromCacheBlob(item,function(recovered){if(!recovered)diagnosePlaybackFailure(item,reason);});
  }
  function playItem(item){
    if(!item||!item.url){queue.shift();refillQueue();playCurrent();return;}
    lastErrorMsg=null;
    audioEl.removeAttribute('crossorigin');audioEl.src=item.url;audioEl.load();
    var p=audioEl.play();
    if(p!==undefined)p.then(function(){playing=true;lastErrorMsg=null;emit();preloadNext();maintainRollingBuffer();if(enableLog){var chanObj=(cd.channels||[]).find(function(c){return c.id===channelId;});logPlayback(item,{id:channelId,name:chanObj?chanObj.name:''},logClient);}}).catch(function(err){playing=false;handlePlaybackFailure(item,(err&&err.message)||'no se pudo iniciar');});
  }

  function playCurrent(){
    if(queue.length===0){emitEmpty();return;}
    playItem(queue[0]);
  }

  /* Baja el volumen suavemente antes de pasar a un anuncio, en vez de cortar la canción
     de golpe. Si no hay nada sonando, ejecuta el callback de inmediato (sin demora). */
  var FADE_DURATION_MS=2200,FADE_STEPS=22;
  function fadeOutThen(cb){
    if(!playing||audioEl.paused){cb();return;}
    var stepTime=FADE_DURATION_MS/FADE_STEPS,step=0;
    var fadeTimer=setInterval(function(){
      step++;
      audioEl.volume=Math.max(0,1-(step/FADE_STEPS));
      if(step>=FADE_STEPS){
        clearInterval(fadeTimer);
        audioEl.pause();
        audioEl.volume=1; // restaurar a volumen normal para lo que suene después (el anuncio)
        playing=false;
        cb();
      }
    },stepTime);
  }

  function insertClientAds(adsArray){
    if(!adsArray||adsArray.length===0)return;
    var wasInterrupting=playing&&!audioEl.paused; // ¿había una canción sonando de verdad ahora mismo?
    var adItems=adsArray.map(function(ad){return{songId:ad.id,title:ad.title,artist:'Tu anuncio',url:ad.url,categoryName:'Anuncio',isAd:true};});
    fadeOutThen(function(){
      // Si cortamos una canción a mitad de reproducción, la sacamos de la cola:
      // no queremos que vuelva a sonar desde el inicio al terminar el/los anuncio(s).
      if(wasInterrupting&&queue.length&&!queue[0].isAd)queue.shift();
      for(var i=adItems.length-1;i>=0;i--)queue.unshift(adItems[i]);
      audioEl.onended=function(){
        queue.shift();
        if(queue.length&&queue[0].isAd){
          playItem(queue[0]); // sigue encadenando el siguiente anuncio de la cola
        }else{
          audioEl.onended=defaultOnEnded;
          if(!queue.length)refillQueue();
          playCurrent();
        }
      };
      playItem(queue[0]);
      toast(adItems.length>1?'📢 '+adItems.length+' anuncios en reproducción':'📢 Anuncio en reproducción');
    });
  }
  function insertClientAd(ad){insertClientAds([ad]);}

  function defaultOnEnded(){
    var finishedItem=queue[0];
    queue.shift();
    if(finishedItem&&!finishedItem.isAd)checkFrequencyAds();
    refillQueue();playCurrent();
  }
  audioEl.onended=defaultOnEnded;
  audioEl.onerror=function(){
    playing=false;
    var item=queue[0];
    if(item){
      var code=audioEl.error?audioEl.error.code:0;
      var codeMsg={1:'cancelado',2:'error de red',3:'error al decodificar el archivo',4:'archivo no disponible o formato no soportado'}[code]||'error desconocido';
      handlePlaybackFailure(item,codeMsg);
    }else emit();
  }; // corte de red a mitad de un tema: el watchdog de abajo reintenta solo
  audioEl.ontimeupdate=function(){
    if(playing){emit();var rem=(audioEl.duration||0)-(audioEl.currentTime||0);if(rem<30&&queue.length<=2)refillQueue();}
  };

  /* ===== Recuperación automática tras un corte largo (más de los 15 min del colchón) =====
     Si el colchón se agotó y la reproducción quedó detenida, no hace falta que nadie le dé
     refresh a la pantalla: apenas vuelve la señal (evento 'online' del navegador, o en la
     siguiente pasada del watchdog cada 15s por si el evento no llegara a dispararse), se
     reintenta solo continuar con la cola donde estaba. */
  function watchdogResume(){if(!playing&&!userPaused&&queue.length&&channelId)playCurrent();}
  var watchdogTimer=setInterval(watchdogResume,15000);
  function onBrowserOnline(){watchdogResume();maintainRollingBuffer();}
  window.addEventListener('online',onBrowserOnline);

  adTimer=setInterval(function(){
    var result=getClientAdNow();
    if(result&&result.ads&&result.ads.length){
      var now=new Date(),currentMinute=now.toTimeString().slice(0,5);
      var fireKey=result.schedId+'_'+currentMinute;
      if(!firedAds.has(fireKey)){
        firedAds.add(fireKey);
        if(firedAds.size>100){var arr=Array.from(firedAds);arr.slice(0,50).forEach(function(k){firedAds.delete(k);});}
        insertClientAds(result.ads);
      }
    }
  },500);

  tickTimer=setInterval(function(){
    if(queue.length<=1){buildQueue(10);if(queue.length){if(!playing&&!userPaused)playCurrent();}else emitEmpty();}
  },5000);

  emitEmpty();

  return{
    setChannel:function(id){channelId=id;userPaused=false;audioEl.pause();playing=false;preloadPool.forEach(function(s){s.url='';s.ready=false;s.audio.removeAttribute('src');s.audio.load();});buildQueue(10);if(queue.length)playCurrent();else emitEmpty();},
    getChannelId:function(){return channelId;},
    togglePlay:function(){
      if(!audioEl.src||audioEl.src===window.location.href){userPaused=false;playCurrent();return;}
      if(playing){userPaused=true;audioEl.pause();playing=false;emit();}
      else{userPaused=false;audioEl.play().then(function(){playing=true;emit();}).catch(function(){playCurrent();});}
    },
    skipNext:function(){userPaused=false;queue.shift();refillQueue();playCurrent();},
    reconnectUI:function(cb){uiCallback=cb;if(queue.length===0)emitEmpty();else emit();},
    destroy:function(){
      clearInterval(tickTimer);clearInterval(adTimer);clearInterval(bufferTimer);clearInterval(watchdogTimer);
      window.removeEventListener('online',onBrowserOnline);
      audioEl.pause();audioEl.onended=null;audioEl.ontimeupdate=null;audioEl.onerror=null;
      preloadPool.forEach(function(s){s.audio.pause();s.audio.removeAttribute('src');s.audio.remove();});
    },
  };
}
