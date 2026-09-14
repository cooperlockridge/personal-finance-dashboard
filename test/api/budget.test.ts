import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ClerkAuthError } from '../../api/_lib/clerk.ts'
import { DELETE, GET, handleBudget, PATCH, POST, PUT, type BudgetDeps } from '../../api/budget.ts'

/* Spec test group 2: the budget handler. The verifier and the PostgREST fetch
   are both injected; the fake PostgREST below keeps a tiny in-memory copy of
   the three tables so each test can check what actually got written. */

const SUPABASE_URL = 'https://example-ref.supabase.co'
const SECRET = 'sb_secret_test_key_do_not_leak'
const ENV = { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET }
const APP = 'https://personal-finance-dashboard-ashen.vercel.app'

const VALID_DATA = {
  profile: { name: 'Laken' },
  envelopes: [{ id: 'rent', amount: 800 }],
  funds: [{ id: 'general', current: 25271.32 }],
  paychecks: [],
  extras: [],
  rollRange: { min: 5, max: 25 },
}

type Call = { method: string, url: URL, headers: Headers, body: unknown }

type BudgetRow = { id: string, data: unknown, version: number, updated_at: string, updated_by: string | null }

function fakeSupabase() {
  const state = {
    members: [
      { budget_id: 'lockridge', clerk_user_id: 'user_laken', label: 'Laken' },
      { budget_id: 'lockridge', clerk_user_id: 'user_cooper', label: 'Cooper' },
    ],
    budgets: [
      { id: 'lockridge', data: VALID_DATA as unknown, version: 4, updated_at: '2026-09-14T17:00:00.000Z', updated_by: 'user_cooper' },
    ] as BudgetRow[],
    snapshots: [] as Record<string, unknown>[],
    failWith: null as null | { status: number, body: string },
  }
  const calls: Call[] = []

  const strip = (value: string | null) => (value ?? '').replace(/^eq\./, '')

  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)

    if (state.failWith) return new Response(state.failWith.body, { status: state.failWith.status })
    if (!url.href.startsWith(`${SUPABASE_URL}/rest/v1/`)) return new Response('wrong base', { status: 404 })

    const table = url.pathname.replace('/rest/v1/', '')
    const q = url.searchParams

    if (call.method === 'GET' && table === 'budget_members') {
      const rows = state.members
        .filter((m) => m.clerk_user_id === strip(q.get('clerk_user_id')))
        .map(({ budget_id, label }) => ({ budget_id, label }))
      return Response.json(rows)
    }
    if (call.method === 'GET' && table === 'budgets') {
      const rows = state.budgets
        .filter((b) => b.id === strip(q.get('id')))
        .map(({ data, version, updated_at, updated_by }) => ({ data, version, updated_at, updated_by }))
      return Response.json(rows)
    }
    if (call.method === 'PATCH' && table === 'budgets') {
      const patch = call.body as Omit<BudgetRow, 'id'>
      const matches = state.budgets.filter((b) => b.id === strip(q.get('id')) && String(b.version) === strip(q.get('version')))
      for (const row of matches) Object.assign(row, patch)
      return Response.json(matches.map((row) => ({ version: row.version })))
    }
    if (call.method === 'POST' && table === 'budget_snapshots') {
      state.snapshots.push(call.body as Record<string, unknown>)
      return new Response(null, { status: 201 })
    }
    return new Response('unhandled', { status: 400 })
  }

  return { state, calls, fetch }
}

const verify: BudgetDeps['verify'] = async (request) => {
  const header = request.headers.get('authorization')
  if (header === 'Bearer laken-token') return { userId: 'user_laken' }
  if (header === 'Bearer stranger-token') return { userId: 'user_stranger' }
  throw new ClerkAuthError('bad_signature')
}

function request(method: string, options: { token?: string, body?: unknown } = {}) {
  const { token = 'laken-token', body } = options
  return new Request(`${APP}/api/budget`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let db: ReturnType<typeof fakeSupabase>
let deps: BudgetDeps

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async () => {
    throw new Error('network is disabled in tests')
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  db = fakeSupabase()
  deps = { env: ENV, verify, fetch: db.fetch }
})

/* Checked after every test, not just the dedicated one below, so no code path
   can slip an Authorization header past the suite. */
afterEach(() => {
  for (const call of db.calls) {
    expect(call.headers.get('apikey')).toBe(SECRET)
    expect(call.headers.has('authorization')).toBe(false)
  }
})

describe('GET /api/budget', () => {
  test('not a member → 403 with the user id and no budget read', async () => {
    const response = await handleBudget(request('GET', { token: 'stranger-token' }), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_member', userId: 'user_stranger' })
    expect(db.calls.length).toBe(1)
    expect(db.calls[0].url.pathname).toBe('/rest/v1/budget_members')
    expect(db.calls[0].url.searchParams.get('clerk_user_id')).toBe('eq.user_stranger')
    expect(db.calls[0].url.searchParams.get('select')).toBe('budget_id,label')
  })

  test('member → 200 with data and version', async () => {
    const response = await handleBudget(request('GET'), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      budgetId: 'lockridge',
      version: 4,
      data: VALID_DATA,
      updatedAt: '2026-09-14T17:00:00.000Z',
      updatedBy: 'user_cooper',
    })
    const read = db.calls[1]
    expect(read.url.pathname).toBe('/rest/v1/budgets')
    expect(read.url.searchParams.get('id')).toBe('eq.lockridge')
    expect(read.url.searchParams.get('select')).toBe('data,version,updated_at,updated_by')
  })

  test('a budget nobody has synced yet returns data null', async () => {
    Object.assign(db.state.budgets[0], { data: null, version: 0, updated_by: null })
    const response = await handleBudget(request('GET'), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ budgetId: 'lockridge', version: 0, data: null, updatedBy: null })
  })
})

