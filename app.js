/* Registro de Clientes — PWA para iPhone
   Toda la data vive en localStorage y se replica a Google Sheets (Apps Script). */

const CONFIG = {
  // Pega aqui la URL de tu Apps Script (Deploy > Web app). Ver README.
  SCRIPT_URL: localStorage.getItem('scriptUrl') || '',
  // La misma clave que pusiste en CLAVE en el Apps Script (si la pusiste).
  TOKEN: localStorage.getItem('syncToken') || '',
  // URL del servidor backend (Render). Vacio = mismo origen (localhost / Netlify proxy).
  API_URL: localStorage.getItem('apiUrl') || 'https://registro-clientes-54nw.onrender.com',
};

const apiFetch = (path, opts) => fetch(CONFIG.API_URL + path, opts);

/* ---------- Supabase: login + base de datos ----------
   Si las claves estan vacias la app sigue igual (localStorage solamente). */
const SUPA_URL = localStorage.getItem('supaUrl') || window.SUPABASE_URL || '';
const SUPA_KEY = localStorage.getItem('supaKey') || window.SUPABASE_ANON_KEY || '';
const sb = (SUPA_URL && SUPA_KEY && window.supabase)
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY) : null;
let session = null;   // sesion de Supabase, null = sin login
let authMode = 'login';            // login | signup | recover | setpass
let authErr = '';
let recoverSent = false;
let authEmail = '', authPass = '', authNombre = '', authPass2 = '', authSaludo = '', authCode = '';

async function dbPush(c) {
  if (!session) return;
  try {
    const { error } = await sb.from('clientes').upsert({
      ...c, user_id: session.user.id, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    c._synced = true; save();
  } catch { /* se reintenta en el siguiente dbPull */ }
}

async function dbDelete(id) {
  if (!session) return;
  try { await sb.from('clientes').delete().eq('id', id); } catch {}
}

/* Fusiona: el servidor gana si esta mas nuevo; los locales nuevos suben;
   los que el servidor ya borro (tenian _synced) desaparecen tambien aqui. */
async function dbPull() {
  if (!session) return;
  try {
    const { data, error } = await sb.from('clientes').select('*');
    if (error) throw error;
    const srvIds = new Set(data.map(r => r.id));
    const byId = new Map(clients.map(c => [c.id, c]));
    for (const r of data) {
      const local = byId.get(r.id);
      const srvTs = new Date(r.updated_at || 0).getTime();
      const locTs = new Date(local && local.updated_at || 0).getTime();
      if (!local || srvTs >= locTs) {
        delete r.user_id;
        r._synced = true;
        byId.set(r.id, r);
      } else dbPush(local);
    }
    clients = [...byId.values()].filter(c => {
      if (srvIds.has(c.id)) return true;
      if (c._synced) return false;   // borrado en otro dispositivo
      dbPush(c);                      // solo existe aqui: subirlo
      return true;
    });
    save();
  } catch {}
}

window.addEventListener('online', dbPull);

/* Pantalla de carga */
let loadTimer = null;
function showLoading(msg, slowMsg) {
  document.getElementById('loading-msg').textContent = msg || 'Cargando, espera por favor…';
  const sub = document.getElementById('loading-sub');
  sub.classList.add('hidden');
  document.getElementById('loading').classList.remove('hidden');
  clearTimeout(loadTimer);
  if (slowMsg) loadTimer = setTimeout(() => { sub.textContent = slowMsg; sub.classList.remove('hidden'); }, 6000);
}
function hideLoading() {
  clearTimeout(loadTimer);
  document.getElementById('loading').classList.add('hidden');
}

const MOTIVOS = ['Precio', 'No respondió', 'Sin presupuesto', 'Siguió buscando', 'Otro'];
const ESTADOS = {
  nuevo:       { label: 'Nuevo',           cls: 'nuevo' },
  conversando: { label: 'En conversación', cls: 'conversando' },
  separado:    { label: 'Separado',        cls: 'separado' },
  venta:       { label: 'Venta',           cls: 'venta' },
  cayo:        { label: 'Se cayó',         cls: 'cayo' },
};
const OPCIONES = [
  ['nuevo', 'Nuevo lead', 'Aún sin atender'],
  ['conversando', 'En conversación', 'Sigue interesado'],
  ['separado', 'Separación lograda', 'Apartó su lugar'],
  ['venta', 'Venta concretada', 'Se cerró el trato'],
  ['cayo', 'Se cayó', 'No se concretó'],
];
/* A donde puede avanzar cada estado (cayo siempre disponible) */
const NEXT = {
  nuevo:       ['conversando', 'separado', 'venta', 'cayo'],
  conversando: ['separado', 'venta', 'cayo'],
  separado:    ['venta', 'cayo'],
  venta:       [],
  cayo:        [],
};
const CON_SEGUIMIENTO = ['nuevo', 'conversando', 'separado'];

/* ---------- Estado ---------- */
let clients = JSON.parse(localStorage.getItem('clients') || '[]');
let pendingSync = JSON.parse(localStorage.getItem('pendingSync') || '[]');
let screen = 'hoy';
let filter = 'todos';
let clientSearch = '';
let detailId = null;
let form = null;
let pickMotivo = false;
let pickVenta = false;
let ventaMonto = '';
let corrigiendo = false;
let livePoll = null;
let liveResumen = null;
let liveError = '';
let liveLimite = { restantes: 2, pro: false, cargado: false };

const save = () => {
  localStorage.setItem('clients', JSON.stringify(clients));
  localStorage.setItem('pendingSync', JSON.stringify(pendingSync));
};

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtFecha = iso => new Date(iso + 'T12:00').toLocaleDateString('es', { day: 'numeric', month: 'short' });
const fmtFechaHora = d =>
  d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
  d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const fmtMoney = n => '$' + Number(n || 0).toLocaleString('es-MX');

/* ---------- Iconos ---------- */
const ICON = {
  chevron: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8.5 8.5 0 0 1-12.6 7.4L3.5 20l1.1-3.8A8.5 8.5 0 1 1 20 11.5z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.6A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.3 7.3A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7a4.5 4.5 0 0 0-3.5-1.9c-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8a4.7 4.7 0 0 0-4 2.4c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4a10.6 10.6 0 0 0 1.4-2.8 4.3 4.3 0 0 1-2.6-3.9zM14 5.4a4.3 4.3 0 0 0 1-3.1 4.4 4.4 0 0 0-2.9 1.5 4.1 4.1 0 0 0-1 3 3.6 3.6 0 0 0 2.9-1.4z"/></svg>',
  android: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.6 9.5 19.4 6.3a.4.4 0 0 0-.7-.4l-1.8 3.2a11 11 0 0 0-9.8 0L5.3 5.9a.4.4 0 0 0-.7.4l1.8 3.2A10.4 10.4 0 0 0 1 18h22a10.4 10.4 0 0 0-5.4-8.5zM7 15.2a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zm10 0a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z"/></svg>',
  tap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11l3.3.6a2 2 0 0 1 1.6 2.3l-.8 4.6a2 2 0 0 1-2 1.5H10a2 2 0 0 1-1.6-.8L5.3 15a1.5 1.5 0 0 1 2.3-1.9L9 14.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5v15l12-7.5z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
};

/* ---------- Sync a Google Sheets ---------- */
const post = p => fetch(CONFIG.SCRIPT_URL, {
  method: 'POST', mode: 'no-cors',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify(p),
});

async function syncRow(client) {
  const ahora = new Date();
  const payload = {
    clave: CONFIG.TOKEN,
    nombre: client.nombre,
    telefono: client.telefono,
    estado: ESTADOS[client.estado].label,
    motivo: client.motivo || '',
    fechahora: fmtFechaHora(ahora),
    seguimiento: client.seguimiento || '',
    notas: (client.notas || '') +
      (client.estado === 'venta' && client.monto_venta ? ` · Venta ${fmtMoney(client.monto_venta)}` : ''),
  };
  if (!CONFIG.SCRIPT_URL) { pendingSync.push(payload); save(); updateBadge(); return; }
  try { await post(payload); } catch { pendingSync.push(payload); save(); }
  flushPending();
  updateBadge();
}

async function flushPending() {
  if (!CONFIG.SCRIPT_URL || !pendingSync.length) return;
  for (const p of [...pendingSync]) {
    try { await post(p); pendingSync.shift(); } catch { break; }
  }
  save(); updateBadge();
}

function updateBadge() {
  const b = document.getElementById('sync-badge');
  const txt = pendingSync.length ? `${pendingSync.length} sin enviar` : (!CONFIG.SCRIPT_URL ? 'Sin Sheet' : '');
  b.textContent = txt;
  b.classList.toggle('hidden', !txt);
}

/* ---------- Navegacion ---------- */
let lastPull = 0;
function go(s, id) {
  if (sb && !session && s !== 'login') s = 'login';
  screen = s; detailId = id || null; form = null;
  pickMotivo = false; pickVenta = false; corrigiendo = false;
  if (s === 'upgrade') upgradeForm = { metodo: 'yape', telefono: '', voucherPreview: null, voucherFile: null, loading: false, error: '', ok: false };
  if (s === 'perfil') {
    const meta = (session && session.user && session.user.user_metadata) || {};
    perfilForm = { nombre: (perfil && perfil.nombre) || meta.nombre || '', saludo: meta.saludo || 'bienvenido', avatar: null, preview: null, saving: false, error: '', ok: false };
  }
  if (s === 'admin') { adminPendientes = []; setTimeout(loadPendientes, 50); }
  /* Leads de WhatsApp pueden llegar en cualquier momento: refresca al navegar */
  if ((s === 'hoy' || s === 'clientes') && Date.now() - lastPull > 30000) {
    lastPull = Date.now(); dbPull().then(() => { if (screen === s) render(); });
  }
  if (livePoll && s !== 'live') { clearInterval(livePoll); livePoll = null; }
  if (s === 'live') {
    showLoading('Cargando, espera por favor…', 'Despertando el servidor, primera vez puede tardar ~40 segundos');
    Promise.all([loadLiveLimite(), loadComps()]).then(() => { hideLoading(); if (screen === 'live') render(); });
  }
  render();
}
document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => go(t.dataset.screen)));

/* ---------- Helpers ---------- */
const clientesHoy = () => clients.filter(c => c.fecha === today());
const seguimientosPendientes = () =>
  clients.filter(c => c.seguimiento && c.seguimiento <= today() && CON_SEGUIMIENTO.includes(c.estado));
const diasDesde = iso => iso ? Math.floor((Date.now() - new Date(iso + 'T12:00')) / 86400000) : null;
const monthKey = d => d.slice(0, 7);
const ofMonth = m => clients.filter(c => monthKey(c.fecha) === m);
function vibrate(pattern=20) { try { if (navigator.vibrate) navigator.vibrate(Array.isArray(pattern) ? pattern : [pattern]); } catch {} }
function emptyState(msg, iconName='user') { return `<div class="empty-state">${ICON[iconName] || ICON.user}<b>${esc(msg)}</b></div>`; }

/* ---------- Confeti ---------- */
function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c);
  const ctx = c.getContext('2d'); c.width = window.innerWidth; c.height = window.innerHeight;
  const colors = ['#7c9f60', '#5d3d24', '#c6a45c', '#f5f1e8'];
  const pieces = Array.from({length: 60}, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * 100,
    w: 6 + Math.random() * 6, h: 6 + Math.random() * 6,
    vx: -2 + Math.random() * 4, vy: 3 + Math.random() * 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * 360, vrot: -5 + Math.random() * 10
  }));
  let anim;
  function draw() {
    ctx.clearRect(0, 0, c.width, c.height);
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vrot;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (pieces.some(p => p.y < c.height + 40)) anim = requestAnimationFrame(draw); else c.remove();
  }
  draw(); setTimeout(() => { cancelAnimationFrame(anim); c.remove(); }, 3000);
}
const initial = n => esc((n.trim()[0] || '?').toUpperCase());

const status = c => `<span class="status ${ESTADOS[c.estado].cls}"><i></i>${ESTADOS[c.estado].label}</span>`;

const row = (c, sub) => `
  <button class="row" onclick="openClientSheet('${c.id}')">
    <span class="avatar">${initial(c.nombre)}</span>
    <span class="row-main"><span class="name">${esc(c.nombre)}</span>
      <span class="sub">${sub}</span></span>
    ${status(c)}${ICON.chevron}
  </button>`;

