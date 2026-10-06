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

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

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
      Prefer: 'return=minimal',
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

  const hoy = new Date().toISOString();
  const fecha = hoy.slice(0, 10);

  /* Si el numero ya es cliente, se anota el mensaje y sube a Nuevo otra vez */
  const existe = await sbRest(`clientes?user_id=eq.${conn.user_id}&telefono=eq.${from}&select=id,notas`);
  if (existe && existe.length) {
    const c = existe[0];
    await sbRest(`clientes?id=eq.${c.id}`, {
      method: 'PATCH',
      body: { notas: ((c.notas || '') + `\nWA: ${texto}`).trim().slice(0, 2000), updated_at: hoy },
    });
    return;
  }

  await sbRest('clientes', {
    method: 'POST',
    body: {
      id: 'wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      user_id: conn.user_id,
      nombre, telefono: from,
      estado: 'nuevo', origen: 'whatsapp', primer_mensaje: texto,
      motivo: '', seguimiento: '', notas: '',
      fecha, estado_fecha: fecha, creado: hoy, updated_at: hoy,
    },
  });

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
app.post('/api/live/resumen', async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'Falta GROQ_API_KEY en el servidor' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  if (!await esPro(user)) return res.status(402).json({ error: 'Requiere plan Pro' });

  const { usuario, metricas = {}, transcript = [] } = req.body || {};
  const texto = transcript.map(t => `[${t.t}s] ${t.texto}`).join('\n').slice(0, 15000);
  if (!texto && !metricas.comentarios) return res.status(400).json({ error: 'Nada que resumir' });

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
    if (!r.ok) return res.status(502).json({ error: d.error && d.error.message || 'Groq falló' });
    const resumen = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
    /* Guardar el reporte completo ligado al usuario */
    if (user.id) sbRest('lives', { method: 'POST', body: {
      user_id: user.id, usuario_tiktok: usuario, inicio: new Date(metricas.inicio || Date.now()),
      minutos: metricas.minutos || 0, pico: metricas.pico || 0, comentarios: metricas.comentarios || 0,
      likes: metricas.likes || 0, regalos: metricas.regalos || 0, leads: metricas.leads || 0,
      keywords: metricas.keywords || [], palabras: metricas.palabras || [],
      transcript, resumen_ia: resumen, razon: metricas.razon || '',
    } });
    res.json({ resumen });
  } catch { res.status(502).json({ error: 'No se pudo generar el resumen' }); }
});

/* ---------- Stripe: planes ---------- */
const stripePost = (ruta, params) =>
  fetch(`https://api.stripe.com/v1/${ruta}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }).then(r => r.json());

/* Plan del usuario: sin Stripe configurado todo queda abierto */
async function esPro(user) {
  if (!STRIPE_KEY) return true;
  if (!user || !user.id) return false;
  const p = await sbRest(`perfiles?user_id=eq.${user.id}&select=plan`);
  return !!(p && p[0] && p[0].plan === 'pro');
}

app.get('/api/plan', (req, res) => res.json({ monetizacion: !!STRIPE_KEY }));

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
});

app.post('/api/live/start', async (req, res) => {
  if (STRIPE_KEY) {   // con monetizacion activa el analisis de lives es Pro
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: 'Sin sesión' });
    if (!await esPro(user)) return res.status(402).json({ error: 'Requiere plan Pro' });
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
    likes: 0, regalos: 0, seguidores: 0, joins: 0, leads: [], kw: {}, words: {} };
  sessions.set(usuario, s);

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

app.post('/api/live/stop', (req, res) => {
  const usuario = String(req.body.usuario || '').replace(/^@/, '').trim();
  if (usuario && sessions.has(usuario)) return res.json(cerrarSesion(usuario, 'Detenido'));
  if (!usuario && sessions.size) return res.json(cerrarSesion([...sessions.keys()][0], 'Detenido'));
  res.json({ activo: false });
});

app.get('/api/live/historial', (req, res) => res.json(data.lives.slice(-20).reverse()));

function cerrarSesion(usuario, razon) {
  const s = sessions.get(usuario); if (!s) return { activo: false };
  sessions.delete(usuario);
  try { s.conn.disconnect(); } catch {}
  const min = Math.round((Date.now() - s.inicio) / 60000);
  const resumen = {
    usuario, inicio: s.inicio, minutos: min, pico: s.pico, comentarios: s.comentarios,
    likes: s.likes, regalos: s.regalos, seguidores: s.seguidores, joins: s.joins,
    leads: s.leads.length, keywords: topEntries(s.kw, 6), palabras: topEntries(s.words, 15), razon,
  };
  data.lives.push(resumen); persist();
  enviarSheet({
    nombre: `LIVE @${usuario}`, telefono: '', estado: 'Live', motivo: '',
    fechahora: new Date().toLocaleString('es-MX'), seguimiento: '',
    notas: `${min}min · pico ${s.pico} · ${s.comentarios} comentarios · ${s.likes} likes · ${s.regalos} regalos · ${s.leads.length} leads · ${resumen.keywords.map(k=>k.k+':'+k.n).join(', ')}`,
  });
  return { activo: false, resumen };
}

/* ---------- Competencia ---------- */
data.competidores = data.competidores || [];

app.get('/api/competidores', (req, res) => res.json(data.competidores.map(c => ({
  ...c,
  analizando: sessions.has(c.usuario),
}))));

app.post('/api/competidores', (req, res) => {
  const usuario = String(req.body.usuario || '').replace(/^@/, '').trim();
  if (!usuario) return res.status(400).json({ error: 'Falta el usuario' });
  if (data.competidores.some(c => c.usuario === usuario)) return res.json({ ok: true });
  data.competidores.push({ usuario, agregado: Date.now(), livesAnalizados: 0 });
  persist(); res.json({ ok: true });
});

app.delete('/api/competidores/:usuario', (req, res) => {
  const u = req.params.usuario;
  if (sessions.has(u)) cerrarSesion(u, 'Eliminado de competencia');
  data.competidores = data.competidores.filter(c => c.usuario !== u);
  persist(); res.json({ ok: true });
});

// Reporte agregado de competencia
app.get('/api/competidores/reporte', (req, res) => {
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
