/* Servidor Registro de Clientes
   - Sirve la PWA (carpeta padre)
   - Analisis de TikTok Live por usuario (TikTok-Live-Connector, no oficial)
   - Push diario 20:00 (web-push) para recordar el registro */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const multer = require('multer');

const os = require('os');
const { spawn } = require('child_process');
const ffmpegBin = require('ffmpeg-static');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const { initWhatsApp } = require('./whatsapp');

/* Supabase desde el servidor (service_role: SOLO aqui, nunca en el frontend) */
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
/* Token que tu eliges y pones igual en Meta > WhatsApp > Webhooks */
const WA_VERIFY = process.env.WA_VERIFY_TOKEN || 'registro-clientes-verify';
/* Groq: transcripcion (Whisper) + resumen (LLM). Key solo en servidor. */
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API = 'https://api.groq.com/openai/v1';
/* Stripe: suscripciones. Sin STRIPE_KEY el servidor queda en modo abierto (dev). */
const STRIPE_KEY = process.env.STRIPE_KEY || '';
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_PRO || '';
/* Monetizacion: por defecto activa (Pro requerido para lives). Pon MONETIZACION=false para desactivar. */
const MONETIZACION = process.env.MONETIZACION !== 'false';
/* Admin para aprobar pagos manuales (Plin/Yape) */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'zapatabraulio458@gmail.com';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
app.use(cors());
/* El webhook de Stripe necesita el body CRUDO para verificar la firma */
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

/* ---------- Persistencia minima ---------- */
let data = { vapid: null, subscriptions: [], lives: [], scriptUrl: '' };
try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
const persist = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

if (!data.vapid) { data.vapid = webpush.generateVAPIDKeys(); persist(); }
webpush.setVapidDetails('mailto:admin@clientes.local', data.vapid.publicKey, data.vapid.privateKey);

/* ---------- Push ---------- */
app.get('/api/vapid-key', (req, res) => res.json({ key: data.vapid.publicKey }));

app.post('/api/subscribe', (req, res) => {
  const sub = req.body.subscription;
  if (sub && !data.subscriptions.find(s => s.endpoint === sub.endpoint)) {
    data.subscriptions.push(sub); persist();
  }
  res.json({ ok: true });
});

app.post('/api/test-push', async (req, res) => {
  let sent = 0;
  for (const s of data.subscriptions) {
    try {
      await webpush.sendNotification(s, JSON.stringify({
        title: 'Mis Clientes', body: 'Prueba de notificación — funciona ✓',
      }));
      sent++;
    } catch { /* suscripcion muerta */ }
  }
  res.json({ ok: true, sent });
});

// Recordatorio diario 20:00 hora del servidor
cron.schedule('0 20 * * *', () => enviarRecordatorio());

// Endpoint para el cron de Vercel (el server puede estar dormido;
// Vercel lo despierta con esta llamada y se envian los recordatorios)
app.get('/api/send-push', async (req, res) => res.json(await enviarRecordatorio()));
app.post('/api/send-push', async (req, res) => res.json(await enviarRecordatorio()));

async function enviarRecordatorio() {
  const payload = JSON.stringify({
    title: 'Mis Clientes',
    body: '¿Cuántos clientes atendiste hoy? Regístralos antes de cerrar el día.',
  });
  const vivos = [];
  let enviados = 0;
  for (const s of data.subscriptions) {
    try { await webpush.sendNotification(s, payload); vivos.push(s); enviados++; } catch {}
  }
  if (vivos.length !== data.subscriptions.length) { data.subscriptions = vivos; persist(); }
  return { ok: true, enviados };
}

