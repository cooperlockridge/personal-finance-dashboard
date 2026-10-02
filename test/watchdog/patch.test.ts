import { describe, expect, test } from 'bun:test'
import type { BudgetData } from '../../src/lib/finance.ts'
import { applyOps, MAX_OPS, parseOps, PatchError, show, validateBudget, type Op } from '../../watchdog/patch.ts'

/* The data lane's arithmetic: what a list of ops does to a budget, what the
   app is told changed, and every reason a patched budget is refused. No
   fakes are needed — the module has no side effects to fake. */

function budget(): BudgetData {
  return {
    profile: { hourlyRate: 25, typicalHours: 50, checksPerMonth: 2, hysaApy: 3.9, hysaInterestToDate: 578.74 },
    envelopes: [
      { id: 'wedding', name: 'Wedding Savings', kind: 'percentNet', value: 10, balance: 2972.69, countsAsSavings: true, remaining: null },
      { id: 'general', name: 'General Savings', kind: 'percentNet', value: 20, balance: 25271.32, countsAsSavings: true, remaining: null },
      { id: 'car', name: 'Car Payment', kind: 'fixedPerCheck', value: 125, balance: 0, countsAsSavings: false, remaining: 3000 },
    ],
    funds: [
      { id: 'italy', name: 'Italy Plane Ticket', target: 900, current: 240, deadline: null, perCheck: 0 },
      { id: 'christmas', name: 'Christmas 2026', target: 1000, current: 600, deadline: '2026-12-11', perCheck: 0 },
    ],
    paychecks: [
      {
        id: 'check-1',
        date: '2026-09-18',
        net: 1000,
        hours: 50,
        gross: 1250,
        grossEstimated: false,
        envelopeAmounts: { wedding: 100, general: 200 },
        fundAmounts: {},
        leftover: 700,
      },
    ],
    extras: [{ id: 'extra-1', date: '2026-09-20', amount: 20, rolled: true }],
    rollRange: { min: 5, max: 50 },
  }
}

const SET_WEDDING: Op = { op: 'set', path: ['envelopes', { id: 'wedding' }, 'value'], value: 15, label: 'Wedding share (%)' }
const NEW_FUND = { id: 'christmas-2027', name: 'Christmas 2027', target: 1500, current: 0, deadline: '2027-12-10', perCheck: 0 }

describe('applyOps', () => {
  test('set changes one value, found by id, and reports the real before and after', () => {
    const { budget: next, changes } = applyOps(budget(), [SET_WEDDING])
    expect(next.envelopes[0].value).toBe(15)
    expect(next.envelopes[1].value).toBe(20)
    expect(changes).toEqual([{ label: 'Wedding share (%)', before: '10', after: '15' }])
  })

  test('set on a key that was not there reports a missing before', () => {
    const { budget: next, changes } = applyOps(budget(), [
      { op: 'set', path: ['funds', { id: 'italy' }, 'startDate'], value: '2027-01-08', label: 'Italy start' },
    ])
    expect(next.funds[0].startDate).toBe('2027-01-08')
    expect(changes).toEqual([{ label: 'Italy start', before: null, after: '2027-01-08' }])
  })

  test('set on an { id } step replaces the whole item', () => {
    const replacement = { ...budget().funds[0], name: 'Rome Trip' }
    const { budget: next, changes } = applyOps(budget(), [
      { op: 'set', path: ['funds', { id: 'italy' }], value: replacement, label: 'Italy fund' },
    ])
    expect(next.funds[0].name).toBe('Rome Trip')
    expect(changes).toEqual([{ label: 'Italy fund', before: 'Italy Plane Ticket', after: 'Rome Trip' }])
  })

  test('add appends to the list and shows the new item by name', () => {
    const { budget: next, changes } = applyOps(budget(), [{ op: 'add', path: ['funds'], value: NEW_FUND, label: 'New fund' }])
    expect(next.funds.map((f) => f.id)).toEqual(['italy', 'christmas', 'christmas-2027'])
    expect(changes).toEqual([{ label: 'New fund', before: null, after: 'Christmas 2027' }])
  })

  test('remove takes out the item the id selects', () => {
    const { budget: next, changes } = applyOps(budget(), [{ op: 'remove', path: ['funds', { id: 'italy' }], label: 'Italy fund' }])
    expect(next.funds.map((f) => f.id)).toEqual(['christmas'])
    expect(changes).toEqual([{ label: 'Italy fund', before: 'Italy Plane Ticket', after: null }])
  })

  test('ops run in order, each seeing the one before', () => {
    const { budget: next, changes } = applyOps(budget(), [
      { op: 'add', path: ['funds'], value: NEW_FUND, label: 'New fund' },
      { op: 'set', path: ['funds', { id: 'christmas-2027' }, 'target'], value: 2000, label: 'Target' },
    ])
    expect(next.funds[2].target).toBe(2000)
    expect(changes[1]).toEqual({ label: 'Target', before: '1500', after: '2000' })
  })

  test('the before/after strings: numbers as they are, objects by name then id, nothing as null', () => {
    expect(show(12.5)).toBe('12.5')
    expect(show({ id: 'x', name: 'Named' })).toBe('Named')
    expect(show({ id: 'only-id' })).toBe('only-id')
    expect(show(undefined)).toBeNull()
    expect(show(null)).toBeNull()
    expect(show(false)).toBe('no')
    expect(show([1, 2])).toBe('2 items')
    expect(show('x'.repeat(200))?.length).toBe(80)
  })

  test('the same ops on the same budget give the same answer, and the original is untouched', () => {
    const original = budget()
    const ops: Op[] = [SET_WEDDING, { op: 'add', path: ['funds'], value: NEW_FUND, label: 'New fund' }, { op: 'remove', path: ['funds', { id: 'italy' }], label: 'Italy' }]
    const first = applyOps(original, ops)
    const second = applyOps(original, ops)
    expect(second).toEqual(first)
    expect(original).toEqual(budget())
    /* The added object is copied in, so a later change to the op cannot reach the budget. */
    expect(first.budget.funds[1]).not.toBe(NEW_FUND)
  })

  test('a path that leads nowhere applies nothing and throws', () => {
    const bad: Op[][] = [
      [{ op: 'set', path: ['envelopes', { id: 'nope' }, 'value'], value: 1, label: 'x' }],
      [{ op: 'set', path: ['profile', 'missing', 'deeper'], value: 1, label: 'x' }],
      [{ op: 'add', path: ['profile'], value: { id: 'a' }, label: 'x' }],
      [{ op: 'remove', path: ['funds'], label: 'x' }],
      [{ op: 'remove', path: ['profile', 'hourlyRate'], label: 'x' }],
      [{ op: 'set', path: ['funds', { id: 'italy' }], value: 5, label: 'x' }],
      /* Inherited names are not keys of the budget. */
      [{ op: 'set', path: ['envelopes', 'length', 'x'], value: 1, label: 'x' }],
      [{ op: 'set', path: ['profile', 'toString', 'x'], value: 1, label: 'x' }],
    ]
    for (const ops of bad) expect(() => applyOps(budget(), ops)).toThrow(PatchError)
  })
})

