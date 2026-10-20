import {
  buildPaycheck,
  effectiveTaxRate,
  envelopeAmount,
  findDuplicate,
  formatDay,
  fundStatus,
  fundsPerCheckTotal,
  grossForCheck,
  grossOf,
  hasStarted,
  learnedWithholding,
  neededPerCheck,
  RETIRED_FUNDS,
  rollAmount,
  typicalNet,
  type BudgetData,
  type Envelope,
  type EnvelopeKind,
  type Fund,
  type FundStatus,
  type Paycheck,
  type Profile,
} from '../../src/lib/finance.js'
import { BUDGET_SCHEMA_GUIDE, budgetProblems } from './budgetSchema.js'
import { ToolError, type BudgetStore } from './budgetStore.js'
import { applyPatch, PatchError } from './jsonPatch.js'

/* Every tool the Claude connector offers (2026-10-19). The goal is that
   anything the dashboard can show or change, Claude can too, using the same
   math from src/lib/finance.ts so a paycheck logged in chat splits exactly
   the way one typed into the app does.

   A tool is a JSON Schema for its arguments plus a function from (context,
   arguments) to a plain object. mcp.ts turns that object into the MCP
   result. Writes go through store.mutate, which reapplies the change on a
   fresh copy if a device saved first. */

export type ToolContext = {
  store: BudgetStore
  /** Her wall clock (America/New_York) as a local Date, so finance.ts's local-midnight math lines up on a UTC server. */
  now: Date
  /** 'YYYY-MM-DD' on her clock. */
  today: string
}

type JsonSchema = Record<string, unknown>

export type ToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: false
}

export type Tool = {
  name: string
  description: string
  inputSchema: JsonSchema
  annotations: ToolAnnotations
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/* ---------- schema helpers ---------- */

const string = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra })
const number = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', description, ...extra })
const boolean = (description: string): JsonSchema => ({ type: 'boolean', description })
const date = (description: string): JsonSchema => string(description, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [schema.type as string, 'null'] })

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const ENVELOPE_REF = string('The envelope, by id or name (for example "general" or "Wedding Savings").')
const FUND_REF = string('The sinking fund, by id or name (for example "christmas" or "Christmas 2026").')
const KIND = string(
  'How the envelope takes from each check: percentNet = % of take-home, percentGross = % of gross pay, fixedPerCheck = a set dollar amount.',
  { enum: ['percentNet', 'percentGross', 'fixedPerCheck'] },
)

/* ---------- argument readers ---------- */

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'string' ? Number.parseFloat(value.replace(/[$,]/g, '')) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw new ToolError(`${key} must be a number.`)
  return parsed
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = optionalNumber(args, key)
  if (value === undefined) throw new ToolError(`${key} is required.`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolError(`${key} must be text.`)
  return value.trim()
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key)
  if (!value) throw new ToolError(`${key} is required.`)
  return value
}

function optionalDate(args: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(args, key)
  if (value === undefined || value === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime())) {
    throw new ToolError(`${key} must be a date like 2026-10-24.`)
  }
  return value
}

