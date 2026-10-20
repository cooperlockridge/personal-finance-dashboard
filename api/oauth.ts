import { ClerkAuthError, type ClerkUser } from './_lib/clerk.js'
import { DeviceAuthError, verifyRequest } from './_lib/device.js'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import {
  ACCESS_TTL_S,
  AUTH_REQUEST_TTL_S,
  CODE_TTL_S,
  isAllowedRedirect,
  OAuthTokenError,
  oauthKeyFromEnv,
  originOf,
  pkceMatches,
  REFRESH_TTL_S,
  SCOPE,
  signArtifact,
  verifyArtifact,
} from './_lib/oauth.js'
import { createSupabase, defaultFetch, eq, SupabaseError, supabaseConfigFromEnv } from './_lib/supabase.js'

/* /api/oauth — the sign-in Claude's connector runs (2026-10-19). One function
   for every step so the project stays well under Hobby's function cap;
   vercel.json rewrites the standard paths onto ?step=.

   GET  /.well-known/oauth-authorization-server → step=as-metadata
   GET  /.well-known/oauth-protected-resource   → step=resource-metadata
   POST /oauth/register   (RFC 7591)             → step=register
   GET  /oauth/authorize  (from Claude)          → step=authorize, 302 to /?connect=…
   POST /oauth/authorize  (from the app, signed in) → step=authorize, { redirect }
   POST /oauth/token                             → step=token

   The approval screen is the app itself (/?connect=…), so a phone that has
   signed in before is recognised by its device cookie and a new one gets the
   normal Clerk sign-in. See _lib/oauth.ts for the token design. */

export type OAuthDeps = {
  env: Env
  verify: (request: Request, env: Env) => Promise<ClerkUser>
  fetch: FetchLike
  now: () => number
}

const MAX_BODY_BYTES = 64 * 1024

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
}

export async function GET(request: Request): Promise<Response> {
  return handleOAuth(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleOAuth(request)
}

export async function OPTIONS(request: Request): Promise<Response> {
  return handleOAuth(request)
}

const defaultVerify = (request: Request, env: Env) => verifyRequest(request, env)

export async function handleOAuth(request: Request, overrides: Partial<OAuthDeps> = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  const env = overrides.env ?? process.env
  const now = overrides.now ?? Date.now
  const url = new URL(request.url)
  /* Normally ?step= from the vercel.json rewrite; the path is the fallback in
     case a rewrite ever hands the function the original URL. */
  const step = url.searchParams.get('step') ?? stepFromPath(url.pathname)
  const origin = originOf(request)

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  try {
    if (step === 'as-metadata' && method === 'GET') return json(200, authServerMetadata(origin), CORS)
    if (step === 'resource-metadata' && method === 'GET') return json(200, resourceMetadata(origin), CORS)

    const key = oauthKeyFromEnv(env)

    if (step === 'register' && method === 'POST') {
      const body = await readBody(request)
      if (!body) return oauthError(400, 'invalid_client_metadata', 'Body must be JSON.')
      const redirects = body.redirect_uris
      if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 5) {
        return oauthError(400, 'invalid_redirect_uri', 'redirect_uris is required.')
      }
      if (!redirects.every(isAllowedRedirect)) {
        return oauthError(400, 'invalid_redirect_uri', 'Only Claude and loopback redirect URIs are accepted.')
      }
      const name = typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 80)
        : 'Claude'
      const issuedAt = Math.floor(now() / 1000)
      const clientId = signArtifact('client', { ru: redirects, name }, key, now())
      return json(201, {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: name,
        redirect_uris: redirects,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      }, CORS)
    }

    if (step === 'authorize' && method === 'GET') return startAuthorize(request, key, now(), origin)
    if (step === 'authorize' && method === 'POST') return await approve(request, key, env, now(), overrides)
    if (step === 'token' && method === 'POST') return await token(request, key, now())

    return json(404, { error: 'not_found' }, CORS)
  } catch (error) {
    if (error instanceof ClerkAuthError || error instanceof DeviceAuthError) {
      return json(401, { error: 'unauthorized' })
    }
    if (error instanceof SupabaseError) return json(502, { error: 'upstream_error' })
    if (error instanceof ConfigError) {
      console.error(error.message)
      return json(500, { error: 'server_misconfigured' })
    }
    console.error('oauth handler failed', error)
    return json(500, { error: 'server_error' })
  }
}

function stepFromPath(path: string): string {
  if (path.startsWith('/.well-known/oauth-protected-resource')) return 'resource-metadata'
  if (path.startsWith('/.well-known/')) return 'as-metadata'
  const match = /^\/oauth\/(register|authorize|token)$/.exec(path)
  return match ? match[1] : ''
}

export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  }
}

export function resourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: "Laken's Finance",
  }
}

/* Claude sends the person here. Nothing about who they are is known yet, so
   all this does is check the request is well formed and hand it, signed, to
   the app's approval screen. A bad client or redirect is shown as a page and
   never redirected anywhere, per RFC 6749 §4.1.2.1. */
