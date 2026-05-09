import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true }, maxDuration: 60 };

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

// ── GOOGLE NEWS RSS FETCH ──
async function fetchNewsHeadlines(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-PK&gl=PK&ceid=PK:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    // Extract titles and descriptions from RSS
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)].map(m => m[1]).slice(1, 6);
    const descs = [...xml.matchAll(/<description><!\[CDATA\[(.+?)\]\]><\/description>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(1, 6);
    if (titles.length === 0) {
      // fallback: plain <title> tags
      const plain = [...xml.matchAll(/<title>(.+?)<\/title>/g)].map(m => m[1]).slice(1, 6);
      return plain;
    }
    return titles.map((t, i) => descs[i] ? `${t} — ${descs[i].slice(0, 120)}` : t);
  } catch {
    return [];
  }
}

// ── PARSE & SAVE ──
async function parseAndSave(raw, redis, existingKeys, existingNames, totalAdded) {
  let personalities = [];
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
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

// ── SCORING RULES (shared across all prompts) ──
const SCORING_RULES = `
CLASSIFICATION:
- "pro" (Zionist): Explicitly supports Israel's existence as a Jewish state, defends Israeli military actions, advocates normalization, opposes BDS.
- "neutral": Supports two-state solution, diplomatic/ambiguous, calls for peace. Two-state supporters MUST be neutral.
- "anti" (Anti-Zionist): Opposes Zionism ideologically, supports Palestinian resistance, supports BDS, describes Israel as apartheid/colonial.

ANTI-ZIONIST-O-METER (be conservative):
- 0-20: Strongly Zionist
- 21-40: Leaning Zionist  
- 41-59: Neutral (two-state, ambiguous, diplomatic)
- 60-74: Mild Anti-Zionist (critical of Israeli policies, supports Palestinian rights)
- 75-87: Strong Anti-Zionist (opposes Zionism ideologically)
- 88-100: Extreme — only for genuinely extreme rhetoric (glorifying violence, dehumanizing language)

Most Pakistani politicians fall 60-80. Only assign 88+ for truly extreme cases.`;

// ── PROMPT BUILDERS ──
function buildMNAPrompt(assembly, party, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';
  return `You are a political analyst building a database of Pakistani legislators and their stance on Zionism.

Task: List exactly 5 current or recent ${assembly} members from ${party} who have made public statements about Israel, Zionism, Gaza, or the Palestinian cause.
${exclusions}
${SCORING_RULES}

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:
[
  {
    "name": "<full name>",
    "role": "${assembly} Member (${party})",
    "stance": "anti" | "pro" | "neutral",
    "meter": <integer 0-100>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [{ "text": "<statement>", "source": "<context>" }]
  }
]
Return ONLY the JSON array.`;
}

function buildMNAWithNewsPrompt(assembly, party, headlines, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';
  const newsContext = headlines.length > 0
    ? `\nRECENT NEWS HEADLINES (use these to inform current stances):\n${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n`
    : '';
  return `You are a political analyst building a database of Pakistani legislators and their stance on Zionism.

Task: List exactly 5 current or recent ${assembly} members from ${party} who have made public statements about Israel, Zionism, Gaza, or the Palestinian cause.
${exclusions}
${newsContext}
${SCORING_RULES}

Prioritize people mentioned in the recent news headlines above. For others, use your training knowledge.

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:
[
  {
    "name": "<full name>",
    "role": "${assembly} Member (${party})",
    "stance": "anti" | "pro" | "neutral",
    "meter": <integer 0-100>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [{ "text": "<statement>", "source": "<context>" }]
  }
]
Return ONLY the JSON array.`;
}

function buildAntiZionistPrompt(category, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';
  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani ${category} who are ANTI-ZIONIST.
${exclusions}
${SCORING_RULES}

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:
[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "anti",
    "meter": <integer 60-100>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [{ "text": "<statement>", "source": "<context>" }]
  }
]
Return ONLY the JSON array.`;
}

function buildZionistPrompt(existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';
  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani personalities from ANY field who are PRO-ZIONIST or have expressed sympathy for Israel, supported normalization, opposed BDS, or defended Israeli military actions.
${exclusions}

These are rare in Pakistan — cast a wide net. Include anyone with even mild pro-Israel or pro-normalization leanings.
${SCORING_RULES}

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:
[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "pro",
    "meter": <integer 0-40>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [{ "text": "<statement>", "source": "<context>" }]
  }
]
Return ONLY the JSON array.`;
}

