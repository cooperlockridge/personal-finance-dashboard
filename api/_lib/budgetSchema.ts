/* The budget document's full shape, for the catch-all patch tool
   (2026-10-19). /api/budget only checks the top-level slices exist, which is
   enough for the app's own code, but a model writing raw JSON can get a
   type or a field name wrong and blank a card on her phone. budgetProblems
   lists every place the document departs from what App.tsx and finance.ts
   expect; patch_budget refuses a patch that adds a problem the stored copy
   did not already have, so an old record missing a newer field never blocks
   an unrelated edit. */

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MONTH_OR_DAY = /^\d{4}-\d{2}(-\d{2})?$/
const KINDS = ['percentNet', 'percentGross', 'fixedPerCheck']

const TOP_KEYS = ['profile', 'envelopes', 'funds', 'paychecks', 'extras', 'rollRange']
const PROFILE_KEYS = ['hourlyRate', 'typicalHours', 'checksPerMonth', 'hysaApy', 'hysaInterestToDate']
const ENVELOPE_KEYS = ['id', 'name', 'kind', 'value', 'balance', 'countsAsSavings', 'remaining']
const FUND_KEYS = ['id', 'name', 'target', 'current', 'deadline', 'startDate', 'perCheck', 'note']
const PAYCHECK_KEYS = ['id', 'date', 'net', 'hours', 'gross', 'grossEstimated', 'envelopeAmounts', 'fundAmounts', 'leftover']
const EXTRA_KEYS = ['id', 'date', 'amount', 'rolled']

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function budgetProblems(data: unknown): string[] {
  const out: string[] = []
  if (!isRec(data)) return ['The budget must be an object.']

  for (const key of Object.keys(data)) if (!TOP_KEYS.includes(key)) out.push(`Unknown top-level field "${key}".`)

  const profile = data.profile
  if (!isRec(profile)) out.push('/profile must be an object.')
  else {
    for (const key of PROFILE_KEYS) if (!isNum(profile[key]) || (profile[key] as number) < 0) out.push(`/profile/${key} must be a number ≥ 0.`)
    if (isNum(profile.checksPerMonth) && profile.checksPerMonth < 1) out.push('/profile/checksPerMonth must be at least 1.')
    for (const key of Object.keys(profile)) if (!PROFILE_KEYS.includes(key)) out.push(`Unknown field /profile/${key}.`)
  }

  const list = (key: string, check: (item: Rec, at: string) => void, allowed: string[]) => {
    const items = data[key]
    if (!Array.isArray(items)) {
      out.push(`/${key} must be an array.`)
      return
    }
    const ids = new Set<string>()
    items.forEach((item, i) => {
      const at = `/${key}/${i}`
      if (!isRec(item)) {
        out.push(`${at} must be an object.`)
        return
      }
      if (typeof item.id !== 'string' || !item.id) out.push(`${at}/id must be a non-empty string.`)
      else if (ids.has(item.id)) out.push(`${at}/id "${item.id}" is used twice in /${key}.`)
      else ids.add(item.id)
      for (const field of Object.keys(item)) if (!allowed.includes(field)) out.push(`Unknown field ${at}/${field}.`)
      check(item, at)
    })
  }

  list('envelopes', (e, at) => {
    if (typeof e.name !== 'string' || !e.name.trim()) out.push(`${at}/name must be non-empty text.`)
    if (!KINDS.includes(e.kind as string)) out.push(`${at}/kind must be one of ${KINDS.join(', ')}.`)
    if (!isNum(e.value) || e.value < 0) out.push(`${at}/value must be a number ≥ 0.`)
    if (!isNum(e.balance)) out.push(`${at}/balance must be a number.`)
    if (typeof e.countsAsSavings !== 'boolean') out.push(`${at}/countsAsSavings must be true or false.`)
    if (e.remaining !== null && (!isNum(e.remaining) || e.remaining < 0)) out.push(`${at}/remaining must be null or a number ≥ 0.`)
  }, ENVELOPE_KEYS)

  list('funds', (f, at) => {
    if (typeof f.name !== 'string' || !f.name.trim()) out.push(`${at}/name must be non-empty text.`)
    if (f.target !== null && (!isNum(f.target) || f.target < 0)) out.push(`${at}/target must be null or a number ≥ 0.`)
    if (!isNum(f.current)) out.push(`${at}/current must be a number.`)
    if (f.deadline !== null && !(typeof f.deadline === 'string' && MONTH_OR_DAY.test(f.deadline))) out.push(`${at}/deadline must be null or YYYY-MM-DD.`)
    if (f.startDate !== undefined && f.startDate !== null && !(typeof f.startDate === 'string' && DAY.test(f.startDate))) out.push(`${at}/startDate must be null or YYYY-MM-DD.`)
    if (!isNum(f.perCheck) || f.perCheck < 0) out.push(`${at}/perCheck must be a number ≥ 0 (0 = automatic).`)
    if (f.note !== undefined && typeof f.note !== 'string') out.push(`${at}/note must be text.`)
  }, FUND_KEYS)

  const amounts = (value: unknown, at: string) => {
    if (!isRec(value)) out.push(`${at} must be an object of id → dollars.`)
    else for (const [id, n] of Object.entries(value)) if (!isNum(n)) out.push(`${at}/${id} must be a number.`)
  }
  list('paychecks', (p, at) => {
    if (typeof p.date !== 'string' || !DAY.test(p.date)) out.push(`${at}/date must be YYYY-MM-DD.`)
    if (!isNum(p.net) || p.net <= 0) out.push(`${at}/net must be a number > 0.`)
    if (p.hours !== null && (!isNum(p.hours) || p.hours < 0)) out.push(`${at}/hours must be null or a number ≥ 0.`)
    if (!isNum(p.gross)) out.push(`${at}/gross must be a number.`)
    if (typeof p.grossEstimated !== 'boolean') out.push(`${at}/grossEstimated must be true or false.`)
    amounts(p.envelopeAmounts, `${at}/envelopeAmounts`)
    amounts(p.fundAmounts, `${at}/fundAmounts`)
    if (!isNum(p.leftover)) out.push(`${at}/leftover must be a number.`)
  }, PAYCHECK_KEYS)

  list('extras', (x, at) => {
    if (typeof x.date !== 'string' || !DAY.test(x.date)) out.push(`${at}/date must be YYYY-MM-DD.`)
    if (!isNum(x.amount) || x.amount <= 0) out.push(`${at}/amount must be a number > 0.`)
    if (typeof x.rolled !== 'boolean') out.push(`${at}/rolled must be true or false.`)
  }, EXTRA_KEYS)

  const range = data.rollRange
  if (!isRec(range) || !isNum(range.min) || !isNum(range.max)) out.push('/rollRange must be { min, max } numbers.')
  else if (range.min < 1 || range.max < range.min) out.push('/rollRange needs 1 ≤ min ≤ max.')

  return out
}

