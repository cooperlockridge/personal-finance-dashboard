import { isBudgetData, type BudgetData } from '../src/lib/finance.ts'

/* The data lane. The model never hands back a budget: it hands back a short
   list of operations, and this file — which has no side effects and trusts
   nothing in that list — works out what the budget becomes, what changed, and
   whether the result is still a budget anyone should save. */

/** A key into an object, or `{ id }` to pick the array item carrying that id. */
export type Segment = string | { id: string }
export type Path = Segment[]

export type Op =
  | { op: 'set', path: Path, value: unknown, label: string }
  | { op: 'add', path: Path, value: Record<string, unknown>, label: string }
  | { op: 'remove', path: Path, label: string }

/** One line of "what changed" as Laken sees it. */
export type Change = { label: string, before: string | null, after: string | null }

export const MAX_OPS = 25
export const MAX_BUDGET_BYTES = 256 * 1024
const MAX_LABEL_LENGTH = 80
const MAX_SHOWN_LENGTH = 80

/* Assigning through any of these reaches the prototype every object shares
   instead of the budget. */
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']

/* The six slices of the document. A path has to start at one of them, so an
   op cannot grow the budget a seventh. */
const ROOT_KEYS: readonly string[] = ['profile', 'envelopes', 'funds', 'paychecks', 'extras', 'rollRange']

/* The four lists whose items are told apart by id. */
const ID_LISTS = ['envelopes', 'funds', 'paychecks', 'extras'] as const
/* History. The watchdog may add to these and nothing else. */
const APPEND_ONLY = ['paychecks', 'extras'] as const

/* An op list that is malformed, or that points at something the budget does
   not hold. The model got it wrong; nothing was applied. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeKey(key: string): string {
  if (key === '' || FORBIDDEN_KEYS.includes(key)) throw new PatchError(`"${key}" cannot be used as a key`)
  return key
}

/* JSON.parse makes "__proto__" an ordinary own key, so a value can carry one
   without harm until something copies it carelessly. Refused at any depth. */
function refuseForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) refuseForbiddenKeys(item)
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      safeKey(key)
      refuseForbiddenKeys(value[key])
    }
  }
}

function parsePath(raw: unknown): Path {
  if (!Array.isArray(raw) || raw.length === 0) throw new PatchError('A path is a list with at least one step')
  const path = raw.map((segment): Segment => {
    if (typeof segment === 'string') return safeKey(segment)
    if (isRecord(segment) && Object.keys(segment).length === 1 && typeof segment.id === 'string' && segment.id !== '') {
      return { id: safeKey(segment.id) }
    }
    /* Numbers land here: an index means a different item as soon as the list
       changes, and the list can change between the read and the write. */
    throw new PatchError('A path step is a key or { "id": "..." }')
  })
  if (typeof path[0] !== 'string' || !ROOT_KEYS.includes(path[0])) {
    throw new PatchError('A path starts at one of the six parts of the budget')
  }
  return path
}

/* Turns whatever the model wrote into ops, or throws. Run before anything is
   applied, so a list with one bad op applies none of them. */
export function parseOps(raw: unknown): Op[] {
  if (!Array.isArray(raw)) throw new PatchError('ops must be a list')
  return raw.map((item): Op => {
    if (!isRecord(item)) throw new PatchError('An op must be an object')
    const { op, label } = item
    if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_LENGTH) {
      throw new PatchError(`An op needs a label of 1 to ${MAX_LABEL_LENGTH} characters`)
    }
    const allowed = op === 'remove' ? ['op', 'path', 'label'] : ['op', 'path', 'value', 'label']
    if (Object.keys(item).some((key) => !allowed.includes(key))) throw new PatchError('An op has a field it should not')
    const path = parsePath(item.path)
    if (op === 'remove') return { op, path, label: label.trim() }
    if (op !== 'set' && op !== 'add') throw new PatchError('An op is one of set, add, remove')
    if (!Object.hasOwn(item, 'value') || item.value === undefined) throw new PatchError(`${op} needs a value`)
    refuseForbiddenKeys(item.value)
    if (op === 'set') return { op, path, value: item.value, label: label.trim() }
    if (!isRecord(item.value)) throw new PatchError('add takes an object')
    return { op, path, value: item.value, label: label.trim() }
  })
}

/* How a value reads in the app's "before → after" line. Short on purpose:
   it sits beside a label in a 12px list. */
