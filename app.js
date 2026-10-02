/* Registro de Clientes — PWA para iPhone
   Toda la data vive en localStorage y se replica a Google Sheets (Apps Script). */

const CONFIG = {
  // Pega aqui la URL de tu Apps Script (Deploy > Web app). Ver README.
  SCRIPT_URL: localStorage.getItem('scriptUrl') || '',
  // La misma clave que pusiste en CLAVE en el Apps Script (si la pusiste).
  TOKEN: localStorage.getItem('syncToken') || '',
  // URL del servidor en Render (ej. https://clientes.onrender.com). Vacio = mismo origen.
  API_URL: localStorage.getItem('apiUrl') || '',
};

const apiFetch = (path, opts) => fetch(CONFIG.API_URL + path, opts);

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
  separado:    { label: 'Separado',        cls: 'separado' },
  conversando: { label: 'En conversación', cls: 'conversando' },
  cayo:        { label: 'Se cayó',         cls: 'cayo' },
};
const OPCIONES = [
  ['separado', 'Separación lograda', 'Cliente cerró'],
  ['conversando', 'En conversación', 'Sigue interesado'],
  ['cayo', 'Se cayó', 'No se concretó'],
];

/* ---------- Estado ---------- */
let clients = JSON.parse(localStorage.getItem('clients') || '[]');
let pendingSync = JSON.parse(localStorage.getItem('pendingSync') || '[]');
let screen = 'hoy';
let filter = 'todos';
let detailId = null;
let form = null;
let pickMotivo = false;
let livePoll = null;
let liveResumen = null;
let liveError = '';

const save = () => {
  localStorage.setItem('clients', JSON.stringify(clients));
  localStorage.setItem('pendingSync', JSON.stringify(pendingSync));
};

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtFecha = iso => new Date(iso + 'T12:00').toLocaleDateString('es', { day: 'numeric', month: 'short' });
const fmtFechaHora = d =>
  d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
  d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

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
    notas: client.notas || '',
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
function go(s, id) {
  screen = s; detailId = id || null; form = null; pickMotivo = false;
  if (livePoll && s !== 'live') { clearInterval(livePoll); livePoll = null; }
  if (s === 'live') {
    showLoading('Cargando, espera por favor…', 'Despertando el servidor, primera vez puede tardar ~40 segundos');
    loadComps().then(() => { hideLoading(); if (screen === 'live') render(); });
  }
  render();
}
document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => go(t.dataset.screen)));

/* ---------- Helpers ---------- */
const clientesHoy = () => clients.filter(c => c.fecha === today());
const seguimientosPendientes = () =>
  clients.filter(c => c.seguimiento && c.seguimiento <= today() && c.estado !== 'separado');
const monthKey = d => d.slice(0, 7);
const ofMonth = m => clients.filter(c => monthKey(c.fecha) === m);
const initial = n => esc((n.trim()[0] || '?').toUpperCase());

const status = c => `<span class="status ${ESTADOS[c.estado].cls}"><i></i>${ESTADOS[c.estado].label}</span>`;

