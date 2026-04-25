# PakistanPulse — Israel Stance Tracker

AI-powered dashboard to track Pakistani personalities' stances on Israel.

## Project Structure

```
pakistan-pulse/
├── api/
│   └── analyze.js        ← Vercel serverless function (Anthropic proxy)
├── public/
│   └── index.html        ← Frontend
├── vercel.json           ← Routing config
└── README.md
```

## Deploy to Vercel (Free) — Step by Step

### 1. Create a GitHub repo
- Go to github.com → New repository → name it `pakistan-pulse`
- Upload all files maintaining the folder structure above

### 2. Connect to Vercel
- Go to vercel.com → Add New Project
- Import your GitHub repo
- Click **Deploy** (default settings are fine)

### 3. Add your Anthropic API key ← THIS IS THE CRITICAL STEP
- In Vercel dashboard → your project → **Settings** → **Environment Variables**
- Add:
  - **Name:** `ANTHROPIC_API_KEY`
  - **Value:** `sk-ant-api03-...` (your key from console.anthropic.com)
  - **Environment:** Production, Preview, Development (check all three)
- Click **Save**

### 4. Redeploy
- Go to **Deployments** tab → click the three dots on latest deployment → **Redeploy**
- Your site is now live at `your-project.vercel.app`

## Why this fixes the CORS error

The old version called `api.anthropic.com` directly from the browser.
Anthropic blocks these requests with a misleading "credit balance" error.

This version calls `/api/analyze` — a serverless function that runs on Vercel's
servers (not in the browser), so there's no CORS issue. Your API key stays
server-side and is never exposed to users.

## Get a Free Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up / log in
3. Go to **API Keys** → **Create Key**
4. Free tier includes $5 of credits (enough for hundreds of analyses)
