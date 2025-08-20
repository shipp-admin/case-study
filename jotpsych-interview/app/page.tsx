"use client"

import { useRef, useState } from 'react'
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
  const [parsedList, setParsedList] = useState<any[]>([])
  const selectPanelRef = useRef<any>(null)

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

        <DiscoveryPanel
          sharedBaseUrl={urlsInput}
          onRunAllRequest={(baseUrl: string) => {
            if (selectPanelRef.current?.runAll) {
              selectPanelRef.current.runAll(baseUrl)
            }
          }}
        />
        <SelectAndScrapePanel
          ref={selectPanelRef}
          sharedBaseUrl={urlsInput}
          autoRunOnMount={true}
          onParsed={({ baseUrl, clinic_info, model, elapsed_ms }) => {
            setParsedList(prev => [...prev, { baseUrl, clinic_info, model, elapsed_ms, ts: Date.now() }])
          }}
        />

        

        <div className="grid grid-cols-1 gap-6">
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Parsed Runs</h2>
              {parsedList.length > 0 && (
                <span className="text-xs text-gray-600">{parsedList.length} run{parsedList.length === 1 ? '' : 's'}</span>
              )}
            </div>

            {parsedList.length === 0 && (
              <div className="bg-white border border-dashed border-gray-300 rounded-xl p-6 text-sm text-gray-600">No parsed runs yet. Enter a URL, or it will auto-run on load if present.</div>
            )}

            {parsedList.length > 0 && (
              <div className="grid grid-cols-1 gap-3">
                {parsedList.map((p, idx) => (
                  <div key={idx} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium break-all">{p.baseUrl || '—'}</div>
                      <div className="text-xs text-gray-600">{p.model || '—'} · {typeof p.elapsed_ms === 'number' ? `${p.elapsed_ms} ms` : '—'}</div>
                    </div>
                    <pre className="text-xs whitespace-pre-wrap leading-relaxed border border-gray-100 rounded-lg p-2 bg-gray-50">{JSON.stringify(p.clinic_info, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
