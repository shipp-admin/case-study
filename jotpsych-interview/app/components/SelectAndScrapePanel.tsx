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

type ClinicData = {
  base_url: string
  discovered_count: number
  selected_count: number
  discovered: string[]
  selected: string[]
  discovery_mode?: string
  limit_chars: number
  results: Result[]
  clinic_info?: {
    clinic_name?: string
    specialty: string
    modalities: string
    location: string
    clinic_size: string
  }
  parse_elapsed_ms?: number
  parse_model?: string | null
}

type DSLResponse = {
  // Multi-clinic structure
  total_clinics?: number
  processed_urls?: string[]
  clinics?: Record<string, ClinicData>
  summary?: {
    total_discovered: number
    total_selected: number
  }
} | ClinicData // Single clinic backwards compatibility

type Props = {
  sharedBaseUrl: string
  autoRunOnMount?: boolean
  onParsed?: (args: { baseUrl: string, clinic_info: { specialty: string, modalities: string, location: string, clinic_size: string }, model?: string | null, elapsed_ms?: number }) => void
}

export type SelectAndScrapePanelHandle = {
  runAll: (baseUrl?: string) => Promise<void>
}

function SelectAndScrapePanelInner({ sharedBaseUrl, autoRunOnMount, onParsed }: Props, ref: React.Ref<SelectAndScrapePanelHandle>) {
  const MAX_DISCOVER = 20
  const MAX_SELECT = 5
  const SCRAPE_CHAR_LIMIT = 13000
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DSLResponse | null>(null)
  const [selectedOnly, setSelectedOnly] = useState<string[] | null>(null)
  const [step, setStep] = useState<'idle' | 'selecting' | 'scraping' | 'parsing'>('idle')
  const [showPages, setShowPages] = useState<boolean>(true)
  const [copied, setCopied] = useState<boolean>(false)
  const [activeClinicTab, setActiveClinicTab] = useState<string | null>(null)

  // Helper functions to handle both single and multi-clinic data
  const isMultiClinic = (data: DSLResponse): data is { clinics: Record<string, ClinicData>, processed_urls: string[] } => {
    return !!(data as any)?.clinics && !!(data as any)?.processed_urls
  }

  const getClinicUrls = (data: DSLResponse): string[] => {
    if (isMultiClinic(data)) {
      return data.processed_urls || []
    }
    return [(data as ClinicData).base_url].filter(Boolean)
  }

  const getClinicData = (data: DSLResponse, url: string): ClinicData | null => {
    if (isMultiClinic(data)) {
      return data.clinics?.[url] || null
    }
    return (data as ClinicData).base_url === url ? (data as ClinicData) : null
  }

  const getAllClinicsData = (data: DSLResponse): ClinicData[] => {
    if (isMultiClinic(data)) {
      return Object.values(data.clinics || {})
    }
    return [data as ClinicData]
  }

  async function handleRun(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setData(null)
    setSelectedOnly(null)
    setActiveClinicTab(null)
    setStep('selecting')
    
    let allClinicsData: Record<string, ClinicData> = {}
    let allSelectedUrls: string[] = []
    
    try {
      const input = sharedBaseUrl || ''
      const urls = input.split(',').map(s => s.trim()).filter(Boolean)
      if (urls.length === 0) return
      
      if (typeof window !== 'undefined') console.log('[dsl:start]', { urls })
      
      // Process each URL for discovery and selection
      for (const baseUrl of urls) {
        const urlTrimmed = (baseUrl || '').trim()
        if (!urlTrimmed) continue
        
        const resp = await fetch('/api/discover-select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlTrimmed, max_discover: MAX_DISCOVER, max_select: MAX_SELECT }),
        })
        if (!resp.ok) {
          let detail = ''
          try { detail = await resp.text() } catch {}
          throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
        }
        const json = await resp.json()
        
        // Handle both old single-clinic format and new multi-clinic format
        if (json.clinics) {
          // New multi-clinic format
          Object.assign(allClinicsData, json.clinics)
          Object.values(json.clinics).forEach((clinic: any) => {
            allSelectedUrls.push(...(clinic.selected || []))
          })
        } else {
          // Old single-clinic format - convert to multi-clinic structure
          const clinicData = { ...json, results: [], limit_chars: SCRAPE_CHAR_LIMIT }
          allClinicsData[baseUrl] = clinicData as ClinicData
          allSelectedUrls.push(...(json.selected || []))
        }
        
        if (typeof window !== 'undefined') console.log('[dsl:selected]', { baseUrl, json })
      }
      
      // Build final multi-clinic response
      const finalResponse: DSLResponse = {
        total_clinics: urls.length,
        processed_urls: urls,
        clinics: allClinicsData,
        summary: {
          total_discovered: Object.values(allClinicsData).reduce((sum, clinic) => sum + clinic.discovered_count, 0),
          total_selected: Object.values(allClinicsData).reduce((sum, clinic) => sum + clinic.selected_count, 0),
        }
      }
      
      setSelectedOnly(allSelectedUrls)
      setData(finalResponse)
      
      // Set active tab to first clinic
      if (urls.length > 0) {
        setActiveClinicTab(urls[0])
      }
      
      if (typeof window !== 'undefined') console.log('[dsl:complete]', finalResponse)
      
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
        body: JSON.stringify({ urls, limit_chars: SCRAPE_CHAR_LIMIT }),
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
    setActiveClinicTab(null)
    setStep('selecting')
    
    let allClinicsData: Record<string, ClinicData> = {}
    
    try {
      const input = (overrideBaseUrl ?? sharedBaseUrl) || ''
      const urls = input.split(',').map(s => s.trim()).filter(Boolean)
      if (urls.length === 0) return
      
      if (typeof window !== 'undefined') console.log('[dsl:start]', { urls })
      
      // Process each URL sequentially (original working approach)
      for (const baseUrl of urls) {
        const urlTrimmed = (baseUrl || '').trim()
        if (!urlTrimmed) continue
        
        setStep('selecting')
        const resp = await fetch('/api/discover-select-scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: urlTrimmed, 
            max_discover: MAX_DISCOVER, 
            max_select: MAX_SELECT,
            limit_chars: SCRAPE_CHAR_LIMIT
          }),
        })
        if (!resp.ok) {
          let detail = ''
          try { detail = await resp.text() } catch {}
          throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
        }
        const json = await resp.json()
        
        // Handle both old single-clinic format and new multi-clinic format
        if (json.clinics) {
          // New multi-clinic format
          Object.assign(allClinicsData, json.clinics)
        } else {
          // Old single-clinic format - convert to multi-clinic structure
          allClinicsData[baseUrl] = json as ClinicData
        }
        
        if (typeof window !== 'undefined') console.log('[dsl:processed]', { baseUrl, json })
        
        // Call onParsed for this clinic if available
        const clinicData = json.clinics ? json.clinics[baseUrl] : json
        if (onParsed && clinicData?.clinic_info) {
          onParsed({ 
            baseUrl: baseUrl, 
            clinic_info: clinicData.clinic_info, 
            model: clinicData.parse_model, 
            elapsed_ms: clinicData.parse_elapsed_ms 
          })
        }
      }
      
      // Build final multi-clinic response
      const finalResponse: DSLResponse = {
        total_clinics: urls.length,
        processed_urls: urls,
        clinics: allClinicsData,
        summary: {
          total_discovered: Object.values(allClinicsData).reduce((sum, clinic) => sum + clinic.discovered_count, 0),
          total_selected: Object.values(allClinicsData).reduce((sum, clinic) => sum + clinic.selected_count, 0),
        }
      }
      
      setData(finalResponse)
      
      // Set active tab to first clinic
      if (urls.length > 0) {
        setActiveClinicTab(urls[0])
      }
      
      if (typeof window !== 'undefined') console.log('[dsl:complete]', finalResponse)
      
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
  }, [autoRunOnMount])

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
      <form onSubmit={handleRun} className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium">Step 2–3: Select and scrape</label>
          <span className="text-xs text-gray-600">Discover ≤ {MAX_DISCOVER} · Select ≤ {MAX_SELECT} · {SCRAPE_CHAR_LIMIT} chars/page</span>
        </div>
        <div className="text-xs text-gray-600">Base URL: <span className="text-black font-medium break-all">{sharedBaseUrl || '—'}</span></div>
        <div className="text-[11px] text-gray-600">Selection uses the model to choose up to {MAX_SELECT} URLs from the discovered list. Scraping fetches up to {SCRAPE_CHAR_LIMIT.toLocaleString()} characters per page to control token usage.</div>
        <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded-md p-2">What happens: we ask the model to pick the most informative pages (About, Services, Providers, Locations/Contact). Then we scrape those pages and parse them into JSON.</div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading || !(sharedBaseUrl || '').trim()}
          >
            {step === 'selecting' ? `Selecting (≤ ${MAX_SELECT})…` : `Select URLs (≤ ${MAX_SELECT})`}
          </button>
          <button
            type="button"
            onClick={handleScrapeSelected}
            className="inline-flex items-center justify-center bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading || !selectedOnly || selectedOnly.length === 0}
          >
            {step === 'scraping' ? `Scraping (≤ ${SCRAPE_CHAR_LIMIT} chars/page)…` : step === 'parsing' ? 'Parsing…' : `Scrape selected (≤ ${SCRAPE_CHAR_LIMIT} chars/page)`}
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
          {/* Multi-clinic tabs */}
          {(() => {
            const clinicUrls = getClinicUrls(data)
            if (clinicUrls.length > 1) {
              return (
                <div className="border-b border-gray-200">
                  <nav className="-mb-px flex space-x-8">
                    {clinicUrls.map((url) => {
                      const isActive = activeClinicTab === url
                      const clinicData = getClinicData(data, url)
                      const displayName = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
                      return (
                        <button
                          key={url}
                          onClick={() => setActiveClinicTab(url)}
                          className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                            isActive
                              ? 'border-purple-500 text-purple-600'
                              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          {displayName}
                          {clinicData && (
                            <span className="ml-2 text-xs text-gray-400">
                              ({clinicData.selected_count}/{MAX_SELECT})
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </nav>
                </div>
              )
            }
            return null
          })()}
          
          {/* Current clinic data */}
          {(() => {
            const clinicUrls = getClinicUrls(data)
            const currentUrl = activeClinicTab || clinicUrls[0]
            const currentClinic = currentUrl ? getClinicData(data, currentUrl) : getAllClinicsData(data)[0]
            
            if (!currentClinic) return null
            
            return (
              <>
                <div className="text-sm text-gray-700">
                  {clinicUrls.length > 1 && (
                    <span className="font-medium text-purple-700">{currentUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '')}: </span>
                  )}
                  Discovered: {currentClinic.discovered_count} {currentClinic.discovered_count > MAX_DISCOVER ? `(showing first ${MAX_DISCOVER})` : ''} · Selected: {currentClinic.selected_count}/{MAX_SELECT} {currentClinic.discovery_mode ? `· Mode: ${currentClinic.discovery_mode}` : ''}
                </div>
                {currentClinic.results && currentClinic.results.length > 0 && (
                  (() => {
                    const totalChars = (currentClinic.results || []).reduce((acc, r) => acc + (r.text ? r.text.length : 0), 0)
                    const approxTokens = Math.ceil(totalChars / 4)
                    return (
                      <div className="text-[11px] text-gray-600">Displayed text total: {totalChars.toLocaleString()} chars (≈ {approxTokens.toLocaleString()} tokens). Parsing uses this displayed text.</div>
                    )
                  })()
                )}
                <div className="text-sm">Selected URLs:</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {currentClinic.selected.map((t, i) => (
                    <a key={i} href={t} target="_blank" rel="noreferrer" className="text-sm text-purple-700 underline break-all">
                      {t}
                    </a>
                  ))}
                </div>

                {/* Parsed clinic info for current clinic */}
                {currentClinic.clinic_info && (
                  <div className="mt-4 bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">
                        Parsed Clinic Info
                        {clinicUrls.length > 1 && (
                          <span className="ml-2 text-xs text-purple-700 font-normal">
                            ({currentUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '')})
                          </span>
                        )}
                      </div>
                      {(() => {
                        const totalChars = (currentClinic.results || []).reduce((acc, r) => acc + (r.text ? r.text.length : 0), 0)
                        const approxTokens = Math.ceil(totalChars / 4)
                        return (
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                try {
                                  const json = JSON.stringify(currentClinic.clinic_info || {}, null, 2)
                                  navigator.clipboard.writeText(json).then(() => {
                                    setCopied(true)
                                    setTimeout(() => setCopied(false), 1200)
                                  }).catch(() => {})
                                } catch {}
                              }}
                              className="text-xs bg-gray-800 hover:bg-gray-900 text-white px-2 py-1 rounded"
                            >
                              {copied ? 'Copied' : 'Copy JSON'}
                            </button>
                            <div className="text-xs text-gray-600">{currentClinic.parse_model || '—'} · {typeof currentClinic.parse_elapsed_ms === 'number' ? `${currentClinic.parse_elapsed_ms} ms` : '—'} · input ≈ {approxTokens.toLocaleString()} tokens</div>
                          </div>
                        )
                      })()}
                    </div>
                    <div className="text-xs grid grid-cols-1 md:grid-cols-2 gap-2">
                      {(['clinic_name', 'specialty', 'modalities', 'location', 'clinic_size'] as const).map((field) => {
                        const value = (currentClinic.clinic_info as any)[field]
                        const isError = typeof value === 'string' && value.trim().toLowerCase() === 'error'
                        return (
                          <div key={field} className={`border rounded-lg p-2 ${isError ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-100 bg-gray-50 text-gray-900'}`}>
                            <div className="text-[11px] uppercase tracking-wide text-gray-600 mb-1">{field.replace('_', ' ')}</div>
                            <div className="whitespace-pre-wrap leading-relaxed">{value || '—'}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {!currentClinic.clinic_info && (
                  <div className="mt-4 text-xs text-gray-600">Clinic data will appear here after processing.</div>
                )}

                {/* Scraped pages for current clinic */}
                {currentClinic.results && currentClinic.results.length > 0 && (
                  <div className="mt-4 bg-white border border-gray-200 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-4 pt-3 pb-1">
                      <div className="text-sm font-medium">
                        Scraped Pages ({currentClinic.results.length})
                        {clinicUrls.length > 1 && (
                          <span className="ml-2 text-xs text-purple-700 font-normal">
                            ({currentUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '')})
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowPages(v => !v)}
                        className="text-xs text-purple-700 underline"
                      >
                        {showPages ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <div className="px-4 pb-2 text-[11px] text-gray-600">Note: badges here reflect page fetch status (e.g., HTTP 429). The red "Error" markers appear only in Parsed Clinic Info when a field could not be found.</div>
                    {showPages && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 pt-0">
                        {currentClinic.results.map((r, idx) => (
                          <div key={idx} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                            <div className="flex items-center justify-between mb-2">
                              {(() => {
                                const label = r.ok ? 'OK' : (typeof r.status_code === 'number' ? `HTTP ${r.status_code}` : 'Fetch error')
                                const cls = r.ok ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
                                return <span className={`text-xs font-medium px-2 py-1 rounded-full ${cls}`}>{label}</span>
                              })()}
                              <a className="text-xs text-purple-700 hover:text-purple-800 underline" href={r.reader_url} target="_blank" rel="noreferrer">Open in Jina</a>
                            </div>
                            <div className="text-sm font-medium break-words mb-1">{r.url}</div>
                            <div className="text-xs text-gray-600">Path: {r.path || '/'}</div>
                            <div className="text-xs text-gray-600 mb-1">Status: {String(r.status_code)} · Length: {r.length} chars · {r.elapsed_ms} ms</div>
                            <div className="text-[11px] text-gray-600 mb-3">Shown text is truncated to {SCRAPE_CHAR_LIMIT} chars/page.</div>
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
              </>
            )
          })()}
        </div>
      )}
    </section>
  )
}

const SelectAndScrapePanel = forwardRef<SelectAndScrapePanelHandle, Props>(SelectAndScrapePanelInner)

export default SelectAndScrapePanel


