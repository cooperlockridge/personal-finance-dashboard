import { describe, expect, test } from 'bun:test'
import { createDeviceApi } from '../../src/lib/deviceSession'

type Sent = { url: string; init: RequestInit }
type Answer = { status: number; body?: unknown; text?: string } | 'network-down'

/* A fetch that answers from a script, one entry per request, and records
   what was sent. */
function scriptedFetch(answers: Answer[]) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    sent.push({ url, init })
    const answer = answers.shift() ?? 'network-down'
    if (answer === 'network-down') throw new TypeError('Failed to fetch')
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), { status: answer.status })
  }
  return { fetch, sent }
}

const LAKEN = { userId: 'user_laken', name: 'Laken' }

describe('device API client', () => {
  test('check asks with no token and reads who is remembered', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: LAKEN }])
    expect(await createDeviceApi({ fetch }).check()).toEqual(LAKEN)
    expect(sent[0].url).toBe('/api/device')
    expect(sent[0].init.method).toBe('GET')
    expect(sent[0].init.headers).toEqual({ Accept: 'application/json' })
  })

  test('check is null for a 401, no answer, a page that is not JSON, or a body with no user', async () => {
    const answers: Answer[] = [
      { status: 401, body: { error: 'unauthorized' } },
      'network-down',
      { status: 200, text: '<!doctype html>' },
      { status: 200, body: { name: 'Laken' } },
    ]
    for (const answer of answers) {
      const { fetch } = scriptedFetch([answer])
      expect(await createDeviceApi({ fetch }).check()).toBeNull()
    }
  })

  test('remember posts the Clerk token as a Bearer header', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: { userId: 'user_laken' } }])
    expect(await createDeviceApi({ fetch }).remember('token-1')).toEqual({ userId: 'user_laken', name: null })
    expect(sent[0].init.method).toBe('POST')
    expect((sent[0].init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
  })

  test('remember is null when the server declines', async () => {
    for (const status of [401, 403, 500]) {
      const { fetch } = scriptedFetch([{ status, body: { error: 'nope' } }])
      expect(await createDeviceApi({ fetch }).remember('token-1')).toBeNull()
    }
  })

  test('forget reports whether the cookie was really cleared', async () => {
    const cleared = scriptedFetch([{ status: 200 }])
    expect(await createDeviceApi({ fetch: cleared.fetch }).forget()).toBe(true)
    expect(cleared.sent[0].init.method).toBe('DELETE')
    expect(await createDeviceApi({ fetch: scriptedFetch(['network-down']).fetch }).forget()).toBe(false)
    expect(await createDeviceApi({ fetch: scriptedFetch([{ status: 500 }]).fetch }).forget()).toBe(false)
  })
})
