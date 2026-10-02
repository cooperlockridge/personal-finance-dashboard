import { describe, expect, test } from 'bun:test'
import type { TokenGetter } from '../../src/lib/budgetApi'
import { createRequestsApi } from '../../src/lib/requestsApi'

type Sent = { url: string; init: RequestInit }
type Answer = { status: number; body?: unknown; text?: string } | 'network-down'

/* A fetch that answers from a script, one entry per request, and records
   what was sent. */
function scriptedFetch(answers: Answer[]) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    const answer = answers.shift() ?? 'network-down'
    if (answer === 'network-down') throw new TypeError('Failed to fetch')
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), { status: answer.status })
  }
  return { fetch, sent }
}

function recordingToken(tokens: (string | null)[] = ['token-1', 'token-2']) {
  const calls: unknown[] = []
  const getToken: TokenGetter = async (options) => {
    calls.push(options)
    return tokens.shift() ?? null
  }
  return { getToken, calls }
}

const noToken: TokenGetter = async () => null

const DONE = {
  id: 7,
  author: 'Laken',
  body: 'Change Wedding to 15%',
  status: 'done',
  lane: 'data',
  question: null,
  answer: null,
  summary: 'Wedding now takes 15% of each check.',
  changes: [{ label: 'Wedding', before: '10', after: '15' }],
  canUndo: true,
  createdAt: '2026-10-02T14:00:00Z',
  updatedAt: '2026-10-03T11:30:00Z',
}

const headersOf = (sent: Sent) => sent.init.headers as Record<string, string>

