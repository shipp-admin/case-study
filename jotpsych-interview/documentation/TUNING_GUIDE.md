## Tuning guide: tokens, speed, scrape depth, and filters

This guide shows how to control Gemini token budgets, Jina rate-limit behavior, the number and depth of URLs scraped, and filtering to avoid sitemap/media noise. Each section cites the exact code locations so you can change them quickly.

### 1) Gemini token/context budget
- Primary control: set `GEMINI_TOKEN_BUDGET` (in tokens). Approx conversion: 1 token ≈ 4 chars.
- Fallback: `CONTEXT_SIZE` (in characters) if `GEMINI_TOKEN_BUDGET` is not set.

Code where the cap is applied before calling Gemini:

```240:254:jotpsych-interview/api/index.py
        # Cap context by env budgets: GEMINI_TOKEN_BUDGET (tokens) preferred, else CONTEXT_SIZE (chars), else 20k chars
        context = (text or "").strip()
        try:
            token_budget = int(os.environ.get("GEMINI_TOKEN_BUDGET") or "0")
        except Exception:
            token_budget = 0
        try:
            context_chars_env = int(os.environ.get("CONTEXT_SIZE") or "0")
        except Exception:
            context_chars_env = 0
        approx_chars_from_tokens = token_budget * 4 if token_budget > 0 else 0
        char_cap = approx_chars_from_tokens or context_chars_env or 20000
        if len(context) > char_cap:
            context = context[:char_cap]
```

Example `.env.local` settings:

```dotenv
# Prefer this: ~10k tokens ≈ 40k chars
GEMINI_TOKEN_BUDGET="10000"

# Or use a character budget directly (only used if GEMINI_TOKEN_BUDGET unset)
CONTEXT_SIZE="128000"
```

### 2) Per-page scrape depth (characters)
There are two places to control per-page truncation:

- Frontend UI constant (what we send to the backend):

```48:51:jotpsych-interview/app/components/SelectAndScrapePanel.tsx
  const MAX_DISCOVER = 20
  const MAX_SELECT = 5
  const SCRAPE_CHAR_LIMIT = 13000
```

- Backend default for per-endpoint (used if the UI doesn’t pass `limit_chars`):

```418:420:jotpsych-interview/api/index.py
    max_discover = int(payload.get("max_discover") or 20)
    max_select = int(payload.get("max_select") or 5)
    limit_chars = int(payload.get("limit_chars") or 13000)
```

```546:547:jotpsych-interview/api/index.py
    limit_chars = int(payload.get("limit_chars") or 13000)
```

When building context from URLs for parse-only calls, we also truncate per URL:

```585:593:jotpsych-interview/api/index.py
        for u in urls[:5]:
            res = fetch_markdown_jina(u)
            if res.get("ok") and res.get("text"):
                t = res.get("text", "")[:13000]
                parts.append(t)
                loc_snippet = _extract_location_snippet(t)
                if loc_snippet:
                    parts.append("\n\n" + loc_snippet)
        text = "\n\n".join(parts)
```

### 3) Selection sizes (how many URLs)
- Frontend labels and requests:

```48:51:jotpsych-interview/app/components/SelectAndScrapePanel.tsx
  const MAX_DISCOVER = 20
  const MAX_SELECT = 5
  const SCRAPE_CHAR_LIMIT = 13000
```

- Backend defaults:

```418:420:jotpsych-interview/api/index.py
    max_discover = int(payload.get("max_discover") or 20)
    max_select = int(payload.get("max_select") or 5)
    limit_chars = int(payload.get("limit_chars") or 13000)
```

```509:511:jotpsych-interview/api/index.py
    max_discover = int(payload.get("max_discover") or 100)
    max_select = int(payload.get("max_select") or 5)
```

### 4) Jina Reader rate limiting and retries
Jina returns HTTP 429 on rate limits. We honor `Retry-After` and retry with backoff:

```627:651:jotpsych-interview/api/index.py
def fetch_markdown_jina(url: str, timeout_seconds: int = 45, retries: int = 2, retry_delay_seconds: float = 1.0) -> Dict[str, Any]:
    ...
            # Handle rate limiting (HTTP 429): respect Retry-After if present
            if resp.status_code == 429:
                try:
                    retry_after = float(resp.headers.get("Retry-After", retry_delay_seconds))
                except Exception:
                    retry_after = retry_delay_seconds
                if attempt < retries:
                    time.sleep(max(retry_after, retry_delay_seconds))
                    attempt += 1
                    continue
```