/* A date field that may be cleared: undefined = leave alone, null = remove. */
function clearableDate(args: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in args)) return undefined
  if (args[key] === null || args[key] === '') return null
  return optionalDate(args, key)
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false.`)
  return value
}

function optionalMonth(args: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(args, key)
  if (value === undefined || value === '') return undefined
  if (!/^\d{4}-\d{2}$/.test(value)) throw new ToolError(`${key} must look like 2026-10.`)
  return value
}

const cents = (n: number) => Math.round(n * 100) / 100

function positiveMoney(args: Record<string, unknown>, key: string): number {
  const value = cents(requiredNumber(args, key))
  if (value <= 0) throw new ToolError(`${key} must be more than $0.`)
  return value
}

/* ---------- lookups ---------- */

function norm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function findByRef<T extends { id: string, name: string }>(items: T[], ref: string, kind: string): T {
  const exact = items.find((item) => item.id === ref)
  if (exact) return exact
  const key = norm(ref)
  const byName = items.filter((item) => norm(item.name) === key || norm(item.id) === key)
  if (byName.length === 1) return byName[0]
  const partial = items.filter((item) => norm(item.name).includes(key))
  if (partial.length === 1) return partial[0]
  const names = items.map((item) => `${item.name} (${item.id})`).join(', ')
  throw new ToolError(
    partial.length > 1
      ? `"${ref}" matches more than one ${kind}: ${partial.map((p) => p.name).join(', ')}. Be more specific.`
      : `No ${kind} called "${ref}". The ${kind}s are: ${names || 'none'}.`,
  )
}

function findPaycheck(data: BudgetData, id: string): Paycheck {
  const check = data.paychecks.find((p) => p.id === id)
  if (!check) throw new ToolError(`No paycheck with id ${id}. Use list_paychecks to find it.`)
  return check
}

function slugId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'item'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/* ---------- views ---------- */

const KIND_LABELS: Record<EnvelopeKind, string> = {
  percentNet: '% of take-home',
  percentGross: '% of gross',
  fixedPerCheck: '$ per check',
}

function ruleText(env: Envelope): string {
  return env.kind === 'fixedPerCheck' ? `$${env.value} per check` : `${env.value}${KIND_LABELS[env.kind]}`
}

function typicalCheck(data: BudgetData) {
  const withholding = learnedWithholding(data.paychecks, data.profile)
  const gross = grossForCheck(data.profile, null)
  const net = typicalNet(data.profile, withholding)
  return { withholding, gross, net }
}

function envelopeView(env: Envelope, data: BudgetData) {
  const typical = typicalCheck(data)
  const isDebt = env.remaining !== null
  return {
    id: env.id,
    name: env.name,
    rule: ruleText(env),
    kind: env.kind,
    value: env.value,
    countsAsSavings: env.countsAsSavings,
    ...(isDebt
      ? { type: 'debt', leftToPay: cents(env.remaining ?? 0), paidOff: (env.remaining ?? 0) <= 0 }
      : { type: 'balance', balance: cents(env.balance) }),
    perTypicalCheck: typical.net === null ? null : cents(envelopeAmount(env, typical.net, typical.gross)),
  }
}

function riskAdvice(fund: Fund, status: FundStatus): string | null {
  if (status.state === 'overdue') {
    return `Its ${fund.deadline ? formatDay(fund.deadline) : ''} date has passed with $${cents(status.remaining)} still to go.`
  }
  if (status.state === 'stalled') {
    return 'It has a target but no date, so nothing is being set aside. Add a deadline or a $/check amount.'
  }
  if (status.state === 'behind' && status.needed !== null) {
    return `Set to $${cents(status.contributing)}/check but needs $${cents(status.needed)} to make ${fund.deadline ? formatDay(fund.deadline) : 'its date'}. Raise it by $${cents(status.shortfall)} or set perCheck to 0 for automatic.`
  }
  return null
}

const STATE_LABELS: Record<FundStatus['state'], string> = {
  done: 'funded',
  overdue: 'past due',
  behind: 'behind',
  stalled: 'not funding',
  upcoming: 'not started yet',
  onTrack: 'on track',
  noTarget: 'no target',
}

function fundView(fund: Fund, ctx: ToolContext, profile: Profile) {
  const status = fundStatus(fund, ctx.now, profile)
  return {
    id: fund.id,
    name: fund.name,
    saved: cents(fund.current),
    target: fund.target,
    remaining: cents(status.remaining),
    progressPercent: fund.target && fund.target > 0 ? Math.min(100, Math.round((fund.current / fund.target) * 100)) : null,
    deadline: fund.deadline,
    deadlineLabel: fund.deadline ? formatDay(fund.deadline) : null,
    startDate: fund.startDate ?? null,
    perCheckSetting: fund.perCheck,
    mode: fund.perCheck > 0 ? 'manual' : 'auto',
    contributingPerCheck: cents(status.contributing),
    neededPerCheck: status.needed === null ? null : cents(status.needed),
    state: status.state,
    stateLabel: STATE_LABELS[status.state],
    needsAttention: status.state === 'behind' || status.state === 'overdue' || status.state === 'stalled',
    advice: riskAdvice(fund, status),
    note: fund.note ?? null,
  }
}

function names(data: BudgetData) {
  return {
    envelopes: new Map(data.envelopes.map((e) => [e.id, e.name])),
    funds: new Map<string, string>([...RETIRED_FUNDS, ...data.funds.map((f): [string, string] => [f.id, f.name])]),
  }
}

function paycheckView(check: Paycheck, data: BudgetData) {
  const gross = grossOf(check, data.profile)
  const rate = effectiveTaxRate(check.net, gross)
  const labels = names(data)
  const allocations = [
    ...Object.entries(check.envelopeAmounts).map(([id, amount]) => ({ to: labels.envelopes.get(id) ?? id, id, type: 'envelope', amount: cents(amount) })),
    ...Object.entries(check.fundAmounts).map(([id, amount]) => ({ to: labels.funds.get(id) ?? id, id, type: 'fund', amount: cents(amount) })),
  ].sort((a, b) => b.amount - a.amount)
  return {
    id: check.id,
    date: check.date,
    dateLabel: formatDay(check.date),
    takeHome: cents(check.net),
    hours: check.hours,
    gross: cents(gross),
    grossIsEstimate: check.grossEstimated,
    taxesTookPercent: rate === null ? null : Math.round(rate * 100),
    allocations,
    stayedInChecking: cents(check.leftover),
  }
}

function savingsRows(data: BudgetData) {
  const extrasTotal = data.extras.reduce((s, x) => s + x.amount, 0)
  const rows = [
    ...data.envelopes.filter((e) => e.countsAsSavings).map((e) => ({ id: e.id, label: e.name, amount: cents(e.balance) })),
    { id: 'funds', label: 'Sinking funds', amount: cents(data.funds.reduce((s, f) => s + f.current, 0)) },
    ...(extrasTotal > 0 ? [{ id: 'extras', label: 'Random savings', amount: cents(extrasTotal) }] : []),
    { id: 'interest', label: 'HYSA interest', amount: cents(data.profile.hysaInterestToDate) },
  ].sort((a, b) => b.amount - a.amount)
  return { rows, total: cents(rows.reduce((s, r) => s + r.amount, 0)) }
}

function monthSummary(data: BudgetData, month: string) {
  const checks = data.paychecks.filter((p) => p.date.startsWith(month))
  const savingIds = new Set(data.envelopes.filter((e) => e.countsAsSavings).map((e) => e.id))
  const labels = names(data)
  const byDestination = new Map<string, { to: string, type: string, amount: number }>()
  let savedFromChecks = 0
  for (const check of checks) {
    for (const [id, amount] of Object.entries(check.envelopeAmounts)) {
      if (savingIds.has(id)) savedFromChecks += amount
      const row = byDestination.get(`e:${id}`) ?? { to: labels.envelopes.get(id) ?? id, type: 'envelope', amount: 0 }
      row.amount += amount
      byDestination.set(`e:${id}`, row)
    }
    for (const [id, amount] of Object.entries(check.fundAmounts)) {
      savedFromChecks += amount
      const row = byDestination.get(`f:${id}`) ?? { to: labels.funds.get(id) ?? id, type: 'fund', amount: 0 }
      row.amount += amount
      byDestination.set(`f:${id}`, row)
    }
  }
  const extras = data.extras.filter((x) => x.date.startsWith(month))
  const extrasTotal = extras.reduce((s, x) => s + x.amount, 0)
  const [year, mon] = month.split('-').map(Number)
  return {
    month,
    monthLabel: new Date(year, mon - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    broughtHome: cents(checks.reduce((s, p) => s + p.net, 0)),
    grossPay: cents(checks.reduce((s, p) => s + grossOf(p, data.profile), 0)),
    paycheckCount: checks.length,
    savedThisMonth: cents(savedFromChecks + extrasTotal),
    savedFromPaychecks: cents(savedFromChecks),
    randomSavings: cents(extrasTotal),
    randomSavingsCount: extras.length,
    stayedInChecking: cents(checks.reduce((s, p) => s + p.leftover, 0)),
    allocations: [...byDestination.values()].map((r) => ({ ...r, amount: cents(r.amount) })).sort((a, b) => b.amount - a.amount),
  }
}

function monthKey(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/* ---------- budget changes, shared by several tools ---------- */

function applyPaycheck(data: BudgetData, check: Paycheck): BudgetData {
  return {
    ...data,
    paychecks: [check, ...data.paychecks],
    envelopes: data.envelopes.map((env) => {
      const amount = check.envelopeAmounts[env.id] ?? 0
      if (amount === 0) return env
      return env.remaining !== null
        ? { ...env, remaining: Math.max(0, env.remaining - amount) }
        : { ...env, balance: env.balance + amount }
    }),
    funds: data.funds.map((fund) => {
      const amount = check.fundAmounts[fund.id] ?? 0
      return amount === 0 ? fund : { ...fund, current: fund.current + amount }
    }),
  }
}

/* Mirrors removePaycheck in App.tsx, including a retired fund's share
   coming back out of General Savings, where that money was folded. */
function reversePaycheck(data: BudgetData, check: Paycheck): BudgetData {
  const retiredShare = Object.entries(check.fundAmounts)
    .filter(([id]) => RETIRED_FUNDS.has(id))
    .reduce((s, [, amount]) => s + amount, 0)
  return {
    ...data,
    paychecks: data.paychecks.filter((p) => p.id !== check.id),
    envelopes: data.envelopes.map((env) => {
      const amount = (check.envelopeAmounts[env.id] ?? 0) + (env.id === 'general' ? retiredShare : 0)
      if (amount === 0) return env
      return env.remaining !== null
        ? { ...env, remaining: env.remaining + amount }
        : { ...env, balance: env.balance - amount }
    }),
    funds: data.funds.map((fund) => {
      const amount = check.fundAmounts[fund.id] ?? 0
      return amount === 0 ? fund : { ...fund, current: fund.current - amount }
    }),
  }
}

function previewWarnings(data: BudgetData, check: Paycheck, hoursUsed: number) {
  const warnings: string[] = []
  const duplicate = findDuplicate(data.paychecks, check.date, check.net)
  if (duplicate) {
    warnings.push(`A $${cents(duplicate.net)} paycheck is already logged on ${formatDay(duplicate.date)} (id ${duplicate.id}). Adding it again would double every allocation.`)
  }
  if (check.net > check.gross) {
    warnings.push(`Take-home is more than gross pay for ${hoursUsed} hours ($${cents(check.gross)}). Double-check the amount or hours.`)
  }
  if (check.leftover < 0) {
    warnings.push(`Allocations are $${cents(-check.leftover)} more than this check.`)
  }
  return { warnings, duplicate }
}

function validEnvelopeFields(args: Record<string, unknown>) {
  const patch: Partial<Envelope> = {}
  const name = optionalString(args, 'name')
  if (name !== undefined) {
    if (!name) throw new ToolError('name cannot be empty.')
    patch.name = name.slice(0, 60)
  }
  const kind = optionalString(args, 'kind')
  if (kind !== undefined) {
    if (kind !== 'percentNet' && kind !== 'percentGross' && kind !== 'fixedPerCheck') {
      throw new ToolError('kind must be percentNet, percentGross or fixedPerCheck.')
    }
    patch.kind = kind
  }
  const value = optionalNumber(args, 'value')
  if (value !== undefined) {
    if (value < 0) throw new ToolError('value cannot be negative.')
    patch.value = cents(value)
  }
  const balance = optionalNumber(args, 'balance')
  if (balance !== undefined) patch.balance = cents(balance)
  const countsAsSavings = optionalBoolean(args, 'countsAsSavings')
  if (countsAsSavings !== undefined) patch.countsAsSavings = countsAsSavings
  return patch
}

function validFundFields(args: Record<string, unknown>) {
  const patch: Partial<Fund> = {}
  const name = optionalString(args, 'name')
  if (name !== undefined) {
    if (!name) throw new ToolError('name cannot be empty.')
    patch.name = name.slice(0, 60)
  }
  if ('target' in args) {
    const target = optionalNumber(args, 'target')
    patch.target = target === undefined || target <= 0 ? null : cents(target)
  }
  const saved = optionalNumber(args, 'saved')
  if (saved !== undefined) patch.current = cents(saved)
  const deadline = clearableDate(args, 'deadline')
  if (deadline !== undefined) patch.deadline = deadline
  const startDate = clearableDate(args, 'startDate')
  if (startDate !== undefined) patch.startDate = startDate
  const perCheck = optionalNumber(args, 'perCheck')
  if (perCheck !== undefined) {
    if (perCheck < 0) throw new ToolError('perCheck cannot be negative. Use 0 for automatic.')
    patch.perCheck = cents(perCheck)
  }
  if ('note' in args) {
    const note = optionalString(args, 'note')
    patch.note = note ? note.slice(0, 200) : undefined
  }
  return patch
}

function checkFundDates(fund: Fund) {
  if (fund.deadline && fund.startDate && fund.startDate > fund.deadline) {
    throw new ToolError('The start date has to be on or before the deadline.')
  }
}

/* A place money can sit: an envelope with a balance, a sinking fund, or
   plain checking (outside the budget). */
type Pot = { kind: 'envelope', env: Envelope } | { kind: 'fund', fund: Fund } | { kind: 'checking' }

function findPot(data: BudgetData, ref: string): Pot {
  if (norm(ref) === 'checking' || norm(ref) === 'outside' || norm(ref) === 'spent') return { kind: 'checking' }
  const envelope = data.envelopes.find((e) => e.id === ref || norm(e.name) === norm(ref) || norm(e.id) === norm(ref))
  if (envelope) return { kind: 'envelope', env: envelope }
  const fund = data.funds.find((f) => f.id === ref || norm(f.name) === norm(ref) || norm(f.id) === norm(ref))
  if (fund) return { kind: 'fund', fund }
  const all = [...data.envelopes.map((e) => ({ id: e.id, name: e.name })), ...data.funds.map((f) => ({ id: f.id, name: f.name }))]
  const partial = all.filter((p) => norm(p.name).includes(norm(ref)))
  if (partial.length === 1) return findPot(data, partial[0].id)
  throw new ToolError(`No envelope or fund called "${ref}". Options: ${all.map((p) => p.name).join(', ')}, or "checking".`)
}

function adjustPot(data: BudgetData, pot: Pot, delta: number): BudgetData {
  if (pot.kind === 'checking') return data
  if (pot.kind === 'envelope') {
    if (pot.env.remaining !== null) {
      throw new ToolError(`${pot.env.name} tracks a debt, not a balance. Change what is left to pay with update_envelope instead.`)
    }
    return { ...data, envelopes: data.envelopes.map((e) => (e.id === pot.env.id ? { ...e, balance: cents(e.balance + delta) } : e)) }
  }
  return { ...data, funds: data.funds.map((f) => (f.id === pot.fund.id ? { ...f, current: cents(f.current + delta) } : f)) }
}

function potLabel(pot: Pot) {
  return pot.kind === 'checking' ? 'checking' : pot.kind === 'envelope' ? pot.env.name : pot.fund.name
}

function potBalance(data: BudgetData, pot: Pot): number | null {
  if (pot.kind === 'checking') return null
  if (pot.kind === 'envelope') return cents(data.envelopes.find((e) => e.id === pot.env.id)?.balance ?? 0)
  return cents(data.funds.find((f) => f.id === pot.fund.id)?.current ?? 0)
}

/* ---------- the catch-all patch ---------- */

const LISTS = ['envelopes', 'funds', 'paychecks', 'extras']

/* Problem messages name items by index, which shifts when an item is added
   or removed. Keyed by id instead, an old record's old problem is
   recognised as old wherever it moves. */
function stableProblems(data: unknown): Map<string, string> {
  const record = (data ?? {}) as Record<string, unknown>
  const keyed = new Map<string, string>()
  for (const message of budgetProblems(data)) {
    const key = message.replace(/\/(envelopes|funds|paychecks|extras)\/(\d+)/, (whole, list: string, index: string) => {
      const items = record[list]
      const id = Array.isArray(items) ? (items[Number(index)] as { id?: unknown } | undefined)?.id : undefined
      return typeof id === 'string' ? `/${list}#${id}` : whole
    })
    keyed.set(key, message)
  }
  return keyed
}

