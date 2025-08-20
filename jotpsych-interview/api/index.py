from flask import Flask, request, jsonify
import requests
import time
from typing import List, Dict, Any, Optional
from urllib.parse import urlparse, urljoin
import re
import os

# Load environment variables for local/dev runs
try:
    from dotenv import load_dotenv
    # Load default .env then Next.js-style .env.local if present
    load_dotenv()
    load_dotenv(".env.local")
except Exception:
    # If python-dotenv is not installed or any error occurs, skip silently
    pass

app = Flask(__name__)
def _get_env(name: str, default: str = "") -> str:
    import os
    return os.environ.get(name, default)


def gemini_select_relevant_urls(urls: List[str], max_urls: int = 10) -> List[str]:
    """Use Gemini to pick the most relevant clinic pages for extracting
    specialty, modalities, location, clinic_size.
    Returns up to max_urls URLs from the provided list.
    """
    api_key = _get_env("GEMINI_API_KEY")
    app.logger.info(f"[gemini] select start: urls={len(urls)}, N={max_urls}, key={'yes' if api_key else 'no'}")
    if not api_key:
        # Fallback heuristic: prioritize common words
        keywords = ["about", "team", "services", "providers", "locations", "contact", "psychological", "therapy"]
        ordered = sorted(urls, key=lambda u: (min((u.find(k) if k in u else 9999) for k in keywords)))
        return ordered[:max_urls]
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        model_name = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
        model = genai.GenerativeModel(
            model_name,
            generation_config={
                "response_mime_type": "application/json",
            },
        )
        examples_hint = [
            "/about", "/our-team", "/team", "/providers", "/services", "/specialties", "/therapy",
            "/psychological-evaluations", "/locations", "/contact", "/dbt-program", "/emdr-program",
        ]
        # Keep input window manageable to avoid model truncation: include full list but sliced to ~10k chars
        import json
        joined_urls = urls[:]
        # Build a compact list string; if it exceeds ~10k chars, trim but keep order
        serialized = json.dumps(joined_urls)
        if len(serialized) > 10000:
            trimmed: List[str] = []
            total_len = 2  # for []
            for u in joined_urls:
                candidate = json.dumps(u)
                if total_len + len(candidate) + (1 if trimmed else 0) > 10000:
                    break
                trimmed.append(u)
                total_len += len(candidate) + (1 if trimmed else 0)
            joined_urls = trimmed

        app.logger.info(f"[gemini] using model={model_name}")
        prompt = {
            "task": "select_relevant_urls",
            "instructions": [
                "From the provided URLs, select up to N URLs (most relevant first) that best help extract these fields: specialty, modalities, location, clinic_size.",
                "STRICTLY EXCLUDE: blog, news, media, video, events, posts, categories, tags, cart, privacy, terms, login.",
                "Prefer pages like About, Team/Providers, Services/Specialties, Therapy, Psychological Evaluations, Locations/Contact, Programs (DBT/EMDR).",
                "Return ONLY a JSON array of strings with URLs; no additional keys or commentary.",
            ],
            "N": max_urls,
            "preferred_url_endings": examples_hint,
            "urls": joined_urls,
        }
        # Retry on transient errors (e.g., rate limits)
        attempts = 0
        last_exc: Optional[Exception] = None
        t0 = time.time()
        while attempts < 3:
            try:
                resp = model.generate_content(prompt)
                break
            except Exception as exc:
                last_exc = exc
                attempts += 1
                app.logger.warning(f"[gemini] attempt {attempts} failed: {type(exc).__name__}: {exc}")
                time.sleep(0.75 * attempts)
        else:
            raise last_exc if last_exc else RuntimeError("Gemini selection failed after retries")
        app.logger.info(f"[gemini] select finished in {int((time.time()-t0)*1000)}ms")
        text = resp.text or ""
        selected: List[str] = []
        try:
            arr = json.loads(text)
            if isinstance(arr, list):
                selected = [str(x) for x in arr if isinstance(x, str)]
        except Exception:
            selected = _extract_urls_from_text(text)
        # Constrain to given list and preserve order
        constrained = [u for u in urls if u in selected]
        if constrained:
            selected = constrained
        else:
            selected = []
        # Post-filter: exclude obvious blogs/media/etc
        exclude_substrings = [
            "/blog", "/news", "/media", "/video", "/events", "/post", "/posts", "/category", "/tag",
            "/cart", "/privacy", "/terms", "/login", "/wp-", "/feed", "/authors",
        ]
        filtered = [u for u in selected if not any(x in u.lower() for x in exclude_substrings)]
        if filtered:
            return filtered[:max_urls]
        # If empty after filter, fall back to heuristic sort
        keywords = ["about", "team", "provider", "services", "special", "therapy", "psychological", "location", "contact", "dbt", "emdr", "apex", "raleigh", "durham"]
        ordered = sorted(urls, key=lambda u: (min((u.lower().find(k) if k in u.lower() else 9999) for k in keywords)))
        ordered = [u for u in ordered if not any(x in u.lower() for x in exclude_substrings)]
        return ordered[:max_urls]
    except Exception as e:
        app.logger.warning(f"[gemini] selection failed, using heuristic: {e}")
    # Heuristic fallback
    keywords = ["about", "team", "services", "providers", "locations", "contact", "psychological", "therapy"]
    ordered = sorted(urls, key=lambda u: (min((u.find(k) if k in u else 9999) for k in keywords)))
    return ordered[:max_urls]


