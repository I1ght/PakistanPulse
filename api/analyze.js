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
  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism and the Israeli-Palestinian conflict.

Analyze: ${name} (${role}, Pakistan)
${extraStatement ? `Known statement provided: "${extraStatement}"` : ''}

Classify their stance using STRICT criteria:

CLASSIFICATION RULES:
- "pro" (Zionist): Explicitly supports Israel's right to exist as a Jewish state, defends Israeli military actions, advocates normalization with Israel, or opposes BDS movement.
- "neutral": Supports a two-state solution, calls for peace negotiations, avoids taking a strong stance, or whose statements are ambiguous. Two-state solution supporters MUST be classified neutral.
- "anti" (Anti-Zionist): Explicitly opposes Zionism as a political ideology, supports Palestinian resistance, calls for a single democratic state, supports BDS, or describes Israel as an apartheid/colonial state.

ANTI-ZIONIST-O-METER (0-100) — be conservative and precise:
- 0-20: Strongly Zionist (actively defends Israel, supports Israeli policies)
- 21-40: Leaning Zionist (mild support, pro-normalization)
- 41-59: Neutral (two-state solution, ambiguous, diplomatic)
- 60-74: Mild Anti-Zionist (critical of Israeli policies, supports Palestinian rights, supports two-state)
- 75-87: Strong Anti-Zionist (opposes Zionism ideologically, supports Palestinian resistance)
- 88-100: Extreme Anti-Zionist (calls for dismantling Israel, glorifies violence, dehumanizing rhetoric)

IMPORTANT: Most Pakistani politicians fall in the 60-80 range. Only assign 88+ for truly extreme rhetoric. Two-state solution supporters should score 50-65 maximum. Default to neutral if unclear.

Respond ONLY with a valid JSON object — no markdown, no text outside JSON:

{
  "stance": "anti" | "pro" | "neutral",
  "meter": <integer 0-100>,
  "analysis": "<2-3 sentence factual summary of their stance on Zionism and Israel>",
  "statements": [
    { "text": "<paraphrased or actual public statement>", "source": "<context e.g. Dawn interview 2023>" }
  ]
}

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
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Upstash Redis not configured' });

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
      name, role, ...parsed,
      date: new Date().toISOString().split('T')[0],
      source: 'manual',
    };
    await redis.hset('personalities', { [name.toLowerCase()]: JSON.stringify(personality) });
    return res.status(200).json({ personality });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
