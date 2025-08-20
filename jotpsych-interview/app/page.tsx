"use client"

import { useState } from 'react'
import dynamic from 'next/dynamic'
const DiscoveryPanel = dynamic(() => import('./components/DiscoveryPanel'), { ssr: false })
const SelectAndScrapePanel = dynamic(() => import('./components/SelectAndScrapePanel'), { ssr: false })

type ScrapeResult = {
  url: string
  target: string
  reader_url: string
  ok: boolean
  status_code: number | null
  length: number
  contains_keywords?: boolean
  snippet?: string
  text?: string
  error?: string
  base_url?: string
  path?: string | null
}

type ApiResponse = {
  input_count: number
  results: ScrapeResult[]
  combined_length: number
  combined_text: string
}

export default function Home() {
  const [urlsInput, setUrlsInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [plannedTargets, setPlannedTargets] = useState<number | null>(null)

  async function handleScrape(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setData(null)
    // Estimate planned targets on client based on heuristics (roughly number of base URLs * common paths)
    const roughPaths = 8
    const baseCount = urlsInput.split(',').map(s => s.trim()).filter(Boolean).length || 1
    setPlannedTargets(baseCount * roughPaths)
    if (typeof window !== 'undefined') {
      console.log('[scrape:start]', { baseCount, roughPaths, planned: baseCount * roughPaths, urlsInput })
    }
    try {
      const resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: urlsInput, limit_chars: 500, debug: true }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = (await resp.json()) as ApiResponse
      setData(json)
      if (typeof window !== 'undefined') {
        console.log('[scrape:done]', { targetsCount: (json as any).targets_count, results: json.results?.length })
      }
    } catch (err: any) {
      setError(err?.message || 'Request failed')
      if (typeof window !== 'undefined') {
        console.error('[scrape:error]', err)
      }
    } finally {
      setIsLoading(false)
      setPlannedTargets(null)
    }
  }

  return (
    <main className="min-h-screen bg-white text-black">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight">Clinic Scraper Dashboard</h1>
          <p className="text-sm text-gray-600 mt-1">Phase 2 · Jina Reader quick validation</p>
        </header>

        <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
          <label className="block text-sm font-medium mb-2">Clinic Base URL</label>
          <input
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-600 focus:border-purple-600"
            placeholder="https://exampleclinic.com"
            value={urlsInput}
            onChange={(e) => setUrlsInput(e.target.value)}
          />
          <p className="text-xs text-gray-600 mt-2">Discovery uses sitemap.xml when available; otherwise falls back to heuristic pages.</p>
        </section>

        <DiscoveryPanel sharedBaseUrl={urlsInput} />
        <SelectAndScrapePanel sharedBaseUrl={urlsInput} />

        

        <div className="grid grid-cols-1 gap-6">
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Pages</h2>
              {data && (
                <span className="text-xs text-gray-600">{data.input_count} URL{data.input_count === 1 ? '' : 's'}</span>
              )}
            </div>

            {!data && (
              <div className="bg-white border border-dashed border-gray-300 rounded-xl p-6 text-sm text-gray-600">No results yet. Enter URLs above and click Scrape.</div>
            )}

            {data && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.results.map((r, idx) => {
                  const statusColor = r.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  if (typeof window !== 'undefined') {
                    console.log('[scrape:card]', { url: r.url, status: r.status_code, ok: r.ok, ms: r.elapsed_ms, len: r.length })
                  }
                  return (
                    <div key={idx} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${statusColor}`}>{r.ok ? 'OK' : 'Error'}</span>
                        <a className="text-xs text-purple-700 hover:text-purple-800 underline" href={r.reader_url} target="_blank" rel="noreferrer">Open in Jina</a>
                      </div>
                      <div className="text-sm font-medium break-words mb-1">{r.url}</div>
                      <div className="text-xs text-gray-600">Base: {r.base_url || '—'}</div>
                      <div className="text-xs text-gray-600">Path: {r.path || '/'}</div>
                      <div className="text-xs text-gray-600 mb-3">Status: {String(r.status_code)} · Length: {r.length} · Keywords: {String(r.contains_keywords)}</div>
                      {r.error && (
                        <div className="text-xs text-red-700 mb-2">{r.error}</div>
                      )}
                      {r.text && (
                        <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-64 overflow-auto border border-gray-100 rounded-lg p-2 bg-gray-50">{r.text}</pre>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
