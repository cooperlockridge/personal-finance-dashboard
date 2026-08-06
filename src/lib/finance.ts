import { useEffect, useState } from 'react'

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
  /** 'YYYY-MM' deadline, contributions due by end of that month. */
  deadline: string | null
  perCheck: number
  note?: string
}

export type Paycheck = {
  id: string
  date: string
  net: number
  hours: number | null
  /** Snapshot of what was allocated where, so removal can reverse it. */
  envelopeAmounts: Record<string, number>
  fundAmounts: Record<string, number>
  leftover: number
}

export const DEFAULT_PROFILE: Profile = {
  hourlyRate: 25,
  typicalHours: 50,
  checksPerMonth: 2,
  hysaApy: 3.9,
  hysaInterestToDate: 578.74,
}

/* Seeded from Laken Budget 2026.xlsx (read Aug 5, 2026). Giving is 5% per
   Cooper's spec; the sheet was using 7.5%. */
export const DEFAULT_ENVELOPES: Envelope[] = [
  { id: 'wedding', name: 'Wedding Savings', kind: 'percentNet', value: 10, balance: 2672.69, countsAsSavings: true, remaining: null },
  { id: 'general', name: 'General Savings', kind: 'percentNet', value: 20, balance: 24958.32, countsAsSavings: true, remaining: null },
  { id: 'giving', name: 'Giving Savings', kind: 'percentNet', value: 5, balance: 335.33, countsAsSavings: false, remaining: null },
  { id: 'expenses', name: 'Expenses', kind: 'percentNet', value: 10, balance: 79.48, countsAsSavings: false, remaining: null },
  { id: 'car', name: 'Car Payment', kind: 'fixedPerCheck', value: 125, balance: 0, countsAsSavings: false, remaining: 3000 },
  { id: 'roth', name: 'Roth IRA', kind: 'percentGross', value: 10, balance: 3067, countsAsSavings: true, remaining: null },
  { id: 'challenge', name: 'Envelope Challenge', kind: 'fixedPerCheck', value: 0, balance: 613, countsAsSavings: true, remaining: null },
]

export const DEFAULT_FUNDS: Fund[] = [
  { id: 'christmas', name: 'Christmas', target: 1000, current: 600, deadline: '2026-12', perCheck: 40 },
  { id: 'phone', name: 'New Phone', target: 1200, current: 0, deadline: '2027-07', perCheck: 0, note: 'Target is a placeholder — set the real price incl. tax' },
  { id: 'italy', name: 'Italy Plane Ticket', target: 1500, current: 0, deadline: '2027-08', perCheck: 0 },
  { id: 'moveout', name: 'Move Out', target: 2500, current: 0, deadline: '2028-01', perCheck: 0 },
  { id: 'craft', name: 'Laken Craft', target: null, current: 0, deadline: null, perCheck: 0 },
  { id: 'band', name: 'Wedding Band', target: 1500, current: 0, deadline: '2028-03', perCheck: 0 },
]

export function grossForCheck(profile: Profile, hours: number | null): number {
  return profile.hourlyRate * (hours ?? profile.typicalHours)
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
): Paycheck {
  const gross = grossForCheck(profile, hours)
  const envelopeAmounts: Record<string, number> = {}
  const fundAmounts: Record<string, number> = {}
  let allocated = 0
  for (const env of envelopes) {
    const amount = envelopeAmount(env, net, gross)
    if (amount > 0) envelopeAmounts[env.id] = amount
    allocated += amount
  }
  for (const fund of funds) {
    if (fund.perCheck > 0) {
      fundAmounts[fund.id] = fund.perCheck
      allocated += fund.perCheck
    }
  }
  return {
    id: crypto.randomUUID(),
    date,
    net,
    hours,
    envelopeAmounts,
    fundAmounts,
    leftover: net - allocated,
  }
}

/** End of the fund's deadline month. */
export function deadlineDate(fund: Fund): Date | null {
  if (!fund.deadline) return null
  const [year, month] = fund.deadline.split('-').map(Number)
  return new Date(year, month, 0)
}

export function weeksLeft(fund: Fund, now: Date): number | null {
  const end = deadlineDate(fund)
  if (!end) return null
  return Math.max(1, (end.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000))
}

export function neededPerWeek(fund: Fund, now: Date): number | null {
  const weeks = weeksLeft(fund, now)
  if (weeks === null || fund.target === null) return null
  return Math.max(0, (fund.target - fund.current) / weeks)
}

export function currency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])
  return [value, setValue] as const
}
