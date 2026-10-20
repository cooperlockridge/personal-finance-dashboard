import { handleBudget } from '../budget.js'
import { handleRequests } from '../requests.js'
import { isBudgetData, migrateBudget, type BudgetData } from '../../src/lib/finance.js'
import type { Env, FetchLike } from './http.js'

/* The budget as the MCP tools see it (2026-10-19). Every read and write goes
   through the very handlers the app calls — /api/budget and /api/requests —
   with the caller's Clerk id handed in as already verified. So membership,
   the shape check, and the version-guarded save are the same code for Claude
   as for her phone, not a second copy of them. */

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/* A save that loses a version race is redone on the fresh copy. Three goes
   is already a race nobody wins by typing. */
const MAX_ATTEMPTS = 3

export type BudgetSnapshot = {
  data: BudgetData
  version: number
  updatedAt: string | null
  updatedBy: string | null
}

export type StoreDeps = { env: Env, fetch?: FetchLike, userId: string }

export type BudgetStore = ReturnType<typeof createBudgetStore>

export function createBudgetStore(deps: StoreDeps) {
  const overrides = {
    env: deps.env,
    verify: async () => ({ userId: deps.userId }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  }

  async function call(path: string, method: string, body?: unknown) {
    const request = new Request(`https://internal.invalid${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const response = path.startsWith('/api/requests')
      ? await handleRequests(request, overrides)
      : await handleBudget(request, overrides)
    const text = await response.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {}
    } catch {
      /* Every handler answers JSON; anything else falls to the status check. */
    }
    return { status: response.status, body: parsed }
  }

  function failure(status: number, body: Record<string, unknown>): never {
    if (status === 403) throw new ToolError('This login is not on a budget yet. Ask Cooper to add it.')
    if (status === 401) throw new ToolError('Not signed in. Reconnect the connector in Claude.')
    throw new ToolError(`The budget server answered ${status}${body.error ? ` (${String(body.error)})` : ''}. Try again in a moment.`)
  }

  function toSnapshot(body: Record<string, unknown>): BudgetSnapshot {
    const raw = body.data
    if (raw === null || raw === undefined) {
      throw new ToolError('The budget has not been set up yet. Open the dashboard once on a signed-in device, then try again.')
    }
    if (!isBudgetData(raw)) throw new ToolError('The stored budget is in a shape this tool does not understand.')
    return {
      data: migrateBudget(raw),
      version: Number(body.version),
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
      updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy : null,
    }
  }

  async function read(): Promise<BudgetSnapshot> {
    const { status, body } = await call('/api/budget', 'GET')
    if (status !== 200) failure(status, body)
    return toSnapshot(body)
  }

  /* `change` gets the current budget and returns the next one plus whatever
     the tool reports back. It may run more than once, so it must be pure. */
  async function mutate<T>(change: (data: BudgetData) => { data: BudgetData, result: T }): Promise<T & { version: number }> {
    let current = await read()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { data, result } = change(current.data)
      const { status, body } = await call('/api/budget', 'PUT', { baseVersion: current.version, data })
      if (status === 200) return { ...result, version: Number(body.version) }
      if (status !== 409) failure(status, body)
      current = toSnapshot(body)
    }
    throw new ToolError('The budget kept changing on another device while saving. Try again.')
  }

  async function requests(method: 'GET' | 'POST', body?: unknown) {
    return call('/api/requests', method, body)
  }

  return { read, mutate, requests, failure }
}
