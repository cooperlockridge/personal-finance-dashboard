import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ClerkAuthError } from '../../api/_lib/clerk.ts'
import { DEVICE_COOKIE, signDeviceToken } from '../../api/_lib/device.ts'
import { GET, handleRequests, POST, type RequestsDeps } from '../../api/requests.ts'

/* The change-request handler. The verifier and the PostgREST fetch are both
   injected; the fake PostgREST below keeps an in-memory copy of the four
   tables and understands the few filters the handler sends, so each test can
   check what actually got read and written. */

const SUPABASE_URL = 'https://example-ref.supabase.co'
const SECRET = 'sb_secret_test_key_do_not_leak'
const DEVICE_SECRET = 'device-secret-for-tests-0123456789abcdef'
const ENV = { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET }
const APP = 'https://personal-finance-dashboard-ashen.vercel.app'

const BEFORE_DATA = {
  profile: { name: 'Laken' },
  envelopes: [{ id: 'wedding', value: 10 }],
  funds: [{ id: 'italy', current: 55.5 }],
  paychecks: [],
  extras: [],
  rollRange: { min: 5, max: 25 },
}
/* What the watchdog's data change left behind: Wedding went 10 → 15. */
const AFTER_DATA = { ...BEFORE_DATA, envelopes: [{ id: 'wedding', value: 15 }] }

const CHANGES = [{ label: 'Wedding', before: '10', after: '15' }]

type Row = Record<string, unknown>
type Call = { method: string, url: URL, headers: Headers, body: unknown }

function requestRow(id: number, fields: Row = {}): Row {
  const at = `2026-10-01T12:00:${String(id).padStart(2, '0')}.000Z`
  return {
    id,
    budget_id: 'lockridge',
    clerk_user_id: 'user_laken',
    author_label: 'Laken',
    body: `request ${id}`,
    status: 'new',
    lane: null,
    question: null,
    answer: null,
    summary: null,
    changes: null,
    snapshot_id: null,
    applied_version: null,
    commit_sha: null,
    attempts: 0,
    claimed_at: null,
    created_at: at,
    updated_at: at,
    ...fields,
  }
}

