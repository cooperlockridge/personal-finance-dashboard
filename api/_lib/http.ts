/* Small pieces every route shares. This directory starts with an underscore
   so Vercel does not turn these files into routes of their own. */

export type Env = Record<string, string | undefined>

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/* Budget responses carry personal numbers and change on every save, so no
   browser or CDN may keep a copy. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/* Thrown when a required env var is missing. It names the variable in the
   server log only; the browser just sees a 500. */
export class ConfigError extends Error {
  constructor(name: string) {
    super(`Missing env var ${name}`)
    this.name = 'ConfigError'
  }
}

export function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(name)
  return value
}
