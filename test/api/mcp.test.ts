import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { handleMcp } from '../../api/mcp.ts'
import { handleOAuth } from '../../api/oauth.ts'
import { DEFAULT_BUDGET, type BudgetData } from '../../src/lib/finance.ts'
import { easternNow, TOOLS } from '../../api/_lib/mcpTools.ts'
import { applyPatch } from '../../api/_lib/jsonPatch.ts'
import { isAllowedRedirect, pkceMatches, signArtifact, oauthKeyFromEnv } from '../../api/_lib/oauth.ts'

/* The Claude connector (2026-10-19): the OAuth dance in api/oauth.ts and the
   MCP tools in api/mcp.ts. PostgREST is faked in memory, so these check what
   actually lands in the budget row, through the same /api/budget handler the
   app uses. */

const APP = 'https://personal-finance-dashboard-ashen.vercel.app'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_key_do_not_leak',
  DEVICE_SESSION_SECRET: 'x'.repeat(40),
}
/* Fri Oct 23, 2026, noon Eastern. */
const NOW = Date.parse('2026-10-23T16:00:00Z')
const VERIFIER = 'v'.repeat(50)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fakeSupabase(data: BudgetData | null = clone(DEFAULT_BUDGET)) {
  const state = {
    members: [{ budget_id: 'lockridge', clerk_user_id: 'user_laken', label: 'Laken' }],
    budget: { data: data as unknown, version: 7, updated_at: '2026-10-20T00:00:00Z', updated_by: 'user_laken' },
    requests: [] as Record<string, unknown>[],
    /* Bumps the version once, as if a phone saved between read and write. */
    raceNextSave: false,
    puts: 0,
  }
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const table = url.pathname.split('/').pop()
    const method = init.method ?? 'GET'
    const filter = (name: string) => url.searchParams.get(name)?.replace(/^eq\./, '')
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const reply = (rows: unknown, status = 200) => new Response(JSON.stringify(rows), { status })

    if (table === 'budget_members') {
      return reply(state.members.filter((m) => m.clerk_user_id === decodeURIComponent(filter('clerk_user_id') ?? '')))
    }
    if (table === 'budgets' && method === 'GET') return reply([state.budget])
    if (table === 'budgets' && method === 'PATCH') {
      state.puts++
      if (state.raceNextSave) {
        state.raceNextSave = false
        state.budget = { ...state.budget, version: state.budget.version + 1 }
      }
      if (Number(filter('version')) !== state.budget.version) return reply([])
      state.budget = { ...state.budget, ...body }
      return reply([{ version: state.budget.version }])
    }
    if (table === 'budget_requests' && method === 'GET') return reply(state.requests)
    if (table === 'budget_requests' && method === 'POST') {
      const row = { id: state.requests.length + 1, status: 'new', ...body }
      state.requests.push(row)
      return reply([{ id: row.id }], 201)
    }
    throw new Error(`unexpected ${method} ${url.pathname}`)
  }
  return { state, fetch }
}

const key = oauthKeyFromEnv(ENV)

function accessToken(userId = 'user_laken', nowMs = NOW) {
  return signArtifact('access', { sub: userId, cid: 'test' }, key, nowMs, 3600)
}

