import { createClient } from '@vercel/kv';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) return res.status(500).json({ error: 'Vercel KV not configured' });

  const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // GET — return all personalities
  if (req.method === 'GET') {
    try {
      const raw = await kv.hgetall('personalities');
      if (!raw) return res.status(200).json({ personalities: [] });
      const personalities = Object.values(raw).map(v => {
        try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
      }).filter(Boolean);
      personalities.sort((a, b) => b.meter - a.meter);
      return res.status(200).json({ personalities });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove one personality by name key
  if (req.method === 'DELETE') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    const { name } = body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
      await kv.hdel('personalities', name.toLowerCase());
      return res.status(200).json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