function buildNeutralPrompt(category, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include: ${existingNames.slice(0, 60).join(', ')}.`
    : '';
  return `You are a political analyst building a database of Pakistani public figures and their stance on Zionism.

Task: List exactly 5 Pakistani ${category} who are NEUTRAL — support two-state solution, take diplomatic stance, or avoid strong positions.
${exclusions}
${SCORING_RULES}

Respond ONLY with a valid JSON array of exactly 5 objects — no markdown, nothing outside JSON:
[
  {
    "name": "<full name>",
    "role": "<Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "neutral",
    "meter": <integer 41-59>,
    "analysis": "<2-3 sentence factual summary>",
    "statements": [{ "text": "<statement>", "source": "<context>" }]
  }
]
Return ONLY the JSON array.`;
}

// ── MNA/MPA TARGETS ──
const MNA_PARTIES = ['PTI (Pakistan Tehreek-e-Insaf)', 'PMLN (Pakistan Muslim League Nawaz)', 'PPP (Pakistan Peoples Party)', 'JUI-F (Jamiat Ulema-e-Islam)', 'JI (Jamaat-e-Islami)', 'MQM-P', 'Independent / other parties'];
const MPA_ASSEMBLIES = ['Punjab Assembly', 'Sindh Assembly', 'KPK Assembly', 'Balochistan Assembly'];

const ANTI_CATEGORIES = [
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

    // ── SWEEP 1: MNAs by party with real-time news context ──
    // Fetch news once for all MNA/MPA sweeps
    const mnaHeadlines = await fetchNewsHeadlines('Pakistan MNA parliament Israel Gaza Palestine Zionism 2024 2025');
    allResults.push({ sweep: 'news-fetch', headlines: mnaHeadlines });

    for (const party of MNA_PARTIES) {
      try {
        const prompt = mnaHeadlines.length > 0
          ? buildMNAWithNewsPrompt('National Assembly (MNA)', party, mnaHeadlines, existingNames)
          : buildMNAPrompt('National Assembly (MNA)', party, existingNames);
        const raw = await callGroq(prompt);
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'MNA', party, results });
      } catch (err) {
        allResults.push({ sweep: 'MNA', party, error: err.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // ── SWEEP 2: MPAs by assembly ──
    const mpaHeadlines = await fetchNewsHeadlines('Pakistan MPA provincial assembly Israel Palestine Gaza 2024 2025');

    for (const assembly of MPA_ASSEMBLIES) {
      try {
        const prompt = mpaHeadlines.length > 0
          ? buildMNAWithNewsPrompt(assembly + ' (MPA)', 'all parties', mpaHeadlines, existingNames)
          : buildMNAPrompt(assembly + ' (MPA)', 'all parties', existingNames);
        const raw = await callGroq(prompt);
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'MPA', assembly, results });
      } catch (err) {
        allResults.push({ sweep: 'MPA', assembly, error: err.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // ── SWEEP 3: Anti-Zionist non-legislators ──
    for (const category of ANTI_CATEGORIES) {
      try {
        // Fetch category-specific news
        const catQuery = `Pakistan ${category.split(' ')[0]} Israel Gaza Palestine 2024 2025`;
        const headlines = await fetchNewsHeadlines(catQuery);
        const raw = await callGroq(buildAntiZionistPrompt(category, existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'anti-zionist', category, headlines: headlines.slice(0, 2), results });
      } catch (err) {
        allResults.push({ sweep: 'anti-zionist', category, error: err.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // ── SWEEP 4: Zionist hunt (3 calls) ──
    for (let i = 0; i < 3; i++) {
      try {
        const raw = await callGroq(buildZionistPrompt(existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'zionist', attempt: i + 1, results });
      } catch (err) {
        allResults.push({ sweep: 'zionist', attempt: i + 1, error: err.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // ── SWEEP 5: Neutral ──
    for (const category of NEUTRAL_CATEGORIES) {
      try {
        const raw = await callGroq(buildNeutralPrompt(category, existingNames));
        const { results, added } = await parseAndSave(raw, redis, existingKeys, existingNames, totalAdded);
        totalAdded += added;
        allResults.push({ sweep: 'neutral', category, results });
      } catch (err) {
        allResults.push({ sweep: 'neutral', category, error: err.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    return res.status(200).json({
      success: true,
      totalAdded,
      newsHeadlinesFetched: mnaHeadlines.length,
      totalSweeps: allResults.length,
      results: allResults,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
