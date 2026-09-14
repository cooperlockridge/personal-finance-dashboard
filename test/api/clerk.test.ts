import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  ClerkAuthError,
  clearJwksCache,
  clerkConfigFromEnv,
  DEFAULT_CLERK_ISSUER,
  verifyClerkRequest,
  verifyClerkToken,
  type ClerkConfig,
  type Jwk,
} from '../../api/_lib/clerk.ts'
import { handleBudget } from '../../api/budget.ts'

/* Spec test group 1: Clerk verify. Real RS256 keys are generated here and
   served through the injected JWKS fetcher, so nothing leaves the machine. */

const ISSUER = DEFAULT_CLERK_ISSUER
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const START_MS = Date.UTC(2026, 8, 14, 18, 0, 0)
const START_S = START_MS / 1000

type TestKey = { kid: string, jwk: Jwk, privateKey: KeyObject }

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as Jwk
  return { kid, jwk, privateKey }
}

const keyA = makeKey('ins_key_a')
const keyB = makeKey('ins_key_b')
const outsider = makeKey('ins_key_a')

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: 'user_laken',
    iat: START_S - 10,
    nbf: START_S - 10,
    exp: START_S + 60,
    azp: 'https://personal-finance-dashboard-ashen.vercel.app',
    ...overrides,
  }
}

function signToken(key: TestKey, payload: Record<string, unknown> = claims(), header: Record<string, unknown> = {}) {
  const h = encode({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header })
  const p = encode(payload)
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url')
  return `${h}.${p}.${s}`
}

/* Each round is the key set one JWKS fetch returns; the last round repeats. */
function jwksServer(...rounds: Jwk[][]) {
  const calls: string[] = []
  const fetchJwks = async (url: string) => {
    calls.push(url)
    return { keys: rounds[Math.min(calls.length - 1, rounds.length - 1)] }
  }
  return { calls, fetchJwks }
}

let clock = START_MS

function config(fetchJwks: ClerkConfig['fetchJwks'], overrides: Partial<ClerkConfig> = {}): ClerkConfig {
  return {
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    authorizedParties: ['http://localhost:5173'],
    fetchJwks,
    now: () => clock,
    ...overrides,
  }
}

async function reasonFor(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ClerkAuthError)
    return (error as ClerkAuthError).reason
  }
  throw new Error('expected the token to be rejected')
}

const realFetch = globalThis.fetch