def gemini_parse_clinic_info(text: str, model_name_env: str = "GEMINI_MODEL_PARSE") -> Dict[str, Any]:
    api_key = _get_env("GEMINI_API_KEY")
    # Base empty schema
    empty = {
        "clinic_info": {
            "specialty": "",
            "modalities": "",
            "location": "",
            "clinic_size": "",
        }
    }
    if not text or not text.strip():
        return {**empty, "model": None, "reason": "empty_text"}
    if not api_key:
        app.logger.info("[gemini:parse] missing_api_key; using heuristic fallback")
        return _fallback_parse_clinic_info(text)
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        model_name = os.environ.get(model_name_env, os.environ.get("GEMINI_MODEL", "gemini-1.5-flash"))
        model = genai.GenerativeModel(
            model_name,
            generation_config={
                "response_mime_type": "application/json",
            },
        )

        # Cap context to ~20k chars to avoid excessive latency
        context = (text or "").strip()
        if len(context) > 20000:
            context = context[:20000]

        prompt = {
            "task": "parse_clinic_info",
            "instructions": [
                "Extract STRICT JSON with exactly this schema. Use empty strings when unknown.",
                "Keys: clinic_info.specialty, clinic_info.modalities, clinic_info.location, clinic_info.clinic_size.",
                "Do not include any extra commentary or keys beyond clinic_info.",
            ],
            "schema": {
                "clinic_info": {
                    "specialty": "",
                    "modalities": "",
                    "location": "",
                    "clinic_size": "",
                }
            },
            "text": context,
        }

        attempts = 0
        last_exc: Optional[Exception] = None
        t0 = time.time()
        while attempts < 3:
            try:
                app.logger.info(f"[gemini:parse] using model={model_name} len={len(context)}")
                resp = model.generate_content(prompt)
                break
            except Exception as exc:
                last_exc = exc
                attempts += 1
                app.logger.warning(f"[gemini:parse] attempt {attempts} failed: {type(exc).__name__}: {exc}")
                time.sleep(0.75 * attempts)
        else:
            raise last_exc if last_exc else RuntimeError("Gemini parse failed after retries")
        elapsed_ms = int((time.time() - t0) * 1000)
        text_out = resp.text or ""
        import json
        try:
            data = json.loads(text_out)
            # Normalize to expected schema
            ci = data.get("clinic_info") if isinstance(data, dict) else None
            out = {
                "clinic_info": {
                    "specialty": (ci or {}).get("specialty", "") if isinstance(ci, dict) else "",
                    "modalities": (ci or {}).get("modalities", "") if isinstance(ci, dict) else "",
                    "location": (ci or {}).get("location", "") if isinstance(ci, dict) else "",
                    "clinic_size": (ci or {}).get("clinic_size", "") if isinstance(ci, dict) else "",
                },
                "model": model_name,
                "elapsed_ms": elapsed_ms,
            }
            # If Gemini returns empty values across the board, use heuristic fallback
            if not any(out["clinic_info"].values()):
                app.logger.info("[gemini:parse] empty fields; using heuristic fallback")
                fb = _fallback_parse_clinic_info(context)
                fb["model"] = model_name
                fb["elapsed_ms"] = elapsed_ms
                return fb
            return out
        except Exception:
            app.logger.warning("[gemini:parse] non-JSON response; returning empty schema")
            fb = _fallback_parse_clinic_info(context)
            fb["model"] = model_name
            fb["elapsed_ms"] = elapsed_ms
            fb["reason"] = "non_json"
            return fb
    except Exception as e:
        app.logger.warning(f"[gemini:parse] failed: {e}")
        return _fallback_parse_clinic_info(text)


