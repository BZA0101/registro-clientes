/* Conexion WhatsApp Web (Baileys) con auth persistente en Supabase.
   Solo lee numeros de mensajes privados entrantes y los registra como leads. */
const { default: makeWASocket, DisconnectReason, initAuthCreds, makeCacheableSignalKeyStore, proto, BufferJSON } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino')({ level: 'silent' });
const QRCode = require('qrcode');

const sockets = new Map(); // userId -> { socket, status, qr, jid }

function initWhatsApp({ sbRest, crearLeadWa, authUser }) {
  async function makeSupabaseAuthState(userId) {
    const readCreds = async () => {
      const rows = await sbRest(`wa_auth_state?user_id=eq.${userId}&key=eq.creds&select=value`);
      if (rows && rows[0]) {
        try { return JSON.parse(rows[0].value, BufferJSON.reviver); } catch {}
      }
      return null;
    };

    const writeCreds = async () => {
      await sbRest('wa_auth_state', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { user_id: userId, key: 'creds', value: JSON.stringify(creds, BufferJSON.replacer) }
      });
    };

    const chunk = (arr, n) => {
      const out = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };

    const store = {
      async get(type, ids) {
        if (!ids.length) return {};
        const all = {};
        for (const batch of chunk(ids, 40)) {
          const keys = batch.map(id => encodeURIComponent(`${type}|${id}`)).join(',');
          const rows = await sbRest(`wa_auth_state?user_id=eq.${userId}&key=in.(${keys})&select=key,value`);
          for (const row of rows || []) {
            const [t, ...rest] = row.key.split('|');
            const id = rest.join('|');
            if (t !== type) continue;
            try {
              let value = JSON.parse(row.value, BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              all[id] = value;
            } catch {}
          }
        }
        return all;
      },
      async set(data) {
        const toInsert = [];
        const toDelete = [];
        for (const type in data) {
          for (const id in data[type]) {
            const value = data[type][id];
            const key = `${type}|${id}`;
            if (value) toInsert.push({ user_id: userId, key, value: JSON.stringify(value, BufferJSON.replacer) });
            else toDelete.push(key);
          }
        }
        const tasks = [];
        for (const batch of chunk(toInsert, 40)) {
          tasks.push(sbRest('wa_auth_state', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: batch
          }));
        }
        for (const batch of chunk(toDelete, 40)) {
          const inList = batch.map(k => encodeURIComponent(k)).join(',');
          tasks.push(sbRest(`wa_auth_state?user_id=eq.${userId}&key=in.(${inList})`, { method: 'DELETE' }));
        }
        await Promise.all(tasks);
      },
      async clear() {
        await sbRest(`wa_auth_state?user_id=eq.${userId}`, { method: 'DELETE' });
      }
    };

    const creds = (await readCreds()) || initAuthCreds();
    return {
      state: { creds, keys: makeCacheableSignalKeyStore(store, pino) },
      saveCreds: writeCreds
    };
  }

  async function clearSession(userId) {
    const s = sockets.get(userId);
    if (s) {
      try { await s.socket.logout(); } catch {}
      sockets.delete(userId);
    }
    await sbRest(`wa_auth_state?user_id=eq.${userId}`, { method: 'DELETE' });
    await sbRest(`wa_sessions?user_id=eq.${userId}`, { method: 'DELETE' });
  }

  async function startSession(userId) {
    if (sockets.has(userId)) return sockets.get(userId);
    const { state, saveCreds } = await makeSupabaseAuthState(userId);
    const sock = makeWASocket({ logger: pino, printQRInTerminal: false, auth: state });
    const sess = { socket: sock, status: 'connecting', qr: null, jid: null };
    sockets.set(userId, sess);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        sess.status = 'qr';
        sess.qr = await QRCode.toDataURL(qr, { margin: 2, width: 256, color: { dark: '#128C7E', light: '#ffffff' } });
      }
      if (connection === 'close') {
        const loggedOut = lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut;
        sess.status = loggedOut ? 'logged_out' : 'connecting';
        sess.qr = null;
        sockets.delete(userId);
        if (loggedOut) {
          await clearSession(userId);
        } else {
          setTimeout(() => startSession(userId).catch(() => {}), 5000);
        }
      } else if (connection === 'open') {
        sess.status = 'connected';
        sess.qr = null;
        sess.jid = sock.user?.id || sock.user?.jid;
        await sbRest('wa_sessions', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: { user_id: userId, jid: sess.jid, connected: true }
        });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || !from.endsWith('@s.whatsapp.net')) continue;
        const number = from.split('@')[0];
        const name = msg.pushName || number;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption || '';
        await crearLeadWa(userId, number, name, text).catch(() => {});
      }
    });

    return sess;
  }

  async function getStatus(userId) {
    let s = sockets.get(userId);
    if (!s) {
      const auth = await sbRest(`wa_auth_state?user_id=eq.${userId}&select=key&limit=1`);
      if (auth && auth.length) s = await startSession(userId).catch(() => null);
    }
    if (!s) return { status: 'disconnected', qr: null, jid: null };
    return { status: s.status, qr: s.qr, jid: s.jid };
  }

  return {
    status: async (req, res) => {
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: 'Sin sesión' });
      res.json(await getStatus(user.id));
    },
    connect: async (req, res) => {
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: 'Sin sesión' });
      let s = sockets.get(user.id);
      if (!s) {
        try { s = await startSession(user.id); } catch (e) { return res.status(502).json({ error: e.message }); }
      }
      res.json({ status: s.status, qr: s.qr, jid: s.jid });
    },
    disconnect: async (req, res) => {
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: 'Sin sesión' });
      await clearSession(user.id);
      res.json({ ok: true, status: 'disconnected', qr: null, jid: null });
    }
  };
}

module.exports = { initWhatsApp };