function fakeSupabase() {
  const state = {
    members: [
      { budget_id: 'lockridge', clerk_user_id: 'user_laken', label: 'Laken' },
      { budget_id: 'lockridge', clerk_user_id: 'user_cooper', label: 'Cooper' },
      { budget_id: 'smith', clerk_user_id: 'user_other', label: 'Sam' },
    ] as Row[],
    budgets: [
      { id: 'lockridge', data: AFTER_DATA, version: 7, updated_at: '2026-10-01T13:00:00.000Z', updated_by: 'watchdog' },
      { id: 'smith', data: BEFORE_DATA, version: 1, updated_at: '2026-10-01T13:00:00.000Z', updated_by: 'user_other' },
    ] as Row[],
    /* Snapshot 31 is the budget just before request 3's data change. */
    snapshots: [
      { id: 31, budget_id: 'lockridge', clerk_user_id: 'watchdog', reason: 'watchdog', data: BEFORE_DATA },
    ] as Row[],
    requests: [
      requestRow(1, { status: 'blocked', summary: 'That one needs Cooper.' }),
      requestRow(2, { status: 'needs_answer', question: 'Percent or dollars?' }),
      requestRow(3, {
        status: 'done',
        lane: 'data',
        summary: 'Wedding now gets 15%.',
        changes: CHANGES,
        snapshot_id: 31,
        applied_version: 7,
      }),
      requestRow(4, { status: 'done', lane: 'code', summary: 'Added a chart.', commit_sha: 'abc1234def' }),
      requestRow(5, { budget_id: 'smith', clerk_user_id: 'user_other', author_label: 'Sam', body: 'smith secret plan' }),
      requestRow(6, {
        budget_id: 'smith',
        clerk_user_id: 'user_other',
        author_label: 'Sam',
        status: 'needs_answer',
        question: 'Which fund?',
      }),
    ] as Row[],
    failWith: null as null | { status: number, body: string },
    /* Runs once, just before the next PATCH on budgets, to play another
       device saving in the middle of an undo. */
    beforeBudgetPatch: null as null | (() => void),
  }
  const calls: Call[] = []
  const tables: Record<string, Row[]> = {
    budget_members: state.members,
    budgets: state.budgets,
    budget_snapshots: state.snapshots,
    budget_requests: state.requests,
  }
  const NOT_FILTERS = new Set(['select', 'order', 'limit'])

  /* eq.x and in.(a,b) are the only two operators the handler uses. */
  const matches = (row: Row, q: URLSearchParams) => {
    for (const [column, filter] of q) {
      if (NOT_FILTERS.has(column)) continue
      const value = String(row[column])
      if (filter.startsWith('eq.')) {
        if (value !== filter.slice(3)) return false
      } else if (filter.startsWith('in.(') && filter.endsWith(')')) {
        if (!filter.slice(4, -1).split(',').includes(value)) return false
      } else {
        throw new Error(`fake PostgREST: unknown filter ${column}=${filter}`)
      }
    }
    return true
  }

  const project = (row: Row, q: URLSearchParams) => {
    const select = q.get('select')
    if (!select) return { ...row }
    return Object.fromEntries(select.split(',').map((column) => [column, row[column]]))
  }

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

    const name = url.pathname.replace('/rest/v1/', '')
    const rows = tables[name]
    const q = url.searchParams
    if (!rows) return new Response('unhandled', { status: 400 })

    if (call.method === 'GET') {
      let found = rows.filter((row) => matches(row, q))
      if (q.get('order') === 'created_at.desc,id.desc') {
        found = [...found].sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id))
      }
      const limit = q.get('limit')
      if (limit) found = found.slice(0, Number(limit))
      return Response.json(found.map((row) => project(row, q)))
    }
    if (call.method === 'PATCH') {
      if (name === 'budgets' && state.beforeBudgetPatch) {
        const hook = state.beforeBudgetPatch
        state.beforeBudgetPatch = null
        hook()
      }
      const found = rows.filter((row) => matches(row, q))
      for (const row of found) Object.assign(row, call.body as Row)
      return Response.json(found.map((row) => project(row, q)))
    }
    if (call.method === 'POST' && name === 'budget_requests') {
      const id = Math.max(0, ...rows.map((row) => Number(row.id))) + 1
      const row = { ...requestRow(id), created_at: '2026-10-02T09:00:00.000Z', updated_at: '2026-10-02T09:00:00.000Z', ...(call.body as Row) }
      rows.push(row)
      return Response.json([project(row, q)], { status: 201 })
    }
    if (call.method === 'POST' && name === 'budget_snapshots') {
      rows.push({ id: 100 + rows.length, ...(call.body as Row) })
      return new Response(null, { status: 201 })
    }
    return new Response('unhandled', { status: 400 })
  }

  return { state, calls, fetch }
}

const verify: RequestsDeps['verify'] = async (request) => {
  const header = request.headers.get('authorization')
  if (header === 'Bearer laken-token') return { userId: 'user_laken' }
  if (header === 'Bearer cooper-token') return { userId: 'user_cooper' }
  if (header === 'Bearer other-token') return { userId: 'user_other' }
  if (header === 'Bearer stranger-token') return { userId: 'user_stranger' }
  throw new ClerkAuthError('bad_signature')
}