const list = (items, sub) => `<div class="list">${items.map(c => row(c, sub(c))).join('')}</div>`;

const optionList = (sel, handler) => `<div class="list">
  ${OPCIONES.map(([k, t, s]) => `
    <button class="row option ${sel===k?'selected':''}" onclick="${handler}('${k}')">
      <span class="dot ${k}"></span>
      <span class="row-main"><span class="name">${t}</span><span class="sub">${s}</span></span>
      <span class="tick">${sel===k ? ICON.check : ''}</span>
    </button>`).join('')}</div>`;

const motivoChips = (sel, handler) => `<div class="chips">
  ${MOTIVOS.map(m => `<button class="chip-btn ${sel===m?'active':''}" onclick="${handler}('${m}')">${m}</button>`).join('')}</div>`;

/* ---------- Vistas ---------- */
/* Campo con etiqueta flotante + icono (+ ojo para claves) */
const fld = (id, label, ico, type, val, varName, extra = '') => `
  <label class="field">
    ${ICON[ico].replace('<svg', '<svg class="ico"')}
    <input id="${id}" type="${type}" placeholder=" " value="${esc(val)}" oninput="${varName}=this.value${id === 'au-pass' && authMode === 'signup' ? ';pwStrength(this.value)' : ''}" ${extra}>
    <span>${label}</span>
    ${type === 'password' ? `<button type="button" class="eye" onclick="event.preventDefault();togglePass(this)" aria-label="Ver clave">${ICON.eye}</button>` : ''}
  </label>`;

function togglePass(btn) {
  const inp = btn.parentElement.querySelector('input');
  const ver = inp.type === 'password';
  inp.type = ver ? 'text' : 'password';
  btn.innerHTML = ver ? ICON.eyeOff : ICON.eye;
}

function pwStrength(v) {
  const el = document.getElementById('pw-strength'); if (!el) return;
  const s = !v ? 0 : v.length < 6 ? 1 : (v.length >= 10 && /\d/.test(v) && /[a-z]/i.test(v)) ? 3 : 2;
  el.className = 'strength' + (s ? ' s' + s : '');
}

function pickSaludo(v, btn) {
  authSaludo = v;
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
}

function viewLogin() {
  const err = authErr ? `<div class="auth-err">${ICON.alert}<span>${esc(authErr)}</span></div>` : '';
  /* las animaciones de entrada solo corren al cambiar de modo, no en cada error */
  const anim = window._authAnimKey !== authMode + recoverSent ? 'anim' : '';
  window._authAnimKey = authMode + recoverSent;
  const shell = inner => `
    <div class="auth-wrap ${anim}">
      <div class="auth-bg"><i></i><i></i><i></i></div>
      <div class="auth-brand">
        <div class="auth-logo">${ICON.home}</div>
        <h1>Mis Clientes</h1>
        <p>Tu plataforma de análisis de marketing</p>
      </div>
      <div class="auth-card">${inner}</div>
      <p class="auth-foot">Tus datos están cifrados y solo <b>tú</b> los ves.</p>
    </div>`;

  /* Paso "recuperar clave" */
  if (authMode === 'recover') {
    return shell(`
      <h2 class="auth-title">${recoverSent ? 'Revisa tu correo' : 'Recuperar clave'}</h2>
      <p class="auth-sub">${recoverSent ? `Te enviamos un código de 6 dígitos a <b>${esc(authEmail)}</b>. Revisa también spam.` : 'Escribe tu correo y te mandamos un código para crear una clave nueva.'}</p>
      <div class="fields">
        ${recoverSent ? '' : fld('au-email', 'Correo', 'mail', 'email', authEmail, 'authEmail', 'inputmode="email" autocomplete="email" autocapitalize="none"')}
        ${recoverSent ? `
          ${fld('au-code', 'Código de 6 dígitos', 'key', 'tel', authCode, 'authCode', 'inputmode="numeric" autocomplete="one-time-code" maxlength="10"')}
          ${fld('au-pass', 'Nueva clave', 'lock', 'password', authPass, 'authPass', 'autocomplete="new-password"')}
          ${fld('au-pass2', 'Repite la clave', 'lock', 'password', authPass2, 'authPass2', 'autocomplete="new-password"')}` : ''}
      </div>
      ${recoverSent ? `<input id="au-email" type="hidden" value="${esc(authEmail)}">` : ''}
      ${err}
      <button class="primary mt" onclick="${recoverSent ? 'doRecover()' : 'doSendRecovery()'}">${recoverSent ? 'Cambiar mi clave' : 'Enviar código'} ${ICON.next}</button>
      <button class="link-btn" onclick="authMode='login';authErr='';recoverSent=false;render()">← Volver a entrar</button>`);
  }

  /* Paso "nueva clave" cuando llegan por el enlace del correo */
  if (authMode === 'setpass') {
    return shell(`
      <h2 class="auth-title">Nueva clave</h2>
      <p class="auth-sub">Elige una clave que recuerdes. Mínimo 6 caracteres.</p>
      <div class="fields">
        ${fld('au-pass', 'Nueva clave', 'lock', 'password', '', 'authPass', 'autocomplete="new-password"')}
        ${fld('au-pass2', 'Repite la clave', 'lock', 'password', '', 'authPass2', 'autocomplete="new-password"')}
      </div>
      ${err}
      <button class="primary mt" onclick="doSetPass()">Guardar clave ${ICON.check}</button>`);
  }

  /* Entrar / Crear cuenta */
  const esSignup = authMode === 'signup';
  const prev = window._authSeg ?? (esSignup ? 1 : 0);
  window._authSeg = esSignup ? 1 : 0;
  return shell(`
      <div class="seg2" data-on="${prev}" data-to="${esSignup ? 1 : 0}">
        <button class="${esSignup ? '' : 'on'}" onclick="authMode='login';authErr='';render()">Entrar</button>
        <button class="${esSignup ? 'on' : ''}" onclick="authMode='signup';authErr='';render()">Crear cuenta</button>
      </div>
      <p class="auth-sub">${esSignup ? 'Crea tu cuenta gratis en 30 segundos.' : 'Qué gusto verte de nuevo.'}</p>
      <div class="fields">
        ${esSignup ? fld('au-nombre', 'Tu nombre', 'user', 'text', authNombre, 'authNombre', 'autocomplete="name"') : ''}
        ${fld('au-email', 'Correo', 'mail', 'email', authEmail, 'authEmail', 'inputmode="email" autocomplete="email" autocapitalize="none"')}
        ${fld('au-pass', esSignup ? 'Clave (mín. 6)' : 'Clave', 'lock', 'password', authPass, 'authPass', `autocomplete="${esSignup ? 'new' : 'current'}-password"`)}
        ${esSignup ? `<div id="pw-strength" class="strength"><i></i><i></i><i></i></div>` : ''}
        ${esSignup ? fld('au-pass2', 'Repite la clave', 'lock', 'password', authPass2, 'authPass2', 'autocomplete="new-password"') : ''}
      </div>
      ${esSignup ? `
        <p class="pick-lbl">¿Cómo te saludamos?</p>
        <div class="saludo-pick">
          <button type="button" class="${authSaludo === 'bienvenida' ? 'on' : ''}" onclick="pickSaludo('bienvenida',this)">Bienvenida<small>femenino</small></button>
          <button type="button" class="${authSaludo === 'bienvenido' ? 'on' : ''}" onclick="pickSaludo('bienvenido',this)">Bienvenido<small>masculino</small></button>
        </div>` : ''}
      ${err}
      <button class="primary mt" onclick="${esSignup ? 'doSignup()' : 'doLogin()'}">${esSignup ? 'Crear mi cuenta' : 'Entrar'} ${ICON.next}</button>
      ${!esSignup ? `<button class="link-btn" onclick="authMode='recover';authErr='';recoverSent=false;render()">¿Olvidaste tu clave?</button>` : ''}`);
}

const field = (id, fallback) => {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
};
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function authCall(fn) {
  authErr = '';
  showLoading('Entrando…');
  const { data, error } = await fn();
  hideLoading();
  if (error) {
    authErr = error.message === 'Invalid login credentials'
      ? 'Correo o clave incorrectos.' : error.message;
    return render();
  }
  if (!data.session) {
    authErr = 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.';
    return render();
  }
}

function doLogin() {
  const email = field('au-email', authEmail).trim();
  const password = field('au-pass', authPass);
  authEmail = email; authPass = password;
  if (!emailOk(email)) { authErr = 'Escribe tu correo completo.'; return render(); }
  if (password.length < 6) { authErr = 'La clave necesita mínimo 6 caracteres.'; return render(); }
  return authCall(() => sb.auth.signInWithPassword({ email, password }));
}

async function doSignup() {
  const nombre = field('au-nombre', authNombre).trim();
  const email = field('au-email', authEmail).trim();
  const password = field('au-pass', authPass);
  const pass2 = field('au-pass2', authPass2);
  authNombre = nombre; authEmail = email; authPass = password; authPass2 = pass2;
  if (!nombre) { authErr = 'Escribe tu nombre.'; return render(); }
  if (!emailOk(email)) { authErr = 'Escribe tu correo completo.'; return render(); }
  if (password.length < 6) { authErr = 'La clave necesita mínimo 6 caracteres.'; return render(); }
  if (password !== pass2) { authErr = 'Las claves no coinciden.'; return render(); }
  if (!authSaludo) { authErr = 'Elige cómo te saludamos (Bienvenida / Bienvenido).'; return render(); }
  authErr = '';
  showLoading('Creando cuenta…');
  const { data, error } = await sb.auth.signUp({ email, password,
    options: { data: { nombre, saludo: authSaludo } } });
  if (error) { hideLoading(); authErr = error.message; return render(); }
  if (data.session) { hideLoading(); return; }   // entra sola via onAuthStateChange
  /* Sin sesion = el proyecto pide confirmar correo. Intentamos entrar igual
     por si la opcion se acaba de apagar. */
  const { error: e2 } = await sb.auth.signInWithPassword({ email, password });
  hideLoading();
  if (e2) {
    authErr = 'Cuenta creada. Tu Supabase aún pide confirmar correo: apágalo en Authentication → Providers → Email → "Confirm email".';
    render();
  }
}

async function doLogout() {
  await sb.auth.signOut();
  location.reload();
}

/* ---------- Recuperar clave (codigo por correo) ---------- */
async function doSendRecovery() {
  const email = field('au-email', authEmail).trim();
  authEmail = email;
  if (!emailOk(email)) { authErr = 'Escribe tu correo completo.'; return render(); }
  authErr = '';
  showLoading('Enviando código…');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  hideLoading();
  if (error) { authErr = error.message; return render(); }
  recoverSent = true;
  render();
}

async function doRecover() {
  const token = field('au-code', authCode).trim();
  const p1 = field('au-pass', authPass);
  const p2 = field('au-pass2', authPass2);
  authCode = token; authPass = p1; authPass2 = p2;
  if (token.length < 4) { authErr = 'Escribe el código que te llegó.'; return render(); }
  if (p1.length < 6) { authErr = 'La clave necesita mínimo 6 caracteres.'; return render(); }
  if (p1 !== p2) { authErr = 'Las claves no coinciden.'; return render(); }
  authErr = '';
  showLoading('Verificando…');
  const { error } = await sb.auth.verifyOtp({ email: authEmail, token, type: 'recovery' });
  if (error) { hideLoading(); authErr = 'Código incorrecto o vencido — pide otro.'; return render(); }
  const { error: e2 } = await sb.auth.updateUser({ password: p1 });
  hideLoading();
  if (e2) { authErr = e2.message; return render(); }
}

async function doSetPass() {
  const p1 = field('au-pass', authPass);
  const p2 = field('au-pass2', authPass2);
  if (p1.length < 6) { authErr = 'La clave necesita mínimo 6 caracteres.'; return render(); }
  if (p1 !== p2) { authErr = 'Las claves no coinciden.'; return render(); }
  authErr = '';
  showLoading('Guardando…');
  const { error } = await sb.auth.updateUser({ password: p1 });
  hideLoading();
  if (error) { authErr = error.message; return render(); }
  go('hoy');
}