function startAuthorize(request: Request, key: Buffer, nowMs: number, origin: string): Response {
  const params = new URL(request.url).searchParams
  let client: Record<string, unknown>
  try {
    client = verifyArtifact(params.get('client_id'), 'client', key, nowMs)
  } catch {
    return errorPage('This connector is not registered. Remove it in Claude and add it again.')
  }
  const redirectUri = params.get('redirect_uri') ?? ''
  const registered = Array.isArray(client.ru) ? client.ru : []
  if (!registered.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return errorPage('That redirect address is not one this connector registered.')
  }

  const state = params.get('state')
  const fail = (code: string) => Response.redirect(withParams(redirectUri, { error: code, state }), 302)
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type')
  const challenge = params.get('code_challenge') ?? ''
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail('invalid_request')
  }

  const pending = signArtifact('authreq', {
    cid: params.get('client_id'),
    ru: redirectUri,
    cc: challenge,
    st: state,
    name: typeof client.name === 'string' ? client.name : 'Claude',
  }, key, nowMs, AUTH_REQUEST_TTL_S)
  return Response.redirect(`${origin}/?connect=${encodeURIComponent(pending)}`, 302)
}

/* The app posts here once she taps Allow (or Cancel). She proves who she is
   exactly as she does for /api/budget, and must be on a budget, so the code
   is only ever minted for a member. */
async function approve(request: Request, key: Buffer, env: Env, nowMs: number, overrides: Partial<OAuthDeps>) {
  const body = await readBody(request)
  if (!body) return json(400, { error: 'invalid_body' })
  let pending: Record<string, unknown>
  try {
    pending = verifyArtifact(body.request, 'authreq', key, nowMs)
  } catch (error) {
    const reason = error instanceof OAuthTokenError ? error.reason : 'bad_request'
    return json(400, { error: reason === 'expired' ? 'request_expired' : 'invalid_request' })
  }
  const redirectUri = String(pending.ru)
  const state = typeof pending.st === 'string' ? pending.st : null

  if (body.decision !== 'allow') {
    return json(200, { redirect: withParams(redirectUri, { error: 'access_denied', state }) })
  }

  const { userId } = await (overrides.verify ?? defaultVerify)(request, env)
  const db = createSupabase(supabaseConfigFromEnv(env, overrides.fetch ?? defaultFetch))
  const members = await db.select<{ label: string }>(`budget_members?clerk_user_id=${eq(userId)}&select=label`)
  if (members.length === 0) return json(403, { error: 'not_member', userId })

  const code = signArtifact('code', { sub: userId, cid: pending.cid, ru: redirectUri, cc: pending.cc }, key, nowMs, CODE_TTL_S)
  console.info('oauth: connector approved', members[0].label)
  return json(200, { redirect: withParams(redirectUri, { code, state }) })
}

async function token(request: Request, key: Buffer, nowMs: number): Promise<Response> {
  const body = await readBody(request)
  if (!body) return oauthError(400, 'invalid_request', 'Body must be form-encoded or JSON.')

  let userId: string
  let clientId: string
  if (body.grant_type === 'authorization_code') {
    let code: Record<string, unknown>
    try {
      code = verifyArtifact(body.code, 'code', key, nowMs)
    } catch {
      return oauthError(400, 'invalid_grant', 'The code is invalid or expired.')
    }
    if (body.client_id !== undefined && body.client_id !== code.cid) {
      return oauthError(400, 'invalid_grant', 'The code was issued to another client.')
    }
    if (body.redirect_uri !== undefined && body.redirect_uri !== code.ru) {
      return oauthError(400, 'invalid_grant', 'redirect_uri does not match.')
    }
    if (!pkceMatches(body.code_verifier, code.cc)) {
      return oauthError(400, 'invalid_grant', 'PKCE verification failed.')
    }
    userId = String(code.sub)
    clientId = String(code.cid)
  } else if (body.grant_type === 'refresh_token') {
    let refresh: Record<string, unknown>
    try {
      refresh = verifyArtifact(body.refresh_token, 'refresh', key, nowMs)
    } catch {
      return oauthError(400, 'invalid_grant', 'The refresh token is invalid or expired.')
    }
    userId = String(refresh.sub)
    clientId = String(refresh.cid)
  } else {
    return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }

  /* Short client id inside the tokens: the full one is a few hundred bytes
     and only its identity matters from here on. */
  const cid = clientId.slice(-16)
  return json(200, {
    access_token: signArtifact('access', { sub: userId, cid }, key, nowMs, ACCESS_TTL_S),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: signArtifact('refresh', { sub: userId, cid: clientId }, key, nowMs, REFRESH_TTL_S),
    scope: SCOPE,
  }, CORS)
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return null
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function withParams(base: string, params: Record<string, string | null>): string {
  const url = new URL(base)
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value)
  }
  return url.toString()
}

function oauthError(status: number, error: string, description: string) {
  return json(status, { error, error_description: description }, CORS)
}

function errorPage(message: string): Response {
  const safe = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Can't connect</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#3a2a30"><h1 style="font-size:1.2rem">Can't connect Claude</h1><p>${safe}</p></body>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}