/* ---------- Supabase REST (service role) ---------- */
const sbRest = async (ruta, opts = {}) => {
  if (!SB_URL || !SB_KEY) return null;
  const r = await fetch(`${SB_URL}/rest/v1/${ruta}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=minimal',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204) return null;
  return r.json().catch(() => null);
};

/* ---------- WhatsApp Cloud API: leads automaticos ---------- */
/* Meta hace GET para verificar el webhook al configurarlo */
app.get('/api/wa/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

/* Meta hace POST con cada mensaje entrante */
app.post('/api/wa/webhook', (req, res) => {
  res.sendStatus(200);  // responder rapido o Meta reintenta
  Promise.resolve().then(async () => {
    for (const entry of (req.body && req.body.entry) || [])
      for (const change of entry.changes || [])
        for (const msg of ((change.value && change.value.messages) || []))
          await procesarWa(change.value || {}, msg).catch(() => {});
  }).catch(() => {});
});

/* Crea el lead (o anota mensaje si el numero ya existe). Lo usan el
   webhook de Meta y el endpoint de captura Tasker/Atajos. */
async function crearLeadWa(userId, tel, nombre, texto) {
  const hoy = new Date().toISOString();
  const fecha = hoy.slice(0, 10);
  const existe = await sbRest(`clientes?user_id=eq.${userId}&telefono=eq.${tel}&select=id,notas`);
  if (existe && existe.length) {
    const c = existe[0];
    await sbRest(`clientes?id=eq.${c.id}`, {
      method: 'PATCH',
      body: { notas: ((c.notas || '') + `\nWA: ${texto}`).trim().slice(0, 2000), updated_at: hoy },
    });
    return 'anotado';
  }
  await sbRest('clientes', {
    method: 'POST',
    body: {
      id: 'wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      user_id: userId,
      nombre: nombre || tel, telefono: tel,
      estado: 'nuevo', origen: 'whatsapp', primer_mensaje: texto,
      motivo: '', seguimiento: '', notas: '',
      fecha, estado_fecha: fecha, creado: hoy, updated_at: hoy,
    },
  });
  return 'creado';
}

/* Captura universal SIN Meta: Tasker (Android, lee notificaciones) o
   Atajos (iOS, portapapeles) hacen POST { de, texto } y aqui se crea el lead.
   El :uid es el user_id del asesor — se muestra en Ajustes. */
app.post('/api/leads/:uid', async (req, res) => {
  const uid = String(req.params.uid || '');
  if (!/^[0-9a-f-]{20,}$/i.test(uid)) return res.status(400).json({ error: 'id inválido' });
  const { de = '', texto = '', telefono = '' } = req.body || {};

  /* 1) numero explicito, 2) extraido del titulo/texto de la notificacion */
  let tel = String(telefono).replace(/\D/g, '');
  if (!tel) {
    const m = `${de} ${texto}`.match(/\+?[\d][\d\s\-().]{7,}\d/);
    if (m) tel = m[0].replace(/\D/g, '');
  }
  if (tel && (tel.length < 8 || tel.length > 15)) tel = '';

  const nombre = de.replace(/\+?[\d][\d\s\-().]{7,}\d/, ' ').replace(/\s+/g, ' ').trim();
  const msg = (texto || de || 'WhatsApp').trim().slice(0, 500);

  /* notificaciones basura del sistema ("2 mensajes de 3 chats", "WhatsApp") */
  if (/^(whatsapp|\d+\s+(mensajes?|messages?|nuevos?|chats?))/i.test(de.trim()))
    return res.status(400).json({ error: 'notificación de resumen, ignorada' });

  if (tel) {
    const r = await crearLeadWa(uid, tel, nombre || tel, msg);
    return res.json({ ok: true, resultado: r, telefono: tel });
  }

  /* Contacto guardado: la notificacion trae nombre, no numero — el lead
     se crea igual (con telefono vacio) para que no se pierda */
  if (!/[\p{L}]/u.test(nombre)) return res.status(400).json({ error: 'no encontré número ni nombre', recibido: `${de} ${texto}`.slice(0, 80) });
  const hoy = new Date().toISOString();
  const ex = await sbRest(`clientes?user_id=eq.${uid}&telefono=eq.&nombre=eq.${encodeURIComponent(nombre)}&select=id,notas`);
  if (ex && ex.length) {
    await sbRest(`clientes?id=eq.${ex[0].id}`, { method: 'PATCH', body: {
      notas: ((ex[0].notas || '') + `\nWA: ${msg}`).trim().slice(0, 2000), updated_at: hoy } });
    return res.json({ ok: true, resultado: 'anotado', nombre });
  }
  await sbRest('clientes', { method: 'POST', body: {
    id: 'wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    user_id: uid, nombre, telefono: '',
    estado: 'nuevo', origen: 'whatsapp', primer_mensaje: msg,
    motivo: '', seguimiento: '', notas: '⚠️ Sin número (ya está en tus contactos — agrégalo manual)',
    fecha: hoy.slice(0, 10), estado_fecha: hoy.slice(0, 10), creado: hoy, updated_at: hoy,
  } });
  res.json({ ok: true, resultado: 'creado', nombre, aviso: 'sin número — contacto guardado' });
});

async function procesarWa(value, msg) {
  const phoneId = value.metadata && value.metadata.phone_number_id;
  const from = msg.from || '';
  const texto = (msg.text && msg.text.body) || `[${msg.type || 'mensaje'}]`;
  const nombre = (value.contacts && value.contacts[0] && value.contacts[0].profile.name) || from;
  if (!phoneId || !from) return;

  /* A que asesor pertenece este numero de WhatsApp Business */
  const conns = await sbRest(`wa_conexiones?phone_number_id=eq.${phoneId}&select=user_id,access_token`);
  const conn = conns && conns[0];
  if (!conn) return;

  await crearLeadWa(conn.user_id, from, nombre, texto);

  /* Auto-respuesta solo al primer contacto del lead */
  const perfs = await sbRest(`perfiles?user_id=eq.${conn.user_id}&select=wa_autoreply`);
  const reply = perfs && perfs[0] && perfs[0].wa_autoreply;
  if (reply && conn.access_token) {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: from, type: 'text',
        text: { body: reply },
      }),
    }).catch(() => {});
  }
}

/* ---------- Auth: verificar JWT de Supabase en endpoints de IA ---------- */
async function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /i, '');
  if (!token || !SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ---------- WhatsApp Web: conexion por QR, solo lectura de leads (Pro) ---------- */
const wa = initWhatsApp({ sbRest, crearLeadWa, authUser });
app.get('/api/whatsapp/status', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro', locked: true });
  wa.status(req, res);
});
app.post('/api/whatsapp/connect', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro', locked: true });
  wa.connect(req, res);
});
app.post('/api/whatsapp/disconnect', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro', locked: true });
  wa.disconnect(req, res);
});

/* ---------- Pagos manuales: Plin/Yape + voucher ---------- */
function isAdmin(email) { return email === ADMIN_EMAIL; }

async function uploadVoucher(file, filePath) {
  const r = await fetch(`${SB_URL}/storage/v1/object/vouchers/${filePath}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'x-upsert': 'true',
      'Content-Type': file.mimetype,
    },
    body: file.buffer,
  });
  return r.ok ? filePath : null;
}