/* A short, readable list of what a patch changed, by item name. */
function describeChanges(before: BudgetData, after: BudgetData): string[] {
  const lines: string[] = []
  const label = (list: string, item: Record<string, unknown>) =>
    `${list.slice(0, -1)} "${String(item.name ?? item.date ?? item.id)}"`
  const show = (value: unknown) => JSON.stringify(value) ?? '(none)'
  for (const list of LISTS) {
    const items = (doc: BudgetData) => (doc as Record<string, unknown>)[list] as Record<string, unknown>[]
    const was = new Map(items(before).map((x) => [x.id, x]))
    const now = new Map(items(after).map((x) => [x.id, x]))
    for (const [id, item] of now) {
      const old = was.get(id)
      if (!old) {
        lines.push(`added ${label(list, item)}`)
        continue
      }
      for (const field of new Set([...Object.keys(old), ...Object.keys(item)])) {
        if (show(old[field]) !== show(item[field])) lines.push(`${label(list, item)}: ${field} ${show(old[field])} → ${show(item[field])}`)
      }
    }
    for (const [id, item] of was) if (!now.has(id)) lines.push(`removed ${label(list, item)}`)
    const order = (m: Map<unknown, unknown>) => [...m.keys()].filter((id) => was.has(id) && now.has(id)).join()
    if (order(was) !== order(now)) lines.push(`reordered ${list}`)
  }
  for (const key of ['profile', 'rollRange'] as const) {
    const old = before[key] as Record<string, unknown>
    const now = after[key] as Record<string, unknown>
    for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) {
      if (show(old[field]) !== show(now[field])) lines.push(`${key}.${field}: ${show(old[field])} → ${show(now[field])}`)
    }
  }
  return lines
}

function checkedPatch(data: BudgetData, operations: unknown): { next: BudgetData, changes: string[] } {
  let next: BudgetData
  try {
    next = applyPatch(data, operations)
  } catch (error) {
    if (error instanceof PatchError) throw new ToolError(`Patch not applied. ${error.message}`)
    throw error
  }
  const before = stableProblems(data)
  const introduced = [...stableProblems(next)].filter(([key]) => !before.has(key)).map(([, message]) => message)
  if (introduced.length > 0) {
    throw new ToolError(`Patch not applied: it would leave the budget in a shape the app cannot use.\n- ${introduced.slice(0, 15).join('\n- ')}\nSee get_budget_schema.`)
  }
  const changes = describeChanges(data, next)
  if (changes.length === 0) throw new ToolError('Patch not applied: it changes nothing.')
  return { next, changes }
}

/* ---------- the tools ---------- */

const READ = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, openWorldHint: false })
const WRITE = (title: string, destructive = false, idempotent = false): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
})

