import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 3000,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    let p = {}; try { p = JSON.parse(raw); } catch {}
    throw new Error(p.error?.message || `Groq error ${res.status}`);
  }
  const data = JSON.parse(raw);
  return data.choices?.[0]?.message?.content || '';
}

const SCAN_PROMPT = `You are an intelligence analyst tracking Pakistani public figures who have made notable statements about Israel, Gaza, or the Israeli-Palestinian conflict.

Generate a list of 8-10 prominent Pakistani personalities known for clear public stances on Israel. Include politicians, journalists, religious figures, military figures, and media influencers. Include a mix of anti-Israel and pro-Israel or moderate figures.

Respond ONLY with a valid JSON array — no markdown, no text outside JSON:

[
  {
    "name": "<full name>",
    "role": "<one of: Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "anti" | "pro" | "neutral",
    "meter": <integer 0-100>,
    "analysis": "<2-3 sentence factual summary of their Israel stance>",
    "statements": [
      { "text": "<paraphrased or actual statement>", "source": "<context>" }
    ]
  }
]

Meter: 0-30=pro-Israel, 31-54=neutral, 55-70=mild anti-Israel, 71-85=strong anti-Israel, 86-100=extreme.
Return ONLY the JSON array.`;

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Upstash Redis not configured' });

  const redis = getRedis();

  try {
    const existing = await redis.hgetall('personalities') || {};
    const existingKeys = new Set(Object.keys(existing).map(k => k.toLowerCase()));

    const raw = await callGroq(SCAN_PROMPT);
    let personalities = [];
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      personalities = JSON.parse(clean);
      if (!Array.isArray(personalities)) throw new Error('Not an array');
    } catch {
      return res.status(500).json({ error: 'Failed to parse scan results', raw: raw.slice(0, 300) });
    }

    let added = 0;
    const results = [];

    for (const p of personalities) {
      if (!p.name || !p.stance) continue;
      const key = p.name.toLowerCase();
      if (existingKeys.has(key)) { results.push({ name: p.name, status: 'skipped' }); continue; }

      const personality = {
        id: Date.now() + added,
        name: p.name,
        role: p.role || 'Other',
        stance: ['pro', 'anti', 'neutral'].includes(p.stance) ? p.stance : 'neutral',
        meter: Math.max(0, Math.min(100, parseInt(p.meter) || 50)),
        analysis: p.analysis || '',
        statements: Array.isArray(p.statements) ? p.statements.slice(0, 3) : [],
        date: new Date().toISOString().split('T')[0],
        source: 'auto-scan',
      };

      await redis.hset('personalities', { [key]: JSON.stringify(personality) });
      existingKeys.add(key);
      added++;
      results.push({ name: p.name, status: 'added', stance: personality.stance, meter: personality.meter });
    }

    return res.status(200).json({ success: true, added, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