def _fallback_parse_clinic_info(text: str) -> Dict[str, Any]:
    """Heuristic extractor used when Gemini is unavailable or returns unusable output."""
    lowered = (text or "").lower()

    # Modalities: choose from a known lexicon
    modalities_lex = [
        "cbt", "cognitive behavioral therapy", "dbt", "dialectical behavior therapy", "emdr",
        "act", "acceptance and commitment therapy", "mindfulness", "play therapy", "group therapy",
        "family therapy", "couples therapy", "psychological evaluation", "assessment", "testing",
        "trauma-focused", "exposure therapy", "peers", "medication management", "psychiatry",
    ]
    modalities_found: List[str] = []
    for m in modalities_lex:
        if m in lowered and m not in modalities_found:
            modalities_found.append(m)
    modalities_out = ", ".join(modalities_found[:8])

    # Specialty: surface common conditions/populations
    specialty_lex = [
        "anxiety", "depression", "adhd", "ocd", "bipolar", "ptsd", "trauma", "autism",
        "child", "adolescent", "teen", "adult", "family", "couples", "eating disorder",
        "substance", "addiction", "grief", "stress", "anger", "sleep", "women", "men",
    ]
    specialty_found: List[str] = []
    for s in specialty_lex:
        if s in lowered and s not in specialty_found:
            specialty_found.append(s)
    specialty_out = ", ".join(specialty_found[:8])

    # Location: naive city, ST detector (e.g., "Raleigh, NC")
    import re as _re
    loc_match = _re.search(r"([A-Z][a-zA-Z]+,\s*[A-Z]{2})(?![A-Za-z])", text or "")
    location_out = loc_match.group(1) if loc_match else ""

    # Clinic size: count provider-like terms
    provider_terms = ["therapist", "psychologist", "psychiatrist", "provider", "counselor", "clinician"]
    provider_count = sum(lowered.count(t) for t in provider_terms)
    if provider_count >= 12:
        size_out = "12+ clinicians"
    elif provider_count >= 8:
        size_out = "8–11 clinicians"
    elif provider_count >= 5:
        size_out = "5–7 clinicians"
    elif provider_count >= 2:
        size_out = "2–4 clinicians"
    else:
        size_out = ""

    out = {
        "clinic_info": {
            "specialty": specialty_out,
            "modalities": modalities_out,
            "location": location_out,
            "clinic_size": size_out,
        },
        "model": None,
        "reason": "heuristic_fallback",
    }
    app.logger.info("[parse:fallback] produced clinic_info via heuristics")
    return out


