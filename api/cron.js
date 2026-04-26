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

function parseStance(text) {
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

const SCAN_PROMPT = `You are an intelligence analyst tracking Pakistani public figures who have made notable statements about Israel, Gaza, or the Israeli-Palestinian conflict.

Generate a list of 8-10 prominent Pakistani personalities who are known for having clear public stances on Israel — include politicians, journalists, religious figures, military figures, and media influencers.

Focus on people who have made significant, newsworthy statements. Include a mix of anti-Israel and pro-Israel (or moderate) figures.

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
  // Verify cron secret to prevent unauthorized triggers
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!process.env.KV_REST_API_URL) return res.status(500).json({ error: 'KV not configured' });

  const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  try {
    console.log('[CRON] Starting daily personality scan...');

    // Get existing personalities to avoid duplicates
    const existing = await kv.hgetall('personalities') || {};
    const existingKeys = new Set(Object.keys(existing).map(k => k.toLowerCase()));

    // Ask Groq to generate a list of notable personalities
    const raw = await callGroq(SCAN_PROMPT);
    let personalities = [];

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      personalities = JSON.parse(clean);
      if (!Array.isArray(personalities)) throw new Error('Not an array');
    } catch (e) {
      console.error('[CRON] Failed to parse Groq response:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse scan results' });
    }

    let added = 0;
    const results = [];

    for (const p of personalities) {
      if (!p.name || !p.stance) continue;
      const key = p.name.toLowerCase();
      if (existingKeys.has(key)) {
        results.push({ name: p.name, status: 'skipped (already exists)' });
        continue;
      }

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

      await kv.hset('personalities', { [key]: JSON.stringify(personality) });
      existingKeys.add(key);
      added++;
      results.push({ name: p.name, status: 'added', stance: personality.stance, meter: personality.meter });
    }

    console.log(`[CRON] Done. Added ${added} new personalities.`);
    return res.status(200).json({ success: true, added, results });

  } catch (err) {
    console.error('[CRON] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
