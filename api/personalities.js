import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Upstash Redis not configured' });

  const redis = getRedis();

  if (req.method === 'GET') {
    try {
      const raw = await redis.hgetall('personalities');
      if (!raw) return res.status(200).json({ personalities: [] });
      const personalities = Object.values(raw).map(v => {
        try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.meter - a.meter);
      return res.status(200).json({ personalities });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    const { name } = body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
      await redis.hdel('personalities', name.toLowerCase());
      return res.status(200).json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