Controls you can tweak:
- `retries`: increase to tolerate bursts (e.g., 3–4).
- `retry_delay_seconds`: increase to wait longer per retry (e.g., 2.0–3.0).
- `timeout_seconds`: increase for slow pages (e.g., 60).

### 5) Filtering out sitemap/robots/media (avoid polluting the LLM)
We exclude index-like and media URLs at selection, discovery, and scraping.

- Selection post-filter (also excludes media):

```172:178:jotpsych-interview/api/index.py
        exclude_substrings = [
            "/blog", "/news", "/media", "/video", "/events", "/post", "/posts", "/category", "/tag",
            "/cart", "/privacy", "/terms", "/login", "/wp-", "/feed", "/authors",
            "/sitemap", "/robots.txt",
        ]
        filtered = [u for u in selected if (not any(x in u.lower() for x in exclude_substrings)) and (not _is_media_url(u))]
```

- Pre-filter before selection in the one‑shot flow:

```431:438:jotpsych-interview/api/index.py
    def _not_index_like(u: str) -> bool:
        lu = (u or "").lower()
        return not ("sitemap" in lu or lu.endswith("/robots.txt") or lu.endswith("robots.txt"))
    filtered_targets = [u for u in all_targets if _not_index_like(u) and not _is_media_url(u)]
    selected = gemini_select_relevant_urls(filtered_targets, max_urls=max_select)
```

- Sitemap discovery skips media and empty sitemaps:

```733:746:jotpsych-interview/api/index.py
    res_primary = fetch_markdown_jina(primary)
    discovered: List[str] = []
    if res_primary.get("ok") and res_primary.get("text") and res_primary.get("text", "").strip():
        urls_in_text = _extract_urls_from_text(res_primary.get("text", ""))
        # Skip if sitemap.xml has no actual URLs (empty content issue)
        if not urls_in_text:
            app.logger.info(f"[sitemap] base={base} sitemap.xml exists but contains no URLs")
            return []
        for u in urls_in_text:
            if _same_domain(u, base) and u not in discovered and not _is_media_url(u):
                discovered.append(u)
                if max_urls and len(discovered) >= max_urls:
                    app.logger.info(f"[sitemap] base={base} found={len(discovered)} (sitemap.xml)")
                    return discovered[:max_urls]
```

- Media URL detector (extendable):

```82:100:jotpsych-interview/api/index.py
def _is_media_url(u: str) -> bool:
    if not u:
        return False
    lu = (u or "").lower()
    lu = re.sub(r'[?#].*$', '', lu)
    lu = re.sub(r'\)\]\([^)]*\)$', '', lu)
    lu = re.sub(r'\)$', '', lu)
    media_exts = [
        # Images
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp", ".tiff", ".tif",
        # Documents
        ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".rtf",
        # Media files
        ".mp4", ".mov", ".avi", ".wmv", ".flv", ".mp3", ".wav", ".ogg", ".m4a",
        # Archives
        ".zip", ".rar", ".tar", ".gz", ".7z",
        # Other file types irrelevant for content analysis
        ".css", ".js", ".xml", ".json", ".csv",
    ]
    return any(lu.endswith(ext) for ext in media_exts)
```

### 6) Location recall helpers (optional tuning)
You can bias the parse toward true office addresses by adjusting these parameters:

- Address snippet around likely addresses (captures footer mailing address):

```36:56:jotpsych-interview/api/index.py
def _extract_location_snippet(text: str, context_window: int = 400) -> str:
    ...
        start = max(0, m.start() - context_window // 2)
        end = min(len(text), m.end() + context_window // 2)
        return text[start:end]
```

- Frequency-sorted location candidates prepended to context:

```59:79:jotpsych-interview/api/index.py
def _extract_location_candidates(text: str, max_items: int = 8) -> List[str]:
    ...
    ordered = sorted(hits.items(), key=lambda kv: (-kv[1], kv[0]))
    return [k for k, _ in ordered[:max_items]]
```

Increase `context_window` or `max_items` if you need stronger location signals.

### 7) Quick recipes
- Faster runs: set `MAX_SELECT = 3–5`, keep `SCRAPE_CHAR_LIMIT` high (e.g., 13000) to capture footers, and set `GEMINI_TOKEN_BUDGET` to 8k–10k.
- Higher accuracy: raise `GEMINI_TOKEN_BUDGET` and per-page `SCRAPE_CHAR_LIMIT`, but keep selection small (≤5) to avoid noisy pages.
- Handle rate limits: increase `retries` and `retry_delay_seconds` in `fetch_markdown_jina`.


