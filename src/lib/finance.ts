export type Profile = {
  hourlyRate: number
  typicalHours: number
  checksPerMonth: number
  hysaApy: number
  hysaInterestToDate: number
}

export type EnvelopeKind = 'percentNet' | 'percentGross' | 'fixedPerCheck'

export type Envelope = {
  id: string
  name: string
  kind: EnvelopeKind
  value: number
  balance: number
  countsAsSavings: boolean
  /** For debts like the car: dollars left to pay; contributions stop at 0. */
  remaining: number | null
}

export type Fund = {
  id: string
  name: string
  target: number | null
  current: number
  /** 'YYYY-MM-DD', contributions due by that day. Records from before
   *  Sep 2026 carry 'YYYY-MM', which means the end of that month. */
  deadline: string | null
  /** 'YYYY-MM-DD'. Checks dated before this skip the fund entirely. */
  startDate?: string | null
  perCheck: number
  note?: string
}

export type Paycheck = {
  id: string
  date: string
  net: number
  hours: number | null
  /** Gross used for this check's math, and whether it was estimated. */
  gross: number
  grossEstimated: boolean
  /** Snapshot of what was allocated where, so removal can reverse it. */
  envelopeAmounts: Record<string, number>
  fundAmounts: Record<string, number>
  leftover: number
}

/** Money put away on a whim, outside the paycheck split. */
export type ExtraSaving = {
  id: string
  date: string
  amount: number
  /** True when the amount came from a roll rather than being typed. */
  rolled: boolean
}

export type RollRange = { min: number; max: number }

export const DEFAULT_PROFILE: Profile = {
  hourlyRate: 25,
  typicalHours: 50,
  checksPerMonth: 2,
  hysaApy: 3.9,
  hysaInterestToDate: 578.74,
}

/* Seeded from Laken Budget 2026.xlsx (read Aug 5, 2026). Giving is 5% per
   Cooper's spec; the sheet was using 7.5%. The Envelope Challenge's $613 was
   split into General (+313) and Wedding (+300) per Cooper, Aug 6 2026. */
export const DEFAULT_ENVELOPES: Envelope[] = [
  { id: 'wedding', name: 'Wedding Savings', kind: 'percentNet', value: 10, balance: 2972.69, countsAsSavings: true, remaining: null },
  { id: 'general', name: 'General Savings', kind: 'percentNet', value: 20, balance: 25271.32, countsAsSavings: true, remaining: null },
  { id: 'giving', name: 'Gifts', kind: 'percentNet', value: 5, balance: 335.33, countsAsSavings: true, remaining: null },
  { id: 'expenses', name: 'Expenses', kind: 'percentNet', value: 10, balance: 79.48, countsAsSavings: false, remaining: null },
  { id: 'car', name: 'Car Payment', kind: 'fixedPerCheck', value: 125, balance: 0, countsAsSavings: false, remaining: 3000 },
  { id: 'roth', name: 'Roth IRA', kind: 'percentGross', value: 10, balance: 3067, countsAsSavings: true, remaining: null },
]

/* Laken's Aug 8, 2026 email: every fund goes except Christmas — $1,000 by
   Dec 11, 2026, then $1,500 collected Jan 8 through Dec 10, 2027. */
export const DEFAULT_FUNDS: Fund[] = [
  { id: 'christmas', name: 'Christmas 2026', target: 1000, current: 600, deadline: '2026-12-11', perCheck: 0 },
  { id: 'christmas-2027', name: 'Christmas 2027', target: 1500, current: 0, deadline: '2027-12-10', startDate: '2027-01-08', perCheck: 0 },
]

export const DEFAULT_ROLL_RANGE: RollRange = { min: 5, max: 50 }

/** Everything the app stores, as one document — the unit every device syncs. */
export type BudgetData = {
  profile: Profile
  envelopes: Envelope[]
  funds: Fund[]
  paychecks: Paycheck[]
  extras: ExtraSaving[]
  rollRange: RollRange
}

export const DEFAULT_BUDGET: BudgetData = {
  profile: DEFAULT_PROFILE,
  envelopes: DEFAULT_ENVELOPES,
  funds: DEFAULT_FUNDS,
  paychecks: [],
  extras: [],
  rollRange: DEFAULT_ROLL_RANGE,
}

