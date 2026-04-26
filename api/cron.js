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
      max_tokens: 6000,
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

function buildScanPrompt(category, existingNames) {
  const exclusions = existingNames.length > 0
    ? `Do NOT include any of these already-tracked people: ${existingNames.join(', ')}.`
    : '';

  return `You are an intelligence analyst building a comprehensive database of Pakistani public figures and their stances on Israel and the Israeli-Palestinian conflict.

Focus specifically on: ${category}

${exclusions}

Generate a list of 20 Pakistani personalities from the category above who have publicly expressed views on Israel, Gaza, or the Israeli-Palestinian conflict. Cast a wide net — include well-known and lesser-known figures, historical and current, those with strong opinions and those with mild ones.

Respond ONLY with a valid JSON array — no markdown, no text outside the JSON:

[
  {
    "name": "<full name>",
    "role": "<one of: Politician | Government Official | Journalist | Influencer | Military | Religious Figure | Academic | Businessperson | Other>",
    "stance": "anti" | "pro" | "neutral",
    "meter": <integer 0-100>,
    "analysis": "<2-3 sentence factual summary of their Israel stance>",
    "statements": [
      { "text": "<paraphrased or actual public statement>", "source": "<context e.g. Dawn interview 2023>" }
    ]
  }
]

Meter scale: 0-30=pro-Israel, 31-54=neutral, 55-70=mild anti-Israel, 71-85=strong anti-Israel, 86-100=extreme anti-Israel rhetoric.
Include 1-3 statements per person. If stance is unclear set neutral and meter 50.
Return ONLY the JSON array with all 20 entries.`;
}

const CATEGORIES = [
  'Pakistani Politicians (federal and provincial, all parties — PTI, PMLN, PPP, MQM, JUI, etc.)',
  'Pakistani Journalists, news anchors, columnists, and media personalities',
  'Pakistani Religious Scholars, clerics, Imams, and Islamic organizations',
  'Pakistani Military figures, ex-generals, defense analysts, and retired officers',
  'Pakistani Social Media Influencers, YouTubers, and digital content creators',
  'Pakistani Academics, university professors, intellectuals, and think tank analysts',
  'Pakistani Government Officials, diplomats, ambassadors, and bureaucrats',
  'Pakistani Businesspeople, entrepreneurs, and civil society leaders',
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
    // Get all existing names to avoid duplicates
    const existing = await redis.hgetall('personalities') || {};
    const existingKeys = new Set(Object.keys(existing).map(k => k.toLowerCase()));
    const existingNames = Object.values(existing).map(v => {
      try { return (typeof v === 'string' ? JSON.parse(v) : v).name; } catch { return null; }
    }).filter(Boolean);

    let totalAdded = 0;
    const allResults = [];

    // Scan each category in parallel batches of 2 to avoid rate limits
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      const batch = CATEGORIES.slice(i, i + 2);

      const batchResults = await Promise.all(batch.map(async (category) => {
        try {
          const raw = await callGroq(buildScanPrompt(category, existingNames));
          let personalities = [];
          try {
            const clean = raw.replace(/```json|```/g, '').trim();
            personalities = JSON.parse(clean);
            if (!Array.isArray(personalities)) return { category, error: 'Not an array' };
          } catch {
            return { category, error: 'Parse failed', raw: raw.slice(0, 200) };
          }

          const categoryResults = [];
          for (const p of personalities) {
            if (!p.name || !p.stance) continue;
            const key = p.name.toLowerCase();
            if (existingKeys.has(key)) { categoryResults.push({ name: p.name, status: 'skipped' }); continue; }

            const personality = {
              id: Date.now() + totalAdded,
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
            totalAdded++;
            categoryResults.push({ name: p.name, status: 'added', stance: personality.stance, meter: personality.meter });
          }

          return { category, results: categoryResults };
        } catch (err) {
          return { category, error: err.message };
        }
      }));

      allResults.push(...batchResults);

      // Small delay between batches to respect Groq rate limits
      if (i + 2 < CATEGORIES.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return res.status(200).json({
      success: true,
      totalAdded,
      categoriesScanned: CATEGORIES.length,
      results: allResults,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