function request(method: string, options: { token?: string, body?: unknown } = {}) {
  const { token = 'laken-token', body } = options
  return new Request(`${APP}/api/requests`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const post = (body: unknown, token?: string) => handleRequests(request('POST', { token, body }), deps)

const row = (id: number) => db.state.requests.find((r) => r.id === id)!
const lockridge = () => db.state.budgets[0]
const writes = () => db.calls.filter((c) => c.method !== 'GET')
const path = (c: Call) => `${c.method} ${c.url.pathname.replace('/rest/v1/', '')}`

let db: ReturnType<typeof fakeSupabase>
let deps: RequestsDeps

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

/* Checked after every test, so no code path can slip an Authorization header
   past the suite. */
afterEach(() => {
  for (const call of db.calls) {
    expect(call.headers.get('apikey')).toBe(SECRET)
    expect(call.headers.has('authorization')).toBe(false)
  }
})

describe('GET /api/requests', () => {
  test('member → 200 with this budget\'s rows, newest first, in the public shape', async () => {
    const response = await handleRequests(request('GET'), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { requests } = await response.json() as { requests: Row[] }
    expect(requests.map((r) => r.id)).toEqual([4, 3, 2, 1])
    expect(requests[1]).toEqual({
      id: 3,
      author: 'Laken',
      body: 'request 3',
      status: 'done',
      lane: 'data',
      question: null,
      answer: null,
      summary: 'Wedding now gets 15%.',
      changes: CHANGES,
      canUndo: true,
      createdAt: '2026-10-01T12:00:03.000Z',
      updatedAt: '2026-10-01T12:00:03.000Z',
    })
    expect(requests[2]).toMatchObject({ id: 2, status: 'needs_answer', question: 'Percent or dollars?', canUndo: false })
  })

  test('reads members, then the budget row once, then the list', async () => {
    await handleRequests(request('GET'), deps)
    expect(db.calls.map(path)).toEqual(['GET budget_members', 'GET budgets', 'GET budget_requests'])
    const list = db.calls[2].url.searchParams
    expect(list.get('budget_id')).toBe('eq.lockridge')
    expect(list.get('order')).toBe('created_at.desc,id.desc')
    expect(list.get('limit')).toBe('20')
  })

  test('never asks for or returns clerk_user_id, snapshot_id or commit_sha', async () => {
    const response = await handleRequests(request('GET'), deps)
    const text = await response.text()
    for (const secret of ['clerk_user_id', 'user_laken', 'snapshot_id', 'snapshotId', 'commit_sha', 'commitSha', 'abc1234def', 'applied_version']) {
      expect(text).not.toContain(secret)
    }
    const select = db.calls[2].url.searchParams.get('select')!.split(',')
    expect(select).not.toContain('clerk_user_id')
    expect(select).not.toContain('commit_sha')
  })

  test('only the 20 newest come back', async () => {
    for (let id = 7; id <= 30; id++) db.state.requests.push(requestRow(id, { status: 'blocked' }))
    const response = await handleRequests(request('GET'), deps)
    const { requests } = await response.json() as { requests: Row[] }
    expect(requests.length).toBe(20)
    expect(requests[0].id).toBe(30)
    expect(requests[19].id).toBe(11)
  })

  test('a budget with no requests → an empty list', async () => {
    db.state.requests.length = 0
    const response = await handleRequests(request('GET'), deps)
    expect(await response.json()).toEqual({ requests: [] })
  })

  const notUndoable: [string, Row][] = [
    ['the budget version moved on', { applied_version: 6 }],
    ['a code change', { lane: 'code' }],
    ['no snapshot', { snapshot_id: null }],
    ['no applied version', { applied_version: null }],
    ['already undone', { status: 'undone' }],
    ['blocked', { status: 'blocked' }],
  ]

  for (const [label, fields] of notUndoable) {
    test(`canUndo is false for ${label}`, async () => {
      Object.assign(row(3), fields)
      const response = await handleRequests(request('GET'), deps)
      const { requests } = await response.json() as { requests: Row[] }
      expect(requests.find((r) => r.id === 3)!.canUndo).toBe(false)
    })
  }

  test('canUndo survives PostgREST sending bigints as strings', async () => {
    Object.assign(row(3), { applied_version: '7', snapshot_id: '31' })
    Object.assign(lockridge(), { version: '7' })
    const response = await handleRequests(request('GET'), deps)
    const { requests } = await response.json() as { requests: Row[] }
    expect(requests.find((r) => r.id === 3)!.canUndo).toBe(true)
  })

  test('not a member → 403 with the user id and nothing else read', async () => {
    const response = await handleRequests(request('GET', { token: 'stranger-token' }), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_member', userId: 'user_stranger' })
    expect(db.calls.map(path)).toEqual(['GET budget_members'])
  })

  test('a member of another budget sees only that budget\'s rows', async () => {
    const response = await handleRequests(request('GET', { token: 'other-token' }), deps)
    const { requests } = await response.json() as { requests: Row[] }
    expect(requests.map((r) => r.id)).toEqual([6, 5])
    expect(requests.every((r) => r.author === 'Sam')).toBe(true)

    const mine = await (await handleRequests(request('GET'), deps)).text()
    expect(mine).not.toContain('smith secret plan')
  })
})

describe('POST /api/requests { body }', () => {
  test('inserts a trimmed request under the member\'s label → 201 { id }', async () => {
    const response = await post({ body: '  retire the Italy fund \n' }, 'cooper-token')
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 7 })

    const insert = writes()[0]
    expect(path(insert)).toBe('POST budget_requests')
    expect(insert.url.searchParams.get('select')).toBe('id')
    expect(insert.headers.get('prefer')).toBe('return=representation')
    expect(insert.headers.get('content-type')).toBe('application/json')
    expect(insert.body).toEqual({
      budget_id: 'lockridge',
      clerk_user_id: 'user_cooper',
      author_label: 'Cooper',
      body: 'retire the Italy fund',
    })
    expect(row(7)).toMatchObject({ status: 'new', author_label: 'Cooper', body: 'retire the Italy fund' })
    expect(writes().length).toBe(1)
  })

  test('2000 characters is accepted, counted the way Postgres counts', async () => {
    expect((await post({ body: 'x'.repeat(2000) })).status).toBe(201)
    /* An emoji is two UTF-16 units but one character to char_length. */
    expect((await post({ body: '🎄'.repeat(2000) })).status).toBe(201)
  })

  const invalidBodies: [string, unknown][] = [
    ['not JSON', '{"body": '],
    ['an array', ['retire the Italy fund']],
    ['null', 'null'],
    ['an empty object', {}],
    ['body is a number', { body: 42 }],
    ['body is empty', { body: '' }],
    ['body is only spaces', { body: '  \n\t ' }],
    ['body is 2001 characters', { body: 'x'.repeat(2001) }],
    ['body over 1 MB', { body: 'x'.repeat(1024 * 1024) }],
  ]

  for (const [label, body] of invalidBodies) {
    test(`invalid body (${label}) → 400 and no insert`, async () => {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_body' })
      expect(writes()).toEqual([])
      expect(db.state.requests.length).toBe(6)
    })
  }

  test('five open requests → 429 too_many_open and no insert', async () => {
    /* Lockridge starts with one open row (request 2). new, in_progress and
       needs_answer all count; finished rows do not. */
    db.state.requests.push(
      requestRow(7, { status: 'new' }),
      requestRow(8, { status: 'in_progress' }),
      requestRow(9, { status: 'new' }),
    )
    expect((await post({ body: 'the fifth' })).status).toBe(201)

    const response = await post({ body: 'one too many' })
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: 'too_many_open' })
    expect(db.state.requests.some((r) => r.body === 'one too many')).toBe(false)

    const count = db.calls.findLast((c) => path(c) === 'GET budget_requests')!.url.searchParams
    expect(count.get('budget_id')).toBe('eq.lockridge')
    expect(count.get('status')).toBe('in.(new,in_progress,needs_answer)')
  })

  test('the cap counts one budget only', async () => {
    for (let id = 7; id <= 12; id++) db.state.requests.push(requestRow(id, { budget_id: 'smith', status: 'new' }))
    expect((await post({ body: 'still room here' })).status).toBe(201)
    expect((await post({ body: 'none here' }, 'other-token')).status).toBe(429)
  })

  test('not a member → 403 and no insert', async () => {
    const response = await post({ body: 'let me in' }, 'stranger-token')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_member', userId: 'user_stranger' })
    expect(writes()).toEqual([])
  })
})

