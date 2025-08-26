JotPsych Case Study – Action Plan (Starter-Aligned)

### Context & Goal
- **Constraint**: Limited customer insights from clinic websites.
- **Goal**: Scrape one or more relevant pages from a clinic site and use AI to extract:
  - specialty, modalities, location, clinic_size
- **Timebox**: ~2.5 hours of focused work.
- **Starter**: Next.js + Flask hybrid app for local and deploy ([Vercel Next.js Flask Starter](https://vercel.com/templates/backend/nextjs-flask-starter)).

### Tooling Decisions
- **Scraping**: Use Jina.ai Reader as primary fetcher; fallback to Python `requests` + `BeautifulSoup`.
  - **Why Jina.ai over Perplexity**: Jina Reader is simpler (single HTTP fetch returning clean Markdown), cheaper, and requires no auth. Perplexity is optimized for web search/answering, requires API key, and is costlier/overkill for single-page extraction. We choose **Jina.ai**.
- **AI Parser**: Use **Gemini** to extract JSON fields from scraped text (prompt-driven).
- **Runtime**: Flask API (`/api/*`) for scraping + parsing; optional minimal Next.js UI for manual testing.

### Project Structure
- Root: `jotpsych-interview/`
  - Frontend (TypeScript, Next.js): `app/`
    - `page.tsx`: simple form to input URL and display JSON
    - `components/` (optional): small testers for each step (e.g., `JinaTester.tsx`, `GeminiTester.tsx`)
  - Backend (Python, Flask): `api/`
    - `index.py`: Flask app and routes (`/api/health`, `/api/scrape`, `/api/parse`, `/api/scrape-and-parse`)
    - (Optional modules as project grows)
      - `scraper.py`: Jina Reader fetch + `requests`/`BeautifulSoup` fallback
      - `parser_gemini.py`: Gemini JSON extraction
      - `text_utils.py`: normalization, dedupe, truncation
  - Docs: `documentation/`
    - `PLAN.md`, `TUNNING_GUIDE.md`
  - Config: `.env.local` (e.g., `GEMINI_API_KEY`), `requirements.txt`, `next.config.js`, `package.json`

### High-Level Architecture
1. **Input**: Clinic root URL (e.g., https://exampleclinic.com).
2. **Candidate page discovery** (lightweight):
   - Heuristic paths: `/about`, `/team`, `/providers`, `/our-team`, `/services`, `/specialties`, `/contact`.
   - Also include root URL.
3. **Fetch content**:
   - Try Jina Reader for each URL (returns Markdown).
   - On error/empty, fallback to `requests` + `BeautifulSoup` to get visible text.
   - Normalize + dedupe + join text; cap to a token budget for Gemini.
4. **Parse with Gemini**:
   - Prompt instructs strict JSON with keys: `specialty`, `modalities`, `location`, `clinic_size`.
   - Post-validate JSON; fill unknowns with empty strings.
5. **Output**:
   - Return JSON:
     ```
     {
       "clinic_info": {
         "specialty": "",
         "modalities": "",
         "location": "",
         "clinic_size": ""
       }
     }
     ```
6. **Interfaces**:
   - Flask:
     - `POST /api/scrape` body `{ "url": "..." }` → returns combined text.
     - `POST /api/parse` body `{ "text": "..." }` → returns JSON.
     - `POST /api/scrape-and-parse` body `{ "url": "..." }` → returns final JSON (primary demo).
     - `GET /api/health` → `{ status: "ok" }`.
   - Next.js (optional): simple form to enter URL, call `/api/scrape-and-parse`, display JSON.

### Testing Plan (componentized)
- **Test 1 – Jina single page**
  - Call `POST /api/scrape` with a clinic root URL. Expect non-empty normalized text that mentions clinic-relevant terms.
  - Acceptance: HTTP 200, body length > N chars, contains at least one of [about/team/services].
- **Test 2 – Jina multi-page**
  - Provide a root URL; verify candidate paths are fetched and concatenated; ensure dedupe works.
  - Acceptance: Combined text includes content from ≥2 distinct paths when available.
- **Test 3 – Gemini parse**
  - Call `POST /api/parse` with sample text; validate strict JSON schema with all four fields.
  - Acceptance: Valid JSON object with `clinic_info` keys; empty strings if unknown; no extra fields.
- **Test 4 – End-to-end**
  - Call `POST /api/scrape-and-parse` with a clinic URL.
  - Acceptance: Valid final JSON; fields populated when present in site content.
- **Test 5 – Frontend smoke test (optional)**
  - Enter URL in UI; render JSON; handle loading/errors clearly.

### Phased Implementation Plan (timeboxed)
- **Phase 1 (0–15 min) – Dev setup**
  - Setup

- **Phase 2 (15–45 min) – Scraper MVP**
  - `discover_candidate_paths(base_url)` – include root and common paths (`/about`, `/team`, `/providers`, `/services`, etc.).
  - `fetch_markdown_jina(url)` – call Jina Reader, return markdown/text.
  - `fetch_text_fallback(url)` – `requests` + `BeautifulSoup` visible text when Jina fails.
  - `consolidate_text(texts)` – normalize, dedupe, truncate to budget.

- **Phase 3 (45–75 min) – Gemini parser**
  - Create prompt (see PROMPT.md) and `parse_with_gemini(text)`.
  - Validate/normalize to strict JSON schema; empty strings for unknowns.

- **Phase 4 (75–95 min) – Flask endpoints**
  - `POST /api/scrape` → combined text.
  - `POST /api/parse` → parsed JSON.
  - `POST /api/scrape-and-parse` → end-to-end JSON (primary demo).
  - Basic error handling (timeouts, non-200, empty results).

- **Phase 5 (95–115 min) – Optional Next.js UI**
  - Minimal page with URL input → calls `/api/scrape-and-parse` → render JSON.

- **Phase 6 (115–150 min) – Deliverables**
  - Flow diagram, `documentation/PROMPT.md`, usage notes, next steps & caveats, and top-3 uses.

### Gemini Prompt Template (save as `documentation/PROMPT.md`)
System/Instruction:
- You are extracting structured clinic information from unstructured website text. Respond with STRICT JSON and do not include any extra commentary.

User:
- Extract the following fields from the provided text. If unknown, use an empty string. Return ONLY this JSON:
{
"clinic_info": {
"specialty": "<primary specialty or specialties>",
"modalities": "<therapy/treatment modalities offered>",
"location": "<city, state or region>",
"clinic_size": "<# of clinicians or size descriptor if available>"
}
}

Context:
- Text (may include noise): 
{{SCRAPED_TEXT}}


Notes:
- Infer conservatively; avoid hallucinations. If multiple locations/specialties, summarize clearly.

### Error Handling & Robustness
- Timeouts and retries for network calls; user-agent header on fallback fetch.
- Normalize whitespace; strip scripts/styles; dedupe lines; limit to N chars for Gemini.
- Candidate pages are heuristic; non-200 responses skipped gracefully.
- Return empty strings on missing data; ensure valid JSON schema.
- Rate-limiting guard (sleep/jitter) if batching in future.

### Next Steps & Caveats
- Add sitemap/robots-aware discovery; respect `robots.txt` in production.
- Improve candidate path discovery via HTML internal link scan from root.
- Add tests for parser consistency; include Pydantic schema for strong validation.
- Support batching (n webpages) with simple queue and concurrency limits.
- Add provider-bios parsing to refine `clinic_size`.
- Add caching (URL → text) to reduce re-fetch costs.

### Top 3 Uses After 600 Clinics
- **Lead scoring & routing**: Match specialty/modalities to product features; prioritize outreach.
- **Personalized onboarding**: Tailored setup flows and templates per clinic size and services.
- **CRM enrichment & analytics**: Segment by region/specialty; monitor market coverage.

### Deliverables Checklist
- **Diagram**: Flow of Discover → Fetch → Normalize → Parse → JSON.
- **Python script(s)**: Scraper + Flask endpoints in `api/index.py`.
- **AI prompt**: `documentation/PROMPT.md`.
- **Next steps & caveats**: This plan section.
- **Top-3 uses**: As above.

### Notes for the Starter Project
- Next.js proxies `/api/*` to Flask in dev and production per template ([Vercel Next.js Flask Starter](https://vercel.com/templates/backend/nextjs-flask-starter)).
- Dev commands:
  - `npm install`
  - Update `package.json` dev script to use `npm run`
  - `npm run dev`