beforeAll(() => {
  /* Belt and braces: any accidental real network call fails the test. */
  globalThis.fetch = (async () => {
    throw new Error('network is disabled in tests')
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  clearJwksCache()
  clock = START_MS
})

describe('verifyClerkToken', () => {
  test('accepts a valid token and returns the user id', async () => {
    const server = jwksServer([keyA.jwk])
    expect(await verifyClerkToken(signToken(keyA), config(server.fetchJwks))).toEqual({ userId: 'user_laken' })
    expect(server.calls).toEqual([JWKS_URL])
  })

  test('rejects a tampered payload', async () => {
    const server = jwksServer([keyA.jwk])
    const [h, , s] = signToken(keyA).split('.')
    const forged = `${h}.${encode(claims({ sub: 'user_attacker' }))}.${s}`
    expect(await reasonFor(verifyClerkToken(forged, config(server.fetchJwks)))).toBe('bad_signature')
  })

  test('rejects a flipped signature byte', async () => {
    const server = jwksServer([keyA.jwk])
    const [h, p, s] = signToken(keyA).split('.')
    const bytes = Buffer.from(s, 'base64url')
    bytes[10] ^= 0xff
    const forged = `${h}.${p}.${bytes.toString('base64url')}`
    expect(await reasonFor(verifyClerkToken(forged, config(server.fetchJwks)))).toBe('bad_signature')
  })

  test('rejects a token signed by a different key that claims a known kid', async () => {
    const server = jwksServer([keyA.jwk])
    expect(await reasonFor(verifyClerkToken(signToken(outsider), config(server.fetchJwks)))).toBe('bad_signature')
  })

  test('rejects the wrong issuer', async () => {
    const server = jwksServer([keyA.jwk])
    const token = signToken(keyA, claims({ iss: 'https://someone-else.clerk.accounts.dev' }))
    expect(await reasonFor(verifyClerkToken(token, config(server.fetchJwks)))).toBe('bad_issuer')
  })

  test('rejects an expired token but allows 5 s of clock skew', async () => {
    const server = jwksServer([keyA.jwk])
    const expired = signToken(keyA, claims({ exp: START_S - 6 }))
    expect(await reasonFor(verifyClerkToken(expired, config(server.fetchJwks)))).toBe('expired')

    const justInside = signToken(keyA, claims({ exp: START_S - 4 }))
    expect(await verifyClerkToken(justInside, config(server.fetchJwks))).toEqual({ userId: 'user_laken' })
  })

  test('rejects a token with no exp', async () => {
    const server = jwksServer([keyA.jwk])
    const token = signToken(keyA, claims({ exp: undefined }))
    expect(await reasonFor(verifyClerkToken(token, config(server.fetchJwks)))).toBe('expired')
  })

  test('rejects nbf in the future but allows 5 s of clock skew', async () => {
    const server = jwksServer([keyA.jwk])
    const early = signToken(keyA, claims({ nbf: START_S + 60 }))
    expect(await reasonFor(verifyClerkToken(early, config(server.fetchJwks)))).toBe('not_yet_valid')

    const justInside = signToken(keyA, claims({ nbf: START_S + 4 }))
    expect(await verifyClerkToken(justInside, config(server.fetchJwks))).toEqual({ userId: 'user_laken' })
  })

  test('rejects a missing or empty sub', async () => {
    const server = jwksServer([keyA.jwk])
    expect(await reasonFor(verifyClerkToken(signToken(keyA, claims({ sub: undefined })), config(server.fetchJwks))))
      .toBe('missing_sub')
    expect(await reasonFor(verifyClerkToken(signToken(keyA, claims({ sub: '' })), config(server.fetchJwks))))
      .toBe('missing_sub')
  })

  test('rejects a disallowed azp', async () => {
    const server = jwksServer([keyA.jwk])
    for (const azp of [
      'https://evil.example.com',
      'https://personal-finance-dashboard-ashen.vercel.app.evil.com',
      'http://personal-finance-dashboard-ashen.vercel.app',
      'https://personal-finance-dashboard.vercel.app',
      'https://other-app-ashen.vercel.app',
      42,
    ]) {
      const token = signToken(keyA, claims({ azp }))
      expect(await reasonFor(verifyClerkToken(token, config(server.fetchJwks)))).toBe('bad_azp')
    }
  })

  test('accepts production, preview, configured and absent azp', async () => {
    const server = jwksServer([keyA.jwk])
    for (const azp of [
      'https://personal-finance-dashboard-ashen.vercel.app',
      'https://personal-finance-dashboard-git-supabase-sync-cooper-lockridge.vercel.app',
      'http://localhost:5173',
      undefined,
    ]) {
      const token = signToken(keyA, claims({ azp }))
      expect(await verifyClerkToken(token, config(server.fetchJwks))).toEqual({ userId: 'user_laken' })
    }
  })

  test('an unknown kid triggers exactly one refetch, which picks up a rotated key', async () => {
    const server = jwksServer([keyA.jwk], [keyA.jwk, keyB.jwk])
    const cfg = config(server.fetchJwks)

    await verifyClerkToken(signToken(keyA), cfg)
    expect(server.calls.length).toBe(1)

    expect(await verifyClerkToken(signToken(keyB), cfg)).toEqual({ userId: 'user_laken' })
    expect(server.calls.length).toBe(2)

    /* Both keys are cached now. */
    await verifyClerkToken(signToken(keyA), cfg)
    await verifyClerkToken(signToken(keyB), cfg)
    expect(server.calls.length).toBe(2)
  })

  test('a kid that never appears refetches once per request, not in a loop', async () => {
    const server = jwksServer([keyA.jwk])
    const cfg = config(server.fetchJwks)
    const ghost = signToken({ ...keyB, kid: 'ins_ghost' })

    await verifyClerkToken(signToken(keyA), cfg)
    expect(await reasonFor(verifyClerkToken(ghost, cfg))).toBe('unknown_kid')
    expect(server.calls.length).toBe(2)
  })

  test('a cold cache does not double-fetch for an unknown kid', async () => {
    const server = jwksServer([keyA.jwk])
    const ghost = signToken({ ...keyB, kid: 'ins_ghost' })
    expect(await reasonFor(verifyClerkToken(ghost, config(server.fetchJwks)))).toBe('unknown_kid')
    expect(server.calls.length).toBe(1)
  })

  test('JWKS stays cached for 10 minutes, then refetches', async () => {
    const server = jwksServer([keyA.jwk])
    const cfg = config(server.fetchJwks)

    await verifyClerkToken(signToken(keyA), cfg)
    clock = START_MS + 10 * 60 * 1000 - 1
    await verifyClerkToken(signToken(keyA, claims({ exp: clock / 1000 + 60 })), cfg)
    expect(server.calls.length).toBe(1)

    clock = START_MS + 10 * 60 * 1000
    await verifyClerkToken(signToken(keyA, claims({ exp: clock / 1000 + 60 })), cfg)
    expect(server.calls.length).toBe(2)
  })

  test('rejects alg none and every alg other than RS256', async () => {
    const server = jwksServer([keyA.jwk])
    const cfg = config(server.fetchJwks)

    const none = `${encode({ alg: 'none', kid: keyA.kid })}.${encode(claims())}.`
    expect(await reasonFor(verifyClerkToken(none, cfg))).toBe('bad_alg')

    for (const alg of ['HS256', 'RS512', 'ES256', undefined]) {
      expect(await reasonFor(verifyClerkToken(signToken(keyA, claims(), { alg }), cfg))).toBe('bad_alg')
    }
    /* A bad alg is refused before any key lookup. */
    expect(server.calls.length).toBe(0)
  })

  test('rejects a missing kid', async () => {
    const server = jwksServer([keyA.jwk])
    const token = signToken(keyA, claims(), { kid: undefined })
    expect(await reasonFor(verifyClerkToken(token, config(server.fetchJwks)))).toBe('missing_kid')
  })

  test('rejects garbage segments', async () => {
    const server = jwksServer([keyA.jwk])
    expect(await reasonFor(verifyClerkToken('abc.def.ghi', config(server.fetchJwks)))).toBe('malformed')
    expect(await reasonFor(verifyClerkToken('only.two', config(server.fetchJwks)))).toBe('malformed')
  })

  test('a JWKS outage is not an auth failure', async () => {
    const cfg = config(async () => {
      throw new Error('clerk is down')
    })
    let thrown: unknown
    try {
      await verifyClerkToken(signToken(keyA), cfg)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(ClerkAuthError)
  })
})

describe('verifyClerkRequest', () => {
  const request = (authorization?: string) => new Request('https://personal-finance-dashboard-ashen.vercel.app/api/budget', {
    headers: authorization === undefined ? {} : { authorization },
  })

  test('reads the Bearer token', async () => {
    const server = jwksServer([keyA.jwk])
    expect(await verifyClerkRequest(request(`Bearer ${signToken(keyA)}`), config(server.fetchJwks)))
      .toEqual({ userId: 'user_laken' })
  })

  test('missing or malformed Authorization header is rejected without fetching keys', async () => {
    const server = jwksServer([keyA.jwk])
    for (const header of [undefined, '', 'Bearer', 'Bearer ', `Basic ${signToken(keyA)}`, 'Bearer not-a-jwt']) {
      expect(await reasonFor(verifyClerkRequest(request(header), config(server.fetchJwks)))).toBe('missing_token')
    }
    expect(server.calls.length).toBe(0)
  })

  test('missing header → 401 from the budget handler, with no Supabase call', async () => {
    const server = jwksServer([keyA.jwk])
    const supabaseCalls: string[] = []
    const deps = {
      env: { SUPABASE_URL: 'https://example-ref.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' },
      verify: (req: Request) => verifyClerkRequest(req, config(server.fetchJwks)),
      fetch: async (input: string) => {
        supabaseCalls.push(input)
        return new Response('[]')
      },
    }

    const missing = await handleBudget(request(), deps)
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'unauthorized' })

    const expired = await handleBudget(request(`Bearer ${signToken(keyA, claims({ exp: START_S - 60 }))}`), deps)
    expect(expired.status).toBe(401)

    expect(supabaseCalls).toEqual([])
  })
})

describe('clerkConfigFromEnv', () => {
  test('falls back to the dev instance issuer and its JWKS URL', () => {
    const cfg = clerkConfigFromEnv({})
    expect(cfg.issuer).toBe('https://meet-moose-71.clerk.accounts.dev')
    expect(cfg.jwksUrl).toBe('https://meet-moose-71.clerk.accounts.dev/.well-known/jwks.json')
    expect(cfg.authorizedParties).toEqual([])
  })

  test('reads overrides and splits authorized parties', () => {
    const cfg = clerkConfigFromEnv({
      CLERK_ISSUER: 'https://clerk.example.com/',
      CLERK_AUTHORIZED_PARTIES: ' http://localhost:5173 , https://example.com,,',
    })
    expect(cfg.issuer).toBe('https://clerk.example.com')
    expect(cfg.jwksUrl).toBe('https://clerk.example.com/.well-known/jwks.json')
    expect(cfg.authorizedParties).toEqual(['http://localhost:5173', 'https://example.com'])

    expect(clerkConfigFromEnv({ CLERK_JWKS_URL: 'https://keys.example.com/jwks' }).jwksUrl)
      .toBe('https://keys.example.com/jwks')
  })
})
