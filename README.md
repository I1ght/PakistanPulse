# PakistanPulse v2 — Israel Stance Tracker

## Project Structure

```
/
├── api/
│   ├── analyze.js        ← Analyze a personality + save to KV
│   ├── personalities.js  ← GET all / DELETE one from KV
│   └── cron.js           ← Daily auto-scan (runs at 6am UTC)
├── index.html            ← Frontend
├── package.json          ← @vercel/kv dependency
├── vercel.json           ← Cron schedule + function config
└── README.md
```

## Setup Instructions

### 1. Push to GitHub
Upload all files to your GitHub repo maintaining the structure above.

### 2. Deploy on Vercel
Import the repo on vercel.com and deploy.

### 3. Create Vercel KV Database (Free)
- In Vercel dashboard → your project → **Storage** tab
- Click **Create Database** → choose **KV** (Upstash Redis)
- Name it anything e.g. `pakistan-pulse-kv`
- Click **Create & Continue** → **Connect** to your project
- Vercel will **automatically** add these env vars to your project:
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`

### 4. Add Environment Variables
In Vercel → Settings → Environment Variables, add:

| Name | Value |
|------|-------|
| `GROQ_API_KEY` | Your Groq key from console.groq.com |
| `CRON_SECRET` | Any random string e.g. `mysecret123` (protects cron endpoint) |

KV variables are added automatically in step 3.

### 5. Redeploy
Go to Deployments → Redeploy after adding all env vars.

### 6. Trigger First Scan Manually
Visit: `https://your-project.vercel.app/api/cron`
With header: `Authorization: Bearer mysecret123`

Or just wait — the cron runs every day at 6am UTC automatically.

## How the Cron Works
- Runs daily at 6:00 AM UTC (configurable in vercel.json)
- Asks Groq to generate a list of 8-10 notable Pakistani personalities
- Skips any already in the database
- Auto-adds new ones with stance + meter score
- Cards show "🤖 auto-scanned" badge

## Free Tier Limits
- **Vercel KV**: 30,000 requests/month, 256MB storage
- **Groq**: 14,400 requests/day
- **Vercel Cron**: Unlimited on free tier
- **Vercel Functions**: 100GB-hours/month
