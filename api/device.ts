import { ClerkAuthError, clerkConfigFromEnv, verifyClerkRequest, type ClerkUser } from './_lib/clerk.js'
import {
  clearedDeviceCookieHeader,
  DEVICE_RENEW_AFTER_S,
  DeviceAuthError,
  deviceCookieHeader,
  deviceSecretFromEnv,
  deviceSessionFromRequest,
  signDeviceToken,
} from './_lib/device.js'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import { createSupabase, defaultFetch, eq, SupabaseError, supabaseConfigFromEnv } from './_lib/supabase.js'

/* /api/device — "remember this device" (2026-10-02). See _lib/device.ts for why.

   POST   (Clerk Bearer) → 200 { userId, name } and the device cookie
   GET    (device cookie) → 200 { userId, name }, or 401 if this device isn't remembered
   DELETE                 → 200 {} and the cookie cleared

   Only a fresh Clerk sign-in by a budget member can mint a cookie. */

export type DeviceDeps = {
  env: Env
  verify: (request: Request, env: Env) => Promise<ClerkUser>
  fetch: FetchLike
  /* Milliseconds since the epoch. Injectable so tests can move the clock. */
  now: () => number
}

export async function GET(request: Request): Promise<Response> {
  return handleDevice(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleDevice(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return handleDevice(request)
}

const defaultVerify = (request: Request, env: Env) => verifyClerkRequest(request, clerkConfigFromEnv(env))

export async function handleDevice(request: Request, overrides: Partial<DeviceDeps> = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  const env = overrides.env ?? process.env
  const now = overrides.now ?? Date.now

  /* Signing out must work even when nothing else does, so it needs no proof
     of who is asking: all it can do is forget this browser. */
  if (method === 'DELETE') return json(200, {}, { 'set-cookie': clearedDeviceCookieHeader() })

  try {
    if (method === 'GET') {
      const session = deviceSessionFromRequest(request, env, now())
      const body = { userId: session.userId, name: session.name }
      if (now() / 1000 - session.issuedAt < DEVICE_RENEW_AFTER_S) return json(200, body)
      const renewed = signDeviceToken(session, deviceSecretFromEnv(env), now())
      return json(200, body, { 'set-cookie': deviceCookieHeader(renewed) })
    }

    if (method === 'POST') {
      const secret = deviceSecretFromEnv(env)
      const { userId } = await (overrides.verify ?? defaultVerify)(request, env)
      const db = createSupabase(supabaseConfigFromEnv(env, overrides.fetch ?? defaultFetch))
      const members = await db.select<{ label: string }>(`budget_members?clerk_user_id=${eq(userId)}&select=label`)
      /* Same answer /api/budget gives, so the not-a-member banner still gets its id. */
      if (members.length === 0) return json(403, { error: 'not_member', userId })
      const user = { userId, name: members[0].label }
      return json(200, user, { 'set-cookie': deviceCookieHeader(signDeviceToken(user, secret, now())) })
    }

    return json(405, { error: 'method_not_allowed' }, { allow: 'GET, POST, DELETE' })
  } catch (error) {
    if (error instanceof ClerkAuthError || error instanceof DeviceAuthError) {
      return json(401, { error: 'unauthorized' })
    }
    /* Already logged with detail inside the Supabase client. */
    if (error instanceof SupabaseError) return json(502, { error: 'upstream_error' })
    if (error instanceof ConfigError) {
      console.error(error.message)
      return json(500, { error: 'server_misconfigured' })
    }
    console.error('device handler failed', error)
    return json(500, { error: 'server_error' })
  }
}