async function signedVoucherUrl(filePath) {
  if (!filePath) return null;
  const r = await fetch(`${SB_URL}/storage/v1/object/sign/vouchers/${filePath}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d && d.signedURL ? `${SB_URL}/storage/v1${d.signedURL}` : null;
}

app.post('/api/pago/solicitar', upload.single('voucher'), async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  const metodo = String(req.body.metodo || '').toLowerCase();
  const telefono = String(req.body.telefono || '').replace(/\D/g, '').slice(0, 15);
  if (!['plin', 'yape'].includes(metodo)) return res.status(400).json({ error: 'Método inválido' });
  if (!telefono) return res.status(400).json({ error: 'Ingresa el número desde el que pagaste' });
  if (!req.file) return res.status(400).json({ error: 'Falta el voucher' });

  const existing = await sbRest(`solicitudes_pago?user_id=eq.${user.id}&estado=eq.pendiente&select=id`);
  if (existing && existing.length) return res.status(409).json({ error: 'Ya tienes una solicitud pendiente' });

  const ext = req.file.mimetype.includes('png') ? 'png' : req.file.mimetype.includes('jpg') || req.file.mimetype.includes('jpeg') ? 'jpg' : 'bin';
  const filePath = `${user.id}/${Date.now()}.${ext}`;
  const voucherUrl = await uploadVoucher(req.file, filePath);
  if (!voucherUrl) return res.status(502).json({ error: 'No se pudo subir el voucher' });

  await sbRest('solicitudes_pago', {
    method: 'POST',
    body: { user_id: user.id, metodo, telefono, monto: 20, voucher_url: voucherUrl }
  });
  res.json({ ok: true });
});

app.get('/api/pago/mis-solicitudes', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  const rows = await sbRest(`solicitudes_pago?user_id=eq.${user.id}&order=creado.desc&select=*`);
  res.json(rows || []);
});

app.get('/api/pago/pendientes', async (req, res) => {
  const user = await authUser(req);
  if (!user || !isAdmin(user.email)) return res.status(403).json({ error: 'No autorizado' });
  const rows = await sbRest(`solicitudes_pago?estado=eq.pendiente&order=creado.asc&select=*,perfiles(nombre,email)`);
  for (const row of (rows || [])) {
    row.voucher_signed = await signedVoucherUrl(row.voucher_url);
  }
  res.json(rows || []);
});

app.post('/api/pago/aprobar', async (req, res) => {
  const user = await authUser(req);
  if (!user || !isAdmin(user.email)) return res.status(403).json({ error: 'No autorizado' });
  const { id, aprobar, notas } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const rows = await sbRest(`solicitudes_pago?id=eq.${id}&select=user_id,estado`);
  if (!rows || !rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
  const target = rows[0];
  if (target.estado !== 'pendiente') return res.status(409).json({ error: 'Ya fue revisada' });

  const estado = aprobar ? 'aprobado' : 'rechazado';
  await sbRest(`solicitudes_pago?id=eq.${id}`, {
    method: 'PATCH',
    body: { estado, notas_admin: String(notas || '').slice(0, 500), revisado_en: new Date().toISOString() }
  });
  if (aprobar) {
    await sbRest(`perfiles?user_id=eq.${target.user_id}`, { method: 'PATCH', body: { plan: 'pro' } });
  }
  res.json({ ok: true, estado });
});

/* ---------- Groq: transcribir audio del live ---------- */
app.post('/api/live/transcribe', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'Falta GROQ_API_KEY en el servidor' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (!await esPro(user)) return res.status(402).json({ error: 'Requiere plan Pro' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Sin audio' });

  const mime = req.headers['content-type'] || 'audio/mp4';
  const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a'
    : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  try {
    const fd = new FormData();
    fd.append('file', new Blob([req.body], { type: mime }), `chunk.${ext}`);
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'es');
    fd.append('response_format', 'json');
    const r = await fetch(`${GROQ_API}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: fd,
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: d.error && d.error.message || 'Groq falló' });
    res.json({ texto: (d.text || '').trim() });
  } catch { res.status(502).json({ error: 'No se pudo transcribir' }); }
});