async function rpc(fake: ReturnType<typeof fakeSupabase>, method: string, params: unknown = {}, token = accessToken()) {
  const response = await handleMcp(new Request(`${APP}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), { env: ENV, fetch: fake.fetch, now: () => NOW })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

async function call(fake: ReturnType<typeof fakeSupabase>, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(fake, 'tools/call', { name, arguments: args })
  const result = body.result
  return { isError: result.isError as boolean, text: result.content[0].text as string, data: result.structuredContent as Record<string, any> }
}

const saved = (fake: ReturnType<typeof fakeSupabase>) => fake.state.budget.data as BudgetData

describe('oauth helpers', () => {
  test('only Claude and loopback redirects are accepted', () => {
    expect(isAllowedRedirect(CALLBACK)).toBe(true)
    expect(isAllowedRedirect('https://claude.com/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirect('http://localhost:6274/oauth/callback')).toBe(true)
    expect(isAllowedRedirect('https://claude.ai.evil.com/cb')).toBe(false)
    expect(isAllowedRedirect('http://claude.ai/cb')).toBe(false)
    expect(isAllowedRedirect('https://evil.com/cb')).toBe(false)
  })

  test('PKCE S256 checks the verifier against the challenge', () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true)
    expect(pkceMatches('w'.repeat(50), CHALLENGE)).toBe(false)
    expect(pkceMatches('short', CHALLENGE)).toBe(false)
  })
})

describe('oauth flow', () => {
  const deps = (fake = fakeSupabase(), userId = 'user_laken') => ({
    env: ENV,
    fetch: fake.fetch,
    now: () => NOW,
    verify: async () => ({ userId }),
  })

  async function register() {
    const response = await handleOAuth(new Request(`${APP}/api/oauth?step=register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Claude' }),
    }), deps())
    expect(response.status).toBe(201)
    return (await response.json() as { client_id: string }).client_id
  }

  async function authorize(clientId: string) {
    const params = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: CALLBACK,
      code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'xyz',
    })
    return handleOAuth(new Request(`${APP}/api/oauth?step=authorize&${params}`), deps())
  }

  test('metadata documents point at this origin', async () => {
    const as = await (await handleOAuth(new Request(`${APP}/api/oauth?step=as-metadata`), deps())).json() as Record<string, unknown>
    expect(as.issuer).toBe(APP)
    expect(as.token_endpoint).toBe(`${APP}/oauth/token`)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    const resource = await (await handleOAuth(new Request(`${APP}/.well-known/oauth-protected-resource/api/mcp`), deps())).json() as Record<string, unknown>
    expect(resource.resource).toBe(`${APP}/api/mcp`)
  })

  test('registration refuses a redirect outside Claude', async () => {
    const response = await handleOAuth(new Request(`${APP}/api/oauth?step=register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.com/cb'] }),
    }), deps())
    expect(response.status).toBe(400)
  })

  test('register → authorize → allow → token → refresh', async () => {
    const clientId = await register()

    const start = await authorize(clientId)
    expect(start.status).toBe(302)
    const consent = new URL(start.headers.get('location') ?? '')
    expect(consent.origin).toBe(APP)
    const pending = consent.searchParams.get('connect') ?? ''
    expect(pending.length).toBeGreaterThan(20)

    const approved = await handleOAuth(new Request(`${APP}/api/oauth?step=authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: pending, decision: 'allow' }),
    }), deps())
    expect(approved.status).toBe(200)
    const back = new URL((await approved.json() as { redirect: string }).redirect)
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
    expect(back.searchParams.get('state')).toBe('xyz')
    const code = back.searchParams.get('code') ?? ''

    const exchange = (verifier: string) => handleOAuth(new Request(`${APP}/api/oauth?step=token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }).toString(),
    }), deps())
    expect((await exchange('w'.repeat(50))).status).toBe(400)
    const tokens = await (await exchange(VERIFIER)).json() as Record<string, string>
    expect(tokens.token_type).toBe('Bearer')

    const fake = fakeSupabase()
    expect((await rpc(fake, 'tools/list', {}, tokens.access_token)).status).toBe(200)

    const refreshed = await (await handleOAuth(new Request(`${APP}/api/oauth?step=token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    }), deps())).json() as Record<string, string>
    expect(typeof refreshed.access_token).toBe('string')
    /* A refresh token is not an access token. */
    expect((await rpc(fake, 'tools/list', {}, tokens.refresh_token)).status).toBe(401)
  })

  test('denying sends access_denied back to Claude', async () => {
    const start = await authorize(await register())
    const pending = new URL(start.headers.get('location') ?? '').searchParams.get('connect')
    const denied = await handleOAuth(new Request(`${APP}/api/oauth?step=authorize`, {
      method: 'POST',
      body: JSON.stringify({ request: pending, decision: 'deny' }),
    }), deps())
    const back = new URL((await denied.json() as { redirect: string }).redirect)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
  })

  test('a login that is not on the budget cannot approve', async () => {
    const start = await authorize(await register())
    const pending = new URL(start.headers.get('location') ?? '').searchParams.get('connect')
    const response = await handleOAuth(new Request(`${APP}/api/oauth?step=authorize`, {
      method: 'POST',
      body: JSON.stringify({ request: pending, decision: 'allow' }),
    }), deps(fakeSupabase(), 'user_stranger'))
    expect(response.status).toBe(403)
  })

  test('a redirect the client never registered is refused without redirecting', async () => {
    const clientId = await register()
    const params = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/other',
      code_challenge: CHALLENGE, code_challenge_method: 'S256',
    })
    const response = await handleOAuth(new Request(`${APP}/api/oauth?step=authorize&${params}`), deps())
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })
})

