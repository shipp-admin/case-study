export async function POST(request: Request) {
  try {
    const body = await request.json()
    const target = process.env.NODE_ENV === 'development'
      ? 'http://127.0.0.1:5329/api/parse'
      : 'https://'+(process.env.VERCEL_URL || request.headers.get('host') || '')+'/api/parse'

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const text = await resp.text()
    return new Response(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Proxy error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}



