import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ClerkAuthError } from '../../api/_lib/clerk.ts'
import {
  DEVICE_COOKIE,
  DEVICE_RENEW_AFTER_S,
  DEVICE_TTL_S,
  DeviceAuthError,
  signDeviceToken,
  verifyDeviceToken,
  verifyRequest,
} from '../../api/_lib/device.ts'
import { handleBudget } from '../../api/budget.ts'
import { DELETE, GET, handleDevice, POST, type DeviceDeps } from '../../api/device.ts'

/* "Remember this device": the cookie's signature and lifetime, the route that
   issues it, and /api/budget accepting it in place of a Clerk token. Clerk
   and PostgREST are both injected, so nothing leaves the machine. */

const SUPABASE_URL = 'https://example-ref.supabase.co'
const DEVICE_SECRET = 'device-secret-for-tests-0123456789abcdef'
const ENV = {
  SUPABASE_URL,
  SUPABASE_SECRET_KEY: 'sb_secret_test_key_do_not_leak',
  DEVICE_SESSION_SECRET: DEVICE_SECRET,
}
const APP = 'https://personal-finance-dashboard-ashen.vercel.app'
const START_MS = Date.UTC(2026, 9, 2, 18, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1000
const LAKEN = { userId: 'user_laken', name: 'Laken' }

const BUDGET = {
  profile: {},
  envelopes: [],
  funds: [],
  paychecks: [],
  extras: [],
  rollRange: { min: 5, max: 25 },
}

/* budget_members and one budgets row, which is all these routes read. */
function fakeSupabase() {
  const urls: string[] = []
  const fetch = async (input: string) => {
    urls.push(input)
    const url = new URL(input)
    if (url.pathname.endsWith('/budget_members')) {
      const id = (url.searchParams.get('clerk_user_id') ?? '').replace(/^eq\./, '')
      return Response.json(id === 'user_laken' ? [{ budget_id: 'lockridge', label: 'Laken' }] : [])
    }
    return Response.json([{ data: BUDGET, version: 2, updated_at: '2026-10-02T19:03:42.086Z', updated_by: 'user_laken' }])
  }
  return { urls, fetch }
}

const verify: DeviceDeps['verify'] = async (request) => {
  const header = request.headers.get('authorization')
  if (header === 'Bearer laken-token') return { userId: 'user_laken' }
  if (header === 'Bearer stranger-token') return { userId: 'user_stranger' }
  throw new ClerkAuthError('bad_signature')
}

function request(method: string, options: { token?: string, cookie?: string, path?: string } = {}) {
  const headers: Record<string, string> = {}
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.cookie) headers.cookie = `theme=dark; ${DEVICE_COOKIE}=${options.cookie}; other=1`
  return new Request(`${APP}${options.path ?? '/api/device'}`, { method, headers })
}

/* The token inside a Set-Cookie header, or null if the header set none. */
function cookieToken(response: Response): string | null {
  const header = response.headers.get('set-cookie')
  return header ? header.slice(DEVICE_COOKIE.length + 1).split(';')[0] : null
}

let db: ReturnType<typeof fakeSupabase>
let nowMs: number
let deps: DeviceDeps

beforeEach(() => {
  db = fakeSupabase()
  nowMs = START_MS
  deps = { env: ENV, verify, fetch: db.fetch, now: () => nowMs }
})

describe('device token', () => {
  test('round-trips the user, the name and the issue time', () => {
    const token = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    expect(verifyDeviceToken(token, DEVICE_SECRET, START_MS)).toEqual({ ...LAKEN, issuedAt: START_MS / 1000 })
  })

  test('holds for a year and not a second longer', () => {
    const token = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    const lastMs = START_MS + DEVICE_TTL_S * 1000
    expect(verifyDeviceToken(token, DEVICE_SECRET, lastMs).userId).toBe('user_laken')
    expect(() => verifyDeviceToken(token, DEVICE_SECRET, lastMs + 1000)).toThrow(DeviceAuthError)
  })

  test('a different secret, an edited payload or a mangled token is rejected', () => {
    const token = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    const [, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'user_cooper', iat: 0, exp: 9e12 })).toString('base64url')
    for (const [bad, secret] of [
      [token, 'another-secret-entirely-0123456789abcdef'],
      [`${forged}.${signature}`, DEVICE_SECRET],
      [`${forged}.`, DEVICE_SECRET],
      ['not-a-token', DEVICE_SECRET],
      [`${token}.extra`, DEVICE_SECRET],
    ]) {
      expect(() => verifyDeviceToken(bad, secret, START_MS)).toThrow(DeviceAuthError)
    }
  })
})