/* Pantalla de bienvenida al entrar (reutiliza el estilo del splash) */
function showWelcome() {
  const meta = (session && session.user && session.user.user_metadata) || {};
  const nombreRaw = (perfil && perfil.nombre) || meta.nombre || (session && session.user && session.user.email || '').split('@')[0] || '';
  const nombre = nombreRaw.split(' ')[0].toUpperCase();
  const saludo = meta.saludo === 'bienvenida' ? 'BIENVENIDA' : 'BIENVENIDO';
  const el = document.createElement('div');
  el.id = 'splash';
  /* cada palabra entra escalonada */
  const palabras = ['HOLA' + (nombre ? ',' : ''), ...(nombre ? [nombre] : [])]
    .map((w, i) => `<span class="w" style="animation-delay:${.35 + i * .15}s">${esc(w)}</span>`).join(' ');
  el.innerHTML = `
    <div class="splash-logo">
      <svg id="splash-heart" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/></svg>
    </div>
    <p class="splash-hi" style="text-transform:uppercase">${palabras}</p>
    <p class="splash-love">${saludo} a tu plataforma de análisis de marketing</p>
    <div class="splash-bar"></div>`;
  document.body.appendChild(el);
  const dismiss = () => { el.classList.add('bye'); setTimeout(() => el.remove(), 700); };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, 2800);
}

/* Crea el perfil del asesor la primera vez que entra */
async function ensurePerfil() {
  if (!session) return;
  try {
    const { data } = await sb.from('perfiles')
      .select('user_id').eq('user_id', session.user.id).maybeSingle();
    if (!data) await sb.from('perfiles').insert({
      user_id: session.user.id,
      nombre: session.user.user_metadata?.nombre || '',
    });
  } catch {}
}

let perfil = null;
let monetizacion = false;   // true = pagos activos (manual Plin/Yape o Stripe)
const esPro = () => !monetizacion || (perfil && perfil.plan === 'pro');
let solicitudPago = null;   // ultima solicitud del usuario
let adminPendientes = [];
const ADMIN_EMAIL = 'zapatabraulio458@gmail.com';
const isAdmin = () => session && session.user.email === ADMIN_EMAIL;

async function loadMonetizacion() {
  try { monetizacion = !!(await (await apiFetch('/api/plan')).json()).monetizacion; }
  catch { monetizacion = false; }
}

async function loadMisSolicitudes() {
  if (!session) return;
  try {
    const r = await apiFetch('/api/pago/mis-solicitudes', { headers: { Authorization: `Bearer ${session.access_token}` } });
    const rows = await r.json();
    solicitudPago = (rows || []).sort((a, b) => new Date(b.creado) - new Date(a.creado))[0] || null;
  } catch { solicitudPago = null; }
}

function irUpgrade() { go('upgrade'); }

async function loadPerfil() {
  if (!session || !sb) return;
  try {
    perfil = (await sb.from('perfiles').select('*').eq('user_id', session.user.id).maybeSingle()).data;
  } catch {}
  await loadMisSolicitudes();
}

function viewHoy() {
  const hoy = clientesHoy();
  const pend = seguimientosPendientes();
  const sepHoy = hoy.filter(c => c.estado === 'separado').length;
  const nuevos = clients.filter(c => c.estado === 'nuevo').length;
  return `
    <div class="hero">
      <div class="hero-stats">
        <div><span class="hero-num">${hoy.length}</span><span class="hero-lbl">clientes hoy</span></div>
        <div><span class="hero-num">${sepHoy}</span><span class="hero-lbl">separaciones</span></div>
        <div><span class="hero-num">${pend.length}</span><span class="hero-lbl">por retomar</span></div>
      </div>
      ${nuevos ? `<button class="secondary" style="margin-bottom:10px" onclick="filter='nuevo';go('clientes')">${nuevos} lead${nuevos>1?'s':''} sin atender</button>` : ''}
      <button class="primary" onclick="go('registrar')">${ICON.plus}Registrar cliente</button>
    </div>

    ${pend.length ? `<div class="section-title">Por retomar</div>
      ${list(pend, c => `${esc(c.telefono)} · ${fmtFecha(c.seguimiento)}`)}` : ''}

    <div class="section-title">Registrados hoy</div>
    ${hoy.length ? list(hoy, c => esc(c.telefono)) :
      emptyState('Aún no registras clientes hoy.', 'user')}
  `;
}

function viewRegistrar() {
  form = form || { nombre: '', telefono: '', estado: '', motivo: '', motivoOtro: '', seguimiento: '', notas: '', monto: '' };
  return `
    <button class="back" onclick="go('hoy')">${ICON.back}Hoy</button>

    <div class="section-title">Cliente</div>
    <div class="list form">
      <label class="input-row"><span>Nombre</span>
        <input id="f-nombre" value="${esc(form.nombre)}" placeholder="María López" autocomplete="off" oninput="form.nombre=this.value"></label>
      <label class="input-row"><span>WhatsApp</span>
        <input id="f-tel" value="${esc(form.telefono)}" type="tel" inputmode="tel" placeholder="+52 555 123 4567" oninput="form.telefono=this.value"></label>
    </div>

    <div class="section-title">¿Cómo quedó?</div>
    ${optionList(form.estado, 'setEstado')}

    ${form.estado === 'cayo' ? `
      <div class="section-title">¿Por qué se cayó?</div>
      ${motivoChips(form.motivo, 'setMotivo')}
      ${form.motivo === 'Otro' ? `<div class="list form"><label class="input-row full">
        <input placeholder="Escribe el motivo" value="${esc(form.motivoOtro)}" oninput="form.motivoOtro=this.value"></label></div>` : ''}
    ` : ''}

    ${form.estado === 'venta' ? `
      <div class="section-title">Monto de la venta</div>
      <div class="list form"><label class="input-row"><span>$</span>
        <input type="tel" inputmode="numeric" placeholder="150000" value="${esc(form.monto||'')}" oninput="form.monto=this.value"></label></div>
    ` : ''}

    ${form.estado && CON_SEGUIMIENTO.includes(form.estado) && form.estado !== 'separado' ? `
      <div class="section-title">Seguimiento</div>
      <div class="list form"><label class="input-row"><span>Retomar el</span>
        <input type="date" value="${form.seguimiento}" onchange="form.seguimiento=this.value"></label></div>` : ''}

    <div class="section-title">Notas</div>
    <div class="list form"><label class="input-row full">
      <textarea rows="2" placeholder="Opcional" oninput="form.notas=this.value">${esc(form.notas)}</textarea></label></div>

    <button class="primary mt" onclick="guardarCliente()">Guardar</button>`;
}

function viewDetalle() {
  const c = clients.find(x => x.id === detailId);
  if (!c) return viewHoy();
  const tel = c.telefono.replace(/[^\d+]/g, '');
  const nexts = NEXT[c.estado] || [];
  return `
    <button class="back" onclick="go('clientes')">${ICON.back}Clientes</button>

    <div class="profile">
      <span class="avatar xl">${initial(c.nombre)}</span>
      <h2>${esc(c.nombre)}</h2>
      <p>${esc(c.telefono)}</p>
      ${status(c)}
    </div>

    <div class="actions">
      <a class="action" href="https://wa.me/${tel.replace('+','')}" target="_blank">${ICON.wa}<span>WhatsApp</span></a>
      <a class="action" href="tel:${tel}">${ICON.phone}<span>Llamar</span></a>
    </div>

    <div class="list info">
      <div class="info-row"><span>Registrado</span><b>${fmtFecha(c.fecha)}</b></div>
      ${c.estado === 'venta' && c.monto_venta ? `<div class="info-row"><span>Venta</span><b>${fmtMoney(c.monto_venta)} · ${fmtFecha(c.fecha_venta || c.fecha)}</b></div>` : ''}
      ${c.motivo ? `<div class="info-row"><span>Motivo</span><b>${esc(c.motivo)}</b></div>` : ''}
      ${c.primer_mensaje ? `<div class="info-row"><span>Primer mensaje</span><b>${esc(c.primer_mensaje)}</b></div>` : ''}
      ${c.notas ? `<div class="info-row"><span>Notas</span><b>${esc(c.notas)}</b></div>` : ''}
    </div>

    ${nexts.length ? `
      <div class="section-title">Actualizar estado</div>
      <div class="list">
        ${nexts.map(k => `
          <button class="row option" onclick="updEstado('${k}')">
            <span class="dot ${k}"></span>
            <span class="row-main"><span class="name">${OPCIONES.find(o=>o[0]===k)[1]}</span>
            <span class="sub">${OPCIONES.find(o=>o[0]===k)[2]}</span></span>
            ${ICON.chevron}
          </button>`).join('')}
      </div>` : ''}

    ${!nexts.length && !corrigiendo ? `
      <button class="secondary" onclick="corrigiendo=true;render()">Corregir estado</button>` : ''}
    ${corrigiendo ? `
      <div class="section-title">Corregir estado</div>
      ${optionList(c.estado, 'updEstado')}` : ''}

    ${pickMotivo ? `<div class="section-title">¿Por qué se cayó?</div>${motivoChips(c.motivo, 'updMotivo')}` : ''}

    ${pickVenta ? `
      <div class="section-title">Monto de la venta</div>
      <div class="list form"><label class="input-row"><span>$</span>
        <input id="v-monto" type="tel" inputmode="numeric" placeholder="150000" value="${esc(ventaMonto)}"></label></div>
      <button class="primary mt" onclick="guardarVenta()">Confirmar venta</button>` : ''}

    ${CON_SEGUIMIENTO.includes(c.estado) ? `
      <div class="section-title">Seguimiento</div>
      <div class="list form"><label class="input-row"><span>Retomar el</span>
        <input type="date" value="${c.seguimiento||''}" onchange="updSeguimiento(this.value)"></label></div>` : ''}

    <button class="destructive" onclick="borrarCliente('${c.id}')">Eliminar cliente</button>`;
}

function viewClientes() {
  const counts = { todos: clients.length };
  for (const k of Object.keys(ESTADOS)) counts[k] = clients.filter(c => c.estado===k).length;
  const term = clientSearch.trim().toLowerCase();
  const base = filter==='todos' ? clients : clients.filter(c => c.estado===filter);
  const items = base.filter(c =>
    (c.nombre || '').toLowerCase().includes(term) ||
    (c.telefono || '').replace(/\D/g, '').includes(term.replace(/\D/g, ''))
  ).slice().reverse();

  /* Apartado Ventas: total del mes arriba de la lista */
  let ventasHead = '';
  if (filter === 'venta') {
    const m = monthKey(today());
    const delMes = items.filter(c => monthKey(c.fecha_venta || c.fecha) === m);
    const total = delMes.reduce((s, c) => s + (Number(c.monto_venta) || 0), 0);
    const ticket = delMes.length ? Math.round(total / delMes.length) : 0;
    ventasHead = `<div class="card ventas-head">
      <div><span class="hero-num">${fmtMoney(total)}</span><span class="hero-lbl">vendido este mes</span></div>
      <div><span class="hero-num">${delMes.length}</span><span class="hero-lbl">ventas</span></div>
      <div><span class="hero-num">${fmtMoney(ticket)}</span><span class="hero-lbl">ticket prom.</span></div>
    </div>`;
  }

  const sub = c => {
    if (filter === 'venta')
      return `${c.monto_venta ? fmtMoney(c.monto_venta) + ' · ' : ''}${fmtFecha(c.fecha_venta || c.fecha)}`;
    if (filter === 'separado') {
      const d = diasDesde(c.estado_fecha || c.fecha);
      return `${esc(c.telefono)} · ${d !== null ? 'hace ' + d + 'd' : fmtFecha(c.fecha)}`;
    }
    if (filter === 'nuevo' && c.primer_mensaje) return esc(c.primer_mensaje);
    return `${esc(c.telefono)} · ${fmtFecha(c.fecha)}`;
  };

  const EMPTY = {
    nuevo: 'Sin leads nuevos. Los que lleguen por WhatsApp aparecen aquí.',
    separado: 'Sin separaciones abiertas.',
    venta: 'Aún no hay ventas registradas.',
    cayo: 'Sin clientes caídos.',
  };

  return `
    <div class="search-bar">
      <input type="search" placeholder="Buscar por nombre o teléfono…" value="${esc(clientSearch)}" oninput="clientSearch=this.value;render()" autocomplete="off">
    </div>
    <div class="segmented scroll">
      ${[['todos','Todos'],['nuevo','Nuevos'],['conversando','Conversando'],['separado','Separaciones'],['venta','Ventas'],['cayo','Caídos']]
        .map(([k,l]) => `<button class="${filter===k?'active':''}" onclick="filter='${k}';render()">${l}<small>${counts[k]||0}</small></button>`).join('')}
    </div>
    ${ventasHead}
    ${items.length ? list(items, sub) : emptyState(clientSearch ? 'Ningún cliente coincide.' : (EMPTY[filter] || 'Sin clientes aquí todavía.'))}
  `;
}