@app.post("/api/discover-select-scrape")
def discover_select_scrape() -> Any:
    payload = request.get_json(silent=True) or {}
    # Accept either single 'url'/'base_url' or 'urls' (comma-separated); use first non-empty
    base_url = (payload.get("url") or payload.get("base_url") or "").strip()
    if not base_url:
        urls_value = payload.get("urls") or ""
        urls_list = split_comma_separated_urls(urls_value)
        if urls_list:
            base_url = urls_list[0]
    if not base_url:
        return jsonify({"error": "base url required", "hint": "Provide 'url' or 'urls' in JSON body."}), 400
    max_discover = int(payload.get("max_discover") or 20)
    max_select = int(payload.get("max_select") or 10)
    limit_chars = int(payload.get("limit_chars") or 500)

    # 1) Discover
    sitemap_all = discover_from_sitemap(base_url, max_urls=None)
    if sitemap_all:
        discovery_mode = "sitemap.xml"
        all_targets = sitemap_all
    else:
        discovery_mode = "heuristic"
        all_targets = discover_candidate_paths(base_url, max_urls=max_discover)
    app.logger.info(f"[dsl] discover({discovery_mode}) -> {len(all_targets)} targets")

    # 2) Select with Gemini (or heuristic)
    selected = gemini_select_relevant_urls(all_targets, max_urls=max_select)
    app.logger.info(f"[dsl] selected -> {len(selected)} targets")

    # 3) Scrape selected
    results: List[Dict[str, Any]] = []
    for u in selected:
        start_time = time.time()
        res = fetch_markdown_jina(u)
        elapsed_ms = int((time.time() - start_time) * 1000)
        full_text = res.get("text", "")
        res["text"] = full_text[:limit_chars]
        res["snippet"] = res["text"]
        res["elapsed_ms"] = elapsed_ms
        try:
            res_parsed = urlparse(res.get("target", u))
            res["path"] = res_parsed.path or '/'
        except Exception:
            res["path"] = '/'
        results.append(res)

    # 4) Parse combined text with Gemini into structured JSON
    combined_text = "\n\n".join([r.get("text", "") for r in results if r.get("text")])
    parsed = gemini_parse_clinic_info(combined_text)

    return jsonify({
        "base_url": base_url,
        "discovery_mode": discovery_mode,
        "discovered_count": len(all_targets),
        "selected_count": len(selected),
        "discovered": all_targets,
        "selected": selected,
        "limit_chars": limit_chars,
        "results": results,
        "clinic_info": parsed.get("clinic_info"),
        "parse_elapsed_ms": parsed.get("elapsed_ms"),
        "parse_model": parsed.get("model"),
    })


@app.post("/api/discover-select")
def discover_and_select_only() -> Any:
    payload = request.get_json(silent=True) or {}
    base_url = (payload.get("url") or payload.get("base_url") or "").strip()
    if not base_url:
        urls_value = payload.get("urls") or ""
        urls_list = split_comma_separated_urls(urls_value)
        if urls_list:
            base_url = urls_list[0]
    if not base_url:
        return jsonify({"error": "base url required", "hint": "Provide 'url' or 'urls' in JSON body."}), 400
    max_discover = int(payload.get("max_discover") or 100)
    max_select = int(payload.get("max_select") or 10)

    # Discover
    sitemap_all = discover_from_sitemap(base_url, max_urls=None)
    if sitemap_all:
        discovery_mode = "sitemap.xml"
        all_targets = sitemap_all
    else:
        discovery_mode = "heuristic"
        all_targets = discover_candidate_paths(base_url, max_urls=max_discover)
    app.logger.info(f"[dsl] discover-only({discovery_mode}) -> {len(all_targets)} targets")

    # Select
    selected = gemini_select_relevant_urls(all_targets, max_urls=max_select)
    app.logger.info(f"[dsl] selected-only -> {len(selected)} targets")

    return jsonify({
        "base_url": base_url,
        "discovery_mode": discovery_mode,
        "discovered_count": len(all_targets),
        "selected_count": len(selected),
        "discovered": all_targets,
        "selected": selected,
    })


