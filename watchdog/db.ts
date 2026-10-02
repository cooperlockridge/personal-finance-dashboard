import { isBudgetData, type BudgetData } from '../src/lib/finance.ts'
import { BUDGET_ID, MAX_ATTEMPTS, STUCK_AFTER_MINUTES, SUMMARY_FAILED_TWICE } from './config.ts'
import type { Exec } from './exec.ts'
import type { Change } from './patch.ts'

/* The watchdog's only road to Postgres is the Supabase CLI already logged in
   on this Mac, which takes one SQL string. There are no bind parameters on
   that road, so every value is turned into a literal by the three functions
   below and by nothing else. A request body is text Laken typed, and a
   summary is text a model wrote; both are hostile as far as SQL is concerned. */

export type Row = Record<string, unknown>
export type RunSql = (sql: string) => Promise<Row[]>

/* A value that cannot be written as a literal. Thrown before any SQL is
   sent. */
export class SqlValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqlValueError'
  }
}

/* A row that came back in a shape the watchdog does not know. */
export class DbShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbShapeError'
  }
}

/* A single-quoted string literal. Doubling the quote is the whole escape:
   Postgres has standard_conforming_strings on (the default since 9.1, and
   Supabase's setting), so a backslash inside '...' is one ordinary character,
   and a $$ only means something outside a quoted string. Postgres text cannot
   hold a NUL, and a NUL would also cut the argument short on its way to the
   CLI, so one is refused rather than dropped. */
export function lit(value: string): string {
  if (typeof value !== 'string') throw new SqlValueError('lit() takes a string')
  if (value.includes('\u0000')) throw new SqlValueError('A NUL character cannot go into SQL')
  return `'${value.replaceAll("'", "''")}'`
}

export function jsonLit(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw new SqlValueError('The value has no JSON form')
  return `${lit(json)}::jsonb`
}

/* Ids and versions. Anything that is not a safe integer could print as
   1e+21, NaN or 1.5 — none of which is the row that was meant. */
export function intLit(value: number): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SqlValueError('An id must be a safe integer')
  }
  return String(value)
}

export type RequestRow = {
  id: number
  userId: string
  author: string
  body: string
  question: string | null
  answer: string | null
  attempts: number
}

export type FinishStatus = 'done' | 'blocked' | 'needs_answer'
const FINISH_STATUSES: readonly string[] = ['done', 'blocked', 'needs_answer']

export type FinishFields = {
  status: FinishStatus
  lane?: 'data' | 'code'
  summary?: string
  changes?: Change[]
  question?: string
  commitSha?: string
}

export type DataPatch = {
  requestId: number
  expectedVersion: number
  newData: BudgetData
  userId: string
  summary: string
  changes: Change[]
}

export type PatchOutcome = { applied: true, version: number, snapshotId: number } | { applied: false }

/* Postgres bigint may arrive as a JSON number or, from some drivers, as a
   string of digits. Either way it has to be a whole number that fits. */
function toInt(value: unknown, what: string): number {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new DbShapeError(`${what} is not an integer`)
  return number
}

function toText(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new DbShapeError(`${what} is not text`)
  return value
}

function toRequestRow(row: Row): RequestRow {
  return {
    id: toInt(row.id, 'budget_requests.id'),
    userId: toText(row.clerk_user_id, 'budget_requests.clerk_user_id'),
    author: toText(row.author_label, 'budget_requests.author_label'),
    body: toText(row.body, 'budget_requests.body'),
    question: typeof row.question === 'string' ? row.question : null,
    answer: typeof row.answer === 'string' ? row.answer : null,
    attempts: toInt(row.attempts, 'budget_requests.attempts'),
  }
}

export type Db = ReturnType<typeof createDb>

