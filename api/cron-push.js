// Cron diario de Vercel (20:00 hora CDMX = 02:00 UTC)
// Despierta al servidor de Render y dispara el recordatorio push.
// Configurar RENDER_URL en Vercel > Settings > Environment Variables,
// ej: https://registro-clientes.onrender.com

export default async function handler(req, res) {
  const base = process.env.RENDER_URL;
  if (!base) return res.status(500).json({ error: 'Falta RENDER_URL' });
  try {
    const r = await fetch(`${base}/api/send-push`, { method: 'POST' });
    const d = await r.json();
    res.status(200).json(d);
  } catch (e) {
    res.status(502).json({ error: 'Render no respondio', detalle: String(e) });
  }
}
