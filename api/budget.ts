import { ClerkAuthError, clerkConfigFromEnv, verifyClerkRequest, type ClerkUser } from './_lib/clerk.js'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import {
  createSupabase,
  defaultFetch,
  eq,
  SupabaseError,
  supabaseConfigFromEnv,
  type Supabase,
} from './_lib/supabase.js'

/* /api/budget — the one shared Lockridge budget (2026-09-14).

   GET  → { budgetId, version, data, updatedAt, updatedBy }
   PUT  { baseVersion, data }  → 200 { version } or 409 { error: 'stale', ...current }
   POST { reason, data }       → 201 {} (a snapshot; nothing a device held is lost)

   Every request proves who it is with a Clerk session token, and the Clerk id
   must be in budget_members. The browser never talks to Supabase itself. */

/* A whole budget is a few kilobytes. A megabyte leaves years of paycheck
   history room while stopping anyone from parking junk in the database. */
const MAX_BODY_BYTES = 1024 * 1024

const SNAPSHOT_REASONS = new Set(['device-import', 'conflict'])

export type BudgetDeps = {
  env: Env
  verify: (request: Request, env: Env) => Promise<ClerkUser>
  fetch: FetchLike
}

type MemberRow = { budget_id: string, label: string }
type BudgetRow = { data: unknown, version: number | string, updated_at: string, updated_by: string | null }
type Parsed<T> = { ok: true, value: T } | { ok: false, detail: string }

/* Vercel picks up these named Web handlers. PATCH and DELETE are exported only
   so they answer 405 from our own code instead of relying on the platform. */
export async function GET(request: Request): Promise<Response> {
  return handleBudget(request)
}

export async function PUT(request: Request): Promise<Response> {
  return handleBudget(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleBudget(request)
}

export async function PATCH(request: Request): Promise<Response> {
  return handleBudget(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return handleBudget(request)
}

const defaultVerify = (request: Request, env: Env) => verifyClerkRequest(request, clerkConfigFromEnv(env))

/* Deps default to the real env, Clerk and Supabase. Tests pass their own so
   nothing here touches the network. */
export async function handleBudget(request: Request, overrides: Partial<BudgetDeps> = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
    return json(405, { error: 'method_not_allowed' }, { allow: 'GET, PUT, POST' })
  }

  const env = overrides.env ?? process.env
  const verify = overrides.verify ?? defaultVerify

  try {
    const { userId } = await verify(request, env)
    const db = createSupabase(supabaseConfigFromEnv(env, overrides.fetch ?? defaultFetch))

    const members = await db.select<MemberRow>(
      `budget_members?clerk_user_id=${eq(userId)}&select=budget_id,label`,
    )
    /* The user id comes back so the not-a-member screen can show it. Cooper
       adds that id to budget_members, and nothing else is needed. */
    if (members.length === 0) return json(403, { error: 'not_member', userId })
    const budgetId = members[0].budget_id

    if (method === 'GET') {
      return json(200, { budgetId, ...(await readBudget(db, budgetId)) })
    }

    const body = await readJsonBody(request)
    if (!body.ok) return invalid(body.detail)

    if (method === 'PUT') {
      const { baseVersion, data } = body.value
      if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
        return invalid('baseVersion')
      }
      const problem = budgetDataProblem(data)
      if (problem) return invalid(problem)
      return await saveBudget(db, budgetId, userId, baseVersion, data)
    }

    const { reason, data } = body.value
    if (typeof reason !== 'string' || !SNAPSHOT_REASONS.has(reason)) return invalid('reason')
    const problem = budgetDataProblem(data)
    if (problem) return invalid(problem)
    await db.insert('budget_snapshots', { budget_id: budgetId, clerk_user_id: userId, reason, data })
    return json(201, {})
  } catch (error) {
    if (error instanceof ClerkAuthError) return json(401, { error: 'unauthorized' })
    /* Already logged with detail inside the Supabase client. */
    if (error instanceof SupabaseError) return json(502, { error: 'upstream_error' })
    if (error instanceof ConfigError) {
      console.error(error.message)
      return json(500, { error: 'server_misconfigured' })
    }
    console.error('budget handler failed', error)
    return json(500, { error: 'server_error' })
  }
}

/* The save only lands if the row still holds the version this device last
   saw. If another device saved first the filter matches nothing, PostgREST
   returns no rows, and the caller gets the current budget to reconcile with
   instead of silently overwriting it. */
async function saveBudget(db: Supabase, budgetId: string, userId: string, baseVersion: number, data: unknown) {
  const rows = await db.update<{ version: number | string }>(
    `budgets?id=${eq(budgetId)}&version=${eq(baseVersion)}&select=version`,
    { data, version: baseVersion + 1, updated_at: new Date().toISOString(), updated_by: userId },
  )
  if (rows.length === 0) {
    return json(409, { error: 'stale', ...(await readBudget(db, budgetId)) })
  }
  return json(200, { version: Number(rows[0].version) })
}

async function readBudget(db: Supabase, budgetId: string) {
  const rows = await db.select<BudgetRow>(`budgets?id=${eq(budgetId)}&select=data,version,updated_at,updated_by`)
  /* budget_members references budgets with on delete cascade, so a member
     without a budget row means the database is broken, not the request. */
  if (rows.length === 0) throw new Error(`budget ${budgetId} has members but no row`)
  const row = rows[0]
  return {
    /* PostgREST sends bigint as a JSON number, but coerce in case a proxy or
       a future PostgREST setting turns it into a string. */
    version: Number(row.version),
    data: row.data ?? null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  }
}

async function readJsonBody(request: Request): Promise<Parsed<Record<string, unknown>>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return { ok: false, detail: 'body_too_large' }
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, detail: 'body_too_large' }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'not_json' }
  }
  if (!isRecord(value)) return { ok: false, detail: 'body' }
  return { ok: true, value }
}

/* A shape check, not a full schema. It is enough to stop a buggy client from
   saving something the app cannot load (a missing funds array would blank the
   dashboard on every device). The client owns the finer rules. */
function budgetDataProblem(data: unknown): string | null {
  if (!isRecord(data)) return 'data'
  if (!isRecord(data.profile)) return 'data.profile'
  for (const key of ['envelopes', 'funds', 'paychecks', 'extras']) {
    if (!Array.isArray(data[key])) return `data.${key}`
  }
  const rollRange = data.rollRange
  if (!isRecord(rollRange) || !isFiniteNumber(rollRange.min) || !isFiniteNumber(rollRange.max)) {
    return 'data.rollRange'
  }
  return null
}

function invalid(detail: string) {
  return json(400, { error: 'invalid_body', detail })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