@app.post("/api/scrape-pages")
def scrape_specific_pages() -> Any:
    payload = request.get_json(silent=True) or {}
    urls_value = payload.get("urls") or payload.get("url") or []
    if isinstance(urls_value, list):
        urls = [str(u).strip() for u in urls_value if str(u).strip()]
    else:
        urls = split_comma_separated_urls(urls_value)
    if not urls:
        return jsonify({"error": "urls required", "hint": "Provide 'urls' as array or comma-separated."}), 400
    limit_chars = int(payload.get("limit_chars") or 500)

    results: List[Dict[str, Any]] = []
    for u in urls:
        start_time = time.time()
        app.logger.info(f"[fetch:pages] -> {u}")
        res = fetch_markdown_jina(u)
        elapsed_ms = int((time.time() - start_time) * 1000)
        full_text = res.get("text", "")
        res["text"] = full_text[:limit_chars]
        res["snippet"] = res["text"]
        res["elapsed_ms"] = elapsed_ms
        try:
            res_parsed = urlparse(res.get("target", u))
            res["path"] = res_parsed.path or '/'
        except Exception:
            res["path"] = '/'
        results.append(res)

    return jsonify({
        "input_count": len(urls),
        "results": results,
    })


@app.post("/api/parse")
def parse_endpoint() -> Any:
    payload = request.get_json(silent=True) or {}
    text = (payload.get("text") or "").strip()
    urls_value = payload.get("urls") or []
    urls: List[str]
    if isinstance(urls_value, list):
        urls = [str(u).strip() for u in urls_value if str(u).strip()]
    else:
        urls = split_comma_separated_urls(urls_value)
    # If text is empty but urls are provided, fetch a small subset to build context
    if not text and urls:
        app.logger.info(f"[parse] building context from urls={len(urls)}")
        parts: List[str] = []
        for u in urls[:5]:
            res = fetch_markdown_jina(u)
            if res.get("ok") and res.get("text"):
                parts.append(res.get("text", "")[:800])
        text = "\n\n".join(parts)
    parsed = gemini_parse_clinic_info(text)
    return jsonify(parsed)


@app.get("/api/health")
def health() -> Any:
    return jsonify({"status": "ok"})


@app.route("/api/python")
def hello_world():
    return "<p>Hello, World!</p>"


def normalize_url_for_jina(url: str) -> str:
    url = url.strip()
    if not url:
        return url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    # Default to https if scheme is missing
    return f"https://{url}"


def fetch_markdown_jina(url: str, timeout_seconds: int = 45, retries: int = 1, retry_delay_seconds: float = 1.0) -> Dict[str, Any]:
    target = normalize_url_for_jina(url)
    reader_url = f"https://r.jina.ai/{target}"
    attempt = 0
    last_error = None
    while attempt <= retries:
        try:
            resp = requests.get(
                reader_url,
                timeout=timeout_seconds,
                headers={
                    "User-Agent": "JotPsych-CaseStudy/1.0",
                    "Accept": "text/markdown, text/plain, */*",
                },
            )
            ok = resp.status_code == 200 and bool(resp.text.strip())
            text = resp.text if ok else ""
            return {
                "url": url,
                "target": target,
                "reader_url": reader_url,
                "ok": ok,
                "status_code": resp.status_code,
                "length": len(text),
                "text": text,
            }
        except requests.RequestException as exc:
            last_error = str(exc)
            if attempt < retries:
                time.sleep(retry_delay_seconds)
            attempt += 1
    return {
        "url": url,
        "target": target,
        "reader_url": reader_url,
        "ok": False,
        "status_code": None,
        "length": 0,
        "error": last_error or "Unknown error",
        "text": "",
    }


def split_comma_separated_urls(value: Any) -> List[str]:
    if isinstance(value, list):
        raw_urls = value
    elif isinstance(value, str):
        raw_urls = [part for part in value.split(",")]
    else:
        raw_urls = []
    cleaned = []
    for u in raw_urls:
        u = u.strip()
        if u:
            cleaned.append(u)
    # de-duplicate preserving order
    seen = set()
    ordered_unique = []
    for u in cleaned:
        if u not in seen:
            seen.add(u)
            ordered_unique.append(u)
    return ordered_unique


def _same_domain(url: str, base: str) -> bool:
    try:
        return urlparse(normalize_url_for_jina(url)).netloc == urlparse(normalize_url_for_jina(base)).netloc
    except Exception:
        return False


