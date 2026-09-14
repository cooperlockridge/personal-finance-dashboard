import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'
import type { Env } from './http.js'

/* Verifies the Clerk session token the browser sends as a Bearer header.

   Written against node:crypto instead of @clerk/backend or jose on purpose
   (2026-09-14): npm installs are banned on this machine while the supply-chain
   attack is live, and a Clerk session token is a plain RS256 JWT. The rules
   below mirror what Clerk's own verifier checks. */

export const DEFAULT_CLERK_ISSUER = 'https://meet-moose-71.clerk.accounts.dev'

/* Production is personal-finance-dashboard-ashen.vercel.app and every preview
   deploy gets its own personal-finance-dashboard-<hash>-<team>.vercel.app. The
   anchors matter: without them 'https://personal-finance-dashboard-x.vercel.app.evil.com'
   would pass. */
const VERCEL_ORIGIN = /^https:\/\/personal-finance-dashboard-[a-z0-9-]+\.vercel\.app$/

/* Clerk rotates signing keys rarely, so ten minutes of caching saves a round
   trip on almost every request while still picking up a rotation quickly. */
const JWKS_TTL_MS = 10 * 60 * 1000

/* Laptop and phone clocks drift a little from Clerk's. */
const CLOCK_SKEW_S = 5

export type Jwk = JsonWebKey & { kid?: string }

export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>

export type ClerkConfig = {
  issuer: string
  jwksUrl: string
  authorizedParties: string[]
  fetchJwks: JwksFetcher
  /* Milliseconds since the epoch. Injectable so tests can move the clock. */
  now?: () => number
}

export type ClerkUser = { userId: string }

/* Every way a token can fail maps to this one type, and the handlers map this
   type to 401. Anything else thrown (Clerk unreachable, bad JWKS response) is a
   server problem and becomes a 5xx instead, so the browser does not throw away
   a perfectly good token. */
export class ClerkAuthError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Clerk token rejected: ${reason}`)
    this.name = 'ClerkAuthError'
    this.reason = reason
  }
}

export const defaultFetchJwks: JwksFetcher = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`JWKS fetch failed with ${response.status}`)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys array')
  return { keys: body.keys as Jwk[] }
}

/* Env is read per request rather than at module load, so a changed Vercel env
   var takes effect on the next cold start without a code change, and tests can
   pass their own. */
export function clerkConfigFromEnv(env: Env, fetchJwks: JwksFetcher = defaultFetchJwks): ClerkConfig {
  const issuer = trimSlashes(env.CLERK_ISSUER?.trim() || DEFAULT_CLERK_ISSUER)
  const jwksUrl = env.CLERK_JWKS_URL?.trim() || `${issuer}/.well-known/jwks.json`
  const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((party) => party.trim())
    .filter(Boolean)
  return { issuer, jwksUrl, authorizedParties, fetchJwks }
}

export async function verifyClerkRequest(request: Request, config: ClerkConfig): Promise<ClerkUser> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim())
  if (!match) throw new ClerkAuthError('missing_token')
  return verifyClerkToken(match[1], config)
}

export async function verifyClerkToken(token: string, config: ClerkConfig): Promise<ClerkUser> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new ClerkAuthError('malformed')
  const [encodedHeader, encodedPayload, encodedSignature] = parts

  const header = decodeSegment(encodedHeader)
  /* Only RS256. Accepting whatever alg the token names is the classic JWT hole:
     'none' skips the signature, and HS256 would let an attacker sign with the
     public key as an HMAC secret. */
  if (header.alg !== 'RS256') throw new ClerkAuthError('bad_alg')
  if (typeof header.kid !== 'string' || !header.kid) throw new ClerkAuthError('missing_kid')

  const payload = decodeSegment(encodedPayload)
  const key = await publicKeyFor(header.kid, config)

  let signatureValid = false
  try {
    signatureValid = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) throw new ClerkAuthError('bad_signature')

  /* Claims are only trusted after the signature checks out. */
  const nowS = (config.now?.() ?? Date.now()) / 1000
  if (payload.iss !== config.issuer) throw new ClerkAuthError('bad_issuer')
  if (typeof payload.exp !== 'number' || nowS > payload.exp + CLOCK_SKEW_S) {
    throw new ClerkAuthError('expired')
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || nowS + CLOCK_SKEW_S < payload.nbf)) {
    throw new ClerkAuthError('not_yet_valid')
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new ClerkAuthError('missing_sub')

  /* azp is the origin the token was minted for. Checking it stops a token
     lifted from some other site on the same Clerk instance from working here. */
  if (payload.azp !== undefined) {
    const azp = payload.azp
    const allowed = typeof azp === 'string' && (config.authorizedParties.includes(azp) || VERCEL_ORIGIN.test(azp))
    if (!allowed) throw new ClerkAuthError('bad_azp')
  }

  return { userId: payload.sub }
}

/* Module scope survives between requests on a warm Vercel instance, which is
   the whole point of the cache. Keyed by URL so two configs never share keys. */
type CachedJwks = { fetchedAt: number, keys: Map<string, Jwk>, parsed: Map<string, KeyObject> }
const jwksCache = new Map<string, CachedJwks>()

/* Tests call this so one case's cached keys never leak into the next. */
export function clearJwksCache() {
  jwksCache.clear()
}

async function publicKeyFor(kid: string, config: ClerkConfig): Promise<KeyObject> {
  const now = config.now?.() ?? Date.now()
  let entry = jwksCache.get(config.jwksUrl)
  let refreshed = false

  if (!entry || now - entry.fetchedAt >= JWKS_TTL_MS) {
    entry = await loadJwks(config, now)
    refreshed = true
  }

  /* An unknown kid usually means Clerk rotated keys since the cache filled, so
     refetch once. Only once: a made-up kid must not loop. */
  if (!entry.keys.has(kid) && !refreshed) {
    entry = await loadJwks(config, now)
  }

  const cached = entry.parsed.get(kid)
  if (cached) return cached

  const jwk = entry.keys.get(kid)
  if (!jwk) throw new ClerkAuthError('unknown_kid')
  if (jwk.kty !== 'RSA') throw new ClerkAuthError('bad_key_type')
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') throw new ClerkAuthError('bad_key_alg')
  if (jwk.use !== undefined && jwk.use !== 'sig') throw new ClerkAuthError('bad_key_use')

  let key: KeyObject
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    throw new ClerkAuthError('bad_key')
  }
  entry.parsed.set(kid, key)
  return key
}

async function loadJwks(config: ClerkConfig, now: number): Promise<CachedJwks> {
  const { keys } = await config.fetchJwks(config.jwksUrl)
  const byKid = new Map<string, Jwk>()
  for (const jwk of keys) {
    if (isRecord(jwk) && typeof jwk.kid === 'string') byKid.set(jwk.kid, jwk)
  }
  const entry: CachedJwks = { fetchedAt: now, keys: byKid, parsed: new Map() }
  jwksCache.set(config.jwksUrl, entry)
  return entry
}

function decodeSegment(segment: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new ClerkAuthError('malformed')
  }
  if (!isRecord(value)) throw new ClerkAuthError('malformed')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimSlashes(value: string) {
  return value.replace(/\/+$/, '')
}