/* What patch_budget's model reads before it writes. Kept next to the
   validator so the two describe the same document. */
export const BUDGET_SCHEMA_GUIDE = `The budget is ONE JSON document. Read it with get_budget; edit it with patch_budget using JSON Pointer paths into it (array items by index, e.g. /envelopes/2/value, "-" appends).

{
  "profile": {
    "hourlyRate": number,          // $/hour
    "typicalHours": number,        // usual hours per paycheck; gross estimate = hourlyRate × typicalHours
    "checksPerMonth": number ≥ 1,  // paces sinking funds
    "hysaApy": number,             // percent, e.g. 3.9
    "hysaInterestToDate": number   // $ of HYSA interest earned so far (counts toward "put away")
  },
  "envelopes": [{                  // each paycheck pays into every envelope by its rule
    "id": string (unique, never change an existing id: paychecks refer to it),
    "name": string,
    "kind": "percentNet" | "percentGross" | "fixedPerCheck",
    "value": number,               // percent for the percent kinds, $ per check for fixedPerCheck
    "balance": number,             // $ in it now (ignored for debts)
    "countsAsSavings": boolean,    // included in "put away" and the savings breakdown
    "remaining": number | null     // debts only (e.g. the car): $ left to pay; contributions stop at 0. null = normal envelope
  }],
  "funds": [{                      // sinking funds: saving toward a dated goal
    "id": string (unique; paychecks refer to it),
    "name": string,
    "target": number | null,       // goal $
    "current": number,             // $ saved so far
    "deadline": "YYYY-MM-DD" | null,
    "startDate"?: "YYYY-MM-DD" | null,  // checks before this skip the fund
    "perCheck": number,            // 0 = automatic (each check sets aside what the deadline needs); > 0 = fixed $ per check
    "note"?: string
  }],
  "paychecks": [{                  // NEWEST FIRST. [0] is "latest check" on the dashboard
    "id": string, "date": "YYYY-MM-DD",
    "net": number,                 // take-home
    "hours": number | null,
    "gross": number, "grossEstimated": boolean,
    "envelopeAmounts": { [envelopeId]: $ },  // what this check put in each envelope (used to reverse it)
    "fundAmounts": { [fundId]: $ },
    "leftover": number             // net − everything allocated; stayed in checking
  }],
  "extras": [{                     // random savings, NEWEST FIRST
    "id": string, "date": "YYYY-MM-DD", "amount": number > 0, "rolled": boolean
  }],
  "rollRange": { "min": number ≥ 1, "max": number ≥ min }
}

Rules that are NOT automatic in a raw patch — keep them consistent yourself:
- Envelope balances and fund "current" already include every logged check. Editing a paycheck's numbers does NOT move money; also adjust the balances (or prefer edit_paycheck / remove_paycheck).
- "Total put away" = balances of countsAsSavings envelopes + every fund's current + all extras + profile.hysaInterestToDate.
- New ids: short lowercase slugs or UUIDs, unique within their list.
- Use "test" operations to assert values you are relying on (e.g. {"op":"test","path":"/envelopes/1/id","value":"general"}) so an index that shifted fails safely instead of editing the wrong item.

Prefer the specific tools when one fits; patch_budget is for everything else (bulk edits, reordering, renaming many things, fixing a bad record, backfilling history, etc.).`
