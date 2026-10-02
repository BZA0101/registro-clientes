/* Servidor Registro de Clientes
   - Sirve la PWA (carpeta padre)
   - Analisis de TikTok Live por usuario (TikTok-Live-Connector, no oficial)
   - Push diario 20:00 (web-push) para recordar el registro */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');
const { TikTokLiveConnection } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const app = express();
app.use(cors());
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
