## JotPsych Case Study – Next.js + Flask (Jina + Gemini)

This app discovers relevant pages on a clinic website, fetches content via Jina Reader, and parses structured clinic info using Gemini. It provides a simple UI to run the flow step-by-step or in one shot.

### Prerequisites
- Node.js 18+
- Python 3.10+
- macOS/Linux/Windows shell

### Repo layout
- `app/` – Next.js UI and API proxies
- `api/` – Flask app and endpoints
- `documentation/PLAN.md` – project plan and phases

### 1) Setup
From the project root:

```bash
cd jotpsych-interview
npm install
pip3 install -r requirements.txt
```

Environment variables (create `jotpsych-interview/.env.local`):

```bash
# Required for Gemini features
GEMINI_API_KEY="your_google_ai_studio_key"

# Optional: override model names
# GEMINI_MODEL="gemini-1.5-flash"
# GEMINI_MODEL_PARSE="gemini-1.5-flash"

# Optional: tune parser context size (chars)
CONTEXT_SIZE="128000"
```

Notes:
- If you don’t want to use a `.env.local`, export variables in your shell before running the server:
  ```bash
  export GEMINI_API_KEY="your_key"
  ```
- Jina Reader requires no API key.

### 2) Run in development

```bash
npm run dev
```

This starts:
- Next.js at `http://localhost:3000`
- Flask at `http://127.0.0.1:5329`

Open `http://localhost:3000` and use the UI:
- Enter the clinic base URL.
- Click “Select URLs” (Gemini filters from sitemap/heuristics).
- Click “Scrape selected” (Jina fetch + parse). The parsed JSON appears under “Parsed Clinic Info”.

### 3) API endpoints
Next.js proxies `/api/*` to Flask in dev and prod.

- `POST /api/health` → `{ status: "ok" }`
- `POST /api/discover` body `{ urls|url, max_urls? }` → discovered candidates
- `POST /api/discover-select` body `{ url, max_discover?, max_select? }` → selected URLs only
- `POST /api/scrape-pages` body `{ urls: string[]|csv, limit_chars? }` → Jina fetch for provided URLs
- `POST /api/discover-select-scrape` body `{ url, max_discover?, max_select?, limit_chars? }` → one‑shot: select + scrape + parse
- `POST /api/parse` body `{ text?, urls? }` → parse to JSON using Gemini; will build context from URLs if `text` missing

Examples:

```bash
curl -s http://127.0.0.1:5329/api/health | cat

curl -s -X POST http://127.0.0.1:5329/api/discover-select \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://exampleclinic.com","max_discover":100,"max_select":10}' | cat

curl -s -X POST http://127.0.0.1:5329/api/scrape-pages \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://exampleclinic.com/about"],"limit_chars":500}' | cat
```

### 4) Troubleshooting
- No parsed JSON: ensure `GEMINI_API_KEY` is set. The app will use a heuristic fallback if Gemini is unavailable, but quality improves with a valid key.
- Slow selection: sitemap lists can be large. Reduce `max_discover` or `max_select` in the UI.
- Logs: look for `[gemini]`, `[gemini:parse]`, `[dsl]`, and `[fetch]` lines in the Flask terminal.

### 5) Deploy (Vercel suggested)
- Next.js can be deployed on Vercel; Flask endpoints can run as Python functions or on a separate service.
- Ensure environment variables are configured in the hosting environment.

### 6) Security & limits
- Do not send sensitive data to third-party APIs.
- Respect target sites’ `robots.txt` and usage policies.

### License
For interview/demo use.