/* ---------- Groq: resumen IA del live (transcript + metricas) ---------- */
/* Resumen IA: lo usan el endpoint (cliente) y cerrarSesion (captura servidor) */
async function generarResumenTexto(usuario, metricas = {}, transcript = []) {
  if (!GROQ_KEY) return '';
  const texto = transcript.map(t => `[${t.t}s] ${t.texto}`).join('\n').slice(0, 15000);
  if (!texto && !metricas.comentarios) return '';
  const prompt = `Eres un analista de ventas por redes sociales para un asesor inmobiliario.
Analiza este live de TikTok de @${usuario}:

MÉTRICAS DEL CHAT:
- Duración: ${metricas.minutos} min · Pico de viewers: ${metricas.pico} · Comentarios: ${metricas.comentarios}
- Likes: ${metricas.likes} · Regalos: ${metricas.regalos} · Nuevos seguidores: ${metricas.seguidores || 0}
- Leads detectados (comentarios con intención de compra): ${metricas.leads}
- Temas que más preguntó la audiencia: ${(metricas.keywords || []).map(k => k.k + ' (' + k.n + ')').join(', ') || 'ninguno'}

TRANSCRIPCIÓN DE LO QUE DIJO EL STREAMER (segundos aprox.):
${texto || '(sin audio capturado)'}

Responde en español, directo y accionable, con estas secciones:
**RESUMEN**: 2-3 líneas de qué pasó en el live.
**OFERTAS Y CTAS**: precios, promociones o llamados a la acción que mencionó.
**QUÉ FUNCIONÓ**: momentos/temas que generaron más interés.
**OBJECIONES**: dudas o quejas que surgieron.
**RECOMENDACIONES**: 3 acciones concretas para el asesor que analiza esto.`;

  try {
    const r = await fetch(`${GROQ_API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });
    const d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch { return ''; }
}

app.post('/api/live/resumen', async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'Falta GROQ_API_KEY en el servidor' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (!await esPro(user)) return res.status(402).json({ error: 'Requiere plan Pro' });

  const { usuario, metricas = {}, transcript = [] } = req.body || {};
  let resumen = req.body.resumen_ia || '';
  if (!resumen) {
    resumen = await generarResumenTexto(usuario, metricas, transcript);
    if (!resumen) return res.status(400).json({ error: 'Nada que resumir' });
  }
  /* Guardar el reporte completo ligado al usuario */
  if (user.id) sbRest('lives', { method: 'POST', body: {
    user_id: user.id, usuario_tiktok: usuario, inicio: new Date(metricas.inicio || Date.now()),
    minutos: metricas.minutos || 0, pico: metricas.pico || 0, comentarios: metricas.comentarios || 0,
    likes: metricas.likes || 0, regalos: metricas.regalos || 0, leads: metricas.leads || 0,
    keywords: metricas.keywords || [], palabras: metricas.palabras || [],
    transcript, resumen_ia: resumen, razon: metricas.razon || '',
  } }).catch(() => {});
  res.json({ resumen });
});

/* ---------- Stripe: planes ---------- */
const stripePost = (ruta, params) =>
  fetch(`https://api.stripe.com/v1/${ruta}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }).then(r => r.json());

/* Plan del usuario: con monetizacion activa solo Pro puede analizar lives */
async function esPro(user) {
  if (!MONETIZACION) return true;
  if (!user || !user.id) return false;
  const p = await sbRest(`perfiles?user_id=eq.${user.id}&select=plan`);
  return !!(p && p[0] && p[0].plan === 'pro');
}

async function liveRestantes(user) {
  if (await esPro(user)) return 9999;
  const hoy = new Date().toISOString().slice(0, 10);
  const rows = await sbRest(`live_uso?user_id=eq.${user.id}&select=usos,fecha`);
  if (!rows || !rows.length) return 2;
  if (rows[0].fecha !== hoy) return 2;
  return Math.max(0, 2 - rows[0].usos);
}

async function usarLive(user) {
  const hoy = new Date().toISOString().slice(0, 10);
  const rows = await sbRest(`live_uso?user_id=eq.${user.id}&select=usos,fecha`);
  if (!rows || !rows.length) {
    await sbRest('live_uso', { method: 'POST', body: { user_id: user.id, fecha: hoy, usos: 1 } });
    return 1;
  }
  if (rows[0].fecha !== hoy) {
    await sbRest(`live_uso?user_id=eq.${user.id}`, { method: 'PATCH', body: { fecha: hoy, usos: 1, actualizado: new Date().toISOString() } });
    return 1;
  }
  const nuevo = rows[0].usos + 1;
  await sbRest(`live_uso?user_id=eq.${user.id}`, { method: 'PATCH', body: { usos: nuevo, actualizado: new Date().toISOString() } });
  return nuevo;
}

app.get('/api/plan', (req, res) => res.json({ monetizacion: MONETIZACION }));

app.post('/api/stripe/checkout', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (!STRIPE_KEY || !STRIPE_PRICE) return res.status(503).json({ error: 'Pagos no configurados' });
  const p = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': STRIPE_PRICE,
    'line_items[0][quantity]': '1',
    success_url: (req.headers.origin || '') + '/?pago=ok',
    cancel_url: (req.headers.origin || '') + '/?pago=cancel',
    client_reference_id: user.id,
    customer_email: user.email || '',
    allow_promotion_codes: 'true',
  });
  const s = await stripePost('checkout/sessions', p);
  if (!s.url) return res.status(502).json({ error: (s.error && s.error.message) || 'Stripe falló' });
  res.json({ url: s.url });
});

