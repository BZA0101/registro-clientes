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
alter table perfiles add column if not exists avatar_url text default '';

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

drop policy if exists "own" on perfiles;
create policy "own" on perfiles      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on clientes;
create policy "own" on clientes      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on lives;
create policy "own" on lives         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on competidores;
create policy "own" on competidores  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on wa_conexiones;
create policy "own" on wa_conexiones for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on push_subs;
create policy "own" on push_subs     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auth state de WhatsApp Web (Baileys) por usuario.
-- Cada par clave/valor se serializa y se guarda en Supabase porque
-- Render no tiene disco persistente en el plan gratuito.
create table if not exists wa_auth_state (
  user_id uuid not null references auth.users on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- Estado de la sesión de WhatsApp Web (jid conectado, último QR, etc.)
create table if not exists wa_sessions (
  user_id uuid primary key references auth.users on delete cascade,
  jid text default '',
  connected boolean default false,
  updated_at timestamptz default now()
);

alter table wa_auth_state enable row level security;
alter table wa_sessions     enable row level security;

drop policy if exists "own" on wa_auth_state;
create policy "own" on wa_auth_state for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own" on wa_sessions;
create policy "own" on wa_sessions     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Solicitudes de pago manual (Plin/Yape). El admin revisa el voucher y marca Pro.
create table if not exists solicitudes_pago (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  telefono text default '',            -- numero desde el que se pago
  metodo text default '',              -- plin | yape
  monto numeric default 20,            -- soles peruanos
  estado text default 'pendiente',     -- pendiente | aprobado | rechazado
  voucher_url text default '',         -- ruta en bucket "vouchers"
  notas_admin text default '',
  creado timestamptz default now(),
  revisado_en timestamptz
);

alter table solicitudes_pago enable row level security;
drop policy if exists "own" on solicitudes_pago;
create policy "own" on solicitudes_pago for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Relacion directa con perfiles para poder hacer select=*,perfiles(nombre,email)
alter table solicitudes_pago drop constraint if exists fk_solicitudes_perfil;
alter table solicitudes_pago add constraint fk_solicitudes_perfil
  foreign key (user_id) references perfiles(user_id) on delete cascade;

-- Buckets de Storage para vouchers y avatares
insert into storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types)
values ('vouchers', 'vouchers', false, false, 5242880, '{image/png,image/jpeg}')
on conflict (id) do update set public=excluded.public, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, false, 2097152, '{image/png,image/jpeg}')
on conflict (id) do update set public=excluded.public, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

-- Politicas de Storage para avatares (cada usuario sube/actualiza el suyo; lectura publica)
drop policy if exists "Avatars public read" on storage.objects;
create policy "Avatars public read" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "Avatars own insert" on storage.objects;
create policy "Avatars own insert" on storage.objects for insert with check (bucket_id = 'avatars' and owner = auth.uid());
drop policy if exists "Avatars own update" on storage.objects;
create policy "Avatars own update" on storage.objects for update using (bucket_id = 'avatars' and owner = auth.uid());
drop policy if exists "Avatars own delete" on storage.objects;
create policy "Avatars own delete" on storage.objects for delete using (bucket_id = 'avatars' and owner = auth.uid());