def _extract_urls_from_text(text: str) -> List[str]:
    urls: List[str] = []
    # Match <loc>http(s)://... </loc>
    for m in re.findall(r"<loc>\s*(https?://[^<\s]+)\s*</loc>", text, flags=re.IGNORECASE):
        urls.append(m.strip())
    # Match raw http(s) links as fallback
    for m in re.findall(r"https?://[^\s\"'<>]+", text):
        urls.append(m.strip())
    # de-duplicate while preserving order
    seen = set()
    ordered = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            ordered.append(u)
    return ordered


def discover_from_sitemap(base_url: str, max_urls: Optional[int] = 8) -> List[str]:
    base = normalize_url_for_jina(base_url)
    parsed = urlparse(base)
    if not parsed.scheme or not parsed.netloc:
        return []
    domain = f"{parsed.scheme}://{parsed.netloc}"
    # Prefer sitemap.xml first; short-circuit if present and usable
    primary = urljoin(domain + '/', 'sitemap.xml')
    res_primary = fetch_markdown_jina(primary)
    discovered: List[str] = []
    if res_primary.get("ok") and res_primary.get("text"):
        urls_in_text = _extract_urls_from_text(res_primary.get("text", ""))
        for u in urls_in_text:
            if _same_domain(u, base) and u not in discovered:
                discovered.append(u)
                if max_urls and len(discovered) >= max_urls:
                    app.logger.info(f"[sitemap] base={base} found={len(discovered)} (sitemap.xml)")
                    return discovered[:max_urls]

    # Next try sitemap_index.xml (may contain nested sitemaps)
    secondary = urljoin(domain + '/', 'sitemap_index.xml')
    res_index = fetch_markdown_jina(secondary)
    if res_index.get("ok") and res_index.get("text"):
        urls_in_text = _extract_urls_from_text(res_index.get("text", ""))
        for u in urls_in_text:
            if _same_domain(u, base) and u not in discovered:
                discovered.append(u)
                if max_urls and len(discovered) >= max_urls:
                    app.logger.info(f"[sitemap] base={base} found={len(discovered)} (sitemap_index.xml)")
                    return discovered[:max_urls]

    # Finally, check robots.txt for additional sitemap hints
    robots = fetch_markdown_jina(urljoin(domain + '/', 'robots.txt'))
    if robots.get("ok") and robots.get("text"):
        for line in robots["text"].splitlines():
            m = re.search(r"^\s*Sitemap:\s*(https?://[^\s]+)", line, flags=re.IGNORECASE)
            if not m:
                continue
            sm = m.group(1).strip()
            res = fetch_markdown_jina(sm)
            if not res.get("ok"):
                continue
            urls_in_text = _extract_urls_from_text(res.get("text", ""))
            for u in urls_in_text:
                if _same_domain(u, base) and u not in discovered:
                    discovered.append(u)
                    if max_urls and len(discovered) >= max_urls:
                        app.logger.info(f"[sitemap] base={base} found={len(discovered)} (robots sitemaps)")
                        return discovered[:max_urls]
    app.logger.info(f"[sitemap] base={base} found={len(discovered)} (cumulative)")
    return discovered if not max_urls else discovered[:max_urls]


def discover_candidate_paths_with_mode(base_url: str, max_urls: int = 8) -> Dict[str, Any]:
    base = normalize_url_for_jina(base_url)
    parsed = urlparse(base)
    if not parsed.scheme or not parsed.netloc:
        return {"candidates": [base], "discovery_mode": "invalid_base"}
    # Ensure base ends with slash for urljoin behavior
    normalized_base = base if base.endswith('/') else base + '/'
    # First try sitemap-derived URLs. Fetch full list so downstream selection can decide.
    sitemap_urls = discover_from_sitemap(base, max_urls=None)
    discovery_mode = "sitemap.xml" if sitemap_urls else "heuristic"
    # Core heuristic paths as fallback
    common_paths = ['', 'about', 'team', 'services']
    candidates: List[str] = []
    seen: set[str] = set()
    # Add sitemap URLs first
    for u in sitemap_urls:
        if u not in seen:
            seen.add(u)
            candidates.append(u)
            if len(candidates) >= max_urls:
                app.logger.info(f"[discover] base={base} -> {len(candidates)} candidates (sitemap)")
                return {"candidates": candidates, "discovery_mode": discovery_mode}
    # Fill remaining with heuristic paths
    for path in common_paths:
        if len(candidates) >= max_urls:
            break
        full_url = urljoin(normalized_base, path)
        if full_url not in seen:
            seen.add(full_url)
            candidates.append(full_url)
    app.logger.info(f"[discover] base={base} -> {len(candidates)} candidates ({discovery_mode}+heuristic)")
    return {"candidates": candidates[:max_urls], "discovery_mode": discovery_mode}


