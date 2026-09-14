import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BUDGET,
  DEFAULT_FUNDS,
  DEFAULT_PROFILE,
  DEFAULT_ROLL_RANGE,
  migrateBudget,
  type BudgetData,
} from '../../src/lib/finance'

/* Spec group 4. The budget as a device last saved it in August 2026, before
   the Aug 6 envelope changes and the Aug 8 fund cleanup ran on it. */
function augustBudget(): BudgetData {
  return {
    profile: DEFAULT_PROFILE,
    envelopes: [
      { id: 'wedding', name: 'Wedding Savings', kind: 'percentNet', value: 10, balance: 2672.69, countsAsSavings: true, remaining: null },
      { id: 'general', name: 'General Savings', kind: 'percentNet', value: 20, balance: 25271.32, countsAsSavings: true, remaining: null },
      { id: 'challenge', name: 'Envelope Challenge', kind: 'fixedPerCheck', value: 0, balance: 613, countsAsSavings: true, remaining: null },
      { id: 'giving', name: 'Giving', kind: 'percentNet', value: 5, balance: 335.33, countsAsSavings: false, remaining: null },
      { id: 'expenses', name: 'Expenses', kind: 'percentNet', value: 10, balance: 79.48, countsAsSavings: false, remaining: null },
    ],
    funds: [
      { id: 'christmas', name: 'Christmas', target: 800, current: 600, deadline: '2026-12', perCheck: 40 },
      { id: 'phone', name: 'New Phone', target: 1200, current: 0, deadline: null, perCheck: 0 },
      { id: 'italy', name: 'Italy Plane Ticket', target: 900, current: 55.5, deadline: '2027-03', perCheck: 0 },
      { id: 'moveout', name: 'Move Out', target: 2000, current: 0, deadline: null, perCheck: 0 },
      { id: 'band', name: 'Wedding Band', target: 500, current: 20, deadline: null, perCheck: 0 },
      { id: 'craft', name: 'Laken Craft', target: null, current: 0, deadline: null, perCheck: 0 },
    ],
    paychecks: [],
    extras: [],
    rollRange: DEFAULT_ROLL_RANGE,
  }
}

describe('migrateBudget', () => {
  test('brings the August 2026 shape up to date', () => {
    const migrated = migrateBudget(augustBudget())
    const envelope = (id: string) => migrated.envelopes.find((e) => e.id === id)

    expect(migrated.envelopes.map((e) => e.id)).toEqual(['wedding', 'general', 'giving', 'expenses'])
    /* +313 from the challenge split, +75.5 folded in from italy and band. */
    expect(envelope('general')?.balance).toBeCloseTo(25271.32 + 313 + 75.5, 6)
    expect(envelope('wedding')?.balance).toBeCloseTo(2672.69 + 300, 6)
    expect(envelope('giving')).toMatchObject({ name: 'Gifts', countsAsSavings: true, balance: 335.33 })

    expect(migrated.funds.map((f) => f.id)).toEqual(['christmas', 'christmas-2027'])
    expect(migrated.funds[0]).toEqual({
      id: 'christmas',
      name: 'Christmas 2026',
      target: 1000,
      current: 600,
      deadline: '2026-12-11',
      perCheck: 0,
    })
    expect(migrated.funds[1]).toBe(DEFAULT_FUNDS[1])
  })

  test('a second run returns the same reference', () => {
    const once = migrateBudget(augustBudget())
    expect(migrateBudget(once)).toBe(once)
  })

  test('DEFAULT_BUDGET needs nothing and comes back as the same reference', () => {
    expect(migrateBudget(DEFAULT_BUDGET)).toBe(DEFAULT_BUDGET)
  })

  test('slices no migration touches keep their references', () => {
    const august = augustBudget()
    const migrated = migrateBudget(august)
    expect(migrated.profile).toBe(august.profile)
    expect(migrated.paychecks).toBe(august.paychecks)
    expect(migrated.extras).toBe(august.extras)
    expect(migrated.rollRange).toBe(august.rollRange)
  })

  test('a later manual rename of Gifts is never clobbered', () => {
    const budget: BudgetData = {
      ...DEFAULT_BUDGET,
      envelopes: DEFAULT_BUDGET.envelopes.map((e) => (e.id === 'giving' ? { ...e, name: 'Presents' } : e)),
    }
    expect(migrateBudget(budget)).toBe(budget)
  })

  test('Christmas keeps a custom name and override, and Christmas 2027 is never added twice', () => {
    const budget: BudgetData = {
      ...DEFAULT_BUDGET,
      funds: [
        { id: 'christmas', name: 'Holidays', target: 800, current: 100, deadline: '2026-12', perCheck: 25 },
        DEFAULT_FUNDS[1],
      ],
    }
    const migrated = migrateBudget(budget)
    expect(migrated.funds).toHaveLength(2)
    expect(migrated.funds[0]).toMatchObject({ name: 'Holidays', perCheck: 25, target: 1000, deadline: '2026-12-11' })
    expect(migrated.envelopes).toBe(budget.envelopes)
  })

  test('retired funds holding no money leave General Savings alone', () => {
    const budget: BudgetData = {
      ...DEFAULT_BUDGET,
      funds: [...DEFAULT_FUNDS, { id: 'phone', name: 'New Phone', target: 1200, current: 0, deadline: null, perCheck: 0 }],
    }
    const migrated = migrateBudget(budget)
    expect(migrated.funds).toEqual(DEFAULT_FUNDS)
    expect(migrated.envelopes).toBe(budget.envelopes)
  })
})