function viewPanel() {
  const now = new Date();
  const mActual = monthKey(today());
  const mPrev = new Date(now.getFullYear(), now.getMonth()-1, 15).toISOString().slice(0,7);
  const cur = ofMonth(mActual), last = ofMonth(mPrev);
  const sep = cur.filter(c => c.estado==='separado').length;
  const conv = cur.filter(c => c.estado==='conversando').length;
  const caidos = cur.filter(c => c.estado==='cayo').length;
  const ventas = cur.filter(c => c.estado==='venta');
  const nVentas = ventas.length;
  const vendido = ventas.reduce((s, c) => s + (Number(c.monto_venta) || 0), 0);
  const ticket = nVentas ? Math.round(vendido / nVentas) : 0;
  const sepPrev = last.filter(c => c.estado==='separado' || c.estado==='venta').length;
  const ventasPrev = last.filter(c => c.estado==='venta').length;
  const vendidoPrev = last.filter(c => c.estado==='venta')
    .reduce((s, c) => s + (Number(c.monto_venta) || 0), 0);
  const pct = cur.length ? Math.round((sep + nVentas)/cur.length*100) : 0;
  const pctPrev = last.length ? Math.round(sepPrev/last.length*100) : 0;
  const pctV = cur.length ? nVentas/cur.length*100 : 0;
  const pctS = cur.length ? sep/cur.length*100 : 0;
  const pctConv = cur.length ? conv/cur.length*100 : 0;
  const delta = (a, b, suf) => {
    const d = a - b;
    return d === 0 ? '<span class="delta">= mes pasado</span>' :
      `<span class="delta ${d>0?'up':'down'}">${d>0?'+':''}${suf?'$':''}${Math.abs(d).toLocaleString('es-MX')} vs mes pasado</span>`;
  };

  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    dias.push({ n: clients.filter(c => c.fecha === key).length,
      lbl: d.toLocaleDateString('es', { weekday: 'narrow' }).toUpperCase(), hoy: i === 0 });
  }
  const maxD = Math.max(1, ...dias.map(d => d.n));

  const motivosCount = {};
  cur.filter(c => c.motivo).forEach(c => motivosCount[c.motivo]=(motivosCount[c.motivo]||0)+1);
  const maxM = Math.max(1, ...Object.values(motivosCount));
  const mes = now.toLocaleDateString('es', { month: 'long' });

  /* Embudo del mes: acumulado por etapa */
  const llegaron = cur.length;
  const contactaron = cur.filter(c => c.estado !== 'nuevo').length;
  const separaron = sep + nVentas;
  const funnel = [
    ['Leads', llegaron], ['En conversación', contactaron],
    ['Separaciones', separaron], ['Ventas', nVentas],
  ];

  return `
    <div class="card donut-card">
      <div class="donut" style="background: conic-gradient(#4a7d5c 0 ${pctV}%, var(--ok) ${pctV}% ${pctV+pctS}%, var(--warn) ${pctV+pctS}% ${pctV+pctS+pctConv}%, var(--bad) ${pctV+pctS+pctConv}% 100%)${cur.length ? '' : ';background:var(--fill)'}">
        <div class="donut-hole"><span class="pct">${Math.round(pctV)}%</span><span class="pct-lbl">ventas</span></div>
      </div>
      <div class="legend">
        <div><i style="background:#4a7d5c"></i>Ventas<b>${nVentas}</b></div>
        <div><i style="background:var(--ok)"></i>Separados<b>${sep}</b></div>
        <div><i style="background:var(--warn)"></i>Conversando<b>${conv}</b></div>
        <div><i style="background:var(--bad)"></i>Caídos<b>${caidos}</b></div>
      </div>
    </div>

    <div class="section-title">Resumen de ${mes}</div>
    <div class="stat-grid">
      <div class="stat"><span class="num">${fmtMoney(vendido)}</span><span class="lbl">Vendido</span>${delta(vendido, vendidoPrev, 1)}</div>
      <div class="stat"><span class="num">${nVentas}</span><span class="lbl">Ventas · ticket ${fmtMoney(ticket)}</span>${delta(nVentas, ventasPrev)}</div>
      <div class="stat"><span class="num">${sep}</span><span class="lbl">Separaciones abiertas</span>${delta(separaron, sepPrev)}</div>
      <div class="stat"><span class="num">${cur.length}</span><span class="lbl">Leads atendidos</span>${delta(cur.length, last.length)}</div>
    </div>

    <div class="section-title">Embudo del mes</div>
    <div class="card">
      ${funnel.map(([l, n], i) => `
        <div class="bar-row"><div class="bar-head"><span>${l}</span><b>${n}</b></div>
        <div class="bar-track"><div class="bar-fill funnel" style="width:${llegaron ? n/llegaron*100 : 0}%"></div></div></div>`).join('')}
    </div>

    <div class="section-title">Últimos 7 días</div>
    <div class="card"><div class="day-chart">
      ${dias.map(d => `<div class="day-col ${d.hoy?'today':''}">
        <span class="day-num">${d.n || ''}</span>
        <div class="day-bar-wrap"><div class="day-bar" style="height:${Math.max(4, d.n/maxD*100)}%"></div></div>
        <span class="day-lbl">${d.lbl}</span></div>`).join('')}
    </div></div>

    <div class="section-title">Por qué se caen las ventas</div>
    <div class="card">
      ${Object.keys(motivosCount).length ? Object.entries(motivosCount)
        .sort((a,b)=>b[1]-a[1]).map(([m,n]) => `
          <div class="bar-row"><div class="bar-head"><span>${esc(m)}</span><b>${n}</b></div>
          <div class="bar-track"><div class="bar-fill" style="width:${n/maxM*100}%"></div></div></div>`).join('') :
        '<div class="empty small">Sin ventas caídas este mes.</div>'}
    </div>`;
}

/* ---------- TikTok Live ---------- */
const fmtSeg = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
let liveSessions = {};   // usuario -> status
let compList = [];       // competidores registrados
let compReport = null;   // reporte agregado

/* ---------- Escaneo de voz del live (mic -> Groq Whisper) ---------- */
let mediaStream = null, mediaRec = null;
let escuchando = null;            // usuario del live que se esta escuchando
let escuchaT0 = 0;
const transcripts = {};           // usuario -> [{t, texto}]

async function startEscucha(usuario) {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    liveError = 'Este navegador no soporta micrófono — en iPhone abre la app en Safari.'; return render();
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    liveError = 'Sin permiso de micrófono. Revísalo en Ajustes del iPhone y recarga.'; return render();
  }
  escuchando = usuario; escuchaT0 = Date.now();
  transcripts[usuario] = transcripts[usuario] || [];
  cicloGrabacion();
  render();
}

/* Graba en ciclos de 20s: cada ciclo produce un archivo completo que se sube */
function cicloGrabacion() {
  const usuario = escuchando;
  if (!usuario || !mediaStream) return;
  mediaRec = new MediaRecorder(mediaStream);
  mediaRec.ondataavailable = e => {
    if (e.data.size > 500) subirChunk(e.data, usuario, Math.round((Date.now() - escuchaT0) / 1000));
  };
  mediaRec.onstop = () => { if (escuchando === usuario) cicloGrabacion(); };
  mediaRec.start();
  setTimeout(() => { if (mediaRec && mediaRec.state === 'recording') mediaRec.stop(); }, 20000);
}

async function subirChunk(blob, usuario, t) {
  if (!session) return;
  try {
    const r = await apiFetch('/api/live/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/mp4', Authorization: `Bearer ${session.access_token}` },
      body: blob,
    });
    const d = await r.json();
    if (d.texto && transcripts[usuario]) {
      transcripts[usuario].push({ t, texto: d.texto });
      if (screen === 'live') render();
    }
  } catch {}
}

function stopEscucha() {
  escuchando = null;
  if (mediaRec && mediaRec.state === 'recording') try { mediaRec.stop(); } catch {}
  mediaRec = null;
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (screen === 'live') render();
}

const mdToHtml = t => esc(t)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/\n/g, '<br>');

/* Pide el resumen IA al detener un live y lo pega en la vista */
async function generarResumenIA(usuario, resumen) {
  if (!session || !resumen) return;
  const tr = (transcripts[usuario] && transcripts[usuario].length ? transcripts[usuario] : resumen.transcript) || [];
  delete transcripts[usuario];
  if (!tr.length && !resumen.comentarios) return;
  try {
    const r = await apiFetch('/api/live/resumen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ usuario, metricas: resumen, transcript: tr, resumen_ia: resumen.resumen_ia || '' }),
    });
    const d = await r.json();
    if (d.resumen && liveResumen) { liveResumen.resumen_ia = d.resumen; if (screen === 'live') render(); }
  } catch {}
}

function viewLive() {
  if (liveResumen) return viewLiveResumen(liveResumen);
  const rest = liveLimite.cargado ? Number(liveLimite.restantes) : NaN;
  if (monetizacion && !esPro() && !isNaN(rest) && rest <= 0) return viewUpgrade();
  const activos = Object.values(liveSessions);
  const freeBadge = monetizacion && !esPro() && liveLimite.cargado && !isNaN(rest)
    ? `<div class="live-limit">Hoy te quedan <b>${rest}</b> análisis gratis</div>`
    : '';
  return `
    <div class="card" style="margin-top:8px">
      <div class="section-title" style="margin-top:0">Analizar un live</div>
      ${freeBadge}
      <div class="list form"><label class="input-row"><span>Usuario</span>
        <input id="live-user" placeholder="@usuario" autocomplete="off" autocapitalize="none" value="${esc(window._liveUser||'')}"></label></div>
      <p class="hint">Si está en vivo, mide viewers, comentarios y detecta posibles clientes hasta que lo detengas.</p>
      ${liveError ? `<p class="hint" style="color:var(--bad)">${esc(liveError)}</p>` : ''}
      <button class="primary" onclick="startLive()">Empezar análisis</button>
    </div>

    ${activos.map(viewLiveCard).join('')}

    <div class="section-title">Competencia ${!esPro() ? '<span class="pro-badge">Pro</span>' : ''}</div>
    ${monetizacion && !esPro()
      ? `<div class="pro-card"><b>Análisis de competencia</b><p>Agrega competidores de TikTok y compara métricas, picos, comentarios y palabras clave. Disponible en Pro.</p><button class="primary" onclick="go('upgrade')">Ver Plan Pro</button></div>`
      : `<div class="list form"><label class="input-row"><span>Agregar</span>
          <input id="comp-user" placeholder="@competidor" autocomplete="off" autocapitalize="none"></label></div>
        <button class="secondary" onclick="addCompetidor()">Guardar competidor</button>
        <div id="comp-list">${viewCompList()}</div>
        <div id="comp-report">${viewCompReport()}</div>`}`;
}