/* Funds removed per Laken's Aug 8, 2026 email. The names still label older
   checks in Paycheck History. */
export const RETIRED_FUNDS = new Map([
  ['phone', 'New Phone'],
  ['italy', 'Italy Plane Ticket'],
  ['moveout', 'Move Out'],
  ['band', 'Wedding Band'],
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The same shape check /api/budget runs before it accepts a save. A stored
 * copy that fails it is treated as missing rather than rendered, since one
 * bad slice would otherwise be pushed up and rejected on every retry.
 */
export function isBudgetData(value: unknown): value is BudgetData {
  if (!isRecord(value)) return false
  const { profile, envelopes, funds, paychecks, extras, rollRange } = value
  return (
    isRecord(profile) &&
    Array.isArray(envelopes) &&
    Array.isArray(funds) &&
    Array.isArray(paychecks) &&
    Array.isArray(extras) &&
    isRecord(rollRange) &&
    typeof rollRange.min === 'number' &&
    typeof rollRange.max === 'number'
  )
}

/**
 * The one-time data migrations, run on whatever copy of the budget a device
 * is about to show — its local cache on load, and every cloud copy it adopts.
 * Moved out of App's mount effect on Sep 14, 2026 when the budget started
 * syncing. Returns the same object when nothing changed: sync relies on that
 * to know whether a migrated cloud copy has to be saved back.
 */
export function migrateBudget(data: BudgetData): BudgetData {
  /* One-time data migration (Aug 6, 2026): the Envelope Challenge's $613
     moved into General (+313) and Wedding (+300); Laken Craft was never a
     fund (it's her name on the spreadsheet). Idempotent — guarded on the
     old records still existing. */
  let next = data.envelopes
  if (next.some((e) => e.id === 'challenge')) {
    next = next
      .filter((e) => e.id !== 'challenge')
      .map((e) =>
        e.id === 'general'
          ? { ...e, balance: e.balance + 313 }
          : e.id === 'wedding'
            ? { ...e, balance: e.balance + 300 }
            : e,
      )
  }
  /* Aug 6, 2026: Giving renamed to Gifts and included in savings. Guarded on
     the old flag so a later manual rename is never clobbered. */
  if (next.some((e) => e.id === 'giving' && !e.countsAsSavings)) {
    next = next.map((e) =>
      e.id === 'giving' && !e.countsAsSavings ? { ...e, name: 'Gifts', countsAsSavings: true } : e,
    )
  }
  let nextFunds = data.funds
  if (nextFunds.some((f) => f.id === 'craft')) {
    nextFunds = nextFunds.filter((f) => f.id !== 'craft')
  }
  /* Sep 14, 2026, from Laken's Aug 8 email: every fund goes except
     Christmas. Money already set aside in a removed fund folds into
     General Savings so her total doesn't drop. Guarded on the old ids. */
  const retired = nextFunds.filter((f) => RETIRED_FUNDS.has(f.id))
  if (retired.length > 0) {
    const moved = retired.reduce((s, f) => s + f.current, 0)
    nextFunds = nextFunds.filter((f) => !RETIRED_FUNDS.has(f.id))
    if (moved > 0) {
      next = next.map((e) => (e.id === 'general' ? { ...e, balance: e.balance + moved } : e))
    }
  }
  /* Same email: Christmas 2026 is $1,000 by Dec 11, then Christmas 2027
     collects $1,500 from Jan 8 to Dec 10, 2027. Guarded on the old
     month-only deadline. The seeded $40/check goes back to auto so the
     date sets the pace; any other override she chose stays. */
  if (nextFunds.some((f) => f.id === 'christmas' && f.deadline?.length === 7)) {
    nextFunds = nextFunds.map((f) =>
      f.id === 'christmas'
        ? {
            ...f,
            name: f.name === 'Christmas' ? 'Christmas 2026' : f.name,
            target: 1000,
            deadline: '2026-12-11',
            perCheck: f.perCheck === 40 ? 0 : f.perCheck,
          }
        : f,
    )
    const christmas2027 = DEFAULT_FUNDS.find((f) => f.id === 'christmas-2027')
    if (christmas2027 && !nextFunds.some((f) => f.id === christmas2027.id)) {
      nextFunds = [...nextFunds, christmas2027]
    }
  }
  if (next === data.envelopes && nextFunds === data.funds) return data
  return { ...data, envelopes: next, funds: nextFunds }
}

export function grossForCheck(profile: Profile, hours: number | null): number {
  return profile.hourlyRate * (hours ?? profile.typicalHours)
}

/**
 * Average withholding rate learned from checks that included hours
 * (rate × hours gives exact gross, so 1 − net/gross is her real rate).
 * Null until at least one such check exists.
 */
export function learnedWithholding(paychecks: Paycheck[], profile: Profile): number | null {
  const rates = paychecks
    .filter((p) => p.hours !== null && p.hours > 0)
    .map((p) => 1 - p.net / (profile.hourlyRate * (p.hours as number)))
    .filter((r) => r > 0 && r < 0.5)
  if (rates.length === 0) return null
  return rates.reduce((sum, r) => sum + r, 0) / rates.length
}

export function envelopeAmount(env: Envelope, net: number, gross: number): number {
  if (env.remaining !== null && env.remaining <= 0) return 0
  let amount = 0
  if (env.kind === 'percentNet') amount = (net * env.value) / 100
  else if (env.kind === 'percentGross') amount = (gross * env.value) / 100
  else amount = env.value
  if (env.remaining !== null) amount = Math.min(amount, env.remaining)
  return amount
}

export function buildPaycheck(
  net: number,
  hours: number | null,
  date: string,
  profile: Profile,
  envelopes: Envelope[],
  funds: Fund[],
  withholding: number | null,
): Paycheck {
  const gross =
    hours !== null
      ? profile.hourlyRate * hours
      : withholding !== null
        ? net / (1 - withholding)
        : grossForCheck(profile, null)
  const envelopeAmounts: Record<string, number> = {}
  const fundAmounts: Record<string, number> = {}
  let allocated = 0
  for (const env of envelopes) {
    const amount = envelopeAmount(env, net, gross)
    if (amount > 0) envelopeAmounts[env.id] = amount
    allocated += amount
  }
  /* Funds auto-contribute what their deadline needs; a manual $/check overrides.
     A fund whose start date is still ahead takes nothing from this check. */
  const checkDate = new Date(`${date}T00:00:00`)
  for (const fund of funds) {
    if (!hasStarted(fund, checkDate)) continue
    const auto = neededPerCheck(fund, checkDate, profile)
    const amount =
      fund.perCheck > 0
        ? fund.perCheck
        : auto !== null
          ? Math.round(auto * 100) / 100
          : 0
    if (amount > 0) {
      fundAmounts[fund.id] = amount
      allocated += amount
    }
  }
  return {
    id: crypto.randomUUID(),
    date,
    net,
    hours,
    gross,
    grossEstimated: hours === null,
    envelopeAmounts,
    fundAmounts,
    leftover: net - allocated,
  }
}

/** 'YYYY-MM-DD' as local midnight; a month-only 'YYYY-MM' as that month's last day. */
function parseDay(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return day ? new Date(year, month - 1, day) : new Date(year, month, 0)
}

export function deadlineDate(fund: Fund): Date | null {
  return fund.deadline ? parseDay(fund.deadline) : null
}

export function hasStarted(fund: Fund, now: Date): boolean {
  return !fund.startDate || parseDay(fund.startDate).getTime() <= now.getTime()
}

/** Weeks of saving left — counted from the start date while that is still ahead. */
export function weeksLeft(fund: Fund, now: Date): number | null {
  const end = deadlineDate(fund)
  if (!end) return null
  const from = hasStarted(fund, now) ? now : parseDay(fund.startDate as string)
  return Math.max(1, (end.getTime() - from.getTime()) / (7 * 24 * 3600 * 1000))
}

export function neededPerWeek(fund: Fund, now: Date): number | null {
  const weeks = weeksLeft(fund, now)
  if (weeks === null || fund.target === null) return null
  return Math.max(0, (fund.target - fund.current) / weeks)
}

export function neededPerCheck(fund: Fund, now: Date, profile: Profile): number | null {
  const weekly = neededPerWeek(fund, now)
  if (weekly === null) return null
  return (weekly * 52) / 12 / Math.max(1, profile.checksPerMonth)
}

/**
 * Where a fund stands against its deadline.
 *
 * A fund on auto-funding can't fall behind — `buildPaycheck` contributes
 * exactly what the deadline needs each check. So `behind` only fires when a
 * manual $/check override is set below that. `stalled` catches the quiet
 * trap: a target with no deadline and no override gets nothing, forever.
 * `upcoming` is a fund whose start date is still ahead: it draws nothing
 * yet, and `needed` is what each check will take once it starts.
 */
export type FundState = 'done' | 'overdue' | 'behind' | 'stalled' | 'upcoming' | 'onTrack' | 'noTarget'

export type FundStatus = {
  state: FundState
  /** Required per check to land the target by the deadline. */
  needed: number | null
  /** What it actually receives per check — nothing before its start date. */
  contributing: number
  /** needed − contributing, when behind. */
  shortfall: number
  remaining: number
}

export function fundStatus(fund: Fund, now: Date, profile: Profile): FundStatus {
  const started = hasStarted(fund, now)
  const needed = neededPerCheck(fund, now, profile)
  const contributing = !started ? 0 : fund.perCheck > 0 ? fund.perCheck : (needed ?? 0)
  const remaining = fund.target !== null ? Math.max(0, fund.target - fund.current) : 0
  const base = { needed, contributing, shortfall: 0, remaining }

  if (fund.target === null || fund.target <= 0) return { ...base, state: 'noTarget' }
  if (fund.current >= fund.target) return { ...base, state: 'done' }
  if (!started) return { ...base, state: 'upcoming' }

  const end = deadlineDate(fund)
  if (end !== null && end.getTime() < now.getTime()) return { ...base, state: 'overdue' }
  if (end === null && fund.perCheck <= 0) return { ...base, state: 'stalled' }
  if (needed !== null && contributing < needed - 0.005) {
    return { ...base, state: 'behind', shortfall: needed - contributing }
  }
  return { ...base, state: 'onTrack' }
}

/** Combined per-check draw of every fund, for the affordability note. */
export function fundsPerCheckTotal(funds: Fund[], now: Date, profile: Profile): number {
  return funds.reduce((sum, fund) => sum + fundStatus(fund, now, profile).contributing, 0)
}

/** Typical take-home, using her learned withholding when we have it. */
export function typicalNet(profile: Profile, withholding: number | null): number | null {
  if (withholding === null) return null
  return grossForCheck(profile, null) * (1 - withholding)
}

/** Same day and same amount — almost certainly the same deposit entered twice. */
export function findDuplicate(paychecks: Paycheck[], date: string, net: number): Paycheck | null {
  return paychecks.find((p) => p.date === date && Math.abs(p.net - net) < 0.005) ?? null
}

/**
 * A whole-dollar amount between the range ends, inclusive. Never repeats
 * `previous` when the range holds another value — a reroll that lands on the
 * same number reads as a broken button.
 */
export function rollAmount(range: RollRange, previous: number | null, random = Math.random): number {
  const lo = Math.max(1, Math.ceil(Math.min(range.min, range.max)))
  const hi = Math.max(lo, Math.floor(Math.max(range.min, range.max)))
  const amount = lo + Math.floor(random() * (hi - lo + 1))
  if (amount !== previous || lo === hi) return amount
  return amount === hi ? lo : amount + 1
}

/** Takes net and gross explicitly — stored checks from before `gross` existed
 *  can carry undefined at runtime, so callers resolve the fallback first. */
export function effectiveTaxRate(net: number, gross: number | null): number | null {
  if (gross === null || !Number.isFinite(gross) || gross <= 0 || net > gross) return null
  return 1 - net / gross
}

/** Gross for a stored check, falling back to rate × hours for legacy records. */
export function grossOf(check: Paycheck, profile: Profile): number {
  return Number.isFinite(check.gross) && check.gross > 0
    ? check.gross
    : grossForCheck(profile, check.hours)
}

export function currency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** Today as 'YYYY-MM-DD' on her clock. `toISOString()` is UTC, which in
 *  Georgia already reads as tomorrow by the evening. */
export function todayKey(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 'Dec 11, 2026'; a month-only date reads 'Dec 2026'. */
export function formatDay(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day || 1).toLocaleDateString(
    'en-US',
    day ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', year: 'numeric' },
  )
}