export const TOOLS: Tool[] = [
  /* ===== Reading ===== */
  {
    name: 'get_overview',
    description: "The dashboard's home screen in one call: total put away, how much of it was saved this month, what she brought home this month, what taxes took from the last check, estimated HYSA interest, the latest paycheck, sinking funds that need attention, and how much all funds take per check. Start here for questions like \"how am I doing?\".",
    inputSchema: object({}),
    annotations: READ('Dashboard overview'),
    async run(ctx) {
      const snapshot = await ctx.store.read()
      const data = snapshot.data
      const savings = savingsRows(data)
      const month = monthSummary(data, monthKey(ctx.now))
      const latest = data.paychecks[0]
      const latestRate = latest ? effectiveTaxRate(latest.net, grossOf(latest, data.profile)) : null
      const general = data.envelopes.find((e) => e.id === 'general')?.balance ?? 0
      const typical = typicalCheck(data)
      const fundsDraw = fundsPerCheckTotal(data.funds, ctx.now, data.profile)
      const funds = data.funds.map((f) => fundView(f, ctx, data.profile))
      return {
        today: ctx.today,
        totalPutAway: savings.total,
        savedThisMonth: month.savedThisMonth,
        thisMonth: {
          label: month.monthLabel,
          broughtHome: month.broughtHome,
          paycheckCount: month.paycheckCount,
        },
        lastCheckTaxesTookPercent: latestRate === null ? null : Math.round(latestRate * 100),
        lastCheckTaxIsEstimate: latest?.grossEstimated ?? null,
        hysa: {
          apyPercent: data.profile.hysaApy,
          estimatedMonthlyInterest: cents((general * data.profile.hysaApy) / 100 / 12),
          interestToDate: data.profile.hysaInterestToDate,
          note: 'Monthly interest is estimated from the General Savings balance.',
        },
        latestPaycheck: latest ? paycheckView(latest, data) : null,
        fundsNeedingAttention: funds.filter((f) => f.needsAttention).map((f) => ({ name: f.name, state: f.stateLabel, advice: f.advice })),
        allFundsPerCheck: cents(fundsDraw),
        allFundsShareOfTypicalCheckPercent: typical.net && typical.net > 0 ? Math.round((fundsDraw / typical.net) * 100) : null,
        savingsBreakdown: savings.rows,
        lastSaved: { at: snapshot.updatedAt, version: snapshot.version },
      }
    },
  },
  {
    name: 'get_budget',
    description: 'The complete raw budget document exactly as stored: profile settings, every envelope, fund, paycheck (with its allocation snapshot), random saving, and the roll range. Use when you need a detail no other tool shows.',
    inputSchema: object({}),
    annotations: READ('Full budget data'),
    async run(ctx) {
      const snapshot = await ctx.store.read()
      return { version: snapshot.version, updatedAt: snapshot.updatedAt, budget: snapshot.data }
    },
  },
  {
    name: 'get_settings',
    description: 'Paycheck profile settings (hourly rate, typical hours per check, checks per month, HYSA APY, HYSA interest to date), the random-savings roll range, and what the app has learned from them: her real withholding rate, typical gross and typical take-home per check.',
    inputSchema: object({}),
    annotations: READ('Settings'),
    async run(ctx) {
      const { data } = await ctx.store.read()
      const typical = typicalCheck(data)
      return {
        profile: data.profile,
        rollRange: data.rollRange,
        learned: {
          withholdingPercent: typical.withholding === null ? null : Math.round(typical.withholding * 1000) / 10,
          typicalGrossPerCheck: cents(typical.gross),
          typicalTakeHomePerCheck: typical.net === null ? null : cents(typical.net),
          note: typical.withholding === null
            ? 'Withholding is learned from paychecks logged with hours. None yet.'
            : 'Withholding is the average from paychecks logged with hours.',
        },
      }
    },
  },
  {
    name: 'list_envelopes',
    description: 'Every envelope: its rule (percent of take-home, percent of gross, or fixed dollars per check), current balance (or amount left to pay for a debt like the car), whether it counts toward savings, and what it would take from a typical check.',
    inputSchema: object({}),
    annotations: READ('List envelopes'),
    async run(ctx) {
      const { data } = await ctx.store.read()
      const views = data.envelopes.map((e) => envelopeView(e, data))
      const percentNet = data.envelopes.filter((e) => e.kind === 'percentNet').reduce((s, e) => s + e.value, 0)
      return { envelopes: views, totalPercentOfTakeHome: percentNet }
    },
  },
  {
    name: 'list_funds',
    description: 'Every sinking fund (saving toward a dated goal like Christmas): saved vs target, deadline, start date, whether it is auto-funded or on a manual $/check, what it takes per check, what it needs per check to hit the date, and a status (on track, behind, past due, not funding, funded, not started yet) with advice.',
    inputSchema: object({}),
    annotations: READ('List sinking funds'),
    async run(ctx) {
      const { data } = await ctx.store.read()
      return {
        funds: data.funds.map((f) => fundView(f, ctx, data.profile)),
        allFundsPerCheck: cents(fundsPerCheckTotal(data.funds, ctx.now, data.profile)),
      }
    },
  },
  {
    name: 'get_savings_breakdown',
    description: 'Total put away and where it sits: each savings envelope, sinking funds combined, random savings, and HYSA interest, largest first.',
    inputSchema: object({}),
    annotations: READ('Savings breakdown'),
    async run(ctx) {
      const { data } = await ctx.store.read()
      return savingsRows(data)
    },
  },
  {
    name: 'list_paychecks',
    description: 'Paycheck history, newest first, each with take-home, hours, gross, what taxes took, and exactly where every dollar went. Filter by month or date range.',
    inputSchema: object({
      month: string('Only this month, like "2026-10".'),
      from: date('Only checks on or after this date (YYYY-MM-DD).'),
      to: date('Only checks on or before this date (YYYY-MM-DD).'),
      limit: number('Most to return. Default 20.', { minimum: 1, maximum: 200 }),
    }),
    annotations: READ('Paycheck history'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const month = optionalMonth(args, 'month')
      const from = optionalDate(args, 'from')
      const to = optionalDate(args, 'to')
      const limit = Math.max(1, Math.min(200, Math.round(optionalNumber(args, 'limit') ?? 20)))
      const matching = data.paychecks.filter((p) =>
        (!month || p.date.startsWith(month)) && (!from || p.date >= from) && (!to || p.date <= to))
      const sorted = [...matching].sort((a, b) => b.date.localeCompare(a.date))
      return {
        totalMatching: matching.length,
        totalTakeHome: cents(matching.reduce((s, p) => s + p.net, 0)),
        paychecks: sorted.slice(0, limit).map((p) => paycheckView(p, data)),
      }
    },
  },
  {
    name: 'get_paycheck',
    description: 'One paycheck in full detail, by its id (from list_paychecks).',
    inputSchema: object({ id: string('The paycheck id.') }, ['id']),
    annotations: READ('Paycheck details'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      return paycheckView(findPaycheck(data, requiredString(args, 'id')), data)
    },
  },
  {
    name: 'preview_paycheck',
    description: 'Shows how a take-home amount would split across envelopes and funds WITHOUT saving anything, plus warnings (already logged, more than gross, over-allocated). Use this to show her the split before add_paycheck.',
    inputSchema: object({
      takeHome: number('The post-tax deposit amount in dollars.', { exclusiveMinimum: 0 }),
      hours: number('Hours worked on this check, if known. Makes gross and the tax rate exact.'),
      date: date("The paycheck date (YYYY-MM-DD). Defaults to today."),
    }, ['takeHome']),
    annotations: READ('Preview a paycheck split'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const net = positiveMoney(args, 'takeHome')
      const hours = optionalNumber(args, 'hours')
      const day = optionalDate(args, 'date') ?? ctx.today
      const hoursOrNull = hours !== undefined && hours > 0 ? hours : null
      const check = buildPaycheck(net, hoursOrNull, day, data.profile, data.envelopes, data.funds, learnedWithholding(data.paychecks, data.profile))
      const { warnings } = previewWarnings(data, check, hoursOrNull ?? data.profile.typicalHours)
      const { id: _id, ...view } = paycheckView(check, data)
      return { saved: false, ...view, warnings }
    },
  },
  {
    name: 'get_month_summary',
    description: 'One month at a glance: brought home, gross, number of checks, how much went to savings (from paychecks and random savings), what stayed in checking, and totals per envelope and fund. Defaults to the current month.',
    inputSchema: object({ month: string('The month, like "2026-09". Defaults to this month.') }),
    annotations: READ('Month summary'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      return monthSummary(data, optionalMonth(args, 'month') ?? monthKey(ctx.now))
    },
  },
  {
    name: 'compare_months',
    description: 'Month-by-month totals (brought home, saved, number of checks) for the last several months, oldest first. Good for trends.',
    inputSchema: object({ months: number('How many months back, including this one. Default 6.', { minimum: 1, maximum: 24 }) }),
    annotations: READ('Compare months'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const count = Math.max(1, Math.min(24, Math.round(optionalNumber(args, 'months') ?? 6)))
      const rows = []
      for (let back = count - 1; back >= 0; back--) {
        const d = new Date(ctx.now.getFullYear(), ctx.now.getMonth() - back, 1)
        const { month, monthLabel, broughtHome, savedThisMonth, paycheckCount, randomSavings } = monthSummary(data, monthKey(d))
        rows.push({ month, monthLabel, broughtHome, saved: savedThisMonth, paycheckCount, randomSavings })
      }
      return { months: rows }
    },
  },
  {
    name: 'list_random_savings',
    description: 'Random savings: the extra money put away on a whim outside the paycheck split (rolled with the dice or typed). Newest first, with the total.',
    inputSchema: object({ limit: number('Most to return. Default 20.', { minimum: 1, maximum: 500 }) }),
    annotations: READ('List random savings'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const limit = Math.max(1, Math.min(500, Math.round(optionalNumber(args, 'limit') ?? 20)))
      return {
        total: cents(data.extras.reduce((s, x) => s + x.amount, 0)),
        count: data.extras.length,
        rollRange: data.rollRange,
        entries: data.extras.slice(0, limit).map((x) => ({ ...x, dateLabel: formatDay(x.date) })),
      }
    },
  },
  {
    name: 'roll_random_amount',
    description: 'Rolls the dice for random savings: a whole-dollar amount inside her roll range. Nothing is saved; call add_random_saving with rolled=true if she wants to put it away.',
    inputSchema: object({ previous: number('The last amount rolled, so a re-roll never lands on the same number.') }),
    annotations: READ('Roll a random amount'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const previous = optionalNumber(args, 'previous') ?? null
      return { amount: rollAmount(data.rollRange, previous), range: data.rollRange, saved: false }
    },
  },
  {
    name: 'plan_fund',
    description: 'What-if planner for a savings goal, without saving anything: given a target, what is already saved, a deadline and optional start date, how much each paycheck needs to set aside, and what share of a typical check that is.',
    inputSchema: object({
      target: number('Goal amount in dollars.', { exclusiveMinimum: 0 }),
      saved: number('Already saved toward it. Default 0.'),
      deadline: date('Date it is needed by (YYYY-MM-DD).'),
      startDate: date('Date to start setting money aside (YYYY-MM-DD). Default today.'),
    }, ['target', 'deadline']),
    annotations: READ('Plan a savings goal'),
    async run(ctx, args) {
      const { data } = await ctx.store.read()
      const fund: Fund = {
        id: 'plan',
        name: 'Plan',
        target: positiveMoney(args, 'target'),
        current: cents(optionalNumber(args, 'saved') ?? 0),
        deadline: optionalDate(args, 'deadline') ?? null,
        startDate: optionalDate(args, 'startDate') ?? null,
        perCheck: 0,
      }
      checkFundDates(fund)
      const perCheck = neededPerCheck(fund, ctx.now, data.profile)
      const typical = typicalCheck(data)
      return {
        perCheck: perCheck === null ? null : cents(perCheck),
        checksPerMonth: data.profile.checksPerMonth,
        perMonth: perCheck === null ? null : cents(perCheck * data.profile.checksPerMonth),
        shareOfTypicalCheckPercent: perCheck !== null && typical.net ? Math.round((perCheck / typical.net) * 100) : null,
        startsLater: !hasStarted(fund, ctx.now),
        allExistingFundsPerCheck: cents(fundsPerCheckTotal(data.funds, ctx.now, data.profile)),
      }
    },
  },

  /* ===== Paychecks ===== */
  {
    name: 'add_paycheck',
    description: 'Logs a paycheck and splits it across every envelope and sinking fund, exactly like the Add button in the app. Balances, debt payoff and fund progress all update. If the same amount is already logged on the same date it refuses unless allowDuplicate is true — ask her first. Removing it later with remove_paycheck reverses everything.',
    inputSchema: object({
      takeHome: number('The post-tax deposit amount in dollars.', { exclusiveMinimum: 0 }),
      hours: number('Hours worked on this check, if she knows. Makes gross and the tax rate exact.'),
      date: date('The paycheck date (YYYY-MM-DD). Defaults to today.'),
      allowDuplicate: boolean('Set true only after she confirms a second identical check on the same day is real.'),
    }, ['takeHome']),
    annotations: WRITE('Add a paycheck'),
    async run(ctx, args) {
      const net = positiveMoney(args, 'takeHome')
      const hours = optionalNumber(args, 'hours')
      const hoursOrNull = hours !== undefined && hours > 0 ? hours : null
      const day = optionalDate(args, 'date') ?? ctx.today
      const allowDuplicate = optionalBoolean(args, 'allowDuplicate') ?? false
      return ctx.store.mutate((data) => {
        const check = buildPaycheck(net, hoursOrNull, day, data.profile, data.envelopes, data.funds, learnedWithholding(data.paychecks, data.profile))
        const { warnings, duplicate } = previewWarnings(data, check, hoursOrNull ?? data.profile.typicalHours)
        if (duplicate && !allowDuplicate) {
          throw new ToolError(`Not saved: ${warnings[0]} Ask her if this is a second, separate deposit; if so, call again with allowDuplicate=true.`)
        }
        const next = applyPaycheck(data, check)
        return { data: next, result: { saved: true, paycheck: paycheckView(check, next), warnings, totalPutAway: savingsRows(next).total } }
      })
    },
  },
  {
    name: 'remove_paycheck',
    description: 'Deletes a logged paycheck and reverses every allocation it made (envelope balances, debt payoff, fund progress), exactly like "Remove this paycheck" in the app. Confirm with her first.',
    inputSchema: object({ id: string('The paycheck id (from list_paychecks).') }, ['id']),
    annotations: WRITE('Remove a paycheck', true, true),
    async run(ctx, args) {
      const id = requiredString(args, 'id')
      return ctx.store.mutate((data) => {
        const check = findPaycheck(data, id)
        const next = reversePaycheck(data, check)
        return { data: next, result: { removed: paycheckView(check, data), totalPutAway: savingsRows(next).total } }
      })
    },
  },
  {
    name: 'edit_paycheck',
    description: 'Corrects a logged paycheck (wrong amount, hours or date): reverses the old split and re-splits it with the new numbers using the current envelope and fund rules. Keep anything not given.',
    inputSchema: object({
      id: string('The paycheck id (from list_paychecks).'),
      takeHome: number('Corrected take-home amount.', { exclusiveMinimum: 0 }),
      hours: nullable(number('Corrected hours, or null to clear them.')),
      date: date('Corrected date (YYYY-MM-DD).'),
    }, ['id']),
    annotations: WRITE('Edit a paycheck', true),
    async run(ctx, args) {
      const id = requiredString(args, 'id')
      const takeHome = args.takeHome === undefined ? undefined : positiveMoney(args, 'takeHome')
      const hoursGiven = 'hours' in args
      const hours = hoursGiven ? optionalNumber(args, 'hours') : undefined
      const day = optionalDate(args, 'date')
      return ctx.store.mutate((data) => {
        const old = findPaycheck(data, id)
        const without = reversePaycheck(data, old)
        const hoursOrNull = hoursGiven ? (hours !== undefined && hours > 0 ? hours : null) : old.hours
        const check = buildPaycheck(takeHome ?? old.net, hoursOrNull, day ?? old.date, without.profile, without.envelopes, without.funds, learnedWithholding(without.paychecks, without.profile))
        /* Keep its id and its place in history. */
        const fixed = { ...check, id: old.id }
        const applied = applyPaycheck(without, fixed)
        const index = data.paychecks.findIndex((p) => p.id === old.id)
        const paychecks = applied.paychecks.slice(1)
        paychecks.splice(index, 0, fixed)
        const next = { ...applied, paychecks }
        return { data: next, result: { before: paycheckView(old, data), after: paycheckView(fixed, next) } }
      })
    },
  },

  /* ===== Settings ===== */
  {
    name: 'update_settings',
    description: 'Changes paycheck profile settings. Only the fields given change. hourlyRate and typicalHours set the gross estimate; checksPerMonth paces sinking funds; hysaApy and hysaInterestToDate feed the interest numbers.',
    inputSchema: object({
      hourlyRate: number('Hourly pay in dollars.', { minimum: 0 }),
      typicalHours: number('Usual hours on one paycheck.', { minimum: 0 }),
      checksPerMonth: number('Paychecks per month.', { minimum: 1 }),
      hysaApy: number('High-yield savings APY in percent, like 3.9.', { minimum: 0 }),
      hysaInterestToDate: number('Total HYSA interest earned so far, in dollars.', { minimum: 0 }),
    }),
    annotations: WRITE('Update settings', false, true),
    async run(ctx, args) {
      const patch: Partial<Profile> = {}
      for (const key of ['hourlyRate', 'typicalHours', 'checksPerMonth', 'hysaApy', 'hysaInterestToDate'] as const) {
        const value = optionalNumber(args, key)
        if (value === undefined) continue
        if (value < 0) throw new ToolError(`${key} cannot be negative.`)
        patch[key] = key === 'hysaInterestToDate' ? cents(value) : value
      }
      if (patch.checksPerMonth !== undefined && patch.checksPerMonth < 1) throw new ToolError('checksPerMonth must be at least 1.')
      if (Object.keys(patch).length === 0) throw new ToolError('Give at least one setting to change.')
      return ctx.store.mutate((data) => ({
        data: { ...data, profile: { ...data.profile, ...patch } },
        result: { before: data.profile, after: { ...data.profile, ...patch } },
      }))
    },
  },
  {
    name: 'set_roll_range',
    description: 'Sets the whole-dollar range the random-savings dice roll between.',
    inputSchema: object({
      min: number('Smallest amount a roll can land on.', { minimum: 1 }),
      max: number('Largest amount a roll can land on.', { minimum: 1 }),
    }, ['min', 'max']),
    annotations: WRITE('Set roll range', false, true),
    async run(ctx, args) {
      const min = Math.round(requiredNumber(args, 'min'))
      const max = Math.round(requiredNumber(args, 'max'))
      if (min < 1 || max < min) throw new ToolError('min must be at least 1 and no more than max.')
      return ctx.store.mutate((data) => ({ data: { ...data, rollRange: { min, max } }, result: { before: data.rollRange, after: { min, max } } }))
    },
  },

  /* ===== Envelopes ===== */
  {
    name: 'add_envelope',
    description: 'Creates an envelope that takes a share of every paycheck. For a debt (like a car loan) give leftToPay: contributions then pay it down and stop at $0 instead of building a balance.',
    inputSchema: object({
      name: string('Envelope name, like "Vacation".'),
      kind: KIND,
      value: number('The percent (for percent kinds) or dollars per check (for fixedPerCheck).', { minimum: 0 }),
      balance: number('Starting balance in dollars. Default 0.'),
      countsAsSavings: boolean('Whether it counts toward "put away". Default true.'),
      leftToPay: number('For a debt only: dollars still owed.', { minimum: 0 }),
    }, ['name', 'kind', 'value']),
    annotations: WRITE('Add an envelope'),
    async run(ctx, args) {
      const fields = validEnvelopeFields(args)
      const leftToPay = optionalNumber(args, 'leftToPay')
      return ctx.store.mutate((data) => {
        const envelope: Envelope = {
          id: slugId(fields.name ?? 'envelope', new Set(data.envelopes.map((e) => e.id))),
          name: fields.name ?? 'New Envelope',
          kind: fields.kind ?? 'percentNet',
          value: fields.value ?? 0,
          balance: fields.balance ?? 0,
          countsAsSavings: fields.countsAsSavings ?? leftToPay === undefined,
          remaining: leftToPay === undefined ? null : cents(leftToPay),
        }
        const next = { ...data, envelopes: [...data.envelopes, envelope] }
        return { data: next, result: { added: envelopeView(envelope, next) } }
      })
    },
  },
  {
    name: 'update_envelope',
    description: 'Changes an envelope: rename it, change its rule (kind/value), set its balance, set what is left to pay on a debt, or whether it counts as savings. Only the fields given change. Setting balance overwrites it; to add or take money use adjust_envelope or move_money.',
    inputSchema: object({
      envelope: ENVELOPE_REF,
      name: string('New name.'),
      kind: KIND,
      value: number('New percent or dollars per check.', { minimum: 0 }),
      balance: number('New balance in dollars (balance envelopes only).'),
      leftToPay: number('New amount left to pay (debt envelopes only).', { minimum: 0 }),
      countsAsSavings: boolean('Whether it counts toward "put away".'),
    }, ['envelope']),
    annotations: WRITE('Update an envelope', false, true),
    async run(ctx, args) {
      const ref = requiredString(args, 'envelope')
      const fields = validEnvelopeFields(args)
      const leftToPay = optionalNumber(args, 'leftToPay')
      return ctx.store.mutate((data) => {
        const env = findByRef(data.envelopes, ref, 'envelope')
        if (fields.balance !== undefined && env.remaining !== null) {
          throw new ToolError(`${env.name} is a debt. Set leftToPay instead of balance.`)
        }
        if (leftToPay !== undefined && env.remaining === null) {
          throw new ToolError(`${env.name} holds a balance, not a debt, so it has no leftToPay.`)
        }
        const updated: Envelope = { ...env, ...fields, ...(leftToPay !== undefined ? { remaining: cents(leftToPay) } : {}) }
        const next = { ...data, envelopes: data.envelopes.map((e) => (e.id === env.id ? updated : e)) }
        return { data: next, result: { before: envelopeView(env, data), after: envelopeView(updated, next) } }
      })
    },
  },
  {
    name: 'adjust_envelope',
    description: 'Adds money to or takes money out of an envelope balance, for example "I spent $40 from Expenses" (amount -40) or "put $100 more into Wedding" (amount 100). Money comes from or goes to outside the budget. Use move_money to shift between envelopes and funds.',
    inputSchema: object({
      envelope: ENVELOPE_REF,
      amount: number('Dollars to add (positive) or take out (negative).'),
    }, ['envelope', 'amount']),
    annotations: WRITE('Adjust an envelope balance'),
    async run(ctx, args) {
      const ref = requiredString(args, 'envelope')
      const amount = cents(requiredNumber(args, 'amount'))
      if (amount === 0) throw new ToolError('amount cannot be 0.')
      return ctx.store.mutate((data) => {
        const env = findByRef(data.envelopes, ref, 'envelope')
        const next = adjustPot(data, { kind: 'envelope', env }, amount)
        const after = next.envelopes.find((e) => e.id === env.id) as Envelope
        return {
          data: next,
          result: { envelope: env.name, change: amount, balanceBefore: cents(env.balance), balanceAfter: cents(after.balance), ...(after.balance < 0 ? { warning: 'The balance is now below $0.' } : {}) },
        }
      })
    },
  },
  {
    name: 'move_money',
    description: 'Moves dollars from one envelope or sinking fund to another, for example "move $200 from General Savings to Christmas 2026". Use "checking" as either side for money entering or leaving the budget.',
    inputSchema: object({
      from: string('Envelope or fund to take from (id or name), or "checking".'),
      to: string('Envelope or fund to put into (id or name), or "checking".'),
      amount: number('Dollars to move.', { exclusiveMinimum: 0 }),
    }, ['from', 'to', 'amount']),
    annotations: WRITE('Move money'),
    async run(ctx, args) {
      const amount = positiveMoney(args, 'amount')
      const fromRef = requiredString(args, 'from')
      const toRef = requiredString(args, 'to')
      return ctx.store.mutate((data) => {
        const from = findPot(data, fromRef)
        const to = findPot(data, toRef)
        if (from.kind === 'checking' && to.kind === 'checking') throw new ToolError('Pick at least one envelope or fund.')
        if (potLabel(from) === potLabel(to)) throw new ToolError('from and to are the same place.')
        const next = adjustPot(adjustPot(data, from, -amount), to, amount)
        const fromAfter = potBalance(next, from)
        return {
          data: next,
          result: {
            moved: amount,
            from: { name: potLabel(from), before: potBalance(data, from), after: fromAfter },
            to: { name: potLabel(to), before: potBalance(data, to), after: potBalance(next, to) },
            ...(fromAfter !== null && fromAfter < 0 ? { warning: `${potLabel(from)} is now below $0.` } : {}),
          },
        }
      })
    },
  },
  {
    name: 'remove_envelope',
    description: 'Deletes an envelope so future paychecks stop paying into it. Its balance leaves the budget unless moveBalanceTo names another envelope or fund to receive it. Past paychecks keep their history. Confirm with her first.',
    inputSchema: object({
      envelope: ENVELOPE_REF,
      moveBalanceTo: string('Optional envelope or fund (id or name) to receive its balance.'),
    }, ['envelope']),
    annotations: WRITE('Remove an envelope', true, true),
    async run(ctx, args) {
      const ref = requiredString(args, 'envelope')
      const target = optionalString(args, 'moveBalanceTo')
      return ctx.store.mutate((data) => {
        const env = findByRef(data.envelopes, ref, 'envelope')
        let next: BudgetData = { ...data, envelopes: data.envelopes.filter((e) => e.id !== env.id) }
        let movedTo: string | null = null
        if (target && env.remaining === null && env.balance !== 0) {
          const pot = findPot(next, target)
          next = adjustPot(next, pot, env.balance)
          movedTo = potLabel(pot)
        }
        return { data: next, result: { removed: envelopeView(env, data), balanceMovedTo: movedTo, balanceMoved: movedTo ? cents(env.balance) : 0 } }
      })
    },
  },

  /* ===== Sinking funds ===== */
  {
    name: 'add_fund',
    description: 'Creates a sinking fund for a dated goal. With perCheck 0 (the default) every paycheck automatically sets aside exactly what the deadline needs; a positive perCheck fixes the amount instead. A startDate in the future means it takes nothing until then.',
    inputSchema: object({
      name: string('Fund name, like "Italy Trip".'),
      target: number('Goal amount in dollars.', { exclusiveMinimum: 0 }),
      deadline: date('Date the money is needed by (YYYY-MM-DD).'),
      startDate: date('Date to start setting money aside (YYYY-MM-DD). Default: now.'),
      saved: number('Already saved toward it. Default 0.', { minimum: 0 }),
      perCheck: number('Fixed dollars per check, or 0 for automatic. Default 0.', { minimum: 0 }),
      note: string('Optional note.'),
    }, ['name']),
    annotations: WRITE('Add a sinking fund'),
    async run(ctx, args) {
      const fields = validFundFields(args)
      return ctx.store.mutate((data) => {
        const fund: Fund = {
          id: slugId(fields.name ?? 'fund', new Set([...data.funds.map((f) => f.id), ...RETIRED_FUNDS.keys()])),
          name: fields.name ?? 'New Fund',
          target: fields.target ?? null,
          current: fields.current ?? 0,
          deadline: fields.deadline ?? null,
          startDate: fields.startDate ?? null,
          perCheck: fields.perCheck ?? 0,
          ...(fields.note ? { note: fields.note } : {}),
        }
        checkFundDates(fund)
        const next = { ...data, funds: [...data.funds, fund] }
        return { data: next, result: { added: fundView(fund, ctx, next.profile) } }
      })
    },
  },
  {
    name: 'update_fund',
    description: 'Changes a sinking fund: name, target (0 or null clears it), saved amount, deadline, start date (null clears either), perCheck (0 = automatic), or note. Only the fields given change. Setting saved overwrites it; use adjust_fund to add or take money.',
    inputSchema: object({
      fund: FUND_REF,
      name: string('New name.'),
      target: nullable(number('New goal amount, or null for no target.')),
      saved: number('New saved amount in dollars.', { minimum: 0 }),
      deadline: nullable(date('New deadline (YYYY-MM-DD), or null.')),
      startDate: nullable(date('New start date (YYYY-MM-DD), or null.')),
      perCheck: number('Fixed dollars per check, or 0 for automatic.', { minimum: 0 }),
      note: nullable(string('Note, or null to clear it.')),
    }, ['fund']),
    annotations: WRITE('Update a sinking fund', false, true),
    async run(ctx, args) {
      const ref = requiredString(args, 'fund')
      const fields = validFundFields(args)
      return ctx.store.mutate((data) => {
        const fund = findByRef(data.funds, ref, 'fund')
        const updated: Fund = { ...fund, ...fields }
        if ('note' in args && !fields.note) delete updated.note
        checkFundDates(updated)
        const next = { ...data, funds: data.funds.map((f) => (f.id === fund.id ? updated : f)) }
        return { data: next, result: { before: fundView(fund, ctx, data.profile), after: fundView(updated, ctx, next.profile) } }
      })
    },
  },
  {
    name: 'adjust_fund',
    description: 'Adds money to or takes money out of a sinking fund, for example "I put $50 extra toward Christmas" (50) or "I spent $120 of the Christmas fund on gifts" (-120).',
    inputSchema: object({
      fund: FUND_REF,
      amount: number('Dollars to add (positive) or take out (negative).'),
    }, ['fund', 'amount']),
    annotations: WRITE('Adjust a sinking fund'),
    async run(ctx, args) {
      const ref = requiredString(args, 'fund')
      const amount = cents(requiredNumber(args, 'amount'))
      if (amount === 0) throw new ToolError('amount cannot be 0.')
      return ctx.store.mutate((data) => {
        const fund = findByRef(data.funds, ref, 'fund')
        const next = adjustPot(data, { kind: 'fund', fund }, amount)
        const after = next.funds.find((f) => f.id === fund.id) as Fund
        return { data: next, result: { fund: fund.name, change: amount, before: fundView(fund, ctx, data.profile), after: fundView(after, ctx, next.profile) } }
      })
    },
  },
  {
    name: 'remove_fund',
    description: 'Deletes a sinking fund so paychecks stop funding it. Whatever it had saved leaves the budget unless moveBalanceTo names an envelope or fund to receive it (for example General Savings). Confirm with her first.',
    inputSchema: object({
      fund: FUND_REF,
      moveBalanceTo: string('Optional envelope or fund (id or name) to receive what it had saved.'),
    }, ['fund']),
    annotations: WRITE('Remove a sinking fund', true, true),
    async run(ctx, args) {
      const ref = requiredString(args, 'fund')
      const target = optionalString(args, 'moveBalanceTo')
      return ctx.store.mutate((data) => {
        const fund = findByRef(data.funds, ref, 'fund')
        let next: BudgetData = { ...data, funds: data.funds.filter((f) => f.id !== fund.id) }
        let movedTo: string | null = null
        if (target && fund.current !== 0) {
          const pot = findPot(next, target)
          next = adjustPot(next, pot, fund.current)
          movedTo = potLabel(pot)
        }
        return { data: next, result: { removed: fundView(fund, ctx, data.profile), savedMovedTo: movedTo, savedMoved: movedTo ? cents(fund.current) : 0 } }
      })
    },
  },

  /* ===== Random savings ===== */
  {
    name: 'add_random_saving',
    description: 'Logs money put away on a whim (the Random Savings card), outside the paycheck split. Counts toward "put away" and this month\'s savings.',
    inputSchema: object({
      amount: number('Dollars put away.', { exclusiveMinimum: 0 }),
      date: date('Date (YYYY-MM-DD). Defaults to today.'),
      rolled: boolean('True if the amount came from roll_random_amount. Default false.'),
    }, ['amount']),
    annotations: WRITE('Add a random saving'),
    async run(ctx, args) {
      const amount = positiveMoney(args, 'amount')
      const day = optionalDate(args, 'date') ?? ctx.today
      const rolled = optionalBoolean(args, 'rolled') ?? false
      return ctx.store.mutate((data) => {
        const entry = { id: crypto.randomUUID(), date: day, amount, rolled }
        const next = { ...data, extras: [entry, ...data.extras] }
        return { data: next, result: { added: entry, randomSavingsTotal: cents(next.extras.reduce((s, x) => s + x.amount, 0)) } }
      })
    },
  },
  {
    name: 'remove_random_saving',
    description: 'Deletes one random-savings entry by id (from list_random_savings).',
    inputSchema: object({ id: string('The entry id.') }, ['id']),
    annotations: WRITE('Remove a random saving', true, true),
    async run(ctx, args) {
      const id = requiredString(args, 'id')
      return ctx.store.mutate((data) => {
        const entry = data.extras.find((x) => x.id === id)
        if (!entry) throw new ToolError(`No random saving with id ${id}.`)
        const next = { ...data, extras: data.extras.filter((x) => x.id !== id) }
        return { data: next, result: { removed: entry, randomSavingsTotal: cents(next.extras.reduce((s, x) => s + x.amount, 0)) } }
      })
    },
  },

  /* ===== Change requests (the app's "Ask Cooper" card) ===== */
  {
    name: 'list_requests',
    description: 'The change requests sent to Cooper (newest 20): what was asked, status (new, in_progress, needs_answer, done, blocked, undone), any question waiting for her answer, the outcome summary, and whether a data change can still be undone.',
    inputSchema: object({}),
    annotations: READ('List change requests'),
    async run(ctx) {
      const { status, body } = await ctx.store.requests('GET')
      if (status !== 200) ctx.store.failure(status, body)
      return body
    },
  },
  {
    name: 'submit_request',
    description: 'Sends Cooper a request to change something the tools here cannot, such as how the app looks or works. It is worked overnight. At most five can be waiting at once.',
    inputSchema: object({ text: string('What she wants changed, in her words (up to 2000 characters).', { maxLength: 2000 }) }, ['text']),
    annotations: WRITE('Send a change request'),
    async run(ctx, args) {
      const text = requiredString(args, 'text')
      const { status, body } = await ctx.store.requests('POST', { body: text })
      if (status === 429) throw new ToolError('Five requests are already waiting. Wait for one to finish first.')
      if (status !== 201) ctx.store.failure(status, body)
      return { sent: true, id: body.id }
    },
  },
  {
    name: 'answer_request',
    description: 'Answers the question on a request whose status is needs_answer, which puts it back in the queue.',
    inputSchema: object({
      id: number('The request id.'),
      answer: string('Her answer (up to 2000 characters).', { maxLength: 2000 }),
    }, ['id', 'answer']),
    annotations: WRITE('Answer a request'),
    async run(ctx, args) {
      const id = Math.round(requiredNumber(args, 'id'))
      const answer = requiredString(args, 'answer')
      const { status, body } = await ctx.store.requests('POST', { id, answer })
      if (status === 409) throw new ToolError('That request is not waiting for an answer.')
      if (status !== 200) ctx.store.failure(status, body)
      return { answered: true, id }
    },
  },
  {
    name: 'undo_request',
    description: 'Takes back a finished request that changed budget numbers (canUndo must be true in list_requests). Only possible while nothing else has been saved since.',
    inputSchema: object({ id: number('The request id.') }, ['id']),
    annotations: WRITE('Undo a request', true),
    async run(ctx, args) {
      const id = Math.round(requiredNumber(args, 'id'))
      const { status, body } = await ctx.store.requests('POST', { id, undo: true })
      if (status === 409) throw new ToolError('The budget changed since then, so this can no longer be undone.')
      if (status !== 200) ctx.store.failure(status, body)
      return { undone: true, id, version: body.version }
    },
  },
  /* ===== Catch-all ===== */
  {
    name: 'get_budget_schema',
    description: 'Explains every field of the budget document and the rules that keep it consistent. Read this before patch_budget.',
    inputSchema: object({}),
    annotations: READ('Budget document schema'),
    async run() {
      return { guide: BUDGET_SCHEMA_GUIDE }
    },
  },
  {
    name: 'patch_budget',
    description: 'Catch-all for anything the other tools do not cover: edits the budget document directly with JSON Patch (RFC 6902) operations. First call get_budget (for the data and its version) and get_budget_schema (for the rules), then send the operations with that version. Use dryRun=true to see exactly what would change, show her, then send again with dryRun=false. The patch is refused if the budget changed since that version, or if the result would break the app (wrong types, missing fields, duplicate ids). Raw edits do not move money automatically, so keep balances consistent yourself.',
    inputSchema: object({
      baseVersion: number('The version returned by get_budget that these operations were written against.'),
      operations: {
        type: 'array',
        description: 'JSON Patch operations, applied in order. Paths are JSON Pointers into the budget document, e.g. /envelopes/2/name, /funds/-, /profile/hourlyRate.',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
            path: { type: 'string' },
            from: { type: 'string', description: 'Source path, for move and copy.' },
            value: { description: 'The value, for add, replace and test.' },
          },
          required: ['op', 'path'],
        },
      },
      reason: string('One line on what this change does, in plain words. Echoed back.'),
      dryRun: boolean('true = validate and describe the change without saving. Default false.'),
    }, ['baseVersion', 'operations']),
    annotations: WRITE('Edit the budget directly', true),
    async run(ctx, args) {
      const baseVersion = Math.round(requiredNumber(args, 'baseVersion'))
      const reason = optionalString(args, 'reason') ?? null
      const dryRun = optionalBoolean(args, 'dryRun') ?? false
      if (dryRun) {
        const current = await ctx.store.read()
        if (current.version !== baseVersion) {
          throw new ToolError(`The budget changed since version ${baseVersion} (it is now ${current.version}). Read it again with get_budget and rebuild the patch.`)
        }
        const { next, changes } = checkedPatch(current.data, args.operations)
        return { saved: false, dryRun: true, reason, changes, totalPutAwayBefore: savingsRows(current.data).total, totalPutAwayAfter: savingsRows(next).total }
      }
      return ctx.store.mutate((data) => {
        const { next, changes } = checkedPatch(data, args.operations)
        return { data: next, result: { saved: true, reason, changes, totalPutAwayBefore: savingsRows(data).total, totalPutAwayAfter: savingsRows(next).total } }
      }, { expectVersion: baseVersion })
    },
  },
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** Her wall clock as a local Date, whatever zone the server runs in. */
export function easternNow(nowMs = Date.now()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
