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
      max_tokens: 1000,
      temperature: 0.3,
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

function buildPrompt(name, role, extraStatement) {
  return `You are an expert analyst of Pakistani public figures and their stances on Israel and the Israeli-Palestinian conflict.

Analyze: ${name} (${role}, Pakistan)
${extraStatement ? `User-provided statement: "${extraStatement}"` : ''}

Based on their publicly known statements, interviews, speeches, and social media activity, classify their stance.

Respond ONLY with a valid JSON object — no markdown, no text outside JSON:

{
  "stance": "anti" | "pro" | "neutral",
  "meter": <integer 0-100>,
  "analysis": "<2-3 sentence factual summary>",
  "statements": [
    { "text": "<paraphrased or actual statement>", "source": "<context, e.g. National Assembly 2023>" }
  ]
}

Meter scale: 0-30=pro-Israel, 31-54=neutral, 55-70=mild anti-Israel, 71-85=strong anti-Israel, 86-100=extreme.
Include 1-3 statements. If person is unknown set stance neutral and meter 50.
Return ONLY the JSON.`;
}

function parseResponse(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      stance: ['pro', 'anti', 'neutral'].includes(parsed.stance) ? parsed.stance : 'neutral',
      meter: Math.max(0, Math.min(100, parseInt(parsed.meter) || 50)),
      analysis: parsed.analysis || '',
      statements: Array.isArray(parsed.statements) ? parsed.statements.slice(0, 3) : [],
    };
  } catch {
    return { stance: 'neutral', meter: 50, analysis: 'Analysis unavailable.', statements: [] };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Upstash Redis not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to env vars.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { name, role = 'Other', statement = '' } = body || {};
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const redis = getRedis();
  const existing = await redis.hget('personalities', name.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Already tracked', personality: typeof existing === 'string' ? JSON.parse(existing) : existing });

  try {
    const raw = await callGroq(buildPrompt(name, role, statement));
    const parsed = parseResponse(raw);
    const personality = {
      id: Date.now(),
      name,
      role,
      ...parsed,
      date: new Date().toISOString().split('T')[0],
      source: 'manual',
    };
    await redis.hset('personalities', { [name.toLowerCase()]: JSON.stringify(personality) });
    return res.status(200).json({ personality });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
