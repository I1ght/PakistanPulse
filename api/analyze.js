export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: API key not set.' });
  }

  // Handle body whether it arrives as string or object
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const prompt = body?.prompt;
  if (!prompt) {
    return res.status(400).json({ error: `Missing prompt. Body received: ${JSON.stringify(body)}` });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const raw = await anthropicRes.text();

    if (!anthropicRes.ok) {
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      return res.status(anthropicRes.status).json({
        error: parsed.error?.message || `Anthropic error ${anthropicRes.status}`
      });
    }

    const data = JSON.parse(raw);
    const text = data.content.map(b => b.text || '').join('');
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ error: `Failed to reach Anthropic: ${err.message}` });
  }
}