describe('parseOps', () => {
  const ok = { op: 'set', path: ['profile', 'hourlyRate'], value: 26, label: 'Hourly rate' }

  test('accepts the three ops', () => {
    expect(parseOps([ok, { op: 'add', path: ['funds'], value: NEW_FUND, label: 'New' }, { op: 'remove', path: ['funds', { id: 'italy' }], label: 'Gone' }])).toHaveLength(3)
  })

  test('refuses __proto__, constructor and prototype as a key, an id, or inside a value', () => {
    const poisoned = JSON.parse('{ "id": "x", "__proto__": { "polluted": true } }')
    const cases: unknown[] = [
      { ...ok, path: ['__proto__', 'polluted'] },
      { ...ok, path: ['profile', '__proto__'] },
      { ...ok, path: ['profile', 'constructor', 'prototype'] },
      { ...ok, path: ['profile', 'prototype'] },
      { ...ok, path: ['funds', { id: '__proto__' }] },
      { op: 'add', path: ['funds'], value: poisoned, label: 'x' },
      { ...ok, value: { nested: [{ constructor: 1 }] } },
    ]
    for (const item of cases) expect(() => parseOps([item])).toThrow(PatchError)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('refuses every malformed op', () => {
    const cases: unknown[] = [
      'not an object',
      { ...ok, op: 'replace' },
      { ...ok, op: 'move' },
      { ...ok, path: [] },
      { ...ok, path: 'profile.hourlyRate' },
      { ...ok, path: ['envelopes', 0, 'value'] },
      { ...ok, path: ['envelopes', { id: 'wedding', extra: 1 }] },
      { ...ok, path: ['envelopes', { id: '' }] },
      { ...ok, path: ['settings', 'theme'] },
      { ...ok, path: [{ id: 'wedding' }] },
      { ...ok, label: '' },
      { ...ok, label: 'x'.repeat(81) },
      { ...ok, label: 7 },
      { op: 'set', path: ['profile', 'hourlyRate'], label: 'no value' },
      { op: 'add', path: ['funds'], value: 5, label: 'x' },
      { op: 'add', path: ['funds'], value: [NEW_FUND], label: 'x' },
      { op: 'remove', path: ['funds', { id: 'italy' }], value: 1, label: 'x' },
      { ...ok, before: '1', after: '2' },
    ]
    for (const item of cases) expect(() => parseOps([item])).toThrow(PatchError)
    expect(() => parseOps({ ops: [ok] })).toThrow(PatchError)
  })
})

describe('validateBudget', () => {
  function patched(ops: Op[]) {
    return applyOps(budget(), ops).budget
  }

  test('an ordinary change passes', () => {
    expect(validateBudget(patched([SET_WEDDING]), budget(), 1)).toEqual([])
  })

  test('a result that is not a budget is refused', () => {
    expect(validateBudget(patched([{ op: 'set', path: ['funds'], value: 'none', label: 'x' }]), budget(), 1)).toEqual(['The result is not a budget'])
    expect(validateBudget(patched([{ op: 'set', path: ['rollRange', 'min'], value: 'five', label: 'x' }]), budget(), 1)).toEqual(['The result is not a budget'])
    expect(validateBudget(null, budget(), 1)).toEqual(['The result is not a budget'])
  })

  test('a number that is not finite is refused, however deep', () => {
    /* JSON has no NaN, but this is how Infinity gets in. */
    const huge = JSON.parse('1e999')
    expect(huge).toBe(Infinity)
    expect(validateBudget(patched([{ op: 'set', path: ['funds', { id: 'italy' }, 'target'], value: huge, label: 'x' }]), budget(), 1)).toContain('A number is not finite')
    const next = patched([])
    next.paychecks.push({ ...budget().paychecks[0], id: 'check-2', envelopeAmounts: { wedding: Number.NaN } })
    expect(validateBudget(next, budget(), 1)).toContain('A number is not finite')
  })

  test('a repeated id is refused in each of the four lists', () => {
    const cases: [string, Op][] = [
      ['envelopes', { op: 'add', path: ['envelopes'], value: { ...budget().envelopes[2] }, label: 'x' }],
      ['funds', { op: 'add', path: ['funds'], value: { ...NEW_FUND, id: 'italy' }, label: 'x' }],
      ['paychecks', { op: 'add', path: ['paychecks'], value: { ...budget().paychecks[0] }, label: 'x' }],
      ['extras', { op: 'add', path: ['extras'], value: { ...budget().extras[0] }, label: 'x' }],
    ]
    for (const [list, op] of cases) {
      const problems = validateBudget(patched([op]), budget(), 1)
      expect(problems.some((problem) => problem.includes(`Two items in ${list} share the id`))).toBe(true)
    }
  })

  test('an item with no id is refused', () => {
    const problems = validateBudget(patched([{ op: 'add', path: ['funds'], value: { name: 'No id' }, label: 'x' }]), budget(), 1)
    expect(problems).toContain('An item in funds has no id')
  })

  test('percent-of-net envelopes may reach 100 and not pass it', () => {
    const at100 = patched([{ op: 'set', path: ['envelopes', { id: 'general' }, 'value'], value: 90, label: 'x' }])
    expect(validateBudget(at100, budget(), 1)).toEqual([])
    const over = patched([{ op: 'set', path: ['envelopes', { id: 'general' }, 'value'], value: 90.5, label: 'x' }])
    expect(validateBudget(over, budget(), 1)).toEqual(['Percent-of-net envelopes add up to 100.5%, over 100%'])
    /* The fixed $125 car payment is not a percentage and does not count. */
    const fixed = patched([{ op: 'set', path: ['envelopes', { id: 'car' }, 'value'], value: 500, label: 'x' }])
    expect(validateBudget(fixed, budget(), 1)).toEqual([])
  })

  test('a negative share cannot be used to hide a total over 100', () => {
    const next = patched([
      { op: 'set', path: ['envelopes', { id: 'general' }, 'value'], value: 150, label: 'x' },
      { op: 'set', path: ['envelopes', { id: 'wedding' }, 'value'], value: -60, label: 'x' },
    ])
    expect(validateBudget(next, budget(), 2).length).toBeGreaterThan(0)
  })

  test('history is append-only: a paycheck or extra may be added, never changed or removed', () => {
    const added = patched([{ op: 'add', path: ['extras'], value: { id: 'extra-2', date: '2026-10-02', amount: 15, rolled: false }, label: 'x' }])
    expect(validateBudget(added, budget(), 1)).toEqual([])

    const cases: [string, Op][] = [
      ['paychecks', { op: 'set', path: ['paychecks', { id: 'check-1' }, 'net'], value: 2000, label: 'x' }],
      ['paychecks', { op: 'set', path: ['paychecks', { id: 'check-1' }, 'envelopeAmounts', 'wedding'], value: 1, label: 'x' }],
      ['paychecks', { op: 'remove', path: ['paychecks', { id: 'check-1' }], label: 'x' }],
      ['paychecks', { op: 'set', path: ['paychecks'], value: [], label: 'x' }],
      ['extras', { op: 'set', path: ['extras', { id: 'extra-1' }, 'amount'], value: 500, label: 'x' }],
      ['extras', { op: 'remove', path: ['extras', { id: 'extra-1' }], label: 'x' }],
    ]
    for (const [list, op] of cases) {
      expect(validateBudget(patched([op]), budget(), 1)).toContain(`An existing record in ${list} was changed or removed`)
    }
  })

  test('more than 25 ops is refused', () => {
    expect(validateBudget(patched([SET_WEDDING]), budget(), MAX_OPS)).toEqual([])
    expect(validateBudget(patched([SET_WEDDING]), budget(), MAX_OPS + 1)).toEqual(['26 operations is more than the 25 one request may make'])
  })

  test('a budget of 256 KB or more is refused', () => {
    const big = patched([{ op: 'set', path: ['funds', { id: 'italy' }, 'note'], value: 'x'.repeat(256 * 1024), label: 'x' }])
    expect(validateBudget(big, budget(), 1).some((problem) => problem.includes('over the 256 KB limit'))).toBe(true)
  })
})
