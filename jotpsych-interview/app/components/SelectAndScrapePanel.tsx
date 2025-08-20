"use client"

import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'

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
  clinic_info?: {
    specialty: string
    modalities: string
    location: string
    clinic_size: string
  }
  parse_elapsed_ms?: number
  parse_model?: string | null
}

type Props = {
  sharedBaseUrl: string
  autoRunOnMount?: boolean
  onParsed?: (args: { baseUrl: string, clinic_info: { specialty: string, modalities: string, location: string, clinic_size: string }, model?: string | null, elapsed_ms?: number }) => void
}

export type SelectAndScrapePanelHandle = {
  runAll: (baseUrl?: string) => Promise<void>
}

function SelectAndScrapePanelInner({ sharedBaseUrl, autoRunOnMount, onParsed }: Props, ref: React.Ref<SelectAndScrapePanelHandle>) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DSLResponse | null>(null)
  const [selectedOnly, setSelectedOnly] = useState<string[] | null>(null)
  const [step, setStep] = useState<'idle' | 'selecting' | 'scraping' | 'parsing'>('idle')
  const [showPages, setShowPages] = useState<boolean>(true)

  async function handleRun(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setData(null)
    setSelectedOnly(null)
    setStep('selecting')
    const baseUrl = sharedBaseUrl
    if (typeof window !== 'undefined') console.log('[dsl:start]', { baseUrl })
    try {
      const urlTrimmed = (baseUrl || '').trim()
      const resp = await fetch('/api/discover-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlTrimmed, max_discover: 100, max_select: 10 }),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = await resp.text() } catch {}
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
      }
      const json = (await resp.json()) as DSLResponse
      setSelectedOnly(json.selected || [])
      setData({ ...json, results: [], limit_chars: 500 })
      if (typeof window !== 'undefined') console.log('[dsl:selected]', json)
    } catch (err: any) {
      setError(err?.message || 'Request failed')
      if (typeof window !== 'undefined') console.error('[dsl:error]', err)
    } finally {
      setIsLoading(false)
      setStep('idle')
    }
  }

  async function scrapeAndParse(urls: string[], baseData: DSLResponse | null, effectiveBaseUrl?: string) {
    if (!urls || urls.length === 0) return
    setIsLoading(true)
    setError(null)
    setStep('scraping')
    try {
      const resp = await fetch('/api/scrape-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, limit_chars: 500 }),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = await resp.text() } catch {}
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
      }
      const json = await resp.json()
      const results = json.results || []
      let merged: DSLResponse | null = baseData ? { ...baseData, results } : null
      setData(merged)
      if (typeof window !== 'undefined') console.log('[dsl:scraped]', merged)

      // Phase 3: parse combined text into structured clinic_info
      const combinedText = (results as Result[])
        .map(r => (r.text || '').trim())
        .filter(Boolean)
        .join('\n\n')
      if (combinedText.length > 0 || (urls && urls.length > 0)) {
        setStep('parsing')
        const parseResp = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: combinedText, urls }),
        })
        if (parseResp.ok) {
          const parsed = await parseResp.json()
          merged = merged ? { ...merged, clinic_info: parsed?.clinic_info, parse_elapsed_ms: parsed?.elapsed_ms, parse_model: parsed?.model } : merged
          setData(merged)
          if (typeof window !== 'undefined') console.log('[dsl:parsed]', parsed)
          if (onParsed && merged && merged.clinic_info) {
            onParsed({ baseUrl: effectiveBaseUrl || baseData?.base_url || '', clinic_info: merged.clinic_info, model: merged.parse_model, elapsed_ms: merged.parse_elapsed_ms })
          }
        }
      }
    } finally {
      setIsLoading(false)
      setStep('idle')
    }
  }

  async function handleScrapeSelected(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedOnly || selectedOnly.length === 0) return
    try { await scrapeAndParse(selectedOnly, data, sharedBaseUrl) } catch (err: any) { setError(err?.message || 'Request failed') }
  }

  async function runAllCore(overrideBaseUrl?: string) {
    setIsLoading(true)
    setError(null)
    setData(null)
    setSelectedOnly(null)
    setStep('selecting')
    try {
      const baseUrl = overrideBaseUrl ?? sharedBaseUrl
      const urlTrimmed = (baseUrl || '').trim()
      const resp = await fetch('/api/discover-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlTrimmed, max_discover: 100, max_select: 10 }),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = await resp.text() } catch {}
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
      }
      const json = (await resp.json()) as DSLResponse
      setSelectedOnly(json.selected || [])
      const baseData: DSLResponse = { ...json, results: [], limit_chars: 500 }
      setData(baseData)
      if (typeof window !== 'undefined') console.log('[dsl:selected]', json)

      // proceed to scrape and parse
      await scrapeAndParse(json.selected || [], baseData, baseUrl)
    } catch (err: any) {
      setError(err?.message || 'Request failed')
      if (typeof window !== 'undefined') console.error('[dsl:error]', err)
    } finally {
      setIsLoading(false)
      setStep('idle')
    }
  }

  async function handleRunAll(e: React.FormEvent) {
    e.preventDefault()
    await runAllCore()
  }

  useImperativeHandle(ref, () => ({
    runAll: async (baseUrl?: string) => {
      await runAllCore(baseUrl)
    },
  }))

  useEffect(() => {
    if (autoRunOnMount && (sharedBaseUrl || '').trim()) {
      runAllCore(sharedBaseUrl).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
      <form onSubmit={handleRun} className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium">Sitemap → Gemini select (10) → Scrape (500 chars)</label>
          <span className="text-xs text-gray-600">Split flow</span>
        </div>
        <div className="text-xs text-gray-600">Base URL: <span className="text-black font-medium break-all">{sharedBaseUrl || '—'}</span></div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {step === 'selecting' ? 'Selecting…' : 'Select URLs'}
          </button>
          <button
            type="button"
            onClick={handleScrapeSelected}
            className="inline-flex items-center justify-center bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading || !selectedOnly || selectedOnly.length === 0}
          >
            {step === 'scraping' ? 'Scraping…' : step === 'parsing' ? 'Parsing…' : 'Scrape selected'}
          </button>
          <button
            type="button"
            onClick={handleRunAll}
            className="inline-flex items-center justify-center bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {step !== 'idle' ? 'Running…' : 'Run all'}
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

          {/* Pages grid removed per request; focusing on parsed JSON output below */}

          {data.clinic_info && (
            <div className="mt-4 bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Parsed Clinic Info</div>
                <div className="text-xs text-gray-600">{data.parse_model || '—'} · {typeof data.parse_elapsed_ms === 'number' ? `${data.parse_elapsed_ms} ms` : '—'}</div>
              </div>
              <pre className="text-xs whitespace-pre-wrap leading-relaxed border border-gray-100 rounded-lg p-2 bg-gray-50">{JSON.stringify(data.clinic_info, null, 2)}</pre>
            </div>
          )}
          {!data.clinic_info && (
            <div className="mt-4 text-xs text-gray-600">Run “Scrape selected” to produce parsed JSON here.</div>
          )}

          {data.results && data.results.length > 0 && (
            <div className="mt-4 bg-white border border-gray-200 rounded-xl shadow-sm">
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <div className="text-sm font-medium">Scraped Pages ({data.results.length})</div>
                <button
                  type="button"
                  onClick={() => setShowPages(v => !v)}
                  className="text-xs text-purple-700 underline"
                >
                  {showPages ? 'Hide' : 'Show'}
                </button>
              </div>
              {showPages && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 pt-0">
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
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const SelectAndScrapePanel = forwardRef<SelectAndScrapePanelHandle, Props>(SelectAndScrapePanelInner)

export default SelectAndScrapePanel