describe('PUT /api/budget', () => {
  test('success sends version = base + 1 with the version=eq.base filter', async () => {
    const next = { ...VALID_DATA, rollRange: { min: 10, max: 30 } }
    const response = await handleBudget(request('PUT', { body: { baseVersion: 4, data: next } }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 5 })

    const patch = db.calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.pathname).toBe('/rest/v1/budgets')
    expect(patch.url.searchParams.get('id')).toBe('eq.lockridge')
    expect(patch.url.searchParams.get('version')).toBe('eq.4')
    expect(patch.headers.get('prefer')).toBe('return=representation')
    expect(patch.headers.get('content-type')).toBe('application/json')

    const body = patch.body as Record<string, unknown>
    expect(body.version).toBe(5)
    expect(body.data).toEqual(next)
    expect(body.updated_by).toBe('user_laken')
    expect(typeof body.updated_at).toBe('string')
    expect(Number.isNaN(Date.parse(body.updated_at as string))).toBe(false)

    expect(db.state.budgets[0]).toMatchObject({ version: 5, data: next, updated_by: 'user_laken' })
  })

  test('first sync onto an empty budget: base 0 → version 1', async () => {
    Object.assign(db.state.budgets[0], { data: null, version: 0, updated_by: null })
    const response = await handleBudget(request('PUT', { body: { baseVersion: 0, data: VALID_DATA } }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 1 })
  })

  test('stale base version → 409 with the current cloud state, nothing overwritten', async () => {
    const mine = { ...VALID_DATA, funds: [] }
    const response = await handleBudget(request('PUT', { body: { baseVersion: 3, data: mine } }), deps)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'stale',
      version: 4,
      data: VALID_DATA,
      updatedAt: '2026-09-14T17:00:00.000Z',
      updatedBy: 'user_cooper',
    })
    expect(db.state.budgets[0]).toMatchObject({ version: 4, data: VALID_DATA })
    /* members, conditional PATCH, re-read */
    expect(db.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /rest/v1/budget_members',
      'PATCH /rest/v1/budgets',
      'GET /rest/v1/budgets',
    ])
  })

  test('not a member → 403 and no write', async () => {
    const response = await handleBudget(request('PUT', { token: 'stranger-token', body: { baseVersion: 4, data: VALID_DATA } }), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_member', userId: 'user_stranger' })
    expect(db.calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  const invalidPutBodies: [string, unknown][] = [
    ['not JSON', '{"baseVersion": 4, "data": '],
    ['an array', [VALID_DATA]],
    ['null', 'null'],
    ['missing data', { baseVersion: 4 }],
    ['data is a string', { baseVersion: 4, data: 'hello' }],
    ['profile is an array', { baseVersion: 4, data: { ...VALID_DATA, profile: [] } }],
    ['profile missing', { baseVersion: 4, data: { ...VALID_DATA, profile: undefined } }],
    ['envelopes not an array', { baseVersion: 4, data: { ...VALID_DATA, envelopes: {} } }],
    ['funds missing', { baseVersion: 4, data: { ...VALID_DATA, funds: undefined } }],
    ['paychecks not an array', { baseVersion: 4, data: { ...VALID_DATA, paychecks: 'none' } }],
    ['extras null', { baseVersion: 4, data: { ...VALID_DATA, extras: null } }],
    ['rollRange missing', { baseVersion: 4, data: { ...VALID_DATA, rollRange: undefined } }],
    ['rollRange.min a string', { baseVersion: 4, data: { ...VALID_DATA, rollRange: { min: '5', max: 25 } } }],
    ['rollRange.max missing', { baseVersion: 4, data: { ...VALID_DATA, rollRange: { min: 5 } } }],
    ['baseVersion missing', { data: VALID_DATA }],
    ['baseVersion a string', { baseVersion: '4', data: VALID_DATA }],
    ['baseVersion negative', { baseVersion: -1, data: VALID_DATA }],
    ['baseVersion fractional', { baseVersion: 4.5, data: VALID_DATA }],
    ['body over 1 MB', { baseVersion: 4, data: { ...VALID_DATA, profile: { note: 'x'.repeat(1024 * 1024) } } }],
  ]

  for (const [label, body] of invalidPutBodies) {
    test(`invalid body (${label}) → 400 and no write`, async () => {
      const response = await handleBudget(request('PUT', { body }), deps)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_body' })
      expect(db.calls.some((c) => c.method === 'PATCH')).toBe(false)
      expect(db.state.budgets[0].version).toBe(4)
    })
  }
})

describe('POST /api/budget', () => {
  test('inserts a snapshot → 201', async () => {
    const local = { ...VALID_DATA, funds: [{ id: 'italy', current: 55.5 }] }
    const response = await handleBudget(request('POST', { body: { reason: 'device-import', data: local } }), deps)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({})

    const insert = db.calls.find((c) => c.method === 'POST')!
    expect(insert.url.pathname).toBe('/rest/v1/budget_snapshots')
    expect(insert.url.search).toBe('')
    expect(insert.headers.get('content-type')).toBe('application/json')
    expect(db.state.snapshots).toEqual([
      { budget_id: 'lockridge', clerk_user_id: 'user_laken', reason: 'device-import', data: local },
    ])
    /* A snapshot never touches the live budget. */
    expect(db.state.budgets[0].version).toBe(4)
  })

  test('conflict reason is accepted too', async () => {
    const response = await handleBudget(request('POST', { body: { reason: 'conflict', data: VALID_DATA } }), deps)
    expect(response.status).toBe(201)
    expect(db.state.snapshots[0]).toMatchObject({ reason: 'conflict' })
  })

  for (const [label, body] of [
    ['unknown reason', { reason: 'backup', data: VALID_DATA }],
    ['missing reason', { data: VALID_DATA }],
    ['invalid data', { reason: 'conflict', data: { ...VALID_DATA, funds: 'lots' } }],
    ['not JSON', 'nope'],
  ] as [string, unknown][]) {
    test(`invalid body (${label}) → 400 and no insert`, async () => {
      const response = await handleBudget(request('POST', { body }), deps)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_body' })
      expect(db.state.snapshots).toEqual([])
    })
  }

  test('not a member → 403 and no insert', async () => {
    const response = await handleBudget(request('POST', { token: 'stranger-token', body: { reason: 'conflict', data: VALID_DATA } }), deps)
    expect(response.status).toBe(403)
    expect(db.state.snapshots).toEqual([])
  })
})

describe('everything else', () => {
  test('other methods → 405 before any auth or database work', async () => {
    let verified = false
    const spyDeps = { ...deps, verify: async () => { verified = true; return { userId: 'user_laken' } } }
    for (const method of ['DELETE', 'PATCH', 'OPTIONS']) {
      const response = await handleBudget(request(method), spyDeps)
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, PUT, POST')
    }
    expect(verified).toBe(false)
    expect(db.calls).toEqual([])
  })

  test('route file exports the Web handlers Vercel looks for', () => {
    for (const handler of [GET, PUT, POST, PATCH, DELETE]) expect(typeof handler).toBe('function')
  })

  test('a rejected token → 401 with no database call', async () => {
    const response = await handleBudget(request('GET', { token: 'forged' }), deps)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(db.calls).toEqual([])
  })

  test('a Supabase error → 502 without leaking the key or the raw error', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    db.state.failWith = { status: 500, body: `permission denied for table budgets (apikey ${SECRET})` }
    try {
      const response = await handleBudget(request('GET'), deps)
      expect(response.status).toBe(502)
      const text = await response.text()
      expect(text).toBe('{"error":"upstream_error"}')
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('permission denied')
    } finally {
      quiet.mockRestore()
    }
  })

  test('a network failure reaching Supabase → 502', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await handleBudget(request('GET'), {
        ...deps,
        fetch: async () => {
          throw new TypeError('fetch failed')
        },
      })
      expect(response.status).toBe(502)
    } finally {
      quiet.mockRestore()
    }
  })

  test('missing Supabase env → 500 and no request at all', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await handleBudget(request('GET'), { ...deps, env: { SUPABASE_URL } })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'server_misconfigured' })
      expect(db.calls).toEqual([])
    } finally {
      quiet.mockRestore()
    }
  })

  test('every Supabase request carries apikey and no Authorization header', async () => {
    await handleBudget(request('GET'), deps)
    await handleBudget(request('PUT', { body: { baseVersion: 4, data: VALID_DATA } }), deps)
    await handleBudget(request('PUT', { body: { baseVersion: 4, data: VALID_DATA } }), deps)
    await handleBudget(request('POST', { body: { reason: 'conflict', data: VALID_DATA } }), deps)

    /* GET: members + read. PUT: members + patch. Stale PUT: members + patch +
       re-read. POST: members + insert. */
    expect(db.calls.length).toBe(9)
    for (const call of db.calls) {
      expect(call.url.origin).toBe(SUPABASE_URL)
      expect(call.headers.get('apikey')).toBe(SECRET)
      expect(call.headers.has('authorization')).toBe(false)
    }
  })
})
