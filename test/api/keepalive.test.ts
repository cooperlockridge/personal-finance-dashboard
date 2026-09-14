import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import * as route from '../../api/keepalive.ts'

/* Not one of the spec's numbered groups, but the keepalive route guards the
   free Supabase project from pausing, so its auth and query are pinned here. */

const SECRET = 'sb_secret_keepalive_test'
const ENV = { SUPABASE_URL: 'https://example-ref.supabase.co', SUPABASE_SECRET_KEY: SECRET, CRON_SECRET: 'cron-secret-123' }

function recorder(response: () => Response = () => Response.json([{ id: 'lockridge' }])) {
  const calls: { url: URL, method: string, headers: Headers }[] = []
  const fetch = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: new URL(input), method: init.method ?? 'GET', headers: new Headers(init.headers) })
    return response()
  }
  return { calls, fetch }
}

const request = (authorization?: string, method = 'GET') => new Request('https://personal-finance-dashboard-ashen.vercel.app/api/keepalive', {
  method,
  headers: authorization === undefined ? {} : { authorization },
})

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error('network is disabled in tests')
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('GET /api/keepalive', () => {
  test('the right cron secret runs one tiny query → 200', async () => {
    const db = recorder()
    const response = await route.handleKeepalive(request('Bearer cron-secret-123'), { env: ENV, fetch: db.fetch })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect(db.calls.length).toBe(1)
    const [call] = db.calls
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/rest/v1/budgets')
    expect(call.url.searchParams.get('select')).toBe('id')
    expect(call.url.searchParams.get('limit')).toBe('1')
    expect(call.headers.get('apikey')).toBe(SECRET)
    expect(call.headers.has('authorization')).toBe(false)
  })

  test('missing or wrong secret → 401 and no query', async () => {
    const db = recorder()
    for (const header of [undefined, '', 'cron-secret-123', 'Bearer wrong', 'Bearer cron-secret-1234']) {
      const response = await route.handleKeepalive(request(header), { env: ENV, fetch: db.fetch })
      expect(response.status).toBe(401)
    }
    expect(db.calls).toEqual([])
  })

  test('no CRON_SECRET configured keeps the route shut', async () => {
    const db = recorder()
    const env = { ...ENV, CRON_SECRET: undefined }
    for (const header of [undefined, 'Bearer ', 'Bearer undefined']) {
      const response = await route.handleKeepalive(request(header), { env, fetch: db.fetch })
      expect(response.status).toBe(401)
    }
    expect(db.calls).toEqual([])
  })

  test('Supabase down → 502', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = recorder(() => new Response('project paused', { status: 503 }))
      const response = await route.handleKeepalive(request('Bearer cron-secret-123'), { env: ENV, fetch: db.fetch })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      quiet.mockRestore()
    }
  })

  test('only GET is exported and other methods get 405', async () => {
    expect(typeof route.GET).toBe('function')
    expect('POST' in route).toBe(false)
    const response = await route.handleKeepalive(request('Bearer cron-secret-123', 'POST'), { env: ENV, fetch: recorder().fetch })
    expect(response.status).toBe(405)
  })
})