describe('mcp protocol', () => {
  test('no token is a 401 that points Claude at the sign-in metadata', async () => {
    const response = await handleMcp(new Request(`${APP}/api/mcp`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }), { env: ENV, now: () => NOW })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(`${APP}/.well-known/oauth-protected-resource`)
  })

  test('an expired token is refused', async () => {
    const { status } = await rpc(fakeSupabase(), 'ping', {}, accessToken('user_laken', NOW - 2 * 3600 * 1000))
    expect(status).toBe(401)
  })

  test('initialize negotiates a protocol version and lists tools', async () => {
    const fake = fakeSupabase()
    const init = await rpc(fake, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.body.result.protocolVersion).toBe('2025-03-26')
    expect(init.body.result.capabilities.tools).toEqual({ listChanged: false })
    const list = await rpc(fake, 'tools/list')
    expect(list.body.result.tools).toHaveLength(TOOLS.length)
    expect(TOOLS.length).toBeGreaterThan(30)
    for (const tool of list.body.result.tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  test('notifications get a 202 and unknown methods an error', async () => {
    const response = await handleMcp(new Request(`${APP}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }), { env: ENV, now: () => NOW })
    expect(response.status).toBe(202)
    const unknown = await rpc(fakeSupabase(), 'sampling/whatever')
    expect(unknown.body.error.code).toBe(-32601)
  })

  test('the clock is her Eastern wall clock', () => {
    const d = easternNow(Date.parse('2026-10-24T02:30:00Z'))
    expect(d.getDate()).toBe(23)
    expect(d.getHours()).toBe(22)
  })
})

describe('mcp tools', () => {
  test('every read-only tool answers on the default budget', async () => {
    const fake = fakeSupabase()
    for (const tool of TOOLS.filter((t) => t.annotations.readOnlyHint && !t.name.includes('request'))) {
      const args: Record<string, unknown> =
        tool.name === 'preview_paycheck' ? { takeHome: 900 }
          : tool.name === 'plan_fund' ? { target: 1200, deadline: '2027-06-30' }
            : tool.name === 'get_paycheck' ? { id: 'none' }
              : {}
      const result = await call(fake, tool.name, args)
      expect(result.isError).toBe(tool.name === 'get_paycheck')
    }
    expect(fake.state.puts).toBe(0)
  })

  test('add_paycheck splits like the app and saves at the next version', async () => {
    const fake = fakeSupabase()
    const general = DEFAULT_BUDGET.envelopes.find((e) => e.id === 'general')!.balance
    const { isError, data } = await call(fake, 'add_paycheck', { takeHome: 1000, hours: 50 })
    expect(isError).toBe(false)
    expect(data.version).toBe(8)
    expect(data.paycheck.date).toBe('2026-10-23')
    expect(data.paycheck.gross).toBe(1250)
    const budget = saved(fake)
    expect(budget.paychecks).toHaveLength(1)
    /* General is 20% of take-home. */
    expect(budget.envelopes.find((e) => e.id === 'general')!.balance).toBeCloseTo(general + 200)
    /* The car is a debt: $125 comes off what is left to pay. */
    expect(budget.envelopes.find((e) => e.id === 'car')!.remaining).toBe(2875)
    /* Roth is 10% of gross. */
    expect(budget.paychecks[0].envelopeAmounts.roth).toBe(125)
  })

  test('the duplicate guard holds until she confirms', async () => {
    const fake = fakeSupabase()
    await call(fake, 'add_paycheck', { takeHome: 950, date: '2026-10-16' })
    const again = await call(fake, 'add_paycheck', { takeHome: 950, date: '2026-10-16' })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('allowDuplicate')
    expect(saved(fake).paychecks).toHaveLength(1)
    const confirmed = await call(fake, 'add_paycheck', { takeHome: 950, date: '2026-10-16', allowDuplicate: true })
    expect(confirmed.isError).toBe(false)
    expect(saved(fake).paychecks).toHaveLength(2)
  })

  test('remove_paycheck puts every balance back', async () => {
    const fake = fakeSupabase()
    const before = clone(saved(fake))
    const { data } = await call(fake, 'add_paycheck', { takeHome: 1000 })
    await call(fake, 'remove_paycheck', { id: data.paycheck.id })
    const after = saved(fake)
    expect(after.paychecks).toHaveLength(0)
    for (const env of before.envelopes) {
      const now = after.envelopes.find((e) => e.id === env.id)!
      expect(now.balance).toBeCloseTo(env.balance)
      expect(now.remaining).toBe(env.remaining)
    }
    for (const fund of before.funds) expect(after.funds.find((f) => f.id === fund.id)!.current).toBeCloseTo(fund.current)
  })

  test('edit_paycheck re-splits in place', async () => {
    const fake = fakeSupabase()
    const first = await call(fake, 'add_paycheck', { takeHome: 1000, date: '2026-10-09' })
    await call(fake, 'add_paycheck', { takeHome: 800, date: '2026-10-23' })
    const general = saved(fake).envelopes.find((e) => e.id === 'general')!.balance
    const { isError, data } = await call(fake, 'edit_paycheck', { id: first.data.paycheck.id, takeHome: 1100 })
    expect(isError).toBe(false)
    expect(data.after.takeHome).toBe(1100)
    const budget = saved(fake)
    expect(budget.paychecks[1].id).toBe(first.data.paycheck.id)
    expect(budget.envelopes.find((e) => e.id === 'general')!.balance).toBeCloseTo(general + 20)
  })

  test('a save that loses a race is redone on the fresh copy', async () => {
    const fake = fakeSupabase()
    fake.state.raceNextSave = true
    const { isError } = await call(fake, 'add_random_saving', { amount: 12 })
    expect(isError).toBe(false)
    expect(fake.state.puts).toBe(2)
    expect(saved(fake).extras).toHaveLength(1)
  })

  test('move_money shifts between an envelope and a fund by name', async () => {
    const fake = fakeSupabase()
    const { isError, data } = await call(fake, 'move_money', { from: 'general savings', to: 'Christmas 2026', amount: 200 })
    expect(isError).toBe(false)
    expect(data.to.after).toBe(800)
    expect(saved(fake).funds.find((f) => f.id === 'christmas')!.current).toBe(800)
  })

  test('envelope and fund editing', async () => {
    const fake = fakeSupabase()
    expect((await call(fake, 'add_envelope', { name: 'Vacation', kind: 'percentNet', value: 5 })).isError).toBe(false)
    expect((await call(fake, 'update_envelope', { envelope: 'vacation', value: 7, balance: 50 })).data.after.balance).toBe(50)
    expect((await call(fake, 'update_envelope', { envelope: 'car', balance: 10 })).isError).toBe(true)
    expect((await call(fake, 'adjust_envelope', { envelope: 'Expenses', amount: -40 })).data.change).toBe(-40)
    expect((await call(fake, 'remove_envelope', { envelope: 'Vacation', moveBalanceTo: 'general' })).data.balanceMoved).toBe(50)

    const added = await call(fake, 'add_fund', { name: 'Italy Trip', target: 1500, deadline: '2027-08-01' })
    expect(added.data.added.id).toBe('italy-trip')
    expect((await call(fake, 'update_fund', { fund: 'italy trip', deadline: null, perCheck: 25 })).data.after.deadline).toBeNull()
    expect((await call(fake, 'add_fund', { name: 'Bad', startDate: '2027-02-01', deadline: '2027-01-01' })).isError).toBe(true)
    expect((await call(fake, 'adjust_fund', { fund: 'Italy', amount: 100 })).data.after.saved).toBe(100)
    const removed = await call(fake, 'remove_fund', { fund: 'Italy Trip' })
    expect(removed.data.savedMovedTo).toBeNull()
    expect(saved(fake).funds.some((f) => f.name === 'Italy Trip')).toBe(false)
    expect((await call(fake, 'update_fund', { fund: 'nope' })).text).toContain('Christmas 2026')
  })

  test('settings and the roll range', async () => {
    const fake = fakeSupabase()
    expect((await call(fake, 'update_settings', { hourlyRate: 27.5 })).data.after.hourlyRate).toBe(27.5)
    expect((await call(fake, 'update_settings', {})).isError).toBe(true)
    expect((await call(fake, 'set_roll_range', { min: 10, max: 5 })).isError).toBe(true)
    await call(fake, 'set_roll_range', { min: 3, max: 3 })
    expect((await call(fake, 'roll_random_amount')).data.amount).toBe(3)
  })

  test('change requests go through /api/requests', async () => {
    const fake = fakeSupabase()
    expect((await call(fake, 'submit_request', { text: 'Make the donut bigger' })).data.id).toBe(1)
    expect(fake.state.requests[0].author_label).toBe('Laken')
  })

  test('a budget that was never synced is reported, not overwritten', async () => {
    const fake = fakeSupabase(null)
    const result = await call(fake, 'add_paycheck', { takeHome: 500 })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Open the dashboard')
    expect(fake.state.puts).toBe(0)
  })

  test('a login that is not on the budget gets a readable error', async () => {
    const { body } = await rpc(fakeSupabase(), 'tools/call', { name: 'get_overview', arguments: {} }, accessToken('user_stranger'))
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('not on a budget')
  })
})

describe('applyPatch', () => {
  const doc = { list: [{ id: 'a' }, { id: 'b' }], n: 1 }

  test('applies every op in order and never touches its input', () => {
    const out = applyPatch(doc, [
      { op: 'add', path: '/list/-', value: { id: 'c' } },
      { op: 'replace', path: '/n', value: 2 },
      { op: 'move', from: '/list/0', path: '/list/2' },
      { op: 'copy', from: '/n', path: '/m' },
      { op: 'test', path: '/list/0/id', value: 'b' },
      { op: 'remove', path: '/list/1' },
    ])
    expect(out).toEqual({ list: [{ id: 'b' }, { id: 'a' }], n: 2, m: 2 })
    expect(doc).toEqual({ list: [{ id: 'a' }, { id: 'b' }], n: 1 })
  })

  test('a failing op names itself and applies nothing', () => {
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/n', value: 5 }, { op: 'test', path: '/list/0/id', value: 'z' }])).toThrow('Operation 2')
    expect(() => applyPatch(doc, [{ op: 'remove', path: '/list/7' }])).toThrow('out of range')
    expect(() => applyPatch(doc, [{ op: 'replace', path: '', value: {} }])).toThrow('whole document')
    expect(() => applyPatch(doc, [])).toThrow('non-empty')
    expect(doc.n).toBe(1)
  })
})

describe('patch_budget (catch-all)', () => {
  test('a dry run describes the change and saves nothing', async () => {
    const fake = fakeSupabase()
    const { isError, data } = await call(fake, 'patch_budget', {
      baseVersion: 7,
      dryRun: true,
      reason: 'rename and resize gifts',
      operations: [
        { op: 'test', path: '/envelopes/2/id', value: 'giving' },
        { op: 'replace', path: '/envelopes/2/name', value: 'Gifts & Giving' },
        { op: 'replace', path: '/envelopes/2/value', value: 6 },
      ],
    })
    expect(isError).toBe(false)
    expect(data.saved).toBe(false)
    expect(data.changes).toContain('envelope "Gifts & Giving": name "Gifts" → "Gifts & Giving"')
    expect(data.changes).toContain('envelope "Gifts & Giving": value 5 → 6')
    expect(fake.state.puts).toBe(0)
  })

  test('saves against the version it was written for', async () => {
    const fake = fakeSupabase()
    const { isError, data } = await call(fake, 'patch_budget', {
      baseVersion: 7,
      operations: [{ op: 'add', path: '/funds/-', value: { id: 'italy-trip', name: 'Italy Trip', target: 1500, current: 0, deadline: '2027-08-01', perCheck: 0 } }],
    })
    expect(isError).toBe(false)
    expect(data.version).toBe(8)
    expect(data.changes).toEqual(['added fund "Italy Trip"'])
    expect(saved(fake).funds.at(-1)!.id).toBe('italy-trip')
  })

  test('a stale version is refused, and is not retried on a race', async () => {
    const fake = fakeSupabase()
    const stale = await call(fake, 'patch_budget', { baseVersion: 6, operations: [{ op: 'replace', path: '/rollRange/max', value: 60 }] })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('get_budget')
    fake.state.raceNextSave = true
    const raced = await call(fake, 'patch_budget', { baseVersion: 7, operations: [{ op: 'replace', path: '/rollRange/max', value: 60 }] })
    expect(raced.isError).toBe(true)
    expect(fake.state.puts).toBe(1)
    expect(saved(fake).rollRange.max).toBe(50)
  })

  test('a patch that would break the app is refused with every reason', async () => {
    const fake = fakeSupabase()
    const bad = await call(fake, 'patch_budget', {
      baseVersion: 7,
      operations: [
        { op: 'replace', path: '/envelopes/0/kind', value: 'percent' },
        { op: 'replace', path: '/envelopes/1/id', value: 'wedding' },
        { op: 'add', path: '/profile/nickname', value: 'L' },
        { op: 'replace', path: '/funds/0/deadline', value: 'December' },
      ],
    })
    expect(bad.isError).toBe(true)
    for (const reason of ['/kind must be one of', 'used twice', 'Unknown field /profile/nickname', '/deadline must be']) {
      expect(bad.text).toContain(reason)
    }
    expect(fake.state.puts).toBe(0)
  })

  test("an old record's existing problem never blocks an unrelated edit", async () => {
    const budget = clone(DEFAULT_BUDGET)
    /* A check from before gross was stored, as older records are. */
    budget.paychecks = [{ id: 'old', date: '2026-08-07', net: 900, hours: null, grossEstimated: true, envelopeAmounts: {}, fundAmounts: {}, leftover: 900 } as never]
    const fake = fakeSupabase(budget)
    const result = await call(fake, 'patch_budget', {
      baseVersion: 7,
      operations: [
        { op: 'add', path: '/extras/0', value: { id: 'x1', date: '2026-10-20', amount: 10, rolled: false } },
        { op: 'add', path: '/paychecks/0', value: { id: 'new', date: '2026-10-23', net: 1000, hours: 50, gross: 1250, grossEstimated: false, envelopeAmounts: {}, fundAmounts: {}, leftover: 1000 } },
      ],
    })
    expect(result.isError).toBe(false)
  })

  test('the schema guide is served', async () => {
    const { data } = await call(fakeSupabase(), 'get_budget_schema')
    expect(data.guide).toContain('percentGross')
  })
})