def discover_candidate_paths(base_url: str, max_urls: int = 8) -> List[str]:
    return discover_candidate_paths_with_mode(base_url, max_urls=max_urls)["candidates"]


@app.post("/api/scrape")
def scrape_with_jina() -> Any:
    payload = request.get_json(silent=True) or {}
    urls_value = payload.get("urls") or payload.get("url") or ""
    urls = split_comma_separated_urls(urls_value)
    limit_chars = int(payload.get("limit_chars") or 500)
    debug_requested = bool(payload.get("debug"))

    results: List[Dict[str, Any]] = []
    expanded_targets: List[Dict[str, str]] = []
    max_urls = int(payload.get("max_urls") or 8)
    for base in urls:
        for candidate in discover_candidate_paths(base, max_urls=max_urls):
            expanded_targets.append({"base_url": base, "url": candidate})

    # de-duplicate by url while preserving first base association
    unique_urls: Dict[str, str] = {}
    for item in expanded_targets:
        if item["url"] not in unique_urls:
            unique_urls[item["url"]] = item["base_url"]

    app.logger.info(f"[scrape] total unique targets: {len(unique_urls)}")

    for u, base_of_u in unique_urls.items():
        start_time = time.time()
        app.logger.info(f"[fetch] -> {u}")
        res = fetch_markdown_jina(u)
        elapsed_ms = int((time.time() - start_time) * 1000)
        # lightweight acceptance signal for debugging (on full text)
        full_text = res.get("text", "")
        text_lower = full_text.lower()
        contains_keywords = any(k in text_lower for k in ["about", "team", "services", "providers"])

        # Truncate for testing visibility per page
        truncated_text = full_text[:limit_chars]

        res["contains_keywords"] = contains_keywords
        res["snippet"] = truncated_text  # keep snippet equal to shown text
        res["text"] = truncated_text
        res["base_url"] = base_of_u
        res["elapsed_ms"] = elapsed_ms
        try:
            res_parsed = urlparse(res.get("target", u))
            res["path"] = res_parsed.path or '/'
        except Exception:
            res["path"] = '/'
        results.append(res)

    combined_text = "\n\n".join([r.get("text", "").strip() for r in results if r.get("ok") and r.get("text")])
    response = {
        "input_count": len(urls),
        "results": results,
        "targets_count": len(unique_urls),
        "combined_length": len(combined_text),
        "combined_text": combined_text,
    }
    if debug_requested:
        response["targets"] = list(unique_urls.keys())
        response["by_base"] = {
            base: [u for u in unique_urls.keys() if _same_domain(u, base)] for base in urls
        }
    return jsonify(response)


@app.post("/api/discover")
def discover_only() -> Any:
    payload = request.get_json(silent=True) or {}
    urls_value = payload.get("urls") or payload.get("url") or ""
    urls = split_comma_separated_urls(urls_value)
    max_urls = int(payload.get("max_urls") or 8)

    discoveries = []
    all_targets: List[str] = []
    for base in urls:
        d = discover_candidate_paths_with_mode(base, max_urls=max_urls)
        targets = d["candidates"]
        discoveries.append({"base_url": base, "targets": targets, "discovery_mode": d.get("discovery_mode")})
        for t in targets:
            if t not in all_targets:
                all_targets.append(t)
    return jsonify({
        "discoveries": discoveries,
        "targets_count": len(all_targets),
        "targets": all_targets,
    })