function viewLiveCard(d) {
  return `
    <div class="live-head"><span class="live-dot"></span>EN VIVO · @${esc(d.usuario)} · ${fmtSeg(d.segundos)}</div>
    <div class="stat-grid">
      <div class="stat"><span class="num">${d.viewers}</span><span class="lbl">Viendo ahora</span></div>
      <div class="stat"><span class="num">${d.pico}</span><span class="lbl">Pico</span></div>
      <div class="stat"><span class="num">${d.comentarios}</span><span class="lbl">Comentarios</span></div>
      <div class="stat"><span class="num">${d.likes}</span><span class="lbl">Likes</span></div>
    </div>
    ${d.keywords && d.keywords.length ? `<div class="section-title">Qué preguntan</div>
      <div class="chips" style="margin-bottom:14px">${d.keywords.map(k => `<span class="chip-btn active">${esc(k.k)} · ${k.n}</span>`).join('')}</div>` : ''}
    <div class="section-title">Posibles clientes (${d.leads.length})</div>
    ${d.leads.length ? `<div class="list">${d.leads.slice(0,50).map(l => `
      <div class="row"><span class="avatar">${initial(l.nombre || l.user)}</span>
      <span class="row-main"><span class="name">@${esc(l.user)}</span>
      <span class="sub">${esc(l.texto)}</span></span></div>`).join('')}</div>` :
      '<div class="empty small">Escuchando comentarios con intención de compra…</div>'}

    <div class="section-title">Voz del live</div>
    ${d.vozServidor
      ? `<p class="hint">Capturando el audio del stream directo — no necesitas micrófono.</p>`
      : escuchando === d.usuario
        ? `<p class="hint">Escuchando… acerca el teléfono a la bocina o pantalla donde suena el live.</p>
           <button class="secondary" onclick="stopEscucha()">Dejar de escuchar</button>`
        : `<button class="secondary" onclick="startEscucha('${esc(d.usuario)}')">${session ? 'Escuchar el audio del live (micrófono)' : 'Escuchar (necesita login)'}</button>`}
    ${((d.transcript && d.transcript.length ? d.transcript : transcripts[d.usuario]) || []).length ? `<div class="card transcript">
      ${(d.transcript && d.transcript.length ? d.transcript : transcripts[d.usuario]).slice(-15).map(l => `<p><b>${fmtSeg(l.t)}</b>  ${esc(l.texto)}</p>`).join('')}
    </div>` : ''}
    <button class="destructive" onclick="stopLive('${esc(d.usuario)}')">Detener análisis de @${esc(d.usuario)}</button>`;
}

function viewLiveResumen(r) {
  return `
    <div class="card" style="margin-top:8px">
      <div class="profile" style="padding:0 0 8px">
        <h2>@${esc(r.usuario)}</h2><p>Análisis terminado — ${esc(r.razon)}</p>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="num">${r.minutos}m</span><span class="lbl">Duración</span></div>
        <div class="stat"><span class="num">${r.pico}</span><span class="lbl">Pico de viewers</span></div>
        <div class="stat"><span class="num">${r.comentarios}</span><span class="lbl">Comentarios</span></div>
        <div class="stat"><span class="num">${r.leads}</span><span class="lbl">Leads detectados</span></div>
      </div>
      ${r.keywords && r.keywords.length ? `<div class="section-title">Qué preguntaron</div>
        <div class="chips">${r.keywords.map(k => `<span class="chip-btn active">${esc(k.k)} · ${k.n}</span>`).join('')}</div>` : ''}
      ${r.resumen_ia ? `<div class="section-title">Resumen IA</div>
        <div class="card"><p style="font-size:15px;line-height:1.55">${mdToHtml(r.resumen_ia)}</p></div>` : ''}
    </div>
    <button class="primary mt" onclick="liveResumen=null;render()">Volver</button>`;
}

function viewCompList() {
  if (!compList.length) return '<div class="empty small">Sin competidores. Agrega 5-6 cuentas de tu rubro.</div>';
  return `<div class="list">${compList.map(c => `
    <div class="row">
      <span class="avatar">${initial(c.usuario)}</span>
      <span class="row-main"><span class="name">@${esc(c.usuario)}</span>
      <span class="sub">${c.livesAnalizados} lives analizados</span></span>
      ${c.analizando
        ? `<span class="status conversando"><i></i>EN VIVO</span>`
        : `<button class="chip-btn" onclick="startLive('${esc(c.usuario)}')">Analizar</button>`}
      <button class="chip-btn" onclick="delCompetidor('${esc(c.usuario)}')" style="color:var(--bad)">✕</button>
    </div>`).join('')}</div>`;
}

function viewCompReport() {
  if (!compReport || !compReport.totalLivesAnalizados) return '';
  const r = compReport;
  return `
    <div class="section-title">Estudio de competencia (${r.totalLivesAnalizados} lives)</div>
    <div class="card">
      ${r.cuentas.map(c => `<div class="info-row"><span>@${esc(c.usuario)}</span>
        <b>pico prom. ${c.picoPromedio} · ${c.lives} lives</b></div>`).join('')}
    </div>
    ${r.topCategorias.length ? `<div class="section-title">Lo que más preguntan sus audiencias</div>
      <div class="chips" style="margin-bottom:14px">${r.topCategorias.map(k => `<span class="chip-btn active">${esc(k.k)} · ${k.n}</span>`).join('')}</div>` : ''}
    ${r.topPalabras.length ? `<div class="section-title">Palabras exactas que usan</div>
      <div class="chips" style="margin-bottom:14px">${r.topPalabras.slice(0,10).map(p => `<span class="chip-btn">${esc(p.k)}</span>`).join('')}</div>` : ''}
    ${r.recomendaciones.length ? `<div class="section-title">Qué puede ofrecer ella</div>
      <div class="card">${r.recomendaciones.map(t => `<p style="font-size:15px;margin-bottom:10px">• ${esc(t)}</p>`).join('')}</div>` : ''}`;
}

async function startLive(preUser) {
  const usuario = preUser || document.getElementById('live-user').value.trim();
  if (!usuario) return alert('Escribe el usuario de TikTok.');
  window._liveUser = usuario; liveError = ''; liveResumen = null;
  showLoading('Cargando, espera por favor…', 'Despertando el servidor, primera vez puede tardar ~40 segundos');
  try {
    const r = await apiFetch('/api/live/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario }),
    });
    const d = await r.json();
    hideLoading();
    if (!r.ok) {
      if (r.status === 402) { await loadLiveLimite(); return viewUpgrade ? go('upgrade') : (liveError = d.error || 'Requiere Pro', render()); }
      liveError = d.error || 'No se pudo conectar'; return render();
    }
    liveSessions[d.usuario] = d; render();
    if (!livePoll) livePoll = setInterval(pollLive, 3000);
  } catch {
    hideLoading();
    liveError = CONFIG.API_URL ? 'Servidor no responde — intenta de nuevo en un momento' : 'Servidor apagado — corre: cd server && npm start';
    render();
  }
}

async function pollLive() {
  try {
    const d = await (await apiFetch('/api/live/status')).json();
    const nuevos = {};
    (d.activos || []).forEach(s => nuevos[s.usuario] = s);
    const antes = Object.keys(liveSessions).length;
    liveSessions = nuevos;
    if (!Object.keys(liveSessions).length && antes) {
      const h = await (await apiFetch('/api/live/historial')).json();
      if (h[0]) { liveResumen = h[0]; generarResumenIA(h[0].usuario, liveResumen); }
      clearInterval(livePoll); livePoll = null;
    }
    if (screen === 'live') render();
  } catch { /* servidor caído */ }
}

async function stopLive(usuario) {
  try {
    const d = await (await apiFetch('/api/live/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario }),
    })).json();
    if (escuchando === usuario) {
      escuchando = null;
      if (mediaRec && mediaRec.state === 'recording') try { mediaRec.stop(); } catch {}
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    }
    if (d.resumen) {
      liveResumen = d.resumen;
      generarResumenIA(usuario, liveResumen);
    }
    delete liveSessions[usuario];
    if (!Object.keys(liveSessions).length && livePoll) { clearInterval(livePoll); livePoll = null; }
    loadComps(); render();
  } catch { liveError = 'No se pudo detener'; render(); }
}

async function loadLiveLimite() {
  try {
    const r = await apiFetch('/api/live/limite');
    liveLimite = await r.json();
    liveLimite.cargado = true;
  } catch { liveLimite = { restantes: 2, pro: false, cargado: true }; }
}

async function loadComps() {
  try {
    compList = await (await apiFetch('/api/competidores')).json();
    compReport = await (await apiFetch('/api/competidores/reporte')).json();
  } catch { compList = []; hideLoading(); }
}

async function addCompetidor() {
  const inp = document.getElementById('comp-user');
  const usuario = inp.value.trim();
  if (!usuario) return;
  await apiFetch('/api/competidores', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario }),
  });
  inp.value = ''; loadComps().then(render);
}

async function delCompetidor(usuario) {
  if (!confirm(`Quitar a @${usuario} de la competencia?`)) return;
  await apiFetch(`/api/competidores/${encodeURIComponent(usuario)}`, { method: 'DELETE' });
  loadComps().then(render);
}

