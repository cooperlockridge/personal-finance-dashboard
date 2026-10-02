import { ClerkAuthError, type ClerkUser } from './_lib/clerk.js'
import { DeviceAuthError, verifyRequest } from './_lib/device.js'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import {
  createSupabase,
  defaultFetch,
  eq,
  SupabaseError,
  supabaseConfigFromEnv,
  type Supabase,
} from './_lib/supabase.js'

/* /api/requests — change requests for the shared budget (2026-10-02).

   GET                       → 200 { requests: [...] }, the 20 newest
   POST { body }             → 201 { id } (a new request)
   POST { id, answer }       → 200 {} (answers the watchdog's question)
   POST { id, undo: true }   → 200 { version } (takes a data change back)

   A member types what should change. The watchdog on Cooper's Mac picks the
   row up once a day and writes the outcome back; this route never runs the
   request itself. Auth and membership work exactly as in /api/budget. */

/* Same cap as /api/budget. A request is 2000 characters at most, so anything
   near a megabyte is not one. */
const MAX_BODY_BYTES = 1024 * 1024

const MAX_TEXT_CHARS = 2000

const LIST_LIMIT = 20

/* Requests the watchdog still has to finish. Five waiting is already more
   than one morning's run takes, and the cap keeps a stuck phone or a bored
   visitor from queueing a hundred. */
const MAX_OPEN = 5
const OPEN_STATUSES = 'in.(new,in_progress,needs_answer)'

/* Never clerk_user_id or commit_sha. snapshot_id and applied_version are read
   to work out canUndo and stay on the server. */
const LIST_COLUMNS = 'id,author_label,body,status,lane,question,answer,summary,changes,snapshot_id,applied_version,created_at,updated_at'

export type RequestsDeps = {
  env: Env
  verify: (request: Request, env: Env) => Promise<ClerkUser>
  fetch: FetchLike
}

type MemberRow = { budget_id: string, label: string }
type BudgetRow = { data: unknown, version: number | string }
type UndoFields = {
  status: string
  lane: string | null
  snapshot_id: number | string | null
  applied_version: number | string | null
}
type RequestRow = UndoFields & {
  id: number | string
  author_label: string
  body: string
  question: string | null
  answer: string | null
  summary: string | null
  changes: unknown
  created_at: string
  updated_at: string
}
type Parsed<T> = { ok: true, value: T } | { ok: false, detail: string }

export async function GET(request: Request): Promise<Response> {
  return handleRequests(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleRequests(request)
}

const defaultVerify = (request: Request, env: Env) => verifyRequest(request, env)

/* Deps default to the real env, Clerk and Supabase. Tests pass their own so
   nothing here touches the network. */
export async function handleRequests(request: Request, overrides: Partial<RequestsDeps> = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { error: 'method_not_allowed' }, { allow: 'GET, POST' })
  }

  const env = overrides.env ?? process.env
  const verify = overrides.verify ?? defaultVerify

  try {
    const { userId } = await verify(request, env)
    const db = createSupabase(supabaseConfigFromEnv(env, overrides.fetch ?? defaultFetch))

    const members = await db.select<MemberRow>(
      `budget_members?clerk_user_id=${eq(userId)}&select=budget_id,label`,
    )
    /* Same answer /api/budget gives, so the not-a-member banner still gets its id. */
    if (members.length === 0) return json(403, { error: 'not_member', userId })
    const { budget_id: budgetId, label } = members[0]

    if (method === 'GET') return await listRequests(db, budgetId)

    const body = await readJsonBody(request)
    if (!body.ok) return invalid(body.detail)
    const { id, answer, undo, body: text } = body.value

    /* No id means a new request. With an id it is an answer or an undo, and
       every query below also names the budget, so one budget's member can
       never reach another budget's row by guessing its number. */
    if (id === undefined) {
      const trimmed = cleanText(text)
      if (trimmed === null) return invalid('body')
      return await createRequest(db, budgetId, userId, label, trimmed)
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return invalid('id')

    if (undo === true) return await undoRequest(db, budgetId, userId, id)

    const trimmed = cleanText(answer)
    if (trimmed === null) return invalid('answer')
    return await answerRequest(db, budgetId, id, trimmed)
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
    console.error('requests handler failed', error)
    return json(500, { error: 'server_error' })
  }
}

