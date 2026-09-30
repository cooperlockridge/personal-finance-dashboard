import { createHash, timingSafeEqual } from 'node:crypto'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import { createSupabase, defaultFetch, SupabaseError, supabaseConfigFromEnv } from './_lib/supabase.js'

/* Supabase evaluates low activity over a week; its guidance recommends a few
   database requests per day. Vercel Hobby permits one daily cron invocation,
   so run three bounded reads here. This reduces pause risk, but only a paid
   Supabase plan guarantees protection from inactivity pausing. */
const DAILY_READS = 3

export type KeepaliveDeps = {
  env: Env
  fetch: FetchLike
}

export async function GET(request: Request): Promise<Response> {
  return handleKeepalive(request)
}

export async function handleKeepalive(request: Request, overrides: Partial<KeepaliveDeps> = {}): Promise<Response> {
  if (request.method.toUpperCase() !== 'GET') {
    return json(405, { error: 'method_not_allowed' }, { allow: 'GET' })
  }

  const env = overrides.env ?? process.env
  const secret = env.CRON_SECRET
  /* Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when the env var
     is set. With no secret configured the route stays shut rather than open. */
  if (!secret || !sameSecret(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
    console.warn('keepalive rejected', { reason: secret ? 'unauthorized' : 'missing_cron_secret' })
    return json(401, { error: 'unauthorized' })
  }

  try {
    const db = createSupabase(supabaseConfigFromEnv(env, overrides.fetch ?? defaultFetch))
    for (let read = 0; read < DAILY_READS; read++) {
      await db.select('budgets?select=id&limit=1')
    }
    console.info('keepalive completed', { reads: DAILY_READS })
    return json(200, { ok: true })
  } catch (error) {
    if (error instanceof SupabaseError) {
      console.error('keepalive failed', { upstreamStatus: error.status })
      return json(502, { ok: false })
    }
    console.error(error instanceof ConfigError ? error.message : error)
    return json(500, { ok: false })
  }
}

/* Hashing first gives both sides the same length, which timingSafeEqual
   requires, so the comparison time says nothing about the secret. */
function sameSecret(given: string, expected: string) {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
