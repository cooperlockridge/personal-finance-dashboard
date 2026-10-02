import { createHmac, timingSafeEqual } from 'node:crypto'
import { ClerkAuthError, clerkConfigFromEnv, verifyClerkRequest } from './clerk.js'
import { ConfigError, type Env } from './http.js'

/* "Remember this device" (2026-10-02).

   Production runs on a Clerk development instance, whose session lives in a
   cookie the browser's own script writes. Safari deletes script-written
   cookies after seven days and Clerk ends the session at seven days anyway,
   so Laken — who opens the app every other Friday — had to sign in on every
   visit.

   After one Clerk sign-in, /api/device hands the browser a cookie of our own.
   It is set by the server in a first-party response, which Safari does not
   cap, and it is HttpOnly so no script can read it. /api/budget accepts it in
   place of a Clerk token. Membership is still checked against budget_members
   on every budget request, so removing a row there locks the device out. */

/* __Host- makes the browser refuse the cookie unless it is Secure, has
   Path=/ and names no Domain — so no other subdomain can plant or read it. */
export const DEVICE_COOKIE = '__Host-pfd_device'

export const DEVICE_TTL_S = 365 * 24 * 60 * 60

/* A cookie older than this is reissued on the next visit, so a device in
   regular use never reaches the year. */
export const DEVICE_RENEW_AFTER_S = 30 * 24 * 60 * 60

/* Short enough to guess is the same as missing. */
const MIN_SECRET_LENGTH = 32

export type DeviceUser = { userId: string, name: string | null }

export type DeviceSession = DeviceUser & { issuedAt: number }

/* Every way a device cookie can fail. Handlers map it to 401, the same as a
   rejected Clerk token. */
export class DeviceAuthError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Device cookie rejected: ${reason}`)
    this.name = 'DeviceAuthError'
    this.reason = reason
  }
}

export function deviceSecretFromEnv(env: Env): string {
  const secret = env.DEVICE_SESSION_SECRET?.trim() ?? ''
  if (secret.length < MIN_SECRET_LENGTH) throw new ConfigError('DEVICE_SESSION_SECRET')
  return secret
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/* <base64url JSON>.<base64url HMAC-SHA256>. A JWT without the header: there
   is one algorithm and one key, so nothing in the token gets to choose. */
export function signDeviceToken(user: DeviceUser, secret: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const payload = Buffer.from(
    JSON.stringify({ sub: user.userId, name: user.name, iat, exp: iat + DEVICE_TTL_S }),
  ).toString('base64url')
  return `${payload}.${sign(payload, secret).toString('base64url')}`
}

export function verifyDeviceToken(token: string, secret: string, nowMs: number): DeviceSession {
  const parts = token.split('.')
  if (parts.length !== 2) throw new DeviceAuthError('malformed')
  const [payload, signature] = parts

  const expected = sign(payload, secret)
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new DeviceAuthError('bad_signature')
  }

  /* Claims are only read after the signature checks out. */
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new DeviceAuthError('malformed')
  }
  if (typeof claims !== 'object' || claims === null) throw new DeviceAuthError('malformed')
  const { sub, name, iat, exp } = claims as Record<string, unknown>
  if (typeof sub !== 'string' || !sub) throw new DeviceAuthError('missing_sub')
  if (typeof iat !== 'number' || typeof exp !== 'number') throw new DeviceAuthError('malformed')
  if (nowMs / 1000 > exp) throw new DeviceAuthError('expired')
  return { userId: sub, name: typeof name === 'string' ? name : null, issuedAt: iat }
}

export function readDeviceCookie(request: Request): string | null {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at !== -1 && pair.slice(0, at).trim() === DEVICE_COOKIE) return pair.slice(at + 1).trim() || null
  }
  return null
}

/* SameSite=Strict keeps the cookie off every request another site starts, so
   no page elsewhere can save to the budget with it. The app's own fetches are
   same-site and carry it. */
const COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Strict'

export function deviceCookieHeader(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Max-Age=${DEVICE_TTL_S}; ${COOKIE_FLAGS}`
}

export function clearedDeviceCookieHeader(): string {
  return `${DEVICE_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`
}

export function deviceSessionFromRequest(request: Request, env: Env, nowMs = Date.now()): DeviceSession {
  const token = readDeviceCookie(request)
  if (!token) throw new DeviceAuthError('missing_cookie')
  let secret: string
  try {
    secret = deviceSecretFromEnv(env)
  } catch {
    /* No secret means no cookie was ever issued, so this one is not ours. */
    throw new DeviceAuthError('not_configured')
  }
  return verifyDeviceToken(token, secret, nowMs)
}

/* Who is asking: a Clerk token if the request carries one, otherwise this
   device's cookie. A request with a Bearer header is judged on that header
   alone, so a bad token never falls through to the cookie. */
export async function verifyRequest(request: Request, env: Env): Promise<{ userId: string }> {
  if (request.headers.get('authorization')) {
    return verifyClerkRequest(request, clerkConfigFromEnv(env))
  }
  if (!readDeviceCookie(request)) throw new ClerkAuthError('missing_token')
  return { userId: deviceSessionFromRequest(request, env).userId }
}
