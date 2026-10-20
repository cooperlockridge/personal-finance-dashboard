import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { deviceSecretFromEnv } from './device.js'
import type { Env } from './http.js'

/* OAuth for the Claude connector (2026-10-19).

   Claude's custom connectors sign in with OAuth 2.1: they register
   themselves, send the person to an authorize page, and swap the code that
   comes back for a token. Everything here is stateless on purpose. Each
   artifact (client id, pending request, code, access and refresh token) is a
   small signed document in the same <payload>.<HMAC> shape as the device
   cookie, so no new table holds anything. Removing a row from budget_members
   still locks a login out, because every MCP call checks membership through
   /api/budget, and changing DEVICE_SESSION_SECRET signs every connector out.

   The key is derived from DEVICE_SESSION_SECRET rather than being that
   secret, so a device cookie can never pass as a token here or the other
   way round. */

export const ACCESS_TTL_S = 24 * 60 * 60
export const REFRESH_TTL_S = 180 * 24 * 60 * 60
export const CODE_TTL_S = 120
export const AUTH_REQUEST_TTL_S = 15 * 60

export const SCOPE = 'budget'

export type ArtifactType = 'client' | 'authreq' | 'code' | 'access' | 'refresh'

export class OAuthTokenError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`OAuth artifact rejected: ${reason}`)
    this.name = 'OAuthTokenError'
    this.reason = reason
  }
}

export function oauthKeyFromEnv(env: Env): Buffer {
  return createHmac('sha256', deviceSecretFromEnv(env)).update('pfd-mcp-oauth-v1').digest()
}

function mac(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/* `typ` is inside the signed payload, so a code can never be replayed as an
   access token, or a client id as anything at all. */
export function signArtifact(typ: ArtifactType, claims: Record<string, unknown>, key: Buffer, nowMs: number, ttlS?: number): string {
  const iat = Math.floor(nowMs / 1000)
  const body: Record<string, unknown> = { ...claims, typ, iat }
  if (ttlS !== undefined) body.exp = iat + ttlS
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${payload}.${mac(payload, key).toString('base64url')}`
}

export function verifyArtifact(token: unknown, typ: ArtifactType, key: Buffer, nowMs: number): Record<string, unknown> {
  if (typeof token !== 'string') throw new OAuthTokenError('missing')
  const parts = token.split('.')
  if (parts.length !== 2) throw new OAuthTokenError('malformed')
  const [payload, signature] = parts
  const expected = mac(payload, key)
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new OAuthTokenError('bad_signature')
  }
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new OAuthTokenError('malformed')
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new OAuthTokenError('malformed')
  const record = claims as Record<string, unknown>
  if (record.typ !== typ) throw new OAuthTokenError('wrong_type')
  if (record.exp !== undefined && (typeof record.exp !== 'number' || nowMs / 1000 > record.exp)) {
    throw new OAuthTokenError('expired')
  }
  return record
}

/* Where an authorization code may be sent. Claude's callback on claude.ai or
   claude.com, and loopback for Claude Code and the MCP Inspector. Anything
   else is refused at registration, so a look-alike client cannot have
   Laken's approval delivered to a server of its own. */
export function isAllowedRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  if (url.protocol === 'https:') {
    return url.hostname === 'claude.ai' || url.hostname === 'claude.com' || url.hostname.endsWith('.claude.ai') || url.hostname.endsWith('.claude.com')
  }
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  }
  return false
}

/* RFC 7636 S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const given = Buffer.from(challenge)
  return computed.length === given.length && timingSafeEqual(computed, given)
}

/* The public origin of this deployment, used as the OAuth issuer and in the
   metadata documents. Taken from the request so preview deploys describe
   themselves rather than production. */
export function originOf(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host') ?? url.host
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export type AccessClaims = { userId: string, clientId: string }

export function verifyAccessToken(request: Request, key: Buffer, nowMs: number): AccessClaims {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/.exec(header.trim())
  if (!match) throw new OAuthTokenError('missing')
  const claims = verifyArtifact(match[1], 'access', key, nowMs)
  if (typeof claims.sub !== 'string' || !claims.sub) throw new OAuthTokenError('missing_sub')
  return { userId: claims.sub, clientId: typeof claims.cid === 'string' ? claims.cid : '' }
}
