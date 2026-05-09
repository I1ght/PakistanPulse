import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  await redis.del('personalities');
  return res.status(200).json({ success: true, message: 'Database cleared. Run /api/cron to repopulate.' });
}
