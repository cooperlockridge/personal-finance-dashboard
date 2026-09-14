import { isBudgetData, type BudgetData } from './finance'

/* Sep 14, 2026: the browser's side of /api/budget. The server verifies the
   Clerk session token, checks membership, and talks to Supabase; all this
   file does is send the token, and turn each answer into one of a few
   outcomes the sync engine can act on. No React and no window here, so the
   mapping is tested in bun with a fake fetch. */

/** The shared budget as the server last saved it. `data` is null until the first device syncs. */
export type CloudState = {
  version: number
  data: BudgetData | null
  updatedAt?: string
  updatedBy?: string | null
}

/** Why a device's copy was kept aside on the server instead of being overwritten. */
export type SnapshotReason = 'device-import' | 'conflict'

/**
 * `offline` is a request that got no answer from the API at all; `error` is
 * an answer that wasn't the one we needed. The header words them differently.
 */
export type Failure = 'offline' | 'error'

export type ApiResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'stale'; cloud: CloudState }
  | { kind: 'not_member'; userId: string }
  | { kind: 'failed'; failure: Failure }

export type BudgetApi = {
  load(): Promise<ApiResult<CloudState>>
  save(baseVersion: number, data: BudgetData): Promise<ApiResult<{ version: number }>>
  snapshot(reason: SnapshotReason, data: BudgetData): Promise<ApiResult<null>>
}

/** Clerk's `getToken`, narrowed to the one option sync uses. */
export type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Status 0 means the request never got an answer. `body` is undefined when it wasn't JSON. */
export type Reply = { status: number; body: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asCloudState(body: unknown): CloudState | null {
  if (!isRecord(body) || typeof body.version !== 'number') return null
  if (body.data !== null && !isBudgetData(body.data)) return null
  return {
    version: body.version,
    data: body.data,
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
    updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy : null,
  }
}

/**
 * A 404, or a success that isn't JSON, means the API isn't there at all —
 * the local preview serves no /api, and a captive portal answers with its
 * own page. Both read as offline, like a dropped connection. Anything else
 * the server said (5xx, a 400, a 401 that survived a fresh token) is an
 * error, retried on the same schedule.
 */
export function failureOf(reply: Reply): Failure {
  if (reply.status === 0 || reply.status === 404) return 'offline'
  if (reply.status >= 200 && reply.status < 300 && reply.body === undefined) return 'offline'
  return 'error'
}

function notMemberOrFailed(reply: Reply): ApiResult<never> {
  const body = reply.body
  if (reply.status === 403 && isRecord(body) && body.error === 'not_member' && typeof body.userId === 'string') {
    return { kind: 'not_member', userId: body.userId }
  }
  return { kind: 'failed', failure: failureOf(reply) }
}

export function classifyLoad(reply: Reply): ApiResult<CloudState> {
  const cloud = reply.status === 200 ? asCloudState(reply.body) : null
  return cloud ? { kind: 'ok', body: cloud } : notMemberOrFailed(reply)
}

export function classifySave(reply: Reply): ApiResult<{ version: number }> {
  const body = reply.body
  if (reply.status === 200 && isRecord(body) && typeof body.version === 'number') {
    return { kind: 'ok', body: { version: body.version } }
  }
  if (reply.status === 409 && isRecord(body) && body.error === 'stale') {
    const cloud = asCloudState(body)
    if (cloud) return { kind: 'stale', cloud }
  }
  return notMemberOrFailed(reply)
}

export function classifySnapshot(reply: Reply): ApiResult<null> {
  if (reply.status >= 200 && reply.status < 300 && reply.body !== undefined) return { kind: 'ok', body: null }
  return notMemberOrFailed(reply)
}

export function createBudgetApi({
  fetch,
  getToken,
  url = '/api/budget',
}: {
  fetch: FetchLike
  getToken: TokenGetter
  url?: string
}): BudgetApi {
  async function attempt(method: string, payload: unknown, freshToken: boolean): Promise<Reply> {
    let token: string | null
    try {
      token = await (freshToken ? getToken({ skipCache: true }) : getToken())
    } catch {
      /* Clerk couldn't mint a token, which on a phone almost always means no connection. */
      return { status: 0, body: undefined }
    }
    if (!token) return { status: 401, body: undefined }
    let response: Response
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          /* Asking for JSON keeps a dev server's HTML fallback from answering 200. */
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      })
    } catch {
      return { status: 0, body: undefined }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }

  /* Clerk caches a session token for most of its minute-long life, so one
     can expire between refreshes. A single retry with a fresh token covers
     that without looping on a login the server really rejects. */
  async function send(method: string, payload?: unknown): Promise<Reply> {
    const first = await attempt(method, payload, false)
    return first.status === 401 ? attempt(method, payload, true) : first
  }

  return {
    load: async () => classifyLoad(await send('GET')),
    save: async (baseVersion, data) => classifySave(await send('PUT', { baseVersion, data })),
    snapshot: async (reason, data) => classifySnapshot(await send('POST', { reason, data })),
  }
}
