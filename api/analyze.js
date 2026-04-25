export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Check API key exists
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server misconfiguration: API key not found in environment variables.' });
  }

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt in request body' });

  console.log('Calling Anthropic for:', prompt.slice(0, 80));

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
    console.log('Anthropic status:', anthropicRes.status);
    console.log('Anthropic response:', raw.slice(0, 300));

    if (!anthropicRes.ok) {
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      return res.status(anthropicRes.status).json({
        error: parsed.error?.message || `Anthropic error ${anthropicRes.status}: ${raw.slice(0, 200)}`
      });
    }

    const data = JSON.parse(raw);
    const text = data.content.map(b => b.text || '').join('');
    return res.status(200).json({ result: text });

  } catch (err) {
    console.error('Fetch to Anthropic failed:', err);
    return res.status(500).json({ error: `Network error reaching Anthropic: ${err.message}` });
  }
}
