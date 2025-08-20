"use client"

import { useState } from 'react'

type Discovery = {
  base_url: string
  targets: string[]
}

type DiscoverResponse = {
  discoveries: Discovery[]
  targets_count: number
  targets: string[]
  discovery_mode?: string
}

export default function DiscoveryPanel({ sharedBaseUrl, onDiscovered }: { sharedBaseUrl: string, onDiscovered?: (targets: string[]) => void }) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DiscoverResponse | null>(null)

  async function handleDiscover(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setData(null)
    const urlsInput = sharedBaseUrl
    if (typeof window !== 'undefined') console.log('[discover:start]', { urlsInput })
    try {
      const resp = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: urlsInput, max_urls: 8 }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = (await resp.json()) as DiscoverResponse
      setData(json)
      if (typeof window !== 'undefined') console.log('[discover:done]', json)
      onDiscovered && onDiscovered(json.targets || [])
    } catch (err: any) {
      setError(err?.message || 'Request failed')
      if (typeof window !== 'undefined') {
        console.error('[discover:error]', err)
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
      <form onSubmit={handleDiscover} className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium">Discover pages (Sitemap → Heuristic)</label>
          <span className="text-xs text-gray-600">Max 8</span>
        </div>
        <div className="text-xs text-gray-600">Base URL: <span className="text-black font-medium break-all">{sharedBaseUrl || '—'}</span></div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? 'Discovering…' : 'Discover'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>

      {data && (
        <div className="mt-4">
          <div className="text-sm text-gray-600 mb-2">Found {data.targets_count} targets</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {data.targets.map((t, i) => (
              <a key={i} href={t} target="_blank" rel="noreferrer" className="text-sm text-purple-700 underline break-all">
                {t}
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}


