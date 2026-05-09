import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true, }, maxDuration: 60 };

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
      max_tokens: 2000,
      temperature: 0.5,
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

function buildAntiZionistPrompt(category, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';

  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani ${category} who are ANTI-ZIONIST — i.e. they oppose Zionism ideologically, support Palestinian resistance, support BDS, or describe Israel as an apartheid/colonial state.
${exclusions}

ANTI-ZIONIST-O-METER scoring:
- 60-74: Mild (critical of Israeli policies, supports Palestinian rights, may support two-state)
- 75-87: Strong (opposes Zionism ideologically, supports resistance)
- 88-100: Extreme (only for genuinely extreme rhetoric — glorifying violence, dehumanizing language)

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:

[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "anti",
    "meter": <integer 60-100>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [
      { "text": "<paraphrased or actual statement>", "source": "<context e.g. Dawn 2023>" }
    ]
  }
]

Return ONLY the JSON array.`;
}

function buildZionistPrompt(existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';

  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani personalities — from ANY field (politics, media, business, academia, military, entertainment) — who are PRO-ZIONIST or have expressed sympathy for Israel, supported normalization with Israel, opposed BDS, or defended Israeli military actions.
${exclusions}

These are rare in Pakistan so cast a wide net — include anyone who has shown even mild pro-Israel leanings, pro-normalization views, or has been critical of Palestinian militant groups.

METER scoring (pro side, so low scores):
- 0-20: Strongly Zionist (actively defends Israel)
- 21-40: Leaning Zionist (mild support, pro-normalization, critical of anti-Israel rhetoric)

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:

[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "pro",
    "meter": <integer 0-40>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [
      { "text": "<paraphrased or actual statement>", "source": "<context>" }
    ]
  }
]

Return ONLY the JSON array.`;
}

function buildNeutralPrompt(category, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';

  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani ${category} who are NEUTRAL on Zionism — i.e. they support a two-state solution, take a diplomatic/ambiguous stance, call for peace negotiations, or avoid strong positions on Israel/Palestine.
${exclusions}

Two-state solution supporters MUST be classified neutral with meter 41-59.

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:

[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "neutral",
    "meter": <integer 41-59>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [
      { "text": "<paraphrased or actual statement>", "source": "<context>" }
    ]
  }
]

Return ONLY the JSON array.`;
}

async function parseAndSave(raw, redis, existingKeys, existingNames, totalAdded) {
  let personalities = [];
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    // Extract JSON array even if there's extra text
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return { results: [], added: 0 };
    personalities = JSON.parse(match[0]);
    if (!Array.isArray(personalities)) return { results: [], added: 0 };
  } catch {
    return { results: [], added: 0 };
  }

  const results = [];
  let added = 0;

  for (const p of personalities) {
    if (!p.name || !p.stance) continue;
    const key = p.name.toLowerCase();
    if (existingKeys.has(key)) { results.push({ name: p.name, status: 'skipped' }); continue; }

    const personality = {
      id: Date.now() + totalAdded + added,
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
    existingNames.push(p.name);
    added++;
    results.push({ name: p.name, status: 'added', stance: personality.stance, meter: personality.meter });
  }

  return { results, added };
}

// Categories for anti-zionist and neutral sweeps
const ANTI_CATEGORIES = [
  'politicians (federal — PTI, PMLN, PPP, MQM, JUI, JI)',
  'politicians (provincial and local government)',
  'TV journalists and news anchors',
  'newspaper columnists and print journalists',
  'religious scholars and clerics',
  'military figures and defense analysts',
  'social media influencers and YouTubers',
  'academics and university professors',
  'government officials and diplomats',
  'civil society leaders and activists',
];

const NEUTRAL_CATEGORIES = [
  'politicians and government officials',
  'journalists and media figures',
  'academics, diplomats, and civil society leaders',
];

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
    const existingNames = Object.values(existing).map(v => {
      try { return (typeof v === 'string' ? JSON.parse(v) : v).name; } catch { return null; }
    }).filter(Boolean);

    let totalAdded = 0;
    const allResults = [];

    // ── SWEEP 1: Anti-Zionist by category (5 per call) ──
    for (const category of ANTI_CATEGORIES) {
      try {
        const raw = await callGroq(buildAntiZionistPrompt(category, existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'anti-zionist', category, results });
      } catch (err) {
        allResults.push({ sweep: 'anti-zionist', category, error: err.message });
      }
      await new Promise(r => setTimeout(r, 800));
    }

    // ── SWEEP 2: Zionist (multiple calls, 5 per call) ──
    for (let i = 0; i < 3; i++) {
      try {
        const raw = await callGroq(buildZionistPrompt(existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'zionist', attempt: i + 1, results });
      } catch (err) {
        allResults.push({ sweep: 'zionist', attempt: i + 1, error: err.message });
      }
      await new Promise(r => setTimeout(r, 800));
    }

    // ── SWEEP 3: Neutral ──
    for (const category of NEUTRAL_CATEGORIES) {
      try {
        const raw = await callGroq(buildNeutralPrompt(category, existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'neutral', category, results });
      } catch (err) {
        allResults.push({ sweep: 'neutral', category, error: err.message });
      }
      await new Promise(r => setTimeout(r, 800));
    }

    return res.status(200).json({
      success: true,
      totalAdded,
      totalCalls: ANTI_CATEGORIES.length + 3 + NEUTRAL_CATEGORIES.length,
      results: allResults,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