export function createDb(runSql: RunSql) {
  const budget = lit(BUDGET_ID)

  return {
    /* A run that died mid-request leaves its row in_progress for good. One
       that has had a single try goes back in the queue; one that has had both
       stops here, with a line Laken can read. */
    async releaseStuck(): Promise<{ requeued: number[], blocked: number[] }> {
      const exhausted = `attempts >= ${intLit(MAX_ATTEMPTS)}`
      const rows = await runSql(
        `update public.budget_requests
         set status = case when ${exhausted} then 'blocked' else 'new' end,
             summary = case when ${exhausted} then ${lit(SUMMARY_FAILED_TWICE)} else summary end,
             claimed_at = null,
             updated_at = now()
         where budget_id = ${budget}
           and status = 'in_progress'
           and (claimed_at is null or claimed_at < now() - make_interval(mins => ${intLit(STUCK_AFTER_MINUTES)}))
         returning id, status`,
      )
      const requeued: number[] = []
      const blocked: number[] = []
      for (const row of rows) (row.status === 'blocked' ? blocked : requeued).push(toInt(row.id, 'budget_requests.id'))
      return { requeued, blocked }
    },

    /* Find and claim in one statement, so two runs can never hold the same
       request. `skip` holds the requests this run has already put back: the
       oldest row is always first in line, and without it a request waiting
       for tomorrow would be picked up again a second later. */
    async claimNext(skip: number[] = []): Promise<RequestRow | null> {
      const notSkipped = skip.length > 0 ? `and id not in (${skip.map(intLit).join(', ')})` : ''
      const rows = await runSql(
        `update public.budget_requests
         set status = 'in_progress', claimed_at = now(), attempts = attempts + 1, updated_at = now()
         where id = (
           select id from public.budget_requests
           where budget_id = ${budget} and status = 'new' ${notSkipped}
           order by created_at
           limit 1
           for update skip locked
         )
         returning *`,
      )
      return rows.length > 0 ? toRequestRow(rows[0]) : null
    },

    async readBudget(): Promise<{ data: BudgetData, version: number }> {
      const rows = await runSql(`select data, version from public.budgets where id = ${budget}`)
      if (rows.length !== 1) throw new DbShapeError('The budget row is missing')
      const raw = rows[0].data
      const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      /* Null until the first device syncs, and a patch to nothing is not a
         patch. The run stops here rather than writing a budget of its own. */
      if (!isBudgetData(data)) throw new DbShapeError('The budget row holds no budget')
      return { data, version: toInt(rows[0].version, 'budgets.version') }
    },

    /* The data lane's one write. A single statement, so Postgres runs it as
       one transaction: the snapshot, the new budget and the request's status
       all land, or none of them does.

       `locked` is the gate. It finds the budget row only at the version the
       agent read, and only while this request is still the one in progress,
       and holds the row lock from there on. If Laken saved from her phone in
       the meantime the version has moved, `locked` is empty, and every later
       step — each of which hangs off the one before — writes nothing. */
    async applyDataPatch(patch: DataPatch): Promise<PatchOutcome> {
      const id = intLit(patch.requestId)
      const version = intLit(patch.expectedVersion)
      const rows = await runSql(
        `with locked as (
           select data from public.budgets
           where id = ${budget} and version = ${version}
             and exists (
               select 1 from public.budget_requests
               where id = ${id} and budget_id = ${budget} and status = 'in_progress'
             )
           for update
         ),
         snap as (
           insert into public.budget_snapshots (budget_id, clerk_user_id, reason, data)
           select ${budget}, ${lit(patch.userId)}, 'watchdog', data from locked
           returning id
         ),
         moved as (
           update public.budgets
           set data = ${jsonLit(patch.newData)}, version = version + 1, updated_at = now(), updated_by = 'watchdog'
           where id = ${budget} and version = ${version} and exists (select 1 from snap)
           returning version
         ),
         marked as (
           update public.budget_requests
           set status = 'done', lane = 'data', summary = ${lit(patch.summary)}, changes = ${jsonLit(patch.changes)},
               snapshot_id = (select id from snap), applied_version = (select version from moved), updated_at = now()
           where id = ${id} and budget_id = ${budget} and exists (select 1 from moved)
           returning id
         )
         select (select version from moved) as version,
                (select id from snap) as snapshot_id,
                (select id from marked) as request_id`,
      )
      const row = rows[0]
      if (!row || row.version === null || row.version === undefined) return { applied: false }
      return {
        applied: true,
        version: toInt(row.version, 'budgets.version'),
        snapshotId: toInt(row.snapshot_id, 'budget_snapshots.id'),
      }
    },

    /* Close a request. Only a row this run still holds is touched, so a
       request Laken has since answered or undone is never written over. */
    async finish(id: number, fields: FinishFields): Promise<boolean> {
      if (!FINISH_STATUSES.includes(fields.status)) throw new SqlValueError('Not a status a request can finish in')
      const sets = [`status = ${lit(fields.status)}`, 'updated_at = now()']
      if (fields.lane !== undefined) sets.push(`lane = ${lit(fields.lane)}`)
      if (fields.summary !== undefined) sets.push(`summary = ${lit(fields.summary)}`)
      if (fields.changes !== undefined) sets.push(`changes = ${jsonLit(fields.changes)}`)
      if (fields.question !== undefined) sets.push(`question = ${lit(fields.question)}`)
      if (fields.commitSha !== undefined) sets.push(`commit_sha = ${lit(fields.commitSha)}`)
      const rows = await runSql(
        `update public.budget_requests
         set ${sets.join(', ')}
         where id = ${intLit(id)} and budget_id = ${budget} and status = 'in_progress'
         returning id`,
      )
      return rows.length > 0
    },

    /* Back in the queue for a later run. `refundAttempt` gives the try back
       when the request was not what failed — the budget moved under it, main
       moved under the push, or the code lane is paused — so those mornings do
       not count toward "failed twice". */
    async requeue(id: number, options: { refundAttempt?: boolean } = {}): Promise<boolean> {
      const attempts = options.refundAttempt ? ', attempts = greatest(attempts - 1, 0)' : ''
      const rows = await runSql(
        `update public.budget_requests
         set status = 'new', claimed_at = null, updated_at = now()${attempts}
         where id = ${intLit(id)} and budget_id = ${budget} and status = 'in_progress'
         returning id`,
      )
      return rows.length > 0
    },
  }
}

const SQL_TIMEOUT_MS = 60_000

/* The real road: `supabase db query --linked`, run from the main checkout
   where the CLI is linked. It prints { "rows": [...] } on stdout; version
   notices go to stderr and are ignored. The error carries the CLI's own words
   and never the SQL, which holds the budget and what Laken wrote. */
export function supabaseRunSql(exec: Exec, mainRepo: string): RunSql {
  return async (sql) => {
    const result = await exec('supabase', ['db', 'query', '--linked', '--workdir', mainRepo, sql], {
      timeoutMs: SQL_TIMEOUT_MS,
    })
    if (result.timedOut) throw new Error('supabase db query timed out')
    if (result.code !== 0) {
      throw new Error(`supabase db query exited ${result.code}: ${result.stderr.trim().slice(-400)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new Error('supabase db query printed something that is not JSON')
    }
    const rows = typeof parsed === 'object' && parsed !== null ? (parsed as Row).rows : undefined
    if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
      throw new Error('supabase db query printed JSON without a rows list')
    }
    return rows as Row[]
  }
}
