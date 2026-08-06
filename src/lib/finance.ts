import { useEffect, useState } from 'react'

export type Profile = { hourlyRate: number; typicalHours: number }
export type Rule = { id: string; name: string; percent: number }
export type Paycheck = { id: string; date: string; net: number }

export const DEFAULT_PROFILE: Profile = { hourlyRate: 25, typicalHours: 40 }

export const DEFAULT_RULES: Rule[] = [
  { id: 'bills', name: 'Rent & Bills', percent: 50 },
  { id: 'savings', name: 'Savings', percent: 20 },
  { id: 'spending', name: 'Spending', percent: 30 },
]

export function grossPerWeek(profile: Profile): number {
  return profile.hourlyRate * profile.typicalHours
}

export function allocate(net: number, rules: Rule[]) {
  return rules.map((rule) => ({ ...rule, amount: (net * rule.percent) / 100 }))
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
