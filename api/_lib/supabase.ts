import { requireEnv, type Env, type FetchLike } from './http.js'

/* A PostgREST client over plain fetch. @supabase/supabase-js would do this,
   but npm installs are banned on this machine (2026-09-14) and the budget API
   only needs select, update and insert. */

export type SupabaseConfig = {
  url: string
  secretKey: string
  fetch: FetchLike
}

/* Thrown for any PostgREST failure. The message stays in server logs; the
   handlers turn it into a bare 502 so neither the key nor Supabase's error body
   ever reaches the browser. */
export class SupabaseError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SupabaseError'
    this.status = status
  }
}

export const defaultFetch: FetchLike = (input, init) => fetch(input, {
  ...init,
  signal: AbortSignal.timeout(10_000),
})

export function supabaseConfigFromEnv(env: Env, fetchImpl: FetchLike = defaultFetch): SupabaseConfig {
  return {
    url: requireEnv(env, 'SUPABASE_URL').replace(/\/+$/, ''),
    secretKey: requireEnv(env, 'SUPABASE_SECRET_KEY'),
    fetch: fetchImpl,
  }
}

export type Supabase = ReturnType<typeof createSupabase>

export function createSupabase(config: SupabaseConfig) {
  const base = `${config.url}/rest/v1`

  async function send<T>(method: string, path: string, options: { body?: unknown, prefer?: string } = {}): Promise<T | null> {
    /* The secret key goes in apikey and nowhere else. New sb_secret_ keys are
       not JWTs, so Supabase answers "Invalid JWT" if one shows up as an
       Authorization Bearer. No Authorization header is sent at all. */
    const headers: Record<string, string> = {
      apikey: config.secretKey,
      accept: 'application/json',
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.prefer) headers.prefer = options.prefer

    let response: Response
    try {
      response = await config.fetch(`${base}/${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (error) {
      console.error('supabase request failed', method, path.split('?')[0], error)
      throw new SupabaseError('network', 0)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error('supabase error', method, path.split('?')[0], response.status, detail)
      throw new SupabaseError('http', response.status)
    }

    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      console.error('supabase returned non-JSON', method, path.split('?')[0], response.status)
      throw new SupabaseError('bad_json', response.status)
    }
  }

  return {
    async select<Row>(path: string): Promise<Row[]> {
      return (await send<Row[]>('GET', path)) ?? []
    },
    /* return=representation makes PostgREST send back the rows it touched.
       The conditional budget save depends on that: zero rows means the version
       filter matched nothing, so another device saved first. */
    async update<Row>(path: string, body: unknown): Promise<Row[]> {
      return (await send<Row[]>('PATCH', path, { body, prefer: 'return=representation' })) ?? []
    },
    async insert(table: string, body: unknown): Promise<void> {
      await send('POST', table, { body, prefer: 'return=minimal' })
    },
  }
}

/* Filter values go through encodeURIComponent so a Clerk id or budget id can
   never smuggle extra query parameters into the request. */
export function eq(value: string | number) {
  return `eq.${encodeURIComponent(String(value))}`
}