describe('POST /api/requests { id, answer }', () => {
  test('stores the answer and puts the request back in the queue', async () => {
    const response = await post({ id: 2, answer: '  percent  ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})

    const patch = writes()[0]
    expect(path(patch)).toBe('PATCH budget_requests')
    expect(patch.url.searchParams.get('id')).toBe('eq.2')
    expect(patch.url.searchParams.get('budget_id')).toBe('eq.lockridge')
    expect(patch.url.searchParams.get('status')).toBe('eq.needs_answer')
    const body = patch.body as Row
    expect(Object.keys(body).sort()).toEqual(['answer', 'status', 'updated_at'])
    expect(body).toMatchObject({ answer: 'percent', status: 'new' })
    expect(Number.isNaN(Date.parse(body.updated_at as string))).toBe(false)

    expect(row(2)).toMatchObject({ status: 'new', answer: 'percent', question: 'Percent or dollars?' })
  })

  test('a request that is not waiting for an answer → 409 not_waiting', async () => {
    for (const id of [1, 3]) {
      const response = await post({ id, answer: 'percent' })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'not_waiting' })
      expect(row(id).answer).toBeNull()
    }
  })

  test('answering twice → the second is refused', async () => {
    expect((await post({ id: 2, answer: 'percent' })).status).toBe(200)
    expect((await post({ id: 2, answer: 'dollars' })).status).toBe(409)
    expect(row(2).answer).toBe('percent')
  })

  test('an id that does not exist → 409 not_waiting', async () => {
    const response = await post({ id: 999, answer: 'percent' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_waiting' })
  })

  test('another budget\'s waiting request cannot be answered', async () => {
    const response = await post({ id: 6, answer: 'the Italy one' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_waiting' })
    expect(row(6)).toMatchObject({ status: 'needs_answer', answer: null })
  })

  const invalidAnswers: [string, unknown][] = [
    ['answer missing', { id: 2 }],
    ['answer is a number', { id: 2, answer: 15 }],
    ['answer is only spaces', { id: 2, answer: '   ' }],
    ['answer is 2001 characters', { id: 2, answer: 'x'.repeat(2001) }],
    ['undo is not true', { id: 2, undo: 'yes' }],
    ['id is a string', { id: '2', answer: 'percent' }],
    ['id is fractional', { id: 2.5, answer: 'percent' }],
    ['id is zero', { id: 0, answer: 'percent' }],
    ['id is null', { id: null, answer: 'percent' }],
  ]

  for (const [label, body] of invalidAnswers) {
    test(`invalid body (${label}) → 400 and no write`, async () => {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_body' })
      expect(writes()).toEqual([])
    })
  }
})

describe('POST /api/requests { id, undo }', () => {
  test('restores the snapshot, bumps the version and marks the request undone', async () => {
    const response = await post({ id: 3, undo: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 8 })

    expect(lockridge()).toMatchObject({ data: BEFORE_DATA, version: 8, updated_by: 'user_laken' })
    expect(lockridge().updated_at).not.toBe('2026-10-01T13:00:00.000Z')
    expect(row(3).status).toBe('undone')
    expect(row(3).updated_at).not.toBe('2026-10-01T12:00:03.000Z')
  })

  test('writes an undo snapshot of the current budget before anything else', async () => {
    await post({ id: 3, undo: true })
    expect(writes().map(path)).toEqual(['POST budget_snapshots', 'PATCH budgets', 'PATCH budget_requests'])

    expect(writes()[0].body).toEqual({
      budget_id: 'lockridge',
      clerk_user_id: 'user_laken',
      reason: 'undo',
      data: AFTER_DATA,
    })

    const save = writes()[1]
    expect(save.url.searchParams.get('id')).toBe('eq.lockridge')
    expect(save.url.searchParams.get('version')).toBe('eq.7')
    expect(save.body).toMatchObject({ data: BEFORE_DATA, version: 8, updated_by: 'user_laken' })

    const mark = writes()[2]
    expect(mark.url.searchParams.get('id')).toBe('eq.3')
    expect(mark.url.searchParams.get('budget_id')).toBe('eq.lockridge')
    expect(mark.body).toMatchObject({ status: 'undone' })
  })

  test('the snapshot is looked up inside this budget', async () => {
    await post({ id: 3, undo: true })
    const read = db.calls.find((c) => path(c) === 'GET budget_snapshots')!.url.searchParams
    expect(read.get('id')).toBe('eq.31')
    expect(read.get('budget_id')).toBe('eq.lockridge')
    expect(read.get('select')).toBe('data')
  })

  test('refused after the budget version moved, with nothing written', async () => {
    Object.assign(lockridge(), { version: 8, data: { ...AFTER_DATA, rollRange: { min: 1, max: 2 } } })
    const response = await post({ id: 3, undo: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cannot_undo' })
    expect(writes()).toEqual([])
    expect(lockridge().version).toBe(8)
    expect(row(3).status).toBe('done')
  })

  test('a save that lands mid-undo wins: 409, the budget and the request untouched', async () => {
    const theirs = { ...AFTER_DATA, funds: [{ id: 'italy', current: 99 }] }
    db.state.beforeBudgetPatch = () => Object.assign(lockridge(), { version: 8, data: theirs })

    const response = await post({ id: 3, undo: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cannot_undo' })
    expect(lockridge()).toMatchObject({ version: 8, data: theirs })
    expect(row(3).status).toBe('done')
    /* The undo snapshot was already kept; an extra copy loses nothing. */
    expect(writes().map(path)).toEqual(['POST budget_snapshots', 'PATCH budgets'])
  })

  test('undo works once', async () => {
    expect((await post({ id: 3, undo: true })).status).toBe(200)
    const second = await post({ id: 3, undo: true })
    expect(second.status).toBe(409)
    expect(lockridge().version).toBe(8)
    expect(db.state.snapshots.filter((s) => s.reason === 'undo').length).toBe(1)
  })

  const refused: [string, number, Row][] = [
    ['a code change', 4, {}],
    ['a blocked request', 1, {}],
    ['a request still waiting', 2, {}],
    ['a done request with no snapshot', 3, { snapshot_id: null }],
    ['a done request with no applied version', 3, { applied_version: null }],
    ['a request already undone', 3, { status: 'undone' }],
    ['an id that does not exist', 999, {}],
  ]

  for (const [label, id, fields] of refused) {
    test(`${label} → 409 cannot_undo and no write`, async () => {
      if (row(id)) Object.assign(row(id), fields)
      const response = await post({ id, undo: true })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'cannot_undo' })
      expect(writes()).toEqual([])
      expect(lockridge()).toMatchObject({ version: 7, data: AFTER_DATA })
    })
  }

  test('a snapshot that is gone → 409 cannot_undo and no write', async () => {
    db.state.snapshots.length = 0
    const response = await post({ id: 3, undo: true })
    expect(response.status).toBe(409)
    expect(writes()).toEqual([])
  })

  test('another budget\'s member cannot undo this budget\'s change', async () => {
    /* Line the other budget up so only the budget_id filter stands in the way. */
    Object.assign(db.state.budgets[1], { version: 7 })
    const response = await post({ id: 3, undo: true }, 'other-token')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cannot_undo' })
    expect(writes()).toEqual([])
    expect(lockridge()).toMatchObject({ version: 7, data: AFTER_DATA })
    expect(row(3).status).toBe('done')
  })

  test('a snapshot from another budget is never restored', async () => {
    db.state.snapshots[0].budget_id = 'smith'
    const response = await post({ id: 3, undo: true })
    expect(response.status).toBe(409)
    expect(writes()).toEqual([])
  })

  test('not a member → 403 and no write', async () => {
    const response = await post({ id: 3, undo: true }, 'stranger-token')
    expect(response.status).toBe(403)
    expect(writes()).toEqual([])
  })
})

describe('everything else', () => {
  test('other methods → 405 before any auth or database work', async () => {
    let verified = false
    const spyDeps = { ...deps, verify: async () => { verified = true; return { userId: 'user_laken' } } }
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await handleRequests(request(method), spyDeps)
      expect(response.status).toBe(405)
      expect(await response.json()).toEqual({ error: 'method_not_allowed' })
      expect(response.headers.get('allow')).toBe('GET, POST')
    }
    expect(verified).toBe(false)
    expect(db.calls).toEqual([])
  })

  test('route file exports the Web handlers Vercel looks for', () => {
    for (const handler of [GET, POST]) expect(typeof handler).toBe('function')
  })

  test('a rejected token → 401 with no database call', async () => {
    for (const method of ['GET', 'POST']) {
      const response = await handleRequests(request(method, { token: 'forged', body: method === 'POST' ? { body: 'hi' } : undefined }), deps)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
    expect(db.calls).toEqual([])
  })

  test('the device cookie works in place of a Clerk token', async () => {
    const env = { ...ENV, DEVICE_SESSION_SECRET: DEVICE_SECRET }
    const token = signDeviceToken({ userId: 'user_laken', name: 'Laken' }, DEVICE_SECRET, Date.now())
    const remembered = new Request(`${APP}/api/requests`, { headers: { cookie: `${DEVICE_COOKIE}=${token}` } })
    const response = await handleRequests(remembered, { env, fetch: db.fetch })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { requests: Row[] }).requests.length).toBe(4)

    const forged = new Request(`${APP}/api/requests`, { headers: { cookie: `${DEVICE_COOKIE}=${token}x` } })
    expect((await handleRequests(forged, { env, fetch: db.fetch })).status).toBe(401)
    const nothing = new Request(`${APP}/api/requests`)
    expect((await handleRequests(nothing, { env, fetch: db.fetch })).status).toBe(401)
  })

  test('a Supabase error → 502 without leaking the key or the raw error', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    db.state.failWith = { status: 500, body: `permission denied for table budget_requests (apikey ${SECRET})` }
    try {
      for (const call of [request('GET'), request('POST', { body: { body: 'hi' } })]) {
        const response = await handleRequests(call, deps)
        expect(response.status).toBe(502)
        const text = await response.text()
        expect(text).toBe('{"error":"upstream_error"}')
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain('permission denied')
      }
    } finally {
      quiet.mockRestore()
    }
  })

  test('a network failure reaching Supabase → 502', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await handleRequests(request('GET'), {
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
      const response = await handleRequests(request('GET'), { ...deps, env: { SUPABASE_URL } })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'server_misconfigured' })
      expect(db.calls).toEqual([])
    } finally {
      quiet.mockRestore()
    }
  })

  test('a member whose budget row is missing → 500 server_error', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    db.state.budgets.length = 0
    try {
      const response = await handleRequests(request('GET'), deps)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'server_error' })
    } finally {
      quiet.mockRestore()
    }
  })

  test('no response of any kind carries a Clerk user id of a member', async () => {
    const responses = [
      await handleRequests(request('GET'), deps),
      await post({ body: 'add a Christmas 2027 fund' }),
      await post({ id: 2, answer: 'percent' }),
      await post({ id: 3, undo: true }),
      await post({ id: 3, undo: true }),
      await post({ id: 1, answer: 'too late' }),
      await post({ body: '' }),
      await handleRequests(request('GET'), deps),
    ]
    expect(responses.map((r) => r.status)).toEqual([200, 201, 200, 200, 409, 409, 400, 200])
    for (const response of responses) {
      const text = await response.text()
      expect(text).not.toContain('clerk_user_id')
      expect(text).not.toContain('user_laken')
      expect(text).not.toContain('user_cooper')
    }
  })
})