async function listRequests(db: Supabase, budgetId: string) {
  /* The budget row is read once, and every row's canUndo is judged against
     that one version. */
  const { version } = await readBudget(db, budgetId)
  const rows = await db.select<RequestRow>(
    `budget_requests?budget_id=${eq(budgetId)}&select=${LIST_COLUMNS}&order=created_at.desc,id.desc&limit=${LIST_LIMIT}`,
  )
  return json(200, {
    requests: rows.map((row) => ({
      id: Number(row.id),
      author: row.author_label,
      body: row.body,
      status: row.status,
      lane: row.lane ?? null,
      question: row.question ?? null,
      answer: row.answer ?? null,
      summary: row.summary ?? null,
      changes: row.changes ?? null,
      canUndo: canUndo(row, version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  })
}

async function createRequest(db: Supabase, budgetId: string, userId: string, label: string, text: string) {
  /* Two devices sending at the same instant could both pass this count and
     leave six open. That is harmless here, so there is no lock. */
  const open = await db.select<{ id: number | string }>(
    `budget_requests?budget_id=${eq(budgetId)}&status=${OPEN_STATUSES}&select=id&limit=${MAX_OPEN}`,
  )
  if (open.length >= MAX_OPEN) return json(429, { error: 'too_many_open' })

  const rows = await db.insertReturning<{ id: number | string }>('budget_requests?select=id', {
    budget_id: budgetId,
    clerk_user_id: userId,
    author_label: label,
    body: text,
  })
  if (rows.length === 0) throw new Error('budget_requests insert returned no row')
  return json(201, { id: Number(rows[0].id) })
}

/* The status filter is part of the update itself, so an answer only lands on
   a row that is still waiting for one. Zero rows back means it is not this
   budget's row, or the question was already answered. */
async function answerRequest(db: Supabase, budgetId: string, id: number, answer: string) {
  const rows = await db.update<{ id: number | string }>(
    `budget_requests?id=${eq(id)}&budget_id=${eq(budgetId)}&status=${eq('needs_answer')}&select=id`,
    { answer, status: 'new', updated_at: new Date().toISOString() },
  )
  if (rows.length === 0) return json(409, { error: 'not_waiting' })
  return json(200, {})
}

/* Puts back the budget the watchdog snapshotted just before its data change.
   Only while the budget still sits at the version that change produced: one
   save later, restoring the old copy would throw that save away. */
async function undoRequest(db: Supabase, budgetId: string, userId: string, id: number) {
  const rows = await db.select<UndoFields>(
    `budget_requests?id=${eq(id)}&budget_id=${eq(budgetId)}&select=status,lane,snapshot_id,applied_version`,
  )
  const current = await readBudget(db, budgetId)
  if (rows.length === 0 || !canUndo(rows[0], current.version)) return cannotUndo()
  const appliedVersion = Number(rows[0].applied_version)

  const snapshots = await db.select<{ data: unknown }>(
    `budget_snapshots?id=${eq(Number(rows[0].snapshot_id))}&budget_id=${eq(budgetId)}&select=data`,
  )
  if (snapshots.length === 0 || snapshots[0].data == null || current.data == null) return cannotUndo()

  /* Kept first, so the change being taken back is itself never lost. */
  await db.insert('budget_snapshots', {
    budget_id: budgetId,
    clerk_user_id: userId,
    reason: 'undo',
    data: current.data,
  })

  /* Same conditional save as /api/budget: if a device saved between the read
     above and here, the filter matches nothing and the undo is refused. */
  const now = new Date().toISOString()
  const saved = await db.update<{ version: number | string }>(
    `budgets?id=${eq(budgetId)}&version=${eq(appliedVersion)}&select=version`,
    { data: snapshots[0].data, version: appliedVersion + 1, updated_at: now, updated_by: userId },
  )
  if (saved.length === 0) return cannotUndo()

  await db.update(
    `budget_requests?id=${eq(id)}&budget_id=${eq(budgetId)}&select=id`,
    { status: 'undone', updated_at: now },
  )
  return json(200, { version: Number(saved[0].version) })
}

function canUndo(row: UndoFields, budgetVersion: number): boolean {
  return row.status === 'done'
    && row.lane === 'data'
    && row.snapshot_id != null
    && row.applied_version != null
    && Number(row.applied_version) === budgetVersion
}

async function readBudget(db: Supabase, budgetId: string) {
  const rows = await db.select<BudgetRow>(`budgets?id=${eq(budgetId)}&select=data,version`)
  /* budget_members references budgets with on delete cascade, so a member
     without a budget row means the database is broken, not the request. */
  if (rows.length === 0) throw new Error(`budget ${budgetId} has members but no row`)
  /* PostgREST sends bigint as a JSON number, but coerce in case a proxy or a
     future PostgREST setting turns it into a string. */
  return { data: rows[0].data ?? null, version: Number(rows[0].version) }
}

/* Trimmed text of 1 to 2000 characters, or null. Counted in code points, the
   way Postgres char_length counts, so the table's own check never fires. */
function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const length = Array.from(trimmed).length
  return length >= 1 && length <= MAX_TEXT_CHARS ? trimmed : null
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, detail: 'body' }
  return { ok: true, value: value as Record<string, unknown> }
}

function invalid(detail: string) {
  return json(400, { error: 'invalid_body', detail })
}

function cannotUndo() {
  return json(409, { error: 'cannot_undo' })
}