describe('POST /api/device', () => {
  test('a member with a Clerk token gets the cookie', async () => {
    const response = await handleDevice(request('POST', { token: 'laken-token' }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(LAKEN)
    const header = response.headers.get('set-cookie') ?? ''
    expect(header.startsWith(`${DEVICE_COOKIE}=`)).toBe(true)
    for (const flag of [`Max-Age=${DEVICE_TTL_S}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(header.split('; ')).toContain(flag)
    }
    expect(verifyDeviceToken(cookieToken(response)!, DEVICE_SECRET, START_MS).userId).toBe('user_laken')
  })

  test('not a member → 403 with the user id and no cookie', async () => {
    const response = await handleDevice(request('POST', { token: 'stranger-token' }), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_member', userId: 'user_stranger' })
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  test('a rejected or missing Clerk token → 401, no cookie, no database call', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    for (const options of [{ token: 'forged' }, {}, { cookie }]) {
      const response = await handleDevice(request('POST', options), deps)
      expect(response.status).toBe(401)
      expect(response.headers.has('set-cookie')).toBe(false)
    }
    expect(db.urls).toEqual([])
  })

  test('a missing or short secret → 500 before any auth or database work', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    for (const secret of [undefined, 'too-short']) {
      const env = { ...ENV, DEVICE_SESSION_SECRET: secret }
      const response = await handleDevice(request('POST', { token: 'laken-token' }), { ...deps, env })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'server_misconfigured' })
      expect(response.headers.has('set-cookie')).toBe(false)
    }
    expect(db.urls).toEqual([])
    quiet.mockRestore()
  })
})

describe('GET /api/device', () => {
  test('a remembered device gets its user back without a database call', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    nowMs = START_MS + 14 * DAY_MS
    const response = await handleDevice(request('GET', { cookie }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(LAKEN)
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(db.urls).toEqual([])
  })

  test('a cookie past the renewal age comes back reissued from now', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    nowMs = START_MS + DEVICE_RENEW_AFTER_S * 1000
    const response = await handleDevice(request('GET', { cookie }), deps)
    expect(response.status).toBe(200)
    expect(verifyDeviceToken(cookieToken(response)!, DEVICE_SECRET, nowMs)).toEqual({ ...LAKEN, issuedAt: nowMs / 1000 })
  })

  test('no cookie, a forged one, an expired one or no secret → 401', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, START_MS)
    const cases: [Parameters<typeof request>[1], Partial<DeviceDeps>][] = [
      [{}, {}],
      [{ cookie: signDeviceToken(LAKEN, 'another-secret-entirely-0123456789abcdef', START_MS) }, {}],
      [{ cookie }, { now: () => START_MS + (DEVICE_TTL_S + 1) * 1000 }],
      [{ cookie }, { env: { ...ENV, DEVICE_SESSION_SECRET: undefined } }],
    ]
    for (const [options, overrides] of cases) {
      const response = await handleDevice(request('GET', options), { ...deps, ...overrides })
      expect(response.status).toBe(401)
      expect(response.headers.has('set-cookie')).toBe(false)
    }
  })
})

describe('DELETE /api/device and the rest', () => {
  test('clears the cookie with nothing to prove', async () => {
    const response = await handleDevice(request('DELETE'), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBe(
      `${DEVICE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
    )
  })

  test('other methods → 405', async () => {
    const response = await handleDevice(request('PUT', { token: 'laken-token' }), deps)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST, DELETE')
  })

  test('route file exports the Web handlers Vercel looks for', () => {
    for (const handler of [GET, POST, DELETE]) expect(typeof handler).toBe('function')
  })
})

/* The real verifier here, not the injected one: these are the lines that
   decide whether a cookie is as good as a Clerk token. It reads the real
   clock, so these cookies are signed against Date.now(). */
describe('/api/budget with the device cookie', () => {
  const budgetDeps = () => ({ env: ENV, fetch: db.fetch })
  const budgetRequest = (options: Parameters<typeof request>[1]) => request('GET', { ...options, path: '/api/budget' })

  test('a valid cookie and no Bearer header reads the budget', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, Date.now())
    const response = await handleBudget(budgetRequest({ cookie }), budgetDeps())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ budgetId: 'lockridge', version: 2 })
  })

  test('a cookie for someone no longer a member → 403', async () => {
    const cookie = signDeviceToken({ userId: 'user_removed', name: 'Gone' }, DEVICE_SECRET, Date.now())
    const quiet = spyOn(console, 'warn').mockImplementation(() => {})
    const response = await handleBudget(budgetRequest({ cookie }), budgetDeps())
    quiet.mockRestore()
    expect(response.status).toBe(403)
  })

  test('no credentials, a forged cookie or an expired one → 401 with no database call', async () => {
    const expired = signDeviceToken(LAKEN, DEVICE_SECRET, Date.now() - (DEVICE_TTL_S + 60) * 1000)
    const forged = signDeviceToken(LAKEN, 'another-secret-entirely-0123456789abcdef', Date.now())
    for (const options of [{}, { cookie: forged }, { cookie: expired }]) {
      const response = await handleBudget(budgetRequest(options), budgetDeps())
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
    expect(db.urls).toEqual([])
  })

  test('a Bearer header is judged alone: a bad token never falls back to the cookie', async () => {
    const cookie = signDeviceToken(LAKEN, DEVICE_SECRET, Date.now())
    await expect(verifyRequest(budgetRequest({ cookie, token: 'not-a-jwt' }), ENV)).rejects.toBeInstanceOf(ClerkAuthError)
    expect(db.urls).toEqual([])
  })
})