/* ---------- Push diario ---------- */
async function activarPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return alert('Este dispositivo no soporta notificaciones push.');
  showLoading('Activando recordatorio…');
  try {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await apiFetch('/api/vapid-key')).json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(key),
    });
    await apiFetch('/api/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
    localStorage.setItem('pushOn', '1');
    hideLoading();
    alert('Listo. Te llegará un recordatorio a las 8:00 pm.');
    render();
  } catch (e) {
    hideLoading();
    alert('No se pudo activar. En iPhone requiere: app instalada en pantalla de inicio + HTTPS (cuando esté publicada).');
  }
}
const urlB64ToUint8 = b64 => {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

function viewAjustes() {
  return `
    ${session ? `
    <div class="section-title">Cuenta</div>
    <div class="profile-card-mini" onclick="go('perfil')">
      <span class="avatar lg">${perfil && perfil.avatar_url ? `<img src="${esc(perfil.avatar_url)}" alt="avatar">` : initial((perfil && perfil.nombre) || session.user.user_metadata?.nombre || session.user.email || '')}</span>
      <div class="profile-mini-info">
        <b>${esc((perfil && perfil.nombre) || session.user.user_metadata?.nombre || session.user.email.split('@')[0])}</b>
        <span>${esc(session.user.email || '')}</span>
        <small>${esPro() ? 'Plan Pro' : 'Plan Free'}</small>
      </div>
      ${ICON.chevron}
    </div>

    ${monetizacion ? `
    <div class="section-title">Plan</div>
    <div class="list">
      <div class="info-row"><span>Plan actual</span><b>${esPro() ? 'Pro' : solicitudPago && solicitudPago.estado === 'pendiente' ? 'En revisión' : 'Free'}</b></div>
    </div>
    ${esPro()
      ? `<button class="secondary" onclick="irUpgrade()">Ver plan Pro</button>`
      : solicitudPago && solicitudPago.estado === 'pendiente'
        ? `<button class="secondary" onclick="irUpgrade()">Solicitud en revisión</button>`
        : `<button class="primary" style="margin-top:10px" onclick="irUpgrade()">Mejorar a Pro</button>`}` : ''}

    ${isAdmin() ? `<button class="secondary" style="margin-top:10px" onclick="go('admin')">Panel de admin</button>` : ''}

    <div class="section-title">WhatsApp ${!esPro() ? '<span class="pro-badge">Pro</span>' : ''}</div>
    ${monetizacion && !esPro()
      ? `<div class="pro-card"><b>Leads automáticos de WhatsApp</b><p>Conecta tu WhatsApp Web y cada número que te escriba entra solo en <b>Nuevos</b>. Desbloquéalo con Pro.</p><button class="primary" onclick="go('upgrade')">Ver Plan Pro</button></div>`
      : `<div id="wa-connect">${viewWhatsAppConnect()}</div>`}
    ` : ''}

    <div class="section-title">Exportar</div>
    <div class="list">
      <button class="row" onclick="exportExcel()">
        <span class="avatar icon">${ICON.doc}</span>
        <span class="row-main"><span class="name">Descargar Excel</span><span class="sub">${clients.length} clientes · .xlsx</span></span>${ICON.chevron}
      </button>
      <button class="row" onclick="exportCSV()">
        <span class="avatar icon">${ICON.doc}</span>
        <span class="row-main"><span class="name">Descargar CSV</span><span class="sub">Respaldo simple</span></span>${ICON.chevron}
      </button>
    </div>

    <div class="section-title">Recordatorio diario</div>
    <div class="list">
      <button class="row" onclick="activarPush()">
        <span class="avatar icon">${ICON.bell}</span>
        <span class="row-main"><span class="name">Aviso a las 8:00 pm</span>
        <span class="sub">${localStorage.getItem('pushOn') ? 'Activado' : 'Registra tus clientes antes de cerrar'}</span></span>${ICON.chevron}
      </button>
    </div>

    <div class="section-title">Servidor</div>
    <div class="list form"><label class="input-row"><span>URL</span>
      <input id="cfg-api" placeholder="https://tu-app.onrender.com" value="${esc(CONFIG.API_URL)}" autocomplete="off" autocapitalize="none"></label></div>
    <p class="hint">URL del backend (Render). Déjala en blanco si usas Netlify con el proxy configurado.</p>

    <div class="section-title">Supabase</div>
    ${sb ? `
    <div class="list">
      <div class="info-row"><span>Base de datos</span><b>Conectada</b></div>
    </div>` : `
    <div class="list form">
      <label class="input-row"><span>URL</span>
        <input id="cfg-supa-url" placeholder="https://xxxx.supabase.co" value="${esc(localStorage.getItem('supaUrl') || '')}" autocomplete="off" autocapitalize="none"></label>
      <label class="input-row"><span>Anon key</span>
        <input id="cfg-supa-key" placeholder="eyJhbGciOi..." value="${esc(localStorage.getItem('supaKey') || '')}" autocomplete="off" autocapitalize="none"></label>
    </div>
    <button class="secondary" onclick="guardarSupa()">Guardar y conectar</button>
    <p class="hint">Para uso permanente edita <b>supabase-config.js</b> (queda para todos los usuarios). Esto solo configura este dispositivo.</p>`}

    <div class="section-title">Google Sheets</div>
    <div class="list form">
      <label class="input-row"><span>URL</span>
        <input id="cfg-url" placeholder="https://script.google.com/macros/s/..." value="${esc(CONFIG.SCRIPT_URL)}" autocomplete="off"></label>
      <label class="input-row"><span>Clave</span>
        <input id="cfg-token" placeholder="Opcional" value="${esc(CONFIG.TOKEN)}" autocomplete="off"></label>
    </div>
    <p class="hint">${pendingSync.length ? `${pendingSync.length} registros pendientes de enviar. ` : ''}Cada registro se guarda también en tu hoja de Google (pestañas Historial y Estado actual).</p>
    <button class="primary" onclick="guardarUrl()">Guardar conexión</button>

    <button class="destructive" onclick="borrarTodo()">Borrar datos del iPhone</button>`;
}

/* ---------- Perfil del asesor ---------- */
let perfilForm = { nombre: '', saludo: 'bienvenido', avatar: null, preview: null, saving: false, error: '', ok: false };

function viewPerfil() {
  const meta = (session && session.user && session.user.user_metadata) || {};
  const nombre = esc((perfil && perfil.nombre) || meta.nombre || '');
  const email = esc((session && session.user.email) || '');
  const saludo = perfilForm.saludo || meta.saludo || 'bienvenido';
  const avatar = perfilForm.preview || (perfil && perfil.avatar_url) || '';
  const initials = initial(nombre) || initial(email) || '?';
  return `
  <button class="back" onclick="go('ajustes')">${ICON.back}Ajustes</button>
  <div class="section-title">Mi perfil</div>
  <div class="profile-card" style="--delay:0">
    <div class="avatar-uploader">
      ${avatar ? `<img src="${esc(avatar)}" alt="avatar" class="avatar xl">` : `<span class="avatar xl">${initials}</span>`}
      <input type="file" id="pf-avatar" accept="image/*" onchange="previewAvatar(this)" hidden>
      <label for="pf-avatar" class="avatar-btn">${ICON.camera} Cambiar foto</label>
    </div>
    <div class="plan-badge">${esPro() ? 'Plan Pro' : 'Plan Free'}</div>
  </div>
  <div class="list form" style="--delay:1">
    <label class="input-row"><span>Nombre</span>
      <input id="pf-nombre" value="${nombre}" oninput="perfilForm.nombre=this.value" autocomplete="off"></label>
    <label class="input-row"><span>Correo</span>
      <input value="${email}" disabled></label>
  </div>
  <div class="section-title" style="--delay:2">¿Cómo te saludamos?</div>
  <div class="saludo-pick" style="--delay:2">
    <button type="button" class="${saludo === 'bienvenida' ? 'on' : ''}" onclick="perfilForm.saludo='bienvenida';render()">Bienvenida<small>femenino</small></button>
    <button type="button" class="${saludo === 'bienvenido' ? 'on' : ''}" onclick="perfilForm.saludo='bienvenido';render()">Bienvenido<small>masculino</small></button>
  </div>
  ${perfilForm.error ? `<div class="form-err" style="--delay:3">${ICON.alert}<span>${esc(perfilForm.error)}</span></div>` : ''}
  ${perfilForm.ok ? `<div class="plan-active" style="--delay:3">${ICON.check}<b>Perfil guardado</b></div>` : ''}
  <button class="primary mt" style="--delay:4" onclick="guardarPerfil()" ${perfilForm.saving ? 'disabled' : ''}>
    ${perfilForm.saving ? 'Guardando…' : 'Guardar perfil'}
  </button>`;
}

function previewAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  perfilForm.avatar = file;
  const reader = new FileReader();
  reader.onload = e => { perfilForm.preview = e.target.result; render(); };
  reader.readAsDataURL(file);
}

async function guardarPerfil() {
  perfilForm.error = ''; perfilForm.ok = false; perfilForm.saving = true; render();
  try {
    let avatarUrl = (perfil && perfil.avatar_url) || '';
    if (perfilForm.avatar) {
      const ext = perfilForm.avatar.type.includes('png') ? 'png' : 'jpg';
      const path = `${session.user.id}/avatar.${ext}`;
      const { error: upErr } = await sb.storage.from('avatars').upload(path, perfilForm.avatar, { upsert: true, contentType: perfilForm.avatar.type });
      if (upErr) throw new Error(upErr.message);
      const { data } = sb.storage.from('avatars').getPublicUrl(path);
      avatarUrl = data.publicUrl;
    }
    const nombre = perfilForm.nombre !== undefined ? perfilForm.nombre : ((perfil && perfil.nombre) || '');
    await sb.from('perfiles').update({ nombre, avatar_url: avatarUrl }).eq('user_id', session.user.id);
    await sb.auth.updateUser({ data: { saludo: perfilForm.saludo } });
    await loadPerfil();
    perfilForm.ok = true;
    vibrate();
  } catch (e) { perfilForm.error = e.message || 'No se pudo guardar.'; }
  perfilForm.saving = false; render();
}

/* ---------- Pagos manuales: Plin/Yape + voucher ---------- */
let upgradeForm = { metodo: 'yape', telefono: '', voucherPreview: null, voucherFile: null, loading: false, error: '', ok: false };

function viewUpgrade() {
  const s = upgradeForm;
  if (s.ok) {
    return `<div class="ok-flash"><div class="ok-icon">${ICON.check}</div>
      <h2>Comprobante enviado</h2>
      <p>Tu pago está en revisión. En cuanto el admin lo apruebe, tu plan cambiará a <b>Pro</b>.</p>
      <button class="primary" onclick="go('hoy')">Listo</button></div>`;
  }
  const statusBadge = solicitudPago ? {
    pendiente: ['En revisión', 'var(--warn)'],
    aprobado: ['Aprobado', 'var(--ok)'],
    rechazado: ['Rechazado', 'var(--bad)']
  }[solicitudPago.estado] : null;

  const rest = liveLimite.cargado ? Number(liveLimite.restantes) : NaN;
  const quedan = !esPro() && !isNaN(rest) && rest < 9999
    ? `<div class="live-limit pulse">Te quedan <b>${rest}</b> lives gratis hoy</div>`
    : '';

  return `
  <button class="back" onclick="go('ajustes')">${ICON.back}Ajustes</button>
  <div class="section-title">Plan Pro</div>
  <div class="plan-hero">
    <div class="plan-price"><span>S/</span><b>20</b><span>soles</span></div>
    <p class="plan-sub">Pago único mensual · Perú</p>
    ${quedan}
  </div>
  ${statusBadge ? `<div class="plan-status" style="color:${statusBadge[1]};border-color:${statusBadge[1]}">${ICON.alert}<b>${statusBadge[0]}</b></div>` : ''}

  <div class="plan-why">
    <div class="why-title">¿Qué desbloqueas con Pro?</div>
    <div class="plan-features">
      <div class="plan-feat">${ICON.check}<span><b>Lives ilimitados</b> de TikTok al día</span></div>
      <div class="plan-feat">${ICON.check}<span><b>Leads automáticos</b> de WhatsApp Web sin apps</span></div>
      <div class="plan-feat">${ICON.check}<span><b>Transcripción + resumen IA</b> de cada live</span></div>
      <div class="plan-feat">${ICON.check}<span><b>Competidores</b> y comparativa de métricas</span></div>
    </div>
  </div>

  <div class="plan-compare">
    <div class="pc-row pc-head"><span>Función</span><span>Free</span><span>Pro</span></div>
    <div class="pc-row"><span>Registrar clientes</span><span class="pc-y">✓</span><span class="pc-y">✓</span></div>
    <div class="pc-row"><span>2 lives gratis / día</span><span class="pc-y">✓</span><span class="pc-y">✓</span></div>
    <div class="pc-row"><span>Lives ilimitados</span><span class="pc-n">—</span><span class="pc-y">✓</span></div>
    <div class="pc-row"><span>Leads WhatsApp automático</span><span class="pc-n">—</span><span class="pc-y">✓</span></div>
    <div class="pc-row"><span>Resumen IA del live</span><span class="pc-n">—</span><span class="pc-y">✓</span></div>
    <div class="pc-row"><span>Análisis de competidores</span><span class="pc-n">—</span><span class="pc-y">✓</span></div>
  </div>

  <div class="plan-social">
    <b>Por menos de un café al día</b>
    <p>Asesores que usan el análisis de lives duplican su tasa de cierre porque detectan clientes calientes en tiempo real.</p>
  </div>

  ${esPro() ? `<div class="plan-active">${ICON.check}<b>Tu plan Pro está activo</b></div>` : ''}
  ${!esPro() && (!solicitudPago || solicitudPago.estado !== 'pendiente')
    ? `<div class="upgrade-form">
        <div class="seg2" data-on="${s.metodo === 'yape' ? 1 : 0}">
          <button class="${s.metodo === 'plin' ? 'on' : ''}" onclick="seleccionarMetodo('plin')">Plin</button>
          <button class="${s.metodo === 'yape' ? 'on' : ''}" onclick="seleccionarMetodo('yape')">Yape</button>
        </div>
        <div class="pay-instr">
          <p>Realiza el pago de <b>S/ 20.00</b> a:</p>
          <div class="pay-number"><b>937 478 810</b><button class="copy-mini" onclick="copiarTexto('937478810')">Copiar</button></div>
        </div>
        <label class="field">
          <span class="ico">${ICON.phone}</span>
          <input id="up-tel" type="tel" inputmode="tel" placeholder=" " value="${esc(s.telefono)}" oninput="upgradeForm.telefono=this.value">
          <span>Número desde el que pagaste</span>
        </label>
        <div class="voucher-upload">
          <input type="file" id="up-voucher" accept="image/*" onchange="previewVoucher(this)" hidden>
          <label for="up-voucher" class="voucher-label ${s.voucherPreview ? 'has-img' : ''}">
            ${s.voucherPreview ? `<img src="${esc(s.voucherPreview)}" alt="voucher">` : `<span>${ICON.bolt} Adjuntar captura del voucher</span>`}
          </label>
        </div>
        ${s.error ? `<div class="form-err">${ICON.alert}<span>${esc(s.error)}</span></div>` : ''}
        <button class="primary wa-btn" onclick="enviarSolicitud()" ${s.loading ? 'disabled' : ''}>
          ${s.loading ? 'Enviando…' : 'Enviar comprobante'}
        </button>
      </div>`
    : ''}
  ${solicitudPago && solicitudPago.estado === 'rechazado' && solicitudPago.notas_admin ? `<div class="plan-note">${ICON.alert}<span>${esc(solicitudPago.notas_admin)}</span></div>` : ''}`;
}

function seleccionarMetodo(m) { upgradeForm.metodo = m; render(); }

function previewVoucher(input) {
  const file = input.files[0];
  if (!file) return;
  upgradeForm.voucherFile = file;
  const reader = new FileReader();
  reader.onload = e => { upgradeForm.voucherPreview = e.target.result; render(); };
  reader.readAsDataURL(file);
}