const row = (c, sub) => `
  <button class="row" onclick="go('detalle','${c.id}')">
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
function viewHoy() {
  const hoy = clientesHoy();
  const pend = seguimientosPendientes();
  const sepHoy = hoy.filter(c => c.estado === 'separado').length;
  return `
    <div class="hero">
      <div class="hero-stats">
        <div><span class="hero-num">${hoy.length}</span><span class="hero-lbl">clientes hoy</span></div>
        <div><span class="hero-num">${sepHoy}</span><span class="hero-lbl">separaciones</span></div>
        <div><span class="hero-num">${pend.length}</span><span class="hero-lbl">por retomar</span></div>
      </div>
      <button class="primary" onclick="go('registrar')">${ICON.plus}Registrar cliente</button>
    </div>

    ${pend.length ? `<div class="section-title">Por retomar</div>
      ${list(pend, c => `${esc(c.telefono)} · ${fmtFecha(c.seguimiento)}`)}` : ''}

    <div class="section-title">Registrados hoy</div>
    ${hoy.length ? list(hoy, c => esc(c.telefono)) :
      `<div class="empty">Aún no registras clientes hoy.</div>`}
  `;
}

function viewRegistrar() {
  form = form || { nombre: '', telefono: '', estado: '', motivo: '', motivoOtro: '', seguimiento: '', notas: '' };
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

    ${form.estado && form.estado !== 'separado' ? `
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
      ${c.motivo ? `<div class="info-row"><span>Motivo</span><b>${esc(c.motivo)}</b></div>` : ''}
      ${c.notas ? `<div class="info-row"><span>Notas</span><b>${esc(c.notas)}</b></div>` : ''}
    </div>

    <div class="section-title">Actualizar estado</div>
    ${optionList(pickMotivo ? 'cayo' : c.estado, 'updEstado')}
    ${pickMotivo ? `<div class="section-title">¿Por qué se cayó?</div>${motivoChips(c.motivo, 'updMotivo')}` : ''}

    ${c.estado !== 'separado' ? `
      <div class="section-title">Seguimiento</div>
      <div class="list form"><label class="input-row"><span>Retomar el</span>
        <input type="date" value="${c.seguimiento||''}" onchange="updSeguimiento(this.value)"></label></div>` : ''}

    <button class="destructive" onclick="borrarCliente('${c.id}')">Eliminar cliente</button>`;
}

function viewClientes() {
  const counts = {
    todos: clients.length,
    conversando: clients.filter(c => c.estado==='conversando').length,
    separado: clients.filter(c => c.estado==='separado').length,
    cayo: clients.filter(c => c.estado==='cayo').length,
  };
  const items = (filter==='todos' ? clients : clients.filter(c => c.estado===filter)).slice().reverse();
  return `
    <div class="segmented">
      ${[['todos','Todos'],['conversando','Activos'],['separado','Separados'],['cayo','Caídos']]
        .map(([k,l]) => `<button class="${filter===k?'active':''}" onclick="filter='${k}';render()">${l}<small>${counts[k]}</small></button>`).join('')}
    </div>
    ${items.length ? list(items, c => `${esc(c.telefono)} · ${fmtFecha(c.fecha)}`) :
      '<div class="empty">Sin clientes aquí todavía.</div>'}
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
  const sepPrev = last.filter(c => c.estado==='separado').length;
  const pct = cur.length ? Math.round(sep/cur.length*100) : 0;
  const pctPrev = last.length ? Math.round(sepPrev/last.length*100) : 0;
  const pctConv = cur.length ? conv/cur.length*100 : 0;
  const delta = (a, b) => {
    const d = a - b;
    return d === 0 ? '<span class="delta">= mes pasado</span>' :
      `<span class="delta ${d>0?'up':'down'}">${d>0?'+':''}${d} vs mes pasado</span>`;
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

  return `
    <div class="card donut-card">
      <div class="donut" style="background: conic-gradient(var(--ok) 0 ${pct}%, var(--warn) ${pct}% ${pct+pctConv}%, var(--bad) ${pct+pctConv}% 100%)${cur.length ? '' : ';background:var(--fill)'}">
        <div class="donut-hole"><span class="pct">${pct}%</span><span class="pct-lbl">cierre</span></div>
      </div>
      <div class="legend">
        <div><i style="background:var(--ok)"></i>Separaron<b>${sep}</b></div>
        <div><i style="background:var(--warn)"></i>En conversación<b>${conv}</b></div>
        <div><i style="background:var(--bad)"></i>Se cayeron<b>${caidos}</b></div>
      </div>
    </div>

    <div class="section-title">Resumen de ${mes}</div>
    <div class="stat-grid">
      <div class="stat"><span class="num">${cur.length}</span><span class="lbl">Clientes atendidos</span>${delta(cur.length, last.length)}</div>
      <div class="stat"><span class="num">${sep}</span><span class="lbl">Separaciones</span>${delta(sep, sepPrev)}</div>
      <div class="stat"><span class="num">${pct}%</span><span class="lbl">Tasa de cierre</span>${delta(pct, pctPrev).replace(/(\d+) vs/, '$1 pts vs')}</div>
      <div class="stat"><span class="num">${conv}</span><span class="lbl">En conversación</span><span class="delta">oportunidades vivas</span></div>
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

function viewLive() {
  if (liveResumen) return viewLiveResumen(liveResumen);
  const activos = Object.values(liveSessions);
  return `
    <div class="card" style="margin-top:8px">
      <div class="section-title" style="margin-top:0">Analizar un live</div>
      <div class="list form"><label class="input-row"><span>Usuario</span>
        <input id="live-user" placeholder="@usuario" autocomplete="off" autocapitalize="none" value="${esc(window._liveUser||'')}"></label></div>
      <p class="hint">Si está en vivo, mide viewers, comentarios y detecta posibles clientes hasta que lo detengas.</p>
      ${liveError ? `<p class="hint" style="color:var(--bad)">${esc(liveError)}</p>` : ''}
      <button class="primary" onclick="startLive()">Empezar análisis</button>
    </div>

    ${activos.map(viewLiveCard).join('')}

    <div class="section-title">Competencia (${compList.length})</div>
    <div class="list form"><label class="input-row"><span>Agregar</span>
      <input id="comp-user" placeholder="@competidor" autocomplete="off" autocapitalize="none"></label></div>
    <button class="secondary" onclick="addCompetidor()">Guardar competidor</button>
    <div id="comp-list">${viewCompList()}</div>
    <div id="comp-report">${viewCompReport()}</div>`;
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
    if (!r.ok) { liveError = d.error || 'No se pudo conectar'; return render(); }
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
      if (h[0]) liveResumen = h[0];
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
    if (d.resumen) { liveResumen = d.resumen; }
    delete liveSessions[usuario];
    if (!Object.keys(liveSessions).length && livePoll) { clearInterval(livePoll); livePoll = null; }
    loadComps(); render();
  } catch { liveError = 'No se pudo detener'; render(); }
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

    <div class="section-title">Servidor (Render)</div>
    <div class="list form"><label class="input-row"><span>URL</span>
      <input id="cfg-api" placeholder="https://tu-app.onrender.com" value="${esc(CONFIG.API_URL)}" autocomplete="off" autocapitalize="none"></label></div>
    <p class="hint">La URL que te da Render al publicar el servidor. Sin esto no funciona la pestaña Live.</p>

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

function viewOk(msg) {
  return `<div class="ok-flash"><div class="ok-icon">${ICON.check}</div>
    <h2>Guardado</h2><p>${esc(msg)}</p>
    <button class="primary" onclick="go('hoy')">Listo</button>
    <button class="secondary" onclick="go('registrar')">Registrar otro</button></div>`;
}

/* ---------- Acciones ---------- */
function setEstado(e) { form.estado = e; if (e!=='cayo'){form.motivo='';form.motivoOtro='';} render(); }
function setMotivo(m) { form.motivo = m; render(); }

function guardarCliente() {
  form.nombre = document.getElementById('f-nombre').value.trim();
  form.telefono = document.getElementById('f-tel').value.trim();
  if (!form.nombre) return alert('Falta el nombre.');
  if (form.telefono.replace(/\D/g,'').length < 8) return alert('Ingresa un WhatsApp válido (mínimo 8 dígitos).');
  if (!form.estado) return alert('Elige cómo quedó el cliente.');
  if (form.estado==='cayo' && !form.motivo) return alert('Elige el motivo.');
  if (form.estado==='cayo' && form.motivo==='Otro' && !form.motivoOtro.trim()) return alert('Escribe el motivo.');

  const c = {
    id: 'c' + Date.now(),
    fecha: today(),
    creado: new Date().toISOString(),
    nombre: form.nombre,
    telefono: form.telefono,
    estado: form.estado,
    motivo: form.estado==='cayo' ? (form.motivo==='Otro' ? form.motivoOtro.trim() : form.motivo) : '',
    seguimiento: form.estado==='separado' ? '' : form.seguimiento,
    notas: form.notas,
  };
  clients.push(c); save(); syncRow(c);
  screen = 'ok'; window._okMsg = `${c.nombre} quedó registrado.`; render();
}

function updEstado(e) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  if (e === 'cayo') { pickMotivo = true; return render(); }
  pickMotivo = false;
  c.motivo = '';
  if (e === 'separado') c.seguimiento = '';
  c.estado = e; save(); syncRow(c); render();
}

function updMotivo(m) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  if (m === 'Otro') {
    const t = prompt('Escribe el motivo');
    if (!t || !t.trim()) return;
    m = t.trim();
  }
  c.estado = 'cayo'; c.motivo = m; pickMotivo = false;
  save(); syncRow(c); render();
}

function updSeguimiento(v) {
  const c = clients.find(x => x.id === detailId); if (!c) return;
  c.seguimiento = v; save(); syncRow(c); render();
}

function borrarCliente(id) {
  if (!confirm('¿Eliminar este cliente? Tu hoja de Google conserva el registro.')) return;
  clients = clients.filter(c => c.id !== id); save(); go('clientes');
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
  screen = 'ok'; window._okMsg = 'Conexión guardada. Los registros llegarán a tu hoja.'; render();
}

/* ---------- Exportar ---------- */
const HEADERS = ['NOMBRES', 'TELEFONO', 'ESTADO', 'MOTIVO', 'FECHA Y HORA'];
const toRow = c => [c.nombre, c.telefono, ESTADOS[c.estado].label, c.motivo||'',
  fmtFechaHora(c.creado ? new Date(c.creado) : new Date(c.fecha + 'T12:00'))];

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
  const widths = [24, 18, 16, 20, 20];
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
  ok: () => viewOk(window._okMsg || '') };
const TITLES = { hoy: 'Hoy', registrar: 'Nuevo cliente', detalle: '',
  clientes: 'Clientes', live: 'TikTok Live', panel: 'Panel', ajustes: 'Ajustes', ok: '' };
const TAB_OF = { registrar: 'hoy', detalle: 'clientes', ok: 'hoy' };

function render() {
  const fecha = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('screen-date').textContent = screen === 'hoy' ? fecha : '';
  document.getElementById('screen-title').textContent = TITLES[screen];
  document.getElementById('app').innerHTML = VIEWS[screen]();
  const tab = TAB_OF[screen] || screen;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === tab));
  updateBadge();
  window.scrollTo(0, 0);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
flushPending();
render();

/* Splash de bienvenida: se va solo o al tocar */
const splash = document.getElementById('splash');
const dismiss = () => { splash.classList.add('bye'); setTimeout(() => splash.remove(), 700); };
splash.addEventListener('click', dismiss);
setTimeout(dismiss, 2400);
