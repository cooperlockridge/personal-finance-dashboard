import { describe, expect, test } from 'bun:test'
import { createBudgetApi, type TokenGetter } from '../../src/lib/budgetApi'
import { DEFAULT_BUDGET } from '../../src/lib/finance'

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
    const text = answer.text ?? JSON.stringify(answer.body ?? {})
    return new Response(text, { status: answer.status })
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

const cloudBody = { budgetId: 'lockridge', version: 4, data: DEFAULT_BUDGET, updatedAt: '2026-09-14T12:00:00Z', updatedBy: 'user_laken' }

describe('budget API client', () => {
  test('GET sends the Clerk token as a Bearer header and asks for JSON', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: cloudBody }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    const result = await api.load()
    expect(result).toEqual({
      kind: 'ok',
      body: { version: 4, data: DEFAULT_BUDGET, updatedAt: '2026-09-14T12:00:00Z', updatedBy: 'user_laken' },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/api/budget')
    expect(sent[0].init.method).toBe('GET')
    expect(sent[0].init.body).toBeUndefined()
    const headers = sent[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-1')
    expect(headers.Accept).toBe('application/json')
  })

  test('GET accepts a budget nobody has synced yet', async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: { ...cloudBody, version: 0, data: null } }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.load()).toMatchObject({ kind: 'ok', body: { version: 0, data: null } })
  })

  test('a 401 retries once with a fresh token', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 401 }, { status: 200, body: cloudBody }])
    const token = recordingToken()
    const api = createBudgetApi({ fetch, getToken: token.getToken })
    expect((await api.load()).kind).toBe('ok')
    expect(token.calls).toEqual([undefined, { skipCache: true }])
    expect((sent[1].init.headers as Record<string, string>).Authorization).toBe('Bearer token-2')
  })

  test('a second 401 stops there as an error', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 401 }, { status: 401 }, { status: 200, body: cloudBody }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.load()).toEqual({ kind: 'failed', failure: 'error' })
    expect(sent).toHaveLength(2)
  })

  test('no token means no request', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: cloudBody }])
    const api = createBudgetApi({ fetch, getToken: recordingToken([null, null]).getToken })
    expect(await api.load()).toEqual({ kind: 'failed', failure: 'error' })
    expect(sent).toHaveLength(0)
  })

  test('403 not_member carries the user id', async () => {
    const { fetch } = scriptedFetch([{ status: 403, body: { error: 'not_member', userId: 'user_new' } }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.load()).toEqual({ kind: 'not_member', userId: 'user_new' })
  })

  test('no answer, a 404, or a non-JSON page reads as offline; a 5xx as an error', async () => {
    const cases: [Answer, string][] = [
      ['network-down', 'offline'],
      [{ status: 404, text: '<!doctype html>' }, 'offline'],
      [{ status: 200, text: '<!doctype html><title>Wi-Fi login</title>' }, 'offline'],
      [{ status: 502, body: { error: 'bad_gateway' } }, 'error'],
      [{ status: 403, text: 'Forbidden' }, 'error'],
    ]
    for (const [answer, failure] of cases) {
      const { fetch } = scriptedFetch([answer])
      const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
      expect(await api.load()).toEqual({ kind: 'failed', failure: failure as 'offline' | 'error' })
    }
  })

  test('PUT sends the base version and data, and reads the new version', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { version: 5 } }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.save(4, DEFAULT_BUDGET)).toEqual({ kind: 'ok', body: { version: 5 } })
    expect(sent[0].init.method).toBe('PUT')
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ baseVersion: 4, data: DEFAULT_BUDGET })
    expect((sent[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  test('PUT 409 hands back the cloud state', async () => {
    const { fetch } = scriptedFetch([{ status: 409, body: { error: 'stale', ...cloudBody, version: 9 } }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.save(4, DEFAULT_BUDGET)).toMatchObject({ kind: 'stale', cloud: { version: 9, data: DEFAULT_BUDGET } })
  })

  test('PUT 400 is an error', async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: 'invalid' } }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.save(4, DEFAULT_BUDGET)).toEqual({ kind: 'failed', failure: 'error' })
  })

  test('POST sends the reason and data', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 201, body: {} }])
    const api = createBudgetApi({ fetch, getToken: recordingToken().getToken })
    expect(await api.snapshot('conflict', DEFAULT_BUDGET)).toEqual({ kind: 'ok', body: null })
    expect(sent[0].init.method).toBe('POST')
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ reason: 'conflict', data: DEFAULT_BUDGET })
  })
})