async function enviarSolicitud() {
  upgradeForm.error = '';
  const telefono = String(upgradeForm.telefono || '').replace(/\D/g, '');
  if (telefono.length < 8) { upgradeForm.error = 'Ingresa el número desde el que pagaste.'; render(); return; }
  if (!upgradeForm.voucherFile) { upgradeForm.error = 'Adjunta la captura del voucher.'; render(); return; }
  upgradeForm.loading = true; render();
  try {
    const fd = new FormData();
    fd.append('metodo', upgradeForm.metodo);
    fd.append('telefono', telefono);
    fd.append('voucher', upgradeForm.voucherFile);
    const r = await apiFetch('/api/pago/solicitar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: fd
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo enviar');
    upgradeForm.ok = true;
    await loadMisSolicitudes();
    vibrate();
  } catch (e) {
    upgradeForm.error = e.message || 'Error al enviar. Intenta de nuevo.';
  }
  upgradeForm.loading = false; render();
}

function copiarTexto(txt) {
  try { navigator.clipboard.writeText(txt); } catch {}
  toast('Copiado');
}

/* ---------- Panel de admin ---------- */
function viewAdmin() {
  const rows = adminPendientes;
  return `
  <button class="back" onclick="go('ajustes')">${ICON.back}Ajustes</button>
  <div class="section-title">Solicitudes de pago</div>
  ${rows.length ? rows.map(r => `
    <div class="admin-card">
      <div class="admin-head">
        <b>${esc((r.perfiles && r.perfiles.nombre) || r.user_id)}</b>
        <span>${esc((r.perfiles && r.perfiles.email) || '')}</span>
        <small>${fmtFechaHora(new Date(r.creado))} · ${String(r.metodo).toUpperCase()} · S/ ${Number(r.monto).toFixed(2)}</small>
      </div>
      ${r.voucher_signed ? `<img src="${esc(r.voucher_signed)}" class="admin-voucher" alt="voucher">` : ''}
      <div class="admin-tel"><b>Desde:</b> ${esc(r.telefono || '')}</div>
      <div class="admin-actions">
        <button class="reject" onclick="aprobarSolicitud(${r.id}, false)">Rechazar</button>
        <button class="approve" onclick="aprobarSolicitud(${r.id}, true)">Aprobar</button>
      </div>
    </div>
  `).join('') : `<div class="empty">No hay solicitudes pendientes</div>`}
  <button class="secondary" style="margin-top:16px" onclick="loadPendientes()">Actualizar</button>`;
}

async function loadPendientes() {
  try {
    const r = await apiFetch('/api/pago/pendientes', { headers: { Authorization: `Bearer ${session.access_token}` } });
    adminPendientes = await r.json();
  } catch { adminPendientes = []; }
  render();
}

async function aprobarSolicitud(id, aprobar) {
  if (!confirm(aprobar ? '¿Aprobar pago y activar Pro?' : '¿Rechazar esta solicitud?')) return;
  try {
    const r = await apiFetch('/api/pago/aprobar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, aprobar })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Error');
    await loadPendientes();
    vibrate([20, 30, 20]);
    toast(aprobar ? 'Pago aprobado · Pro activado' : 'Solicitud rechazada');
  } catch (e) { alert(e.message); }
}

function viewOk(msg) {
  return `<div class="ok-flash"><div class="ok-icon">${ICON.check}</div>
    <h2>Guardado</h2><p>${esc(msg)}</p>
    <button class="primary" onclick="go('hoy')">Listo</button>
    <button class="secondary" onclick="go('registrar')">Registrar otro</button></div>`;
}

/* ---------- Acciones ---------- */
function setEstado(e) { form.estado = e; if (e!=='cayo'){form.motivo='';form.motivoOtro='';} if (e!=='venta') form.monto=''; render(); }
function setMotivo(m) { form.motivo = m; render(); }

function guardarCliente() {
  form.nombre = document.getElementById('f-nombre').value.trim();
  form.telefono = document.getElementById('f-tel').value.trim();
  if (!form.nombre) return alert('Falta el nombre.');
  if (form.telefono.replace(/\D/g,'').length < 8) return alert('Ingresa un WhatsApp válido (mínimo 8 dígitos).');
  if (!form.estado) return alert('Elige cómo quedó el cliente.');
  if (form.estado==='cayo' && !form.motivo) return alert('Elige el motivo.');
  if (form.estado==='cayo' && form.motivo==='Otro' && !form.motivoOtro.trim()) return alert('Escribe el motivo.');
  if (form.estado==='venta' && !Number(String(form.monto).replace(/[^\d.]/g,''))) return alert('Escribe el monto de la venta.');

  const ahora = new Date().toISOString();
  const c = {
    id: 'c' + Date.now(),
    fecha: today(),
    creado: ahora,
    updated_at: ahora,
    nombre: form.nombre,
    telefono: form.telefono,
    estado: form.estado,
    motivo: form.estado==='cayo' ? (form.motivo==='Otro' ? form.motivoOtro.trim() : form.motivo) : '',
    seguimiento: CON_SEGUIMIENTO.includes(form.estado) ? form.seguimiento : '',
    notas: form.notas,
    origen: 'manual',
    estado_fecha: today(),
  };
  if (form.estado === 'venta') {
    c.monto_venta = Number(String(form.monto).replace(/[^\d.]/g,''));
    c.fecha_venta = today();
  }
  clients.push(c); save(); syncRow(c); dbPush(c);
  vibrate();
  if (c.estado === 'venta') confetti();
  screen = 'ok'; window._okMsg = `${c.nombre} quedó registrado.`; render();
}

function updEstado(e) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  if (e === 'cayo') { pickMotivo = true; return render(); }
  if (e === 'venta') { pickVenta = true; ventaMonto = ''; corrigiendo = false; return render(); }
  pickMotivo = false; corrigiendo = false;
  c.motivo = '';
  if (e === 'separado') c.seguimiento = '';
  c.estado = e; c.estado_fecha = today(); c.updated_at = new Date().toISOString();
  vibrate();
  save(); syncRow(c); dbPush(c); render();
}

function guardarVenta() {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  const monto = Number(String(document.getElementById('v-monto').value).replace(/[^\d.]/g, ''));
  if (!monto) return alert('Escribe el monto de la venta.');
  pickVenta = false; corrigiendo = false;
  c.estado = 'venta'; c.motivo = '';
  c.monto_venta = monto; c.fecha_venta = today();
  c.estado_fecha = today(); c.seguimiento = '';
  c.updated_at = new Date().toISOString();
  vibrate(); confetti();
  save(); syncRow(c); dbPush(c); render();
}

function updMotivo(m) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  if (m === 'Otro') {
    const t = prompt('Escribe el motivo');
    if (!t || !t.trim()) return;
    m = t.trim();
  }
  c.estado = 'cayo'; c.motivo = m; pickMotivo = false; corrigiendo = false;
  c.estado_fecha = today(); c.updated_at = new Date().toISOString();
  save(); syncRow(c); dbPush(c); render();
}

function updSeguimiento(v) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  c.seguimiento = v; c.updated_at = new Date().toISOString();
  save(); syncRow(c); dbPush(c); render();
}

function borrarCliente(id) {
  if (!confirm('¿Eliminar este cliente? Tu hoja de Google conserva el registro.')) return;
  clients = clients.filter(c => c.id !== id); save(); dbDelete(id); go('clientes');
}

function guardarUrl() {
  CONFIG.SCRIPT_URL = document.getElementById('cfg-url').value.trim();
  CONFIG.TOKEN = document.getElementById('cfg-token').value.trim();
  const api = document.getElementById('cfg-api').value.trim().replace(/\/$/, '');
  if (api && !/^https?:\/\//.test(api)) return alert('La URL del servidor debe empezar con https://');
  CONFIG.API_URL = api;
  localStorage.setItem('apiUrl', CONFIG.API_URL);
  localStorage.setItem('scriptUrl', CONFIG.SCRIPT_URL);
  localStorage.setItem('syncToken', CONFIG.TOKEN);
  apiFetch('/api/sheet-url', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: CONFIG.SCRIPT_URL }) }).catch(() => {});
  flushPending(); updateBadge();
  vibrate();
  screen = 'ok'; window._okMsg = 'Conexión guardada. Los registros llegarán a tu hoja.'; render();
}

/* ---------- Bottom sheet de acciones por cliente ---------- */
let sheetClient = null;
function openClientSheet(id) {
  sheetClient = clients.find(c => c.id === id) || null;
  renderSheet();
}
function closeSheet() {
  sheetClient = null;
  const s = document.getElementById('bottom-sheet');
  if (s) { s.classList.remove('open'); setTimeout(() => s.remove(), 260); }
  document.body.classList.remove('sheet-open');
}
function renderSheet() {
  if (!sheetClient) { closeSheet(); return; }
  const c = sheetClient;
  const tel = String(c.telefono || '').replace(/[^\d+]/g, '');
  let s = document.getElementById('bottom-sheet');
  if (!s) {
    s = document.createElement('div');
    s.id = 'bottom-sheet';
    s.innerHTML = '<div class="sheet-backdrop" onclick="closeSheet()"></div><div class="sheet-card" id="sheet-card"></div>';
    document.body.appendChild(s);
    requestAnimationFrame(() => s.classList.add('open'));
    document.body.classList.add('sheet-open');
  }
  const card = document.getElementById('sheet-card');
  card.innerHTML = `
    <div class="sheet-handle"></div>
    <button class="sheet-close" onclick="closeSheet()">${ICON.close}</button>
    <div class="sheet-header">
      <span class="avatar lg">${perfil && perfil.avatar_url ? `<img src="${esc(perfil.avatar_url)}" alt="avatar">` : initial(c.nombre)}</span>
      <div><b>${esc(c.nombre)}</b><span>${esc(c.telefono)} ${status(c)}</span></div>
    </div>
    <div class="sheet-actions">
      <a class="sheet-action" href="https://wa.me/${tel.replace('+','')}" target="_blank" onclick="closeSheet()">${ICON.wa}<span>WhatsApp</span></a>
      <a class="sheet-action" href="tel:${tel}" onclick="closeSheet()">${ICON.phone}<span>Llamar</span></a>
      <button class="sheet-action" onclick="closeSheet();go('detalle','${c.id}')">${ICON.eye}<span>Ver detalle</span></button>
      <button class="sheet-action danger" onclick="closeSheet();borrarCliente('${c.id}')">${ICON.trash}<span>Eliminar</span></button>
    </div>`;
}

/* ---------- Pull to refresh ---------- */
let ptrStartY = null, ptrPulling = false, ptrEl = null;
function setupPTR() {
  if (ptrEl) return;
  ptrEl = document.createElement('div');
  ptrEl.id = 'ptr';
  ptrEl.innerHTML = `${ICON.bolt}<span>Suelta para actualizar</span>`;
  document.body.appendChild(ptrEl);
  window.addEventListener('touchstart', e => {
    if (window.scrollY > 5) return;
    ptrStartY = e.touches[0].clientY;
    ptrPulling = false;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (ptrStartY === null || window.scrollY > 5) return;
    const dy = e.touches[0].clientY - ptrStartY;
    if (dy > 20) {
      e.preventDefault();
      ptrPulling = dy > 100;
      ptrEl.classList.add('visible');
      const span = ptrEl.querySelector('span');
      if (span) span.textContent = ptrPulling ? 'Suelta para actualizar' : 'Sigue jalando…';
    }
  }, { passive: false });
  window.addEventListener('touchend', async () => {
    ptrEl.classList.remove('visible');
    if (ptrPulling) {
      showLoading('Actualizando…');
      await dbPull();
      hideLoading();
      toast('Lista actualizada');
    }
    ptrStartY = null; ptrPulling = false;
  }, { passive: true });
}

/* ---------- Conexion WhatsApp Web por QR (Baileys) ---------- */
const waState = { status: 'disconnected', qr: null, jid: null, polling: null, error: null };

async function waFetch(path, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45000);
  try {
    return await apiFetch(path, {
      ...opts,
      headers: {
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...(opts.headers || {})
      },
      signal: controller.signal
    });
  } finally { clearTimeout(t); }
}

function fmtJid(jid) {
  if (!jid) return '';
  const n = String(jid).replace(/\D/g, '');
  if (n.length === 12 && n.startsWith('52')) return `+${n.slice(0,2)} ${n.slice(2,4)} ${n.slice(4,8)} ${n.slice(8)}`;
  if (n.length === 13 && n.startsWith('521')) return `+${n.slice(0,2)} ${n.slice(3,5)} ${n.slice(5,9)} ${n.slice(9)}`;
  return '+' + n;
}