describe('requests API client', () => {
  test('list sends the Clerk token as a Bearer header, asks for JSON, and skips the cache', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { requests: [DONE] } }])
    const result = await createRequestsApi({ fetch, getToken: recordingToken().getToken }).list()
    expect(result).toEqual({ kind: 'ok', requests: [DONE] })
    expect(sent[0].url).toBe('/api/requests')
    expect(sent[0].init.method).toBe('GET')
    expect(sent[0].init.cache).toBe('no-store')
    expect(sent[0].init.body).toBeUndefined()
    expect(headersOf(sent[0])).toEqual({ Accept: 'application/json', Authorization: 'Bearer token-1' })
  })

  test('with no token the request still goes out, with no Authorization header, for the device cookie to carry', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { requests: [] } }])
    expect(await createRequestsApi({ fetch, getToken: noToken }).list()).toEqual({ kind: 'ok', requests: [] })
    expect(headersOf(sent[0])).toEqual({ Accept: 'application/json' })
  })

  test('a getToken that throws is treated as no token', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { requests: [] } }])
    const getToken: TokenGetter = async () => {
      throw new Error('clerk not loaded')
    }
    expect((await createRequestsApi({ fetch, getToken }).list()).kind).toBe('ok')
    expect(headersOf(sent[0]).Authorization).toBeUndefined()
  })

  test('a 401 is retried once with a fresh token, and not a second time', async () => {
    const { fetch, sent } = scriptedFetch([
      { status: 401, body: { error: 'unauthorized' } },
      { status: 200, body: { requests: [] } },
    ])
    const token = recordingToken()
    expect((await createRequestsApi({ fetch, getToken: token.getToken }).list()).kind).toBe('ok')
    expect(token.calls).toEqual([undefined, { skipCache: true }])
    expect(headersOf(sent[1]).Authorization).toBe('Bearer token-2')

    const twice = scriptedFetch([
      { status: 401, body: { error: 'unauthorized' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 200, body: { requests: [] } },
    ])
    expect(await createRequestsApi({ fetch: twice.fetch, getToken: recordingToken().getToken }).list()).toEqual({ kind: 'failed' })
    expect(twice.sent).toHaveLength(2)
  })

  test('list fails quietly for no answer, a missing API, a page that is not JSON, a 403, or a body with no list', async () => {
    const answers: Answer[] = [
      'network-down',
      { status: 404, text: 'Not found' },
      { status: 200, text: '<!doctype html>' },
      { status: 403, body: { error: 'not_member', userId: 'user_x' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 200, body: { requests: 'nope' } },
    ]
    for (const answer of answers) {
      const { fetch } = scriptedFetch([answer])
      expect(await createRequestsApi({ fetch, getToken: noToken }).list()).toEqual({ kind: 'failed' })
    }
  })

  test('list fills in what a row leaves out and drops a row it cannot read', async () => {
    const rows = [
      { id: 3, body: 'Add a Christmas 2027 fund', status: 'new' },
      { id: 4, body: 'Retire the Italy fund', status: 'done', lane: 'elsewhere', canUndo: 'yes', changes: [] },
      { id: 5, body: 'A status from a newer server', status: 'paused' },
      { id: '6', body: 'An id that is not a number', status: 'new' },
      { id: 8, status: 'new' },
      null,
    ]
    const { fetch } = scriptedFetch([{ status: 200, body: { requests: rows } }])
    const result = await createRequestsApi({ fetch, getToken: noToken }).list()
    const blank = { question: null, answer: null, summary: null, changes: null, canUndo: false, createdAt: '', updatedAt: '' }
    expect(result).toEqual({
      kind: 'ok',
      requests: [
        { id: 3, author: '', body: 'Add a Christmas 2027 fund', status: 'new', lane: null, ...blank },
        { id: 4, author: '', body: 'Retire the Italy fund', status: 'done', lane: null, ...blank },
      ],
    })
  })

  test('a change keeps a missing side as null and a change with no label is dropped', async () => {
    const changes = [
      { label: 'Christmas 2027', after: 'Christmas 2027' },
      { label: 'Italy', before: 'Italy', after: null },
      { before: '1', after: '2' },
      'not a change',
    ]
    const { fetch } = scriptedFetch([{ status: 200, body: { requests: [{ ...DONE, changes }] } }])
    const result = await createRequestsApi({ fetch, getToken: noToken }).list()
    expect(result.kind === 'ok' && result.requests[0].changes).toEqual([
      { label: 'Christmas 2027', before: null, after: 'Christmas 2027' },
      { label: 'Italy', before: 'Italy', after: null },
    ])
  })

  test('submit posts the text as JSON and returns the new id', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 201, body: { id: 12 } }])
    const result = await createRequestsApi({ fetch, getToken: recordingToken().getToken }).submit('Retire the Italy fund')
    expect(result).toEqual({ kind: 'ok', id: 12 })
    expect(sent[0].init.method).toBe('POST')
    expect(sent[0].init.cache).toBe('no-store')
    expect(headersOf(sent[0])).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ body: 'Retire the Italy fund' })
  })

  test('submit tells five-already-waiting apart from every other refusal', async () => {
    const full = scriptedFetch([{ status: 429, body: { error: 'too_many_open' } }])
    expect(await createRequestsApi({ fetch: full.fetch, getToken: noToken }).submit('One more')).toEqual({ kind: 'too_many_open' })

    const answers: Answer[] = [
      'network-down',
      { status: 400, body: { error: 'invalid_body' } },
      { status: 429, body: { error: 'rate_limited' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 201, text: '<!doctype html>' },
      { status: 200, body: { id: 12 } },
    ]
    for (const answer of answers) {
      const { fetch } = scriptedFetch([answer])
      expect(await createRequestsApi({ fetch, getToken: noToken }).submit('One more')).toEqual({ kind: 'failed' })
    }
  })

  test('answer posts the id with her reply', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: {} }])
    expect(await createRequestsApi({ fetch, getToken: noToken }).answer(7, 'Fifteen percent of net')).toEqual({ kind: 'ok' })
    expect(sent[0].init.method).toBe('POST')
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ id: 7, answer: 'Fifteen percent of net' })
  })

  test('answer reports a request that stopped waiting, and fails for anything else', async () => {
    const gone = scriptedFetch([{ status: 409, body: { error: 'not_waiting' } }])
    expect(await createRequestsApi({ fetch: gone.fetch, getToken: noToken }).answer(7, 'Net')).toEqual({ kind: 'not_waiting' })

    const answers: Answer[] = ['network-down', { status: 200, text: '<!doctype html>' }, { status: 409, body: { error: 'cannot_undo' } }, { status: 502, body: { error: 'upstream' } }]
    for (const answer of answers) {
      const { fetch } = scriptedFetch([answer])
      expect(await createRequestsApi({ fetch, getToken: noToken }).answer(7, 'Net')).toEqual({ kind: 'failed' })
    }
  })

  test('undo posts the id with undo: true and returns the new budget version', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { version: 9 } }])
    expect(await createRequestsApi({ fetch, getToken: noToken }).undo(7)).toEqual({ kind: 'ok', version: 9 })
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ id: 7, undo: true })
  })

  test('undo reports a budget that has moved on, and fails for anything else', async () => {
    const moved = scriptedFetch([{ status: 409, body: { error: 'cannot_undo' } }])
    expect(await createRequestsApi({ fetch: moved.fetch, getToken: noToken }).undo(7)).toEqual({ kind: 'cannot_undo' })

    const answers: Answer[] = ['network-down', { status: 200, body: {} }, { status: 409, body: { error: 'not_waiting' } }, { status: 500, body: { error: 'server_error' } }]
    for (const answer of answers) {
      const { fetch } = scriptedFetch([answer])
      expect(await createRequestsApi({ fetch, getToken: noToken }).undo(7)).toEqual({ kind: 'failed' })
    }
  })

  test('no call ever throws, even when the fetch does', async () => {
    const api = createRequestsApi({ fetch: scriptedFetch([]).fetch, getToken: noToken })
    expect(await api.list()).toEqual({ kind: 'failed' })
    expect(await api.submit('x')).toEqual({ kind: 'failed' })
    expect(await api.answer(1, 'x')).toEqual({ kind: 'failed' })
    expect(await api.undo(1)).toEqual({ kind: 'failed' })
  })
})
