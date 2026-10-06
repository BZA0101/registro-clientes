-- Registro de Clientes — esquema Supabase
-- Pegar completo en: supabase.com > tu proyecto > SQL Editor > Run

-- Perfil del asesor (1:1 con auth.users)
create table if not exists perfiles (
  user_id uuid primary key references auth.users on delete cascade,
  nombre text default '',
  plan text default 'free',           -- free | pro | agencia
  sheet_url text default '',          -- Google Sheets del usuario
  sheet_clave text default '',
  wa_autoreply text default '',       -- auto-respuesta de WhatsApp
  stripe_customer_id text default '',
  created_at timestamptz default now()
);

-- Clientes / embudo de ventas
create table if not exists clientes (
  id text primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  nombre text not null,
  telefono text default '',
  estado text not null default 'nuevo',  -- nuevo | conversando | separado | venta | cayo
  motivo text default '',
  seguimiento text default '',
  notas text default '',
  origen text default 'manual',       -- manual | whatsapp | live
  primer_mensaje text default '',     -- texto del primer WhatsApp (leads auto)
  monto_venta numeric,
  fecha_venta text default '',
  estado_fecha text default '',       -- cuando cambio a su estado actual
  fecha text not null,
  creado timestamptz,
  updated_at timestamptz default now()
);

-- Historial de lives analizados (metricas + transcript + resumen IA)
create table if not exists lives (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  usuario_tiktok text not null,
  inicio timestamptz,
  minutos int default 0,
  pico int default 0,
  comentarios int default 0,
  likes int default 0,
  regalos int default 0,
  leads int default 0,
  keywords jsonb default '[]',
  palabras jsonb default '[]',
  transcript jsonb default '[]',      -- [{t, texto}] con timestamps
  resumen_ia text default '',
  razon text default '',
  creado timestamptz default now()
);

-- Competidores que el asesor vigila
create table if not exists competidores (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  usuario_tiktok text not null,
  agregado timestamptz default now(),
  unique (user_id, usuario_tiktok)
);

-- Conexion de WhatsApp Cloud API por usuario (embedded signup)
create table if not exists wa_conexiones (
  user_id uuid primary key references auth.users on delete cascade,
  waba_id text default '',
  phone_number_id text default '',
  display_number text default '',
  access_token text default '',       -- token del sistema Meta (encriptar en prod)
  conectado timestamptz default now()
);

-- Suscripciones push por usuario
create table if not exists push_subs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  subscription jsonb not null
);
create unique index if not exists push_subs_endpoint
  on push_subs (user_id, ((subscription->>'endpoint')));

-- RLS: cada usuario solo ve lo suyo
alter table perfiles     enable row level security;
alter table clientes     enable row level security;
alter table lives        enable row level security;
alter table competidores enable row level security;
alter table wa_conexiones enable row level security;
alter table push_subs    enable row level security;

create policy "own" on perfiles      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own" on clientes      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own" on lives         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own" on competidores  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own" on wa_conexiones for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own" on push_subs     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