function viewWhatsAppConnect() {
  if (!session) return '';
  const s = waState;
  const labels = {
    disconnected: 'Desconectado',
    connecting: 'Conectando…',
    qr: 'Esperando QR',
    connected: 'Conectado',
    logged_out: 'Sesión cerrada'
  };
  const label = labels[s.status] || s.status;
  const isCon = s.status === 'connected';
  return `
  <div class="wa-connect">
    <div class="wa-card">
      <div class="wa-icon ${s.status}">${ICON.wa}</div>
      <div class="wa-status">
        <span class="wa-dot ${s.status}"></span>
        <b>${label}</b>
        ${isCon ? `<small>${fmtJid(s.jid)}</small>` : ''}
      </div>
      <p class="wa-desc">${isCon
        ? 'Los números que te escriban entrarán solos a <b>Clientes → Nuevos</b>.'
        : 'Vincula WhatsApp Web una sola vez. Después, cada número que te escriba se guarda solo.'}</p>
      ${s.error ? `<div class="wa-tip">${ICON.alert}<span>${esc(s.error)}</span></div>` : ''}
      ${!isCon
        ? `<button class="primary wa-btn" onclick="waConnect()" id="wa-btn" ${s.status === 'connecting' || s.status === 'qr' ? 'disabled' : ''}>
             ${s.status === 'connecting' ? 'Conectando…' : s.status === 'qr' ? 'Esperando que escanees…' : 'Conectar WhatsApp'}
           </button>`
        : `<button class="secondary wa-btn" onclick="waDisconnect()">Cerrar sesión de WhatsApp</button>`}
    </div>
    ${s.status === 'qr' && s.qr
      ? `<div class="wa-qr"><img src="${esc(s.qr)}" alt="QR WhatsApp"><p>Abre WhatsApp en tu teléfono → <b>⋮</b> → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> → escanea este código.</p></div>`
      : ''}
    ${s.status === 'disconnected' || s.status === 'logged_out'
      ? `<div class="wa-tip">${ICON.alert}<span>Solo leemos el número del remitente. No enviamos respuestas automáticas, así el riesgo de bloqueo es mucho menor.</span></div>`
      : ''}
  </div>`;
}

async function waStatus() {
  try {
    const r = await waFetch('/api/whatsapp/status');
    const d = await r.json();
    if (d.error) return;
    const changed = waState.status !== d.status || waState.qr !== d.qr || waState.jid !== d.jid || waState.error;
    Object.assign(waState, { ...d, error: null });
    if (changed) {
      const el = document.getElementById('wa-connect');
      if (el) { el.innerHTML = viewWhatsAppConnect(); animarSegs(el); }
    }
    if (d.status !== 'connected' && !waState.polling) {
      waState.polling = setInterval(waStatus, 3000);
    } else if (d.status === 'connected' && waState.polling) {
      clearInterval(waState.polling); waState.polling = null;
    }
  } catch {}
}

async function waConnect() {
  const btn = document.getElementById('wa-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Conectando…'; }
  try {
    waState.error = null;
    const r = await waFetch('/api/whatsapp/connect', { method: 'POST' });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    Object.assign(waState, { ...d, error: null });
    const el = document.getElementById('wa-connect');
    if (el) { el.innerHTML = viewWhatsAppConnect(); animarSegs(el); }
    if (d.status !== 'connected' && !waState.polling) {
      waState.polling = setInterval(waStatus, 3000);
    }
  } catch (e) {
    waState.error = e.message || 'No se pudo conectar. El servidor puede estar despertando; intenta de nuevo.';
    waState.status = 'disconnected';
    const el = document.getElementById('wa-connect');
    if (el) { el.innerHTML = viewWhatsAppConnect(); animarSegs(el); }
  }
}

async function waDisconnect() {
  try {
    await waFetch('/api/whatsapp/disconnect', { method: 'POST' });
    if (waState.polling) { clearInterval(waState.polling); waState.polling = null; }
    Object.assign(waState, { status: 'disconnected', qr: null, jid: null, error: null });
    const el = document.getElementById('wa-connect');
    if (el) { el.innerHTML = viewWhatsAppConnect(); animarSegs(el); }
  } catch {}
}

let toastT;
function toast(msg, type='success') {
  const t = document.getElementById('toast'); if (!t) return;
  const icon = type === 'error' ? ICON.alert : type === 'warn' ? ICON.alert : ICON.check;
  t.className = 'show ' + type;
  t.innerHTML = `${icon}<span>${esc(msg)}</span>`;
  t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}

/* La pildora del segmented se desliza del valor anterior al nuevo */
function animarSegs(root = document) {
  root.querySelectorAll('.seg2[data-to]').forEach(el => {
    if (el.dataset.on === el.dataset.to) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.on = el.dataset.to; }));
  });
}

/* Simula un lead entrante para probar la captura sin configurar nada */
async function probarCaptura() {
  if (!session || lg.probando) return;
  lg.probando = true; lg.result = null; lgRefresh();
  try {
    const tel = '52155' + String(Math.floor(1000000 + Math.random() * 8999999));
    const r = await apiFetch(`/api/leads/${session.user.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ de: '+52 1 ' + tel.slice(2), texto: 'Prueba — me interesa' }),
    });
    const d = await r.json();
    if (d.ok) { await dbPull(); toast('Lead creado'); }
    lg.result = d.ok
      ? { ok: true, msg: `${d.telefono} ya está en Clientes → Nuevos.` }
      : { ok: false, msg: d.error || 'Intenta de nuevo.' };
  } catch { lg.result = { ok: false, msg: 'El servidor no respondió — puede estar despertando, intenta en 30 s.' }; }
  lg.probando = false; lgRefresh();
}

function guardarSupa() {
  const url = document.getElementById('cfg-supa-url').value.trim();
  const key = document.getElementById('cfg-supa-key').value.trim();
  if (url && !/^https:\/\//.test(url)) return alert('La URL debe empezar con https://');
  localStorage.setItem('supaUrl', url);
  localStorage.setItem('supaKey', key);
  location.reload();
}

/* ---------- Exportar ---------- */
const HEADERS = ['NOMBRES', 'TELEFONO', 'ESTADO', 'MOTIVO', 'FECHA Y HORA', 'MONTO VENTA'];
const toRow = c => [c.nombre, c.telefono, ESTADOS[c.estado].label, c.motivo||'',
  fmtFechaHora(c.creado ? new Date(c.creado) : new Date(c.fecha + 'T12:00')),
  c.monto_venta ? Number(c.monto_venta) : ''];

async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportCSV() {
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [HEADERS, ...clients.map(toRow)].map(r => r.map(q).join(',')).join('\n');
  shareOrDownload(new Blob(['\uFEFF' + csv], { type: 'text/csv' }), `clientes_${today()}.csv`);
}

function exportExcel() {
  shareOrDownload(buildXlsx([HEADERS, ...clients.map(toRow)]), `clientes_${today()}.xlsx`);
}

/* XLSX minimo (zip sin compresion) — sin librerias externas */
function buildXlsx(rows) {
  const x = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const col = i => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) =>
    `<row r="${ri+1}">${r.map((v, ci) =>
      `<c r="${col(ci)}${ri+1}" t="inlineStr"${ri===0?' s="1"':''}><is><t xml:space="preserve">${x(v)}</t></is></c>`).join('')}</row>`).join('');
  const widths = [24, 18, 16, 20, 20, 14];
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clientes" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7A5232"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function zipStore(files) {
  const enc = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc32 = b => { let c = ~0; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const parts = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nm = enc.encode(name), data = enc.encode(content), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = Object.keys(files).length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

function borrarTodo() {
  if (!confirm('¿Borrar TODOS los datos del iPhone? Tu hoja de Google no se toca.')) return;
  clients = []; pendingSync = []; save(); go('hoy');
}

/* ---------- Render ---------- */
const VIEWS = { hoy: viewHoy, registrar: viewRegistrar, detalle: viewDetalle,
  clientes: viewClientes, live: viewLive, panel: viewPanel, ajustes: viewAjustes,
  perfil: viewPerfil, upgrade: viewUpgrade, admin: viewAdmin,
  login: viewLogin, ok: () => viewOk(window._okMsg || '') };
const TITLES = { hoy: 'Hoy', registrar: 'Nuevo cliente', detalle: '',
  clientes: 'Clientes', live: 'TikTok Live', panel: 'Panel', ajustes: 'Ajustes',
  perfil: 'Perfil', upgrade: 'Plan Pro', admin: 'Admin', login: 'Entrar', ok: '' };
const TAB_OF = { registrar: 'hoy', detalle: 'clientes', ok: 'hoy' };

/* Numeros que suben de 0 a su valor (hero, stats, %) */
function countUp(root) {
  root.querySelectorAll('.hero-num, .stat .num, .pct').forEach(el => {
    const m = el.textContent.match(/^(\D*)([\d.,]+)(.*)$/);
    if (!m) return;
    const conComa = m[2].includes(',');
    const fin = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(fin) || fin === 0) return;
    const dec = (m[2].split('.')[1] || '').length;
    const t0 = performance.now(), dur = 800;
    const fmt = v => conComa ? v.toLocaleString('es-MX', { maximumFractionDigits: dec }) : v.toFixed(dec);
    const paso = t => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = m[1] + fmt(fin * e) + m[3];
      if (p < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  });
}

let lastScreen = null;
function render() {
  const key = screen + (detailId || '');
  const cambio = key !== lastScreen;
  lastScreen = key;
  const fecha = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('screen-date').textContent = screen === 'hoy' ? fecha : '';
  const title = document.getElementById('screen-title');
  title.textContent = TITLES[screen];
  const app = document.getElementById('app');
  app.innerHTML = VIEWS[screen]();
  if (screen === 'ajustes') setTimeout(waStatus, 50);
  else if (waState.polling) { clearInterval(waState.polling); waState.polling = null; }
  document.body.classList.toggle('is-login', screen === 'login');
  document.getElementById('tabbar').classList.toggle('hidden', screen === 'login');
  const tab = TAB_OF[screen] || screen;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === tab));
  updateBadge();
  animarSegs(app);
  if (cambio) {
    app.classList.remove('enter'); title.classList.remove('swap');
    void app.offsetWidth;   // reinicia la animacion
    app.classList.add('enter'); title.classList.add('swap');
    countUp(app);
    window.scrollTo(0, 0);
  }
}

/* ---------- Ripple en botones ---------- */
document.addEventListener('click', e => {
  const btn = e.target.closest('button.primary, button.secondary, button.destructive');
  if (!btn) return;
  const circle = document.createElement('span');
  const d = Math.max(btn.clientWidth, btn.clientHeight);
  const rect = btn.getBoundingClientRect();
  circle.style.cssText = `position:absolute;border-radius:50%;background:rgba(255,255,255,.35);width:${d}px;height:${d}px;left:${e.clientX - rect.left - d/2}px;top:${e.clientY - rect.top - d/2}px;pointer-events:none;transform:scale(0);animation:ripple .6s linear`;
  btn.appendChild(circle);
  setTimeout(() => circle.remove(), 600);
}, true);

/* ---------- Arranque: sesion + datos ---------- */
async function boot() {
  loadMonetizacion();
  setupPTR();
  if (new URLSearchParams(location.search).get('pago') === 'ok') {
    history.replaceState(null, '', location.pathname);
    window._okMsg = 'Pago recibido — tu plan Pro se activa en segundos.';
    screen = 'ok';
    setTimeout(loadPerfil, 5000);   // el webhook tarda un momento en marcar pro
  }
  if (sb) {
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (!session) { screen = 'login'; render(); return; }
    showLoading('Cargando tus datos…');
    await ensurePerfil();
    await Promise.all([dbPull(), loadPerfil()]);
    hideLoading();
  }
  render();
}

if (sb) sb.auth.onAuthStateChange((ev, s) => {
  if (ev === 'PASSWORD_RECOVERY') {
    /* Llegaron por el enlace del correo: pedir clave nueva */
    session = s; authMode = 'setpass'; screen = 'login'; render();
    return;
  }
  const tenia = !!session;
  session = s;
  if (session && !tenia) {
    showWelcome();
    ensurePerfil()
      .then(() => Promise.all([dbPull(), loadPerfil()]))
      .then(() => { if (screen === 'login') go('hoy'); else render(); });
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
flushPending();
boot();

/* Splash de bienvenida: se va solo o al tocar */
const splash = document.getElementById('splash');
const dismiss = () => { splash.classList.add('bye'); setTimeout(() => splash.remove(), 700); };
splash.addEventListener('click', dismiss);
setTimeout(dismiss, 2400);
