import { createClient } from '@vercel/kv';

export const config = { api: { bodyParser: true } };

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
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    throw new Error(parsed.error?.message || `Groq error ${res.status}`);
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
    { "text": "<paraphrased or actual statement>", "source": "<context, e.g. 'National Assembly, 2023'>" }
  ]
}

Meter scale: 0-30 = pro-Israel, 31-54 = neutral, 55-70 = mild anti-Israel, 71-85 = strong anti-Israel, 86-100 = extreme anti-Israel rhetoric.
Include 1-3 statements. If person unknown, set stance "neutral" and meter 50.
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
  if (!process.env.KV_REST_API_URL) return res.status(500).json({ error: 'Vercel KV not configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { name, role = 'Other', statement = '' } = body || {};
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // Check duplicate
  const existing = await kv.hget('personalities', name.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Already tracked', personality: existing });

  try {
    const prompt = buildPrompt(name, role, statement);
    const raw = await callGroq(prompt);
    const parsed = parseResponse(raw);

    const personality = {
      id: Date.now(),
      name,
      role,
      ...parsed,
      date: new Date().toISOString().split('T')[0],
      source: 'manual',
    };

    await kv.hset('personalities', { [name.toLowerCase()]: JSON.stringify(personality) });

    return res.status(200).json({ personality });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
