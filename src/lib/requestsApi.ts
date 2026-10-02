import type { FetchLike, Reply, TokenGetter } from './budgetApi'

/* Oct 2, 2026: the browser's side of /api/requests. Laken types what she
   wants changed, a job on Cooper's Mac does it overnight, and this is how the
   app sends the request and reads back what became of it. The server decides
   everything; these four calls only carry her words there and turn each
   answer into a small outcome the card can show. No React and no window, so
   it is tested in bun with a fake fetch. */

export type RequestStatus = 'new' | 'in_progress' | 'needs_answer' | 'done' | 'blocked' | 'undone'

/** One line of "what changed". A side is null when the value didn't exist before, or doesn't now. */
export type RequestChange = { label: string; before: string | null; after: string | null }

export type BudgetRequest = {
  id: number
  author: string
  body: string
  status: RequestStatus
  /** `data` changed her numbers, `code` changed the app. Null until the job has decided. */
  lane: 'data' | 'code' | null
  question: string | null
  answer: string | null
  summary: string | null
  changes: RequestChange[] | null
  /** True only while the budget is still exactly as that change left it. */
  canUndo: boolean
  createdAt: string
  updatedAt: string
}

/* `failed` is every answer the card has no words of its own for: no
   connection, no API (the local preview), a 401, a 5xx. */
export type ListResult = { kind: 'ok'; requests: BudgetRequest[] } | { kind: 'failed' }
export type SubmitResult = { kind: 'ok'; id: number } | { kind: 'too_many_open' } | { kind: 'failed' }
export type AnswerResult = { kind: 'ok' } | { kind: 'not_waiting' } | { kind: 'failed' }
export type UndoResult = { kind: 'ok'; version: number } | { kind: 'cannot_undo' } | { kind: 'failed' }

export type RequestsApi = {
  /** The budget's newest requests, newest first. */
  list(): Promise<ListResult>
  submit(body: string): Promise<SubmitResult>
  /** Her reply to the one question a request came back with. It goes back in the queue. */
  answer(id: number, text: string): Promise<AnswerResult>
  /** Put the budget back as it was before that change. Refused once the budget has moved on. */
  undo(id: number): Promise<UndoResult>
}

const STATUSES: readonly string[] = ['new', 'in_progress', 'needs_answer', 'done', 'blocked', 'undone']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asChanges(value: unknown): RequestChange[] | null {
  if (!Array.isArray(value)) return null
  const changes: RequestChange[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.label !== 'string') continue
    changes.push({ label: item.label, before: textOrNull(item.before), after: textOrNull(item.after) })
  }
  return changes.length > 0 ? changes : null
}

function asRequest(value: unknown): BudgetRequest | null {
  if (!isRecord(value)) return null
  const { id, body, status } = value
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null
  if (typeof body !== 'string' || typeof status !== 'string' || !STATUSES.includes(status)) return null
  return {
    id,
    author: typeof value.author === 'string' ? value.author : '',
    body,
    status: status as RequestStatus,
    lane: value.lane === 'data' || value.lane === 'code' ? value.lane : null,
    question: textOrNull(value.question),
    answer: textOrNull(value.answer),
    summary: textOrNull(value.summary),
    changes: asChanges(value.changes),
    /* Anything but a plain true hides Undo; the server would refuse it anyway. */
    canUndo: value.canUndo === true,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

function errorOf(reply: Reply): unknown {
  return isRecord(reply.body) ? reply.body.error : undefined
}

/** A row this version of the app can't read is left out rather than failing the whole list. */
export function classifyList(reply: Reply): ListResult {
  if (reply.status !== 200 || !isRecord(reply.body) || !Array.isArray(reply.body.requests)) return { kind: 'failed' }
  const requests: BudgetRequest[] = []
  for (const row of reply.body.requests) {
    const request = asRequest(row)
    if (request) requests.push(request)
  }
  return { kind: 'ok', requests }
}

export function classifySubmit(reply: Reply): SubmitResult {
  if (reply.status === 201 && isRecord(reply.body) && typeof reply.body.id === 'number') {
    return { kind: 'ok', id: reply.body.id }
  }
  if (reply.status === 429 && errorOf(reply) === 'too_many_open') return { kind: 'too_many_open' }
  return { kind: 'failed' }
}

export function classifyAnswer(reply: Reply): AnswerResult {
  /* A 200 that isn't JSON is a dev server's page, not the API saying yes. */
  if (reply.status === 200 && reply.body !== undefined) return { kind: 'ok' }
  if (reply.status === 409 && errorOf(reply) === 'not_waiting') return { kind: 'not_waiting' }
  return { kind: 'failed' }
}

export function classifyUndo(reply: Reply): UndoResult {
  if (reply.status === 200 && isRecord(reply.body) && typeof reply.body.version === 'number') {
    return { kind: 'ok', version: reply.body.version }
  }
  if (reply.status === 409 && errorOf(reply) === 'cannot_undo') return { kind: 'cannot_undo' }
  return { kind: 'failed' }
}

export function createRequestsApi({
  fetch,
  getToken,
  url = '/api/requests',
}: {
  fetch: FetchLike
  getToken: TokenGetter
  url?: string
}): RequestsApi {
  async function attempt(method: string, payload: unknown, freshToken: boolean): Promise<Reply> {
    /* No token is not the end of it: a remembered device carries the cookie
       from /api/device, which the browser attaches on its own. So the request
       goes out either way, the same as in budgetApi. */
    let token: string | null
    try {
      token = await (freshToken ? getToken({ skipCache: true }) : getToken())
    } catch {
      token = null
    }
    let response: Response
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          /* Asking for JSON keeps a dev server's HTML fallback from answering 200. */
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

  /* One retry with a fresh token, for the Clerk token that expired in its
     cache. A 401 means the server did nothing, so sending a POST twice this
     way can't file a request twice. */
  async function send(method: string, payload?: unknown): Promise<Reply> {
    const first = await attempt(method, payload, false)
    return first.status === 401 ? attempt(method, payload, true) : first
  }

  return {
    list: async () => classifyList(await send('GET')),
    submit: async (body) => classifySubmit(await send('POST', { body })),
    answer: async (id, text) => classifyAnswer(await send('POST', { id, answer: text })),
    undo: async (id) => classifyUndo(await send('POST', { id, undo: true })),
  }
}
