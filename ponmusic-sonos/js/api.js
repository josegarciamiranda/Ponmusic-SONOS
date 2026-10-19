/* api.js - Cliente para Netlify Functions (modo offline) */
const API = (() => {
  async function call(path, method, body) {
    method = method || 'GET';
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const json = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }

  const library = {
    getAll: function(brand) { return call('/.netlify/functions/api-library?brand=' + (brand||'ponmusic')); },
    add:    function(song) { return call('/.netlify/functions/api-library', 'POST', song); },
    update: function(id, data) { return call('/.netlify/functions/api-library?id=' + id, 'PUT', data); },
    remove: function(id) { return call('/.netlify/functions/api-library?id=' + id, 'DELETE'); },
  };

  const clients = {
    getAll: function(brand) { return call('/.netlify/functions/api-clients?brand=' + (brand||'ponmusic')); },
    add:    function(c) { return call('/.netlify/functions/api-clients', 'POST', c); },
    update: function(id, data) { return call('/.netlify/functions/api-clients?id=' + id, 'PUT', data); },
    remove: function(id) { return call('/.netlify/functions/api-clients?id=' + id, 'DELETE'); },
  };

  const clientData = {
    get:   function(clientId) { return call('/.netlify/functions/api-clientdata?id=' + clientId); },
    save:  function(clientId, data) { return call('/.netlify/functions/api-clientdata?id=' + clientId, 'PUT', data); },
    login: function(username, password) { return call('/.netlify/functions/api-clientdata?action=login', 'POST', { username: username, password: password }); },
  };

  const clientAds = {
    get:     function(clientId) { return call('/.netlify/functions/api-clientads?id=' + clientId); },
    save:    function(clientId, data) { return call('/.netlify/functions/api-clientads?id=' + clientId, 'PUT', data); },
    version: function(clientId) { return call('/.netlify/functions/api-clientads?action=version&id=' + clientId); },
  };

  const sessions = {
    login:     function(username) { return call('/.netlify/functions/api-sessions?action=login', 'POST', { username: username }); },
    heartbeat: function(username, token) { return call('/.netlify/functions/api-sessions?action=heartbeat', 'POST', { username: username, token: token }); },
    logout:    function(username, token) { return call('/.netlify/functions/api-sessions?action=logout', 'POST', { username: username, token: token }); },
  };

  const playlog = {
    push:  function(entries) { return call('/.netlify/functions/api-playlog', 'POST', { entries: entries }); },
    dates: function(channelId) { return call('/.netlify/functions/api-playlog?list=dates&channel_id=' + channelId); },
    get:   function(channelId, date) { return call('/.netlify/functions/api-playlog?channel_id=' + channelId + '&date=' + date); },
  };

  const presence = {
    ping:   function(data) { return call('/.netlify/functions/api-presence', 'POST', data); },
    get:    function(clientId) { return call('/.netlify/functions/api-presence?client_id=' + clientId); },
    // Preferido sobre get(): filtra por la lista real de IDs de Tienda (más confiable que
    // el client_id grabado en la fila de presencia, que puede quedar desactualizado).
    // Va por POST (con la lista en el cuerpo del pedido), no por GET con la lista en la
    // URL: con ~150-200 tiendas la URL puede superar el límite de longitud que imponen
    // Netlify/AWS/el CDN de por medio, y la lista quedaría cortada en silencio — dejando
    // fuera de la consulta a tiendas que sí están conectadas.
    getByStoreIds: function(storeIds) { return call('/.netlify/functions/api-presence?action=by_store_ids', 'POST', { store_ids: storeIds }); },
    remove: function(deviceId) { return call('/.netlify/functions/api-presence?id=' + deviceId, 'DELETE'); },
  };

  const stores = {
    list:   function(stationId) { return call('/.netlify/functions/api-stores?station_id=' + stationId); },
    add:    function(s) { return call('/.netlify/functions/api-stores', 'POST', s); },
    update: function(id, data) { return call('/.netlify/functions/api-stores?id=' + id, 'PUT', data); },
    remove: function(id) { return call('/.netlify/functions/api-stores?id=' + id, 'DELETE'); },
    login:  function(username, password) { return call('/.netlify/functions/api-stores?action=login', 'POST', { username: username, password: password }); },
  };

  const stations = {
    list:   function(clientId) { return call('/.netlify/functions/api-stations?client_id=' + clientId); },
    add:    function(s) { return call('/.netlify/functions/api-stations', 'POST', s); },
    update: function(id, data) { return call('/.netlify/functions/api-stations?id=' + id, 'PUT', data); },
    remove: function(id) { return call('/.netlify/functions/api-stations?id=' + id, 'DELETE'); },
  };

  const negocioUsers = {
    list:   function(clientId) { return call('/.netlify/functions/api-negocio-users?client_id=' + clientId); },
    add:    function(u) { return call('/.netlify/functions/api-negocio-users', 'POST', u); },
    update: function(id, data) { return call('/.netlify/functions/api-negocio-users?id=' + id, 'PUT', data); },
    remove: function(id) { return call('/.netlify/functions/api-negocio-users?id=' + id, 'DELETE'); },
    login:  function(username, password) { return call('/.netlify/functions/api-negocio-users?action=login', 'POST', { username: username, password: password }); },
  };

  const adminConfig = {
    login:  function(username, password, totpCode, trustToken, trustDevice) { return call('/.netlify/functions/api-admin-config?action=login', 'POST', { username: username, password: password, totpCode: totpCode, trustToken: trustToken, trustDevice: trustDevice }); },
    forgetDevices: function(username, password) { return call('/.netlify/functions/api-admin-config?action=forget_devices', 'POST', { username: username, password: password }); },
    change: function(oldUsername, oldPassword, newUsername, newPassword) { return call('/.netlify/functions/api-admin-config?action=change', 'POST', { oldUsername: oldUsername, oldPassword: oldPassword, newUsername: newUsername, newPassword: newPassword }); },
    totpStatus:  function(username, password) { return call('/.netlify/functions/api-admin-config?action=totp_status', 'POST', { username: username, password: password }); },
    totpSetup:   function(username, password) { return call('/.netlify/functions/api-admin-config?action=totp_setup', 'POST', { username: username, password: password }); },
    totpConfirm: function(username, password, secret, totpCode) { return call('/.netlify/functions/api-admin-config?action=totp_confirm', 'POST', { username: username, password: password, secret: secret, totpCode: totpCode }); },
    totpDisable: function(username, password) { return call('/.netlify/functions/api-admin-config?action=totp_disable', 'POST', { username: username, password: password }); },
  };

  const connectionReport = {
    // No usa call() porque necesita leer el header X-Report-Note (aviso de "informe
    // parcial" cuando el rango pedido arranca antes de que los datos fueran confiables).
    get: async function(stationId, from, to) {
      const res = await fetch('/.netlify/functions/api-connection-report?station_id='+stationId+'&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));
      const json = await res.json().catch(function(){return {};});
      if (!res.ok) throw new Error(json.error || ('HTTP '+res.status));
      var note=null;
      try{ var raw=res.headers.get('X-Report-Note'); if(raw)note=decodeURIComponent(raw); }catch(e){}
      if (json && !Array.isArray(json) && json.notReady) return json;
      return { rows: json, partialNote: note };
    },
  };

  const sonos = {
    authStartUrl: function(clientId, stationId) { return '/.netlify/functions/api-sonos-auth?action=start&client_id=' + encodeURIComponent(clientId) + (stationId?'&station_id='+encodeURIComponent(stationId):''); },
    status: function(clientId) { return call('/.netlify/functions/api-sonos-connect?action=status&client_id=' + clientId); },
    groups: function(clientId) { return call('/.netlify/functions/api-sonos-connect?action=groups&client_id=' + clientId); },
    connect: function(data) { return call('/.netlify/functions/api-sonos-connect', 'POST', data); },
  };

  return { library, clients, clientData, clientAds, sessions, playlog, presence, stores, stations, negocioUsers, adminConfig, connectionReport, sonos };
})();
