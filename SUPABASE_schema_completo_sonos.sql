-- ============================================================================
-- PonMusic + Sonos — esquema completo para un proyecto Supabase NUEVO Y VACÍO.
-- Correr todo este archivo de una sola vez en el SQL Editor de Supabase.
--
-- Esto NO es una migración incremental como los demás archivos SUPABASE_*.sql
-- de este repo (esos asumen una base ya existente con historial). Este archivo
-- reconstruye desde cero todas las tablas que usa el sistema, tal como quedaron
-- en la versión v20, MÁS las dos tablas nuevas que necesita la integración con
-- Sonos (al final del archivo, sección "SONOS").
--
-- Es seguro volver a correrlo más de una vez (todo usa IF NOT EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- NEGOCIOS (clientes de PonMusic — en este proyecto nuevo, normalmente uno solo)
-- ---------------------------------------------------------------------------
create table if not exists clients (
  id text primary key,
  business_name text,
  username text unique,
  password text,
  status text default 'activa',
  expires_at timestamptz,
  logo_data text,
  banner_data text,
  brand text default 'ponmusic',
  is_client_admin boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_clients_brand on clients (brand);

-- Hasta 5 logins de "Administrador de Cliente" por Negocio.
create table if not exists negocio_users (
  id text primary key,
  client_id text not null,
  username text unique,
  password text,
  created_at timestamptz default now()
);
create index if not exists idx_negocio_users_client on negocio_users (client_id);

-- ---------------------------------------------------------------------------
-- ESTACIONES (nivel entre Negocio y Tienda — un Negocio puede tener varias)
-- ---------------------------------------------------------------------------
create table if not exists stations (
  id text primary key,
  client_id text not null,
  name text,
  logo_data text,
  created_at timestamptz default now()
);
create index if not exists idx_stations_client on stations (client_id);

-- ---------------------------------------------------------------------------
-- TIENDAS
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id text primary key,
  client_id text,
  station_id text,
  name text,
  channel_id text,
  channel_name text,
  username text unique,
  password text,
  only_player boolean default false,
  inactive boolean default false,
  logo_data text,
  oper_start text,            -- 'HH:MM' o NULL (= 24 horas)
  oper_end text,
  timezone text default 'America/Lima',
  group_name text,             -- 'Lima' | 'Provincias' (filtro de Monitoreo)
  zone text,
  created_at timestamptz default now()
);
create index if not exists idx_stores_client on stores (client_id);
create index if not exists idx_stores_station on stores (station_id);

-- ---------------------------------------------------------------------------
-- BIBLIOTECA (canciones)
-- ---------------------------------------------------------------------------
create table if not exists library (
  id text primary key,
  title text,
  artist text,
  composer text,
  genre text,
  filename text,
  duration numeric,
  type text,              -- 'cancion' (los anuncios NO viven aquí, ver client_ads)
  url text,               -- URL del archivo en Cloudflare R2
  brand text default 'ponmusic',
  added_at timestamptz default now()
);
create index if not exists idx_library_brand on library (brand);

-- ---------------------------------------------------------------------------
-- CONFIGURACIÓN DE CADA NEGOCIO (categorías, canales, clasificación, horarios)
-- ---------------------------------------------------------------------------
create table if not exists client_data (
  client_id text primary key,
  categories jsonb default '[]'::jsonb,
  classifications jsonb default '[]'::jsonb,
  clocks jsonb default '[]'::jsonb,
  channels jsonb default '[]'::jsonb,
  schedule jsonb default '[]'::jsonb,
  "playlistContent" jsonb default '[]'::jsonb
);

-- ---------------------------------------------------------------------------
-- ANUNCIOS propios de cada Negocio (independientes de la Biblioteca)
-- ---------------------------------------------------------------------------
create table if not exists client_ads (
  client_id text primary key,
  ads jsonb default '[]'::jsonb,
  ad_schedule jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- ADMINISTRADOR PRINCIPAL
-- ---------------------------------------------------------------------------
create table if not exists admin_config (
  id text primary key default 'main',
  username text not null default 'admin',
  password text not null default 'admin123',
  totp_secret text
);
insert into admin_config (id, username, password)
  values ('main','admin','admin123')
  on conflict (id) do nothing;
-- Cambia esta clave apenas entres por primera vez:
-- UPDATE admin_config SET username='admin', password='NUEVA_CLAVE' WHERE id='main';

create table if not exists admin_trusted_devices (
  id text primary key,
  token text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz default now(),
  label text
);
create index if not exists idx_trusted_devices_token on admin_trusted_devices (token);

-- ---------------------------------------------------------------------------
-- SESIÓN ÚNICA (un usuario = un dispositivo conectado a la vez)
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  username text primary key,
  token text not null,
  last_heartbeat timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- MONITOREO — presencia en vivo + historial de conexión
-- ---------------------------------------------------------------------------
create table if not exists client_presence (
  id text primary key,          -- 'store_' + store_id (una sola fila por tienda)
  client_id text,
  station_id text,
  store_id text,
  store_name text,
  username text,
  business_name text,
  channel_name text,
  is_playing boolean default false,
  now_playing text,
  connected_since timestamptz,
  last_seen timestamptz default now()
);
create index if not exists idx_client_presence_client on client_presence (client_id);

create table if not exists connection_events (
  id text primary key,
  store_id text not null,
  station_id text,
  client_id text,
  event_type text not null, -- 'connect' | 'disconnect'
  event_time timestamptz not null,
  created_at timestamptz default now()
);
create index if not exists idx_connevents_store on connection_events (store_id, event_time);
create index if not exists idx_connevents_station on connection_events (station_id, event_time);
create index if not exists idx_connevents_time on connection_events (event_time);

-- ---------------------------------------------------------------------------
-- REGISTROS DE REPRODUCCIÓN (historial canción/anuncio + hora, por canal)
-- ---------------------------------------------------------------------------
create table if not exists playback_logs (
  id text primary key,
  channel_id text,
  channel_name text,
  client_id text,
  client_name text,
  log_date text not null,      -- 'YYYY-MM-DD'
  log_time text not null,      -- 'HH:MM:SS'
  type text,                   -- 'Canción' | 'Anuncio'
  title text,
  artist text,
  category text,
  created_at timestamptz default now()
);
create index if not exists idx_playback_logs_channel_date on playback_logs (channel_id, log_date);

-- ---------------------------------------------------------------------------
-- CONFIGURACIÓN INTERNA DEL SISTEMA (ej. reliable_since del Informe de conexión)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz DEFAULT now()
);

-- ============================================================================
-- SONOS — tablas nuevas, exclusivas de esta integración
-- ============================================================================

-- Una fila por cada "household" de Sonos que el cliente autorizó a conectarse
-- con PonMusic (flujo OAuth). Guarda los tokens para poder seguir llamando a
-- la Control API de Sonos sin que el cliente tenga que volver a autorizar cada
-- vez (el access_token dura poco y se renueva solo con el refresh_token).
create table if not exists sonos_connections (
  id text primary key,              -- uid propio, ej. 'sonos_<random>'
  client_id text not null,          -- a qué Negocio de PonMusic pertenece
  station_id text,                  -- opcional: si el Negocio tiene varias Estaciones
  sonos_household_id text,          -- id del hogar/local Sonos, una vez autorizado
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  status text default 'pendiente',  -- 'pendiente' | 'conectado' | 'error'
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sonos_connections_client on sonos_connections (client_id);

-- Un "estado de reproducción" por grupo de parlantes Sonos que estamos
-- manejando — reemplaza lo que antes vivía en memoria del navegador
-- (appState.player: cuántas canciones van sin anuncio, qué sonó último, etc.)
-- porque ahora quien decide "qué sigue" es el servidor, no un navegador.
create table if not exists sonos_playback_state (
  sonos_group_id text primary key,  -- id del grupo de parlantes en Sonos
  connection_id text not null,      -- referencia a sonos_connections.id
  client_id text not null,
  station_id text,
  channel_id text,                  -- qué Playlist/Canal de PonMusic suena en este grupo
  queue_items jsonb default '[]'::jsonb,   -- cola ya generada (canciones + anuncios), uno por índice
  clock_pointer integer default 0,         -- posición actual en la secuencia del Reloj activo
  recent_played jsonb default '{}'::jsonb, -- anti-repetición por bloque/estilo (igual que el navegador)
  freq_counters jsonb default '{}'::jsonb, -- contador "cada N canciones" por programación de anuncio
  seq_indexes jsonb default '{}'::jsonb,   -- rotación de anuncios en orden 'sequence'
  updated_at timestamptz default now()
);
create index if not exists idx_sonos_playback_connection on sonos_playback_state (connection_id);

NOTIFY pgrst, 'reload schema';
