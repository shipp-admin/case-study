"use client"

import { useState } from 'react'

type Result = {
  url: string
  ok: boolean
  status_code: number | null
  length: number
  reader_url: string
  text?: string
  path?: string | null
  elapsed_ms?: number
  error?: string
}

type DSLResponse = {
  base_url: string
  discovered_count: number
  selected_count: number
  discovered: string[]
  selected: string[]
  discovery_mode?: string
  limit_chars: number
  results: Result[]
}

export default function SelectAndScrapePanel({ sharedBaseUrl }: { sharedBaseUrl: string }) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DSLResponse | null>(null)

  async function handleRun(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setData(null)
    const baseUrl = sharedBaseUrl
    if (typeof window !== 'undefined') console.log('[dsl:start]', { baseUrl })
    try {
      const urlTrimmed = (baseUrl || '').trim()
      const resp = await fetch('/api/discover-select-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlTrimmed, max_discover: 20, max_select: 10, limit_chars: 500 }),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = await resp.text() } catch {}
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
      }
      const json = (await resp.json()) as DSLResponse
      setData(json)
      if (typeof window !== 'undefined') console.log('[dsl:done]', json)
    } catch (err: any) {
      setError(err?.message || 'Request failed')
      if (typeof window !== 'undefined') console.error('[dsl:error]', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
      <form onSubmit={handleRun} className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium">Sitemap → Gemini select (10) → Scrape (500 chars)</label>
          <span className="text-xs text-gray-600">Phase 2+</span>
        </div>
        <div className="text-xs text-gray-600">Base URL: <span className="text-black font-medium break-all">{sharedBaseUrl || '—'}</span></div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? 'Running…' : 'Run selection + scrape'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>

      {data && (
        <div className="mt-4 space-y-3">
          <div className="text-sm text-gray-700">Discovered: {data.discovered_count} · Selected: {data.selected_count} {data.discovery_mode ? `· Mode: ${data.discovery_mode}` : ''}</div>
          <div className="text-sm">Selected URLs:</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {data.selected.map((t, i) => (
              <a key={i} href={t} target="_blank" rel="noreferrer" className="text-sm text-purple-700 underline break-all">
                {t}
              </a>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.results.map((r, idx) => (
              <div key={idx} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${r.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{r.ok ? 'OK' : 'Error'}</span>
                  <a className="text-xs text-purple-700 hover:text-purple-800 underline" href={r.reader_url} target="_blank" rel="noreferrer">Open in Jina</a>
                </div>
                <div className="text-sm font-medium break-words mb-1">{r.url}</div>
                <div className="text-xs text-gray-600">Path: {r.path || '/'}</div>
                <div className="text-xs text-gray-600 mb-3">Status: {String(r.status_code)} · Length: {r.length} · {r.elapsed_ms} ms</div>
                {r.error && <div className="text-xs text-red-700 mb-2">{r.error}</div>}
                {r.text && (
                  <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-64 overflow-auto border border-gray-100 rounded-lg p-2 bg-gray-50">{r.text}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}