app.post('/api/stripe/portal', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  const perfs = await sbRest(`perfiles?user_id=eq.${user.id}&select=stripe_customer_id`);
  const cust = perfs && perfs[0] && perfs[0].stripe_customer_id;
  if (!cust) return res.status(400).json({ error: 'Sin suscripción' });
  const p = new URLSearchParams({ customer: cust, return_url: req.headers.origin || '' });
  const s = await stripePost('billing_portal/sessions', p);
  if (!s.url) return res.status(502).json({ error: 'Stripe falló' });
  res.json({ url: s.url });
});

function verificarStripe(rawBody, sigHeader) {
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const esperada = crypto.createHmac('sha256', STRIPE_WH)
      .update(`${parts.t}.${rawBody.toString()}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(parts.v1 || ''));
  } catch { return false; }
}

app.post('/api/stripe/webhook', async (req, res) => {
  if (!verificarStripe(req.body, req.headers['stripe-signature'] || ''))
    return res.sendStatus(400);
  let ev; try { ev = JSON.parse(req.body.toString()); } catch { return res.sendStatus(400); }

  if (ev.type === 'checkout.session.completed') {
    const o = ev.data.object;
    if (o.client_reference_id) {
      await sbRest(`perfiles?user_id=eq.${o.client_reference_id}`, {
        method: 'PATCH', body: { plan: 'pro', stripe_customer_id: o.customer || '' },
      });
    }
  }
  if (ev.type === 'customer.subscription.deleted') {
    await sbRest(`perfiles?stripe_customer_id=eq.${ev.data.object.customer}`, {
      method: 'PATCH', body: { plan: 'free' },
    });
  }
  res.json({ ok: true });
});

/* ---------- Google Sheet (resumen de lives) ---------- */
app.post('/api/sheet-url', (req, res) => {
  data.scriptUrl = req.body.url || ''; persist();
  res.json({ ok: true });
});
const enviarSheet = payload => {
  if (!data.scriptUrl) return;
  fetch(data.scriptUrl, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  }).catch(() => {});
};

/* ---------- Analisis de TikTok Live ---------- */
/* ---------- Sesiones de live (propias y de competencia) ---------- */
const LEAD_RE = /(precio|info|quie?ro|cu[aá]nto|d[oó]nde|separ|interesa|fich|apart)/i;

const CATEGORIAS = {
  'Precio':      /precio|cu[aá]nto|costo|vale|barato|caro|pesos|d[oó]lares/i,
  'Formas de pago': /infonavit|cr[eé]dito|hipoteca|meses|mensualidad|enganche|aparta|separ|contado|tarjeta|pago/i,
  'Ubicación':   /d[oó]nde|ubicaci[oó]n|queda|zona|colonia|direcci[oó]n|ciudad|centro/i,
  'Entrega':     /entrega|cu[aá]ndo|fecha|disponible|tiempo de|inmediata/i,
  'Confianza':   /estafa|fraude|confiable|seguro|garant[ií]a|real|verdad|falso|legal/i,
};

const STOPWORDS = new Set(('para,pero,como,este,esta,esto,está,estas,estos,aqui,aquí,hola,donde,cuando,' +
  'cuánto,cuanto,precio,info,tengo,tienen,quiero,quieren,puede,pueden,bueno,buena,mucho,muchas,' +
  'gracias,jaja,jajaja,hay,son,por,que,los,las,una,uno,del,con,sin,más,muy,ya,no,si,sí,de,el,' +
  'la,en,y,al,lo,me,te,se,mi,tu,su,es,un,le,nos,les,porque,porqué,cual,cuál,quién,quien,qué').split(','));

const sessions = new Map(); // usuario -> sesion

const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function topEntries(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));
}

const sessionStatus = s => ({
  activo: true,
  usuario: s.usuario,
  inicio: s.inicio,
  segundos: Math.floor((Date.now() - s.inicio) / 1000),
  viewers: s.viewers, pico: s.pico, comentarios: s.comentarios, likes: s.likes,
  regalos: s.regalos, nuevosSeguidores: s.seguidores, joins: s.joins,
  leads: s.leads,
  keywords: topEntries(s.kw, 6),
  palabras: topEntries(s.words, 15),
  vozServidor: !!s.ff,                       // true = el audio se capta solo
  transcript: (s.transcript || []).slice(-15),
});

/* ---------- Captura del audio del stream en el servidor ---------- */
/* Saca la URL del stream de la pagina publica del live (fragil: TikTok
   puede bloquear; si falla, el micro del cliente sigue funcionando) */
async function obtenerStreamUrl(usuario) {
  try {
    const r = await fetch(`https://www.tiktok.com/@${usuario}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await r.text();
    const m = html.match(/"stream_url"\s*:\s*(\{.+?\})\s*,\s*"/s);
    if (!m) return null;
    const su = JSON.parse(m[1]);
    if (typeof su.hls_pull_url === 'string' && su.hls_pull_url) return su.hls_pull_url;
    const flv = su.flv_pull_url || {};
    return flv.FULL_HD1 || flv.HD1 || flv.SD1 || flv.ORIGIN || null;
  } catch { return null; }
}

async function transcribirAudio(buf) {
  if (!GROQ_KEY) return '';
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'seg.mp3');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'es');
    fd.append('response_format', 'json');
    const r = await fetch(`${GROQ_API}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: fd,
    });
    const d = await r.json();
    return (d.text || '').trim();
  } catch { return ''; }
}

/* ffmpeg -> mp3 en segmentos de 30s -> cada uno a Whisper */
function capturarStream(s, streamUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  s.ffDir = dir;
  s.ff = spawn(ffmpegBin, [
    '-loglevel', 'error',
    '-i', streamUrl,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
    '-f', 'segment', '-segment_time', '30', '-reset_timestamps', '1',
    path.join(dir, 'seg_%04d.mp3'),
  ]);
  s.ff.on('error', () => { s.ff = null; });
  s.ff.on('exit', () => { s.ff = null; });
  const vistos = new Set();
  s.ffTimer = setInterval(() => {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).sort(); } catch { return; }
    for (const f of files.slice(0, -1)) {   // el ultimo aun se esta escribiendo
      if (vistos.has(f)) continue;
      vistos.add(f);
      const n = parseInt(f.match(/\d+/)[0], 10) || 0;
      const t = (n - 1) * 30;
      try {
        const buf = fs.readFileSync(path.join(dir, f));
        transcribirAudio(buf).then(txt => {
          if (txt) { s.transcript.push({ t, texto: txt }); }
        });
      } catch {}
    }
  }, 8000);
}

function detenerCaptura(s) {
  if (s.ffTimer) clearInterval(s.ffTimer);
  if (s.ff) try { s.ff.kill('SIGKILL'); } catch {}
  /* ultimo segmento pendiente */
  try {
    const files = fs.readdirSync(s.ffDir).filter(f => f.endsWith('.mp3')).sort();
    const ultimo = files[files.length - 1];
    if (ultimo) {
      const n = parseInt(ultimo.match(/\d+/)[0], 10) || 0;
      const buf = fs.readFileSync(path.join(s.ffDir, ultimo));
      return transcribirAudio(buf).then(txt => {
        if (txt) s.transcript.push({ t: (n - 1) * 30, texto: txt });
      }).finally(() => { try { fs.rmSync(s.ffDir, { recursive: true }); } catch {} });
    }
  } catch {}
  try { fs.rmSync(s.ffDir || '', { recursive: true }); } catch {}
  return Promise.resolve();
}

app.post('/api/live/start', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) {
    const rest = await liveRestantes(user);
    if (rest <= 0) return res.status(402).json({ error: 'Límite de 2 lives gratuitos alcanzado. Mejora a Pro para analizar sin límite.' });
  }
  const usuario = String(req.body.usuario || '').replace(/^@/, '').trim();
  if (!usuario) return res.status(400).json({ error: 'Falta el usuario' });
  if (sessions.has(usuario)) return res.json(sessionStatus(sessions.get(usuario)));

  const conn = new TikTokLiveConnection(usuario, {});
  try {
    await conn.connect();
  } catch {
    return res.status(404).json({ error: `@${usuario} no está en vivo o no existe` });
  }

  const s = { usuario, conn, inicio: Date.now(), viewers: 0, pico: 0, comentarios: 0,
    likes: 0, regalos: 0, seguidores: 0, joins: 0, leads: [], kw: {}, words: {},
    transcript: [] };
  sessions.set(usuario, s);

  /* Graba uso del live para el limite diario de usuarios free */
  if (MONETIZACION && !(await esPro(user))) await usarLive(user);

  /* Captura del audio del stream directo en el servidor (sin micro) */
  if (GROQ_KEY && ffmpegBin) {
    obtenerStreamUrl(usuario)
      .then(u => { if (u && sessions.has(usuario)) capturarStream(s, u); })
      .catch(() => {});
  }

  conn.on('roomUser', d => {
    s.viewers = Number(d.total) || s.viewers;
    if (s.viewers > s.pico) s.pico = s.viewers;
  });
  conn.on('chat', d => {
    s.comentarios++;
    const txt = d.comment || d.content || '';
    const user = d.uniqueId || (d.user && d.user.uniqueId) || '';
    const nombre = d.nickname || (d.user && d.user.nickname) || user;
    if (LEAD_RE.test(txt)) {
      s.leads.unshift({ user, nombre, texto: txt });
      if (s.leads.length > 200) s.leads.pop();
    }
    for (const [cat, re] of Object.entries(CATEGORIAS)) if (re.test(txt)) s.kw[cat] = (s.kw[cat] || 0) + 1;
    for (const w of norm(txt).match(/[a-zñ]{4,}/g) || []) {
      if (!STOPWORDS.has(w)) s.words[w] = (s.words[w] || 0) + 1;
    }
  });
  conn.on('like', d => { s.likes = Number(d.total) || s.likes; });
  conn.on('gift', () => { s.regalos++; });
  conn.on('follow', () => { s.seguidores++; });
  conn.on('member', () => { s.joins++; });
  conn.on('streamEnd', () => cerrarSesion(usuario, 'El live terminó'));
  conn.on('disconnected', () => { if (sessions.has(usuario)) cerrarSesion(usuario, 'Conexión perdida'); });
  conn.on('error', () => {});

  res.json(sessionStatus(s));
});

app.get('/api/live/status', (req, res) => {
  const u = req.query.usuario;
  if (u) return res.json(sessions.has(u) ? sessionStatus(sessions.get(u)) : { activo: false });
  res.json({ activos: [...sessions.values()].map(sessionStatus) });
});

app.post('/api/live/stop', async (req, res) => {
  const usuario = String(req.body.usuario || '').replace(/^@/, '').trim();
  if (usuario && sessions.has(usuario)) return res.json(await cerrarSesion(usuario, 'Detenido'));
  if (!usuario && sessions.size) return res.json(await cerrarSesion([...sessions.keys()][0], 'Detenido'));
  res.json({ activo: false });
});

app.get('/api/live/limite', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  const pro = await esPro(user);
  const rest = await liveRestantes(user);
  res.json({ pro, restantes: rest });
});

app.get('/api/live/historial', (req, res) => res.json(data.lives.slice(-20).reverse()));

async function cerrarSesion(usuario, razon) {
  const s = sessions.get(usuario); if (!s) return { activo: false };
  sessions.delete(usuario);
  try { s.conn.disconnect(); } catch {}
  await detenerCaptura(s);
  const min = Math.round((Date.now() - s.inicio) / 60000);
  const resumen = {
    usuario, inicio: s.inicio, minutos: min, pico: s.pico, comentarios: s.comentarios,
    likes: s.likes, regalos: s.regalos, seguidores: s.seguidores, joins: s.joins,
    leads: s.leads.length, keywords: topEntries(s.kw, 6), palabras: topEntries(s.words, 15),
    razon, transcript: s.transcript || [],
  };
  resumen.resumen_ia = await generarResumenTexto(usuario, resumen, resumen.transcript);
  data.lives.push(resumen); persist();
  enviarSheet({
    nombre: `LIVE @${usuario}`, telefono: '', estado: 'Live', motivo: '',
    fechahora: new Date().toLocaleString('es-MX'), seguimiento: '',
    notas: `${min}min · pico ${s.pico} · ${s.comentarios} comentarios · ${s.likes} likes · ${s.regalos} regalos · ${s.leads.length} leads · ${resumen.keywords.map(k=>k.k+':'+k.n).join(', ')}`,
  });
  return { activo: false, resumen };
}

/* ---------- Competencia (Pro) ---------- */
data.competidores = data.competidores || [];

app.get('/api/competidores', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro' });
  res.json(data.competidores.map(c => ({ ...c, analizando: sessions.has(c.usuario) })));
});

app.post('/api/competidores', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro' });
  const usuario = String(req.body.usuario || '').replace(/^@/, '').trim();
  if (!usuario) return res.status(400).json({ error: 'Falta el usuario' });
  if (data.competidores.some(c => c.usuario === usuario)) return res.json({ ok: true });
  data.competidores.push({ usuario, agregado: Date.now(), livesAnalizados: 0 });
  persist(); res.json({ ok: true });
});

app.delete('/api/competidores/:usuario', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro' });
  const u = req.params.usuario;
  if (sessions.has(u)) cerrarSesion(u, 'Eliminado de competencia');
  data.competidores = data.competidores.filter(c => c.usuario !== u);
  persist(); res.json({ ok: true });
});

// Reporte agregado de competencia
app.get('/api/competidores/reporte', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (MONETIZACION && !(await esPro(user))) return res.status(402).json({ error: 'Requiere plan Pro' });
  const users = new Set(data.competidores.map(c => c.usuario));
  const vidas = data.lives.filter(l => users.has(l.usuario));
  const porCuenta = {};
  const kwTot = {}, wordsTot = {};
  for (const l of vidas) {
    const c = porCuenta[l.usuario] = porCuenta[l.usuario] || { usuario: l.usuario, lives: 0, picoTotal: 0, comentariosTotal: 0, leadsTotal: 0 };
    c.lives++; c.picoTotal += l.pico; c.comentariosTotal += l.comentarios; c.leadsTotal += l.leads;
    (l.keywords || []).forEach(k => kwTot[k.k] = (kwTot[k.k] || 0) + k.n);
    (l.palabras || []).forEach(p => wordsTot[p.k] = (wordsTot[p.k] || 0) + p.n);
  }
  const cuentas = Object.values(porCuenta).map(c => ({
    ...c, picoPromedio: Math.round(c.picoTotal / c.lives),
    comentariosPromedio: Math.round(c.comentariosTotal / c.lives),
  })).sort((a, b) => b.picoPromedio - a.picoPromedio);

  const RECOS = {
    'Precio': 'Habla del precio desde el primer minuto y ponlo en el título del live.',
    'Formas de pago': 'Menciona crédito, meses y enganche temprano: es lo que más preguntan.',
    'Ubicación': 'Pon la zona/colonia en el título del live y repítela cada tanto.',
    'Entrega': 'Comunica fechas de entrega claras al aire.',
    'Confianza': 'Muestra pruebas de entrega o testimonios: hay miedo a estafa.',
  };
  const topKw = topEntries(kwTot, 5);
  res.json({
    cuentas,
    totalLivesAnalizados: vidas.length,
    topCategorias: topKw,
    topPalabras: topEntries(wordsTot, 15),
    recomendaciones: topKw.slice(0, 3).map(k => RECOS[k.k]).filter(Boolean),
  });
});

app.listen(PORT, () => console.log(`App + API en http://localhost:${PORT}`));