export function show(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string') return clip(value)
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`
  if (isRecord(value)) {
    const name = value.name ?? value.id
    return typeof name === 'string' || typeof name === 'number' ? clip(String(name)) : 'item'
  }
  return null
}

function clip(text: string): string {
  return text.length > MAX_SHOWN_LENGTH ? `${text.slice(0, MAX_SHOWN_LENGTH - 1)}…` : text
}

function indexOfId(list: unknown[], id: string): number {
  const index = list.findIndex((item) => isRecord(item) && item.id === id)
  if (index === -1) throw new PatchError(`Nothing in the list has the id "${id}"`)
  return index
}

/* One step down. Own keys only, so "toString" or "length" finds nothing. */
function step(node: unknown, segment: Segment): unknown {
  if (typeof segment === 'string') {
    if (!isRecord(node) || !Object.hasOwn(node, segment)) throw new PatchError(`The path has no "${segment}" to follow`)
    return node[segment]
  }
  if (!Array.isArray(node)) throw new PatchError('An { "id" } step needs a list')
  return node[indexOfId(node, segment.id)]
}

function walk(root: unknown, path: Path): unknown {
  return path.reduce(step, root)
}

/**
 * Applies the ops in order to a copy. The budget passed in is never touched,
 * so the same call on the same input always gives the same answer.
 *
 * `changes` is what the app shows Laken, and each before/after is read from
 * the document itself on either side of the op. The model supplies the label
 * and nothing else: it cannot report one change and make another.
 */
export function applyOps(budget: BudgetData, ops: Op[]): { budget: BudgetData, changes: Change[] } {
  const next: unknown = structuredClone(budget)
  const changes: Change[] = []

  for (const op of ops) {
    if (op.op === 'add') {
      const list = walk(next, op.path)
      if (!Array.isArray(list)) throw new PatchError('add needs a path that ends at a list')
      const value = structuredClone(op.value)
      list.push(value)
      changes.push({ label: op.label, before: null, after: show(value) })
      continue
    }

    const parent = walk(next, op.path.slice(0, -1))
    const last = op.path[op.path.length - 1]

    if (op.op === 'remove') {
      if (typeof last === 'string' || !Array.isArray(parent)) {
        throw new PatchError('remove needs a path that ends at { "id" } in a list')
      }
      const [removed] = parent.splice(indexOfId(parent, last.id), 1)
      changes.push({ label: op.label, before: show(removed), after: null })
      continue
    }

    const value = structuredClone(op.value)
    if (typeof last === 'string') {
      if (!isRecord(parent)) throw new PatchError(`"${last}" can only be set on an object`)
      const before = Object.hasOwn(parent, last) ? parent[last] : undefined
      parent[last] = value
      changes.push({ label: op.label, before: show(before), after: show(value) })
    } else {
      if (!Array.isArray(parent)) throw new PatchError('An { "id" } step needs a list')
      if (!isRecord(value)) throw new PatchError('A list item can only be replaced by an object')
      const index = indexOfId(parent, last.id)
      const before = parent[index]
      parent[index] = value
      changes.push({ label: op.label, before: show(before), after: show(value) })
    }
  }

  return { budget: next as BudgetData, changes }
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(allFinite)
  if (isRecord(value)) return Object.values(value).every(allFinite)
  return true
}

/* Equality the way JSON sees it: key order does not count, and a key holding
   undefined is the same as no key. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined)
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined)
  return aKeys.length === bKeys.length && aKeys.every((key) => b[key] !== undefined && sameJson(a[key], b[key]))
}

/**
 * Everything wrong with a patched budget, in words for Cooper's email. An
 * empty list means it may be saved. `opCount` is how many ops produced it.
 *
 * This runs on the result, not on the ops, so it holds no matter how the ops
 * got there: a `set` that swaps out the whole paychecks list is caught by the
 * same rule as a `remove` aimed at one check.
 */
export function validateBudget(next: unknown, previous: BudgetData, opCount = 0): string[] {
  const problems: string[] = []
  if (opCount > MAX_OPS) problems.push(`${opCount} operations is more than the ${MAX_OPS} one request may make`)
  if (!isBudgetData(next)) {
    problems.push('The result is not a budget')
    return problems
  }

  /* JSON has no NaN, but 1e999 parses to Infinity, and Infinity saves as null. */
  if (!allFinite(next)) problems.push('A number is not finite')

  for (const key of ID_LISTS) {
    const seen = new Set<string>()
    for (const item of next[key] as unknown[]) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') {
        problems.push(`An item in ${key} has no id`)
      } else if (seen.has(item.id)) {
        problems.push(`Two items in ${key} share the id "${item.id}"`)
      } else {
        seen.add(item.id)
      }
    }
  }

  /* Percent-of-net envelopes are cut from the same check, so together they
     cannot take more than all of it. A negative share would let the others
     pass that sum while taking more than the check, so it is refused too. */
  let percentOfNet = 0
  for (const envelope of next.envelopes as unknown[]) {
    if (!isRecord(envelope) || envelope.kind !== 'percentNet') continue
    if (typeof envelope.value !== 'number' || envelope.value < 0) {
      problems.push('A percent-of-net envelope has a share below zero or no share at all')
    } else {
      percentOfNet += envelope.value
    }
  }
  if (percentOfNet > 100 + 1e-9) problems.push(`Percent-of-net envelopes add up to ${percentOfNet}%, over 100%`)

  /* Past paychecks and extra savings are the record of what happened. `add`
     appends, so every record that was there must still be there, unchanged
     and in its place. */
  for (const key of APPEND_ONLY) {
    const before = previous[key] as unknown[]
    const after = next[key] as unknown[]
    if (after.length < before.length || before.some((item, i) => !sameJson(item, after[i]))) {
      problems.push(`An existing record in ${key} was changed or removed`)
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify(next)).length
  if (bytes >= MAX_BUDGET_BYTES) problems.push(`The budget would be ${bytes} bytes, over the 256 KB limit`)

  return problems
}
