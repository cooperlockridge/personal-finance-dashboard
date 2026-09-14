import { useEffect, useState } from 'react'
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react'
import {
  DEFAULT_ENVELOPES,
  DEFAULT_FUNDS,
  DEFAULT_PROFILE,
  DEFAULT_ROLL_RANGE,
  buildPaycheck,
  currency,
  effectiveTaxRate,
  findDuplicate,
  formatDay,
  fundStatus,
  fundsPerCheckTotal,
  grossOf,
  learnedWithholding,
  rollAmount,
  todayKey,
  typicalNet,
  usePersistentState,
  type Envelope,
  type EnvelopeKind,
  type ExtraSaving,
  type Fund,
  type FundStatus,
  type Paycheck,
  type Profile,
  type RollRange,
} from './lib/finance'

/* 16px on phones keeps iOS Safari from zooming the page on focus; min-h-11
   gives a 44px tap target. Both shrink back down at sm. */
const inputClass =
  'rounded-apple border border-border-default bg-surface-base px-3 py-2 text-[16px] text-ink-body tabular-nums min-h-11 sm:min-h-0 sm:py-1.5 sm:text-[14px]'
const editorInputClass =
  'rounded-apple border border-border-default bg-surface-base px-2.5 py-2 text-[16px] text-ink-body tabular-nums min-h-11 sm:min-h-0 sm:py-1 sm:text-[13px]'
/* Comfortable hit area for the small inline text buttons on touch. */
const tapClass = 'inline-flex min-h-11 items-center sm:min-h-0'

const KIND_LABELS: Record<EnvelopeKind, string> = {
  percentNet: '% net',
  percentGross: '% gross',
  fixedPerCheck: '$ fixed',
}

/* Categorical palette validated with the dataviz skill's checker (CVD-safe in
   this draw order on white). Leftover is a tint slice, not a series color. */
const SLOT_COLORS = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948']
const ENTITY_SLOTS: Record<string, number> = {
  general: 0,
  giving: 1,
  wedding: 2,
  expenses: 3,
  car: 4,
  roth: 5,
}
const FUNDS_SLOT = 6
/* Deep rose (the app accent) — validated visible on the tint surface and
   CVD-distinct from both donut neighbors (violet, blue). */
const LEFTOVER_COLOR = '#c03760'

/* Funds removed per Laken's Aug 8, 2026 email. The names still label older
   checks in Paycheck History. */
const RETIRED_FUNDS = new Map([
  ['phone', 'New Phone'],
  ['italy', 'Italy Plane Ticket'],
  ['moveout', 'Move Out'],
  ['band', 'Wedding Band'],
])

type Slice = { id: string; label: string; amount: number; color: string }

function donutSlices(check: Paycheck, envelopes: Envelope[]): Slice[] {
  const slices: Slice[] = []
  for (const env of envelopes) {
    const amount = check.envelopeAmounts[env.id] ?? 0
    if (amount <= 0) continue
    const slot = ENTITY_SLOTS[env.id] ?? 7
    slices.push({ id: env.id, label: env.name, amount, color: SLOT_COLORS[slot] })
  }
  const fundTotal = Object.values(check.fundAmounts).reduce((s, v) => s + v, 0)
  if (fundTotal > 0) {
    slices.push({ id: 'funds', label: 'Sinking funds', amount: fundTotal, color: SLOT_COLORS[FUNDS_SLOT] })
  }
  slices.sort((a, b) => SLOT_COLORS.indexOf(a.color) - SLOT_COLORS.indexOf(b.color))
  if (check.leftover > 0) {
    slices.push({ id: 'leftover', label: 'Stays in checking', amount: check.leftover, color: LEFTOVER_COLOR })
  }
  return slices
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0)
  const y0 = cy + r * Math.sin(a0)
  const x1 = cx + r * Math.cos(a1)
  const y1 = cy + r * Math.sin(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`
}

function Donut({ slices, centerLabel, centerValue }: { slices: Slice[]; centerLabel: string; centerValue: string }) {
  const [hovered, setHovered] = useState<Slice | null>(null)
  const total = slices.reduce((s, x) => s + x.amount, 0)
  const gap = slices.length > 1 ? 0.04 : 0
  let angle = -Math.PI / 2
  const arcs = slices.map((slice) => {
    const sweep = total > 0 ? (slice.amount / total) * Math.PI * 2 : 0
    const a0 = angle
    const a1 = angle + Math.max(0.001, sweep - gap)
    angle += sweep
    return { slice, a0, a1 }
  })
  const shown = hovered ?? null
  /* Tapping a slice on touch pins the readout, since there's no hover. */
  const toggle = (slice: Slice) => setHovered((cur) => (cur?.id === slice.id ? null : slice))
  return (
    /* Side by side while the panel is full width, stacked again at lg where
       the panel narrows to 5 columns — that's what lets both grow. */
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center lg:flex-col lg:gap-4">
      <svg
        viewBox="0 0 176 176"
        role="img"
        aria-label="Paycheck split"
        className="w-52 shrink-0 sm:w-56 lg:w-64"
      >
        {arcs.map(({ slice, a0, a1 }) => (
          <path
            key={slice.id}
            d={arcPath(88, 88, 61, a0, a1)}
            fill="none"
            stroke={slice.color}
            strokeWidth={hovered?.id === slice.id ? 34 : 27}
            strokeLinecap="butt"
            onMouseEnter={() => setHovered(slice)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => toggle(slice)}
          >
            <title>{`${slice.label}: ${currency(slice.amount)}`}</title>
          </path>
        ))}
        <text x="88" y="82" textAnchor="middle" className="fill-ink-caption" fontSize="9.5" fontWeight="300">
          {shown ? shown.label : centerLabel}
        </text>
        <text x="88" y="99" textAnchor="middle" className="fill-ink-heading" fontSize="15" fontWeight="600">
          {shown ? currency(shown.amount) : centerValue}
        </text>
      </svg>
      <ul className="w-full flex-1 space-y-0.5">
        {slices.map((slice) => {
          const pct = total > 0 ? (slice.amount / total) * 100 : 0
          return (
            <li
              key={slice.id}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[14px] sm:text-[13px] ${
                hovered?.id === slice.id ? 'bg-surface-tint' : ''
              }`}
              onMouseEnter={() => setHovered(slice)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => toggle(slice)}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: slice.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-body">{slice.label}</span>
              <span className="shrink-0 tabular-nums text-ink-body">{currency(slice.amount)}</span>
              <span className="w-9 shrink-0 text-right tabular-nums text-ink-caption">
                {pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function App() {
  const [profile, setProfile] = usePersistentState('pfd2:profile', DEFAULT_PROFILE)
  const [envelopes, setEnvelopes] = usePersistentState<Envelope[]>('pfd2:envelopes', DEFAULT_ENVELOPES)
  const [funds, setFunds] = usePersistentState<Fund[]>('pfd2:funds', DEFAULT_FUNDS)
  const [paychecks, setPaychecks] = usePersistentState<Paycheck[]>('pfd2:paychecks', [])
  const [extras, setExtras] = usePersistentState<ExtraSaving[]>('pfd2:extras', [])
  const [rollRange, setRollRange] = usePersistentState<RollRange>('pfd2:rollRange', DEFAULT_ROLL_RANGE)
  const [amountInput, setAmountInput] = useState('')
  const [hoursInput, setHoursInput] = useState('')
  const [dateInput, setDateInput] = useState(() => todayKey())
  const [formError, setFormError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  /* Set when the entry matches a check already logged; clears on any edit. */
  const [duplicateOf, setDuplicateOf] = useState<Paycheck | null>(null)
  const { user } = useUser()

  /* One-time data migration (Aug 6, 2026): the Envelope Challenge's $613
     moved into General (+313) and Wedding (+300); Laken Craft was never a
     fund (it's her name on the spreadsheet). Idempotent — guarded on the
     old records still existing. */
  useEffect(() => {
    let next = envelopes
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
    let nextFunds = funds
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
    if (next !== envelopes) setEnvelopes(next)
    if (nextFunds !== funds) setFunds(nextFunds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const now = new Date()
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const monthName = now.toLocaleDateString('en-US', { month: 'long' })
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthChecks = paychecks.filter((p) => p.date.startsWith(monthKey))
  const monthNet = monthChecks.reduce((s, p) => s + p.net, 0)
  const firstName = user?.firstName ?? 'Laken'
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const typedNet = Number.parseFloat(amountInput)
  const typedHours = Number.parseFloat(hoursInput)
  const hoursOrNull = Number.isFinite(typedHours) && typedHours > 0 ? typedHours : null
  const withholding = learnedWithholding(paychecks, profile)

  const preview =
    Number.isFinite(typedNet) && typedNet > 0
      ? buildPaycheck(typedNet, hoursOrNull, dateInput, profile, envelopes, funds, withholding)
      : null

  const latest = paychecks[0]
  const donutCheck = preview ?? latest ?? null
  const latestRate = latest ? effectiveTaxRate(latest.net, grossOf(latest, profile)) : null
  const taxRate = latestRate === null ? null : Math.round(latestRate * 100)

  const extrasTotal = extras.reduce((s, x) => s + x.amount, 0)
  const savingsRows = [
    ...envelopes
      .filter((e) => e.countsAsSavings)
      .map((e) => ({ id: e.id, label: e.name, amount: e.balance })),
    { id: 'funds', label: 'Sinking funds', amount: funds.reduce((s, f) => s + f.current, 0) },
    ...(extrasTotal > 0 ? [{ id: 'extras', label: 'Random savings', amount: extrasTotal }] : []),
    { id: 'interest', label: 'HYSA interest', amount: profile.hysaInterestToDate },
  ].sort((a, b) => b.amount - a.amount)
  const savingsTotal = savingsRows.reduce((s, r) => s + r.amount, 0)
  const savingsMax = Math.max(...savingsRows.map((r) => r.amount), 1)
  const generalBalance = envelopes.find((e) => e.id === 'general')?.balance ?? 0
  const estMonthlyInterest = (generalBalance * profile.hysaApy) / 100 / 12

  /* What this month actually moved into savings — every envelope that counts
     as savings, every sinking-fund contribution, and every random saving. */
  const savingsEnvelopeIds = new Set(envelopes.filter((e) => e.countsAsSavings).map((e) => e.id))
  const savedThisMonth =
    monthChecks.reduce((sum, check) => {
      const toEnvelopes = Object.entries(check.envelopeAmounts)
        .filter(([id]) => savingsEnvelopeIds.has(id))
        .reduce((s, [, amount]) => s + amount, 0)
      const toFunds = Object.values(check.fundAmounts).reduce((s, amount) => s + amount, 0)
      return sum + toEnvelopes + toFunds
    }, 0) +
    extras.filter((x) => x.date.startsWith(monthKey)).reduce((s, x) => s + x.amount, 0)

  const fundViews = funds.map((fund) => ({ fund, status: fundStatus(fund, now, profile) }))
  const atRisk = fundViews.filter(
    (v) => v.status.state === 'behind' || v.status.state === 'overdue' || v.status.state === 'stalled',
  )
  const fundsDraw = fundsPerCheckTotal(funds, now, profile)
  const estNet = typicalNet(profile, withholding)
  /* Only meaningful once we've learned her real withholding from a check. */
  const fundsShare = estNet !== null && estNet > 0 ? fundsDraw / estNet : null

  const envelopeNames = new Map(envelopes.map((e) => [e.id, e.name]))
  const fundNames = new Map<string, string>([
    ...RETIRED_FUNDS,
    ...funds.map((f): [string, string] => [f.id, f.name]),
  ])

  function addPaycheck() {
    const net = Number.parseFloat(amountInput)
    if (!Number.isFinite(net) || net <= 0) {
      setFormError('Enter the take-home amount from her deposit.')
      return
    }
    setFormError('')
    /* Same day, same amount — ask before double-allocating every envelope. */
    const existing = findDuplicate(paychecks, dateInput, net)
    if (existing && duplicateOf?.id !== existing.id) {
      setDuplicateOf(existing)
      return
    }
    commitPaycheck(net)
  }

  function commitPaycheck(net: number) {
    setDuplicateOf(null)
    const check = buildPaycheck(net, hoursOrNull, dateInput, profile, envelopes, funds, withholding)
    setPaychecks([check, ...paychecks])
    setEnvelopes(
      envelopes.map((env) => {
        const amount = check.envelopeAmounts[env.id] ?? 0
        if (amount === 0) return env
        return env.remaining !== null
          ? { ...env, remaining: Math.max(0, env.remaining - amount) }
          : { ...env, balance: env.balance + amount }
      }),
    )
    setFunds(
      funds.map((fund) => {
        const amount = check.fundAmounts[fund.id] ?? 0
        return amount === 0 ? fund : { ...fund, current: fund.current + amount }
      }),
    )
    setAmountInput('')
    setHoursInput('')
  }

  function removePaycheck(check: Paycheck) {
    /* A retired fund's money moved into General Savings, so an older check
       gives back its share for that fund from General instead. */
    const retiredShare = Object.entries(check.fundAmounts)
      .filter(([id]) => RETIRED_FUNDS.has(id))
      .reduce((s, [, amount]) => s + amount, 0)
    setPaychecks(paychecks.filter((p) => p.id !== check.id))
    setEnvelopes(
      envelopes.map((env) => {
        const amount = (check.envelopeAmounts[env.id] ?? 0) + (env.id === 'general' ? retiredShare : 0)
        if (amount === 0) return env
        return env.remaining !== null
          ? { ...env, remaining: env.remaining + amount }
          : { ...env, balance: env.balance - amount }
      }),
    )
    setFunds(
      funds.map((fund) => {
        const amount = check.fundAmounts[fund.id] ?? 0
        return amount === 0 ? fund : { ...fund, current: fund.current - amount }
      }),
    )
    setRemovingId(null)
    setExpandedId(null)
  }

  function updateEnvelope(id: string, patch: Partial<Envelope>) {
    setEnvelopes(envelopes.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  function updateFund(id: string, patch: Partial<Fund>) {
    setFunds(funds.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }

  function num(raw: string): number {
    return Number.parseFloat(raw) || 0
  }

  return (
    <div className="min-h-dvh bg-surface-base text-ink-body">
      <header className="border-b border-border-default">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <h1 className="text-[16px] font-semibold text-ink-heading">Laken's Finance</h1>
          <div className="flex items-center gap-3 sm:gap-4">
            {/* The hero card carries the month, so this detail line is desktop-only. */}
            <span className="hidden text-[12px] font-light tabular-nums text-ink-rose sm:inline">
              {monthLabel} · ${profile.hourlyRate}/hr · HYSA {profile.hysaApy}%
            </span>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>

      <SignedOut>
        <div className="mx-auto max-w-sm px-6 py-24 text-center">
          <p className="text-[21px] font-semibold text-ink-heading">Hi, Laken 🌸</p>
          <p className="mt-2 text-[14px] text-pretty text-ink-caption">
            Sign in to see the dashboard and enter this week's paycheck.
          </p>
          <SignInButton mode="modal">
            <button
              type="button"
              className="mt-5 rounded-apple bg-pink px-6 py-2 text-[14px] font-medium text-ink-heading hover:bg-pink-hover"
            >
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
      <main className="mx-auto max-w-[1200px] space-y-4 px-4 py-4 sm:px-6">
        <section className="rounded-apple border border-border-default bg-surface-tint p-5 sm:p-6">
          <p className="text-[14px] text-ink-rose">
            {greeting}, {firstName} 🌸
          </p>
          <p className="mt-1 text-[15px] text-pretty text-ink-body">You've put away</p>
          <p className="mt-0.5 text-[34px] leading-tight font-semibold tabular-nums text-ink-heading sm:text-[40px]">
            {currency(savingsTotal)}
          </p>
          <p className="mt-1.5 text-[13px] text-pretty text-ink-caption">
            {savedThisMonth > 0 ? (
              <>
                <span className="font-medium text-ink-rose">
                  {currency(savedThisMonth)} of it this month
                </span>{' '}
                — across savings, sinking funds, and interest.
              </>
            ) : (
              <>across savings, sinking funds, and interest. Add a paycheck to grow it.</>
            )}
          </p>
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          <PersonalCard
            label={`Brought home in ${monthName}`}
            value={currency(monthNet)}
            note={
              monthChecks.length === 0
                ? 'no paychecks logged yet'
                : `from ${monthChecks.length} paycheck${monthChecks.length === 1 ? '' : 's'}`
            }
          />
          <PersonalCard
            label="Taxes took"
            value={taxRate === null ? '—' : `${taxRate}%`}
            note={
              taxRate === null
                ? 'add a check with hours to find out'
                : `of your last check${latest?.grossEstimated ? ' (estimated)' : ''}`
            }
          />
          <PersonalCard
            label="Earned while you slept"
            value={`≈ ${currency(estMonthlyInterest)}/mo`}
            note={`${currency(profile.hysaInterestToDate)} in interest so far`}
          />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className="rounded-apple border border-border-default bg-surface-tint p-5 lg:col-span-5">
            <h2 className="text-[15px] font-medium text-ink-heading">This Paycheck</h2>
            {/* Stacked and full-width on phones; single row from sm up. */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="Take-home $"
                aria-label="Take-home paycheck amount"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value)
                  setDuplicateOf(null)
                }}
                className={`${inputClass} w-full sm:w-32`}
              />
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.5"
                placeholder={`Hrs (${profile.typicalHours})`}
                aria-label="Hours worked this check"
                value={hoursInput}
                onChange={(e) => setHoursInput(e.target.value)}
                className={`${inputClass} w-full sm:w-24`}
              />
              <input
                type="date"
                aria-label="Paycheck date"
                value={dateInput}
                onChange={(e) => {
                  setDateInput(e.target.value)
                  setDuplicateOf(null)
                }}
                className={`${inputClass} col-span-2 w-full sm:w-auto`}
              />
              <button
                type="button"
                onClick={addPaycheck}
                className="col-span-2 min-h-11 w-full rounded-apple bg-pink px-4 text-[15px] font-medium text-ink-heading hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto sm:py-1.5 sm:text-[14px]"
              >
                Add
              </button>
            </div>
            {formError && <p className="mt-2 text-[13px] text-accent sm:text-[12px]">{formError}</p>}
            {duplicateOf && (
              <div className="mt-3 rounded-apple border border-accent/40 bg-surface-tint p-3">
                <p className="text-[13px] text-pretty text-ink-body">
                  You already logged{' '}
                  <span className="font-medium tabular-nums">{currency(duplicateOf.net)}</span> on{' '}
                  {duplicateOf.date}. Adding it again will double every allocation.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={() => commitPaycheck(Number.parseFloat(amountInput))}
                    className={`${tapClass} text-[13px] font-medium text-accent hover:text-accent-hover`}
                  >
                    Add anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setDuplicateOf(null)}
                    className={`${tapClass} text-[13px] text-ink-caption`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {preview && preview.net > preview.gross && (
              <p className="mt-2 text-[12px] text-ink-rose">
                More than gross for {hoursOrNull ?? profile.typicalHours} hrs ({currency(preview.gross)}) —
                double-check.
              </p>
            )}
            {preview && preview.leftover < 0 && (
              <p className="mt-2 text-[12px] text-accent">
                Allocations exceed this check by {currency(-preview.leftover)}.
              </p>
            )}
            <div className="mt-4">
              {donutCheck ? (
                <>
                  <Donut
                    slices={donutSlices(donutCheck, envelopes)}
                    centerLabel={preview ? 'as typed' : 'latest check'}
                    centerValue={currency(donutCheck.net)}
                  />
                  <p className="mt-2 text-[11px] font-light tabular-nums text-ink-rose">
                    Gross {currency(donutCheck.gross ?? 0)}
                    {donutCheck.grossEstimated
                      ? withholding !== null
                        ? ` · est. from her usual ${Math.round(withholding * 100)}% withholding`
                        : ` · assumes ${profile.typicalHours} hrs`
                      : ` · exact (${donutCheck.hours} hrs)`}
                  </p>
                </>
              ) : (
                <p className="py-10 text-center text-[13px] text-pretty text-ink-caption">
                  Type an amount above to see the split.
                </p>
              )}
            </div>
          </section>

          <div className="space-y-4 lg:col-span-7">
            <RandomSavings
              extras={extras}
              onChange={setExtras}
              range={rollRange}
              onRangeChange={setRollRange}
            />

            <section className="rounded-apple border border-border-default p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[15px] font-medium text-ink-heading">Savings Breakdown</h2>
                <span className="text-[12px] tabular-nums text-ink-caption">{currency(savingsTotal)} total</span>
              </div>
              <div className="mt-3 space-y-2">
                {savingsRows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2 sm:gap-3">
                    <span className="w-24 shrink-0 truncate text-[13px] text-ink-body sm:w-32 sm:text-[12px]">
                      {row.label}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded-[4px] bg-surface-tint">
                      <div
                        className="h-full rounded-[4px]"
                        style={{
                          width: `${Math.max(0.5, (row.amount / savingsMax) * 100)}%`,
                          background: '#e87ba4',
                        }}
                      />
                    </div>
                    <span className="w-[70px] shrink-0 text-right text-[12px] tabular-nums text-ink-caption sm:w-20">
                      {currency(row.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-apple border border-border-default p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-[15px] font-medium text-ink-heading">Sinking Funds</h2>
                <span className="text-[11px] font-light text-ink-caption">
                  each check auto-funds what the date needs
                </span>
              </div>

              {atRisk.length > 0 && (
                <div className="mt-3 rounded-apple border border-accent/40 bg-surface-tint p-3">
                  <p className="text-[13px] font-medium text-accent">
                    {atRisk.length} fund{atRisk.length === 1 ? '' : 's'} need
                    {atRisk.length === 1 ? 's' : ''} attention
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {atRisk.map(({ fund, status }) => (
                      <li key={fund.id} className="text-[13px] text-pretty text-ink-body sm:text-[12px]">
                        <span className="font-medium">{fund.name}</span> — {riskAdvice(fund, status)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-3 space-y-3">
                {fundViews.map(({ fund, status }) => {
                  const progress =
                    fund.target && fund.target > 0 ? Math.min(1, fund.current / fund.target) : null
                  return (
                    <div key={fund.id}>
                      {/* Name and status ride above the bar so nothing is cramped on a phone. */}
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] text-ink-body sm:text-[12px]">{fund.name}</span>
                        <StatusChip state={status.state} />
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-tint">
                        {progress !== null && (
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${progress * 100}%`,
                              background: status.state === 'behind' || status.state === 'overdue' ? LEFTOVER_COLOR : '#ff8da1',
                            }}
                          />
                        )}
                      </div>
                      <p className="mt-1 text-[12px] tabular-nums text-ink-caption sm:text-[11px]">
                        {fundCaption(fund, status)}
                      </p>
                    </div>
                  )
                })}
              </div>

              {fundsDraw > 0 && (
                <p className="mt-3 border-t border-border-default pt-3 text-[12px] text-pretty text-ink-caption sm:text-[11px]">
                  All funds together take{' '}
                  <span className="font-medium tabular-nums text-ink-rose">{currency(fundsDraw)}</span> per
                  check
                  {fundsShare !== null && ` — about ${Math.round(fundsShare * 100)}% of a typical take-home`}.
                </p>
              )}
            </section>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <details className="rounded-apple border border-border-default p-4">
            <summary className="min-h-11 cursor-pointer text-[15px] font-medium text-ink-heading sm:min-h-0 sm:text-[14px]">
              Envelopes
            </summary>
            <div className="mt-3 space-y-3">
              {envelopes.map((env) => (
                <div key={env.id} className="border-b border-border-default pb-3 last:border-b-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Envelope name"
                      value={env.name}
                      onChange={(e) => updateEnvelope(env.id, { name: e.target.value })}
                      className={`${editorInputClass} min-w-0 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => setEnvelopes(envelopes.filter((e) => e.id !== env.id))}
                      className={`${tapClass} shrink-0 px-1 text-[13px] text-ink-rose hover:text-accent sm:text-[12px]`}
                    >
                      Remove
                    </button>
                  </div>
                  {/* Wraps rather than overflowing once the phone runs out of width. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`${env.name} rule type`}
                      value={env.kind}
                      onChange={(e) => updateEnvelope(env.id, { kind: e.target.value as EnvelopeKind })}
                      className={`${editorInputClass} w-24 shrink-0`}
                    >
                      {Object.entries(KIND_LABELS).map(([kind, label]) => (
                        <option key={kind} value={kind}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      aria-label={`${env.name} value`}
                      value={env.value}
                      onChange={(e) => updateEnvelope(env.id, { value: num(e.target.value) })}
                      className={`${editorInputClass} w-14 shrink-0`}
                    />
                    <span className="ml-auto text-[11px] text-ink-caption">
                      {env.remaining !== null ? 'left to pay' : 'balance'}
                    </span>
                    <input
                      type="number"
                      aria-label={`${env.name} ${env.remaining !== null ? 'remaining' : 'balance'}`}
                      value={env.remaining !== null ? env.remaining : Math.round(env.balance * 100) / 100}
                      onChange={(e) =>
                        env.remaining !== null
                          ? updateEnvelope(env.id, { remaining: num(e.target.value) })
                          : updateEnvelope(env.id, { balance: num(e.target.value) })
                      }
                      className={`${editorInputClass} w-24 shrink-0`}
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setEnvelopes([
                    ...envelopes,
                    {
                      id: crypto.randomUUID(),
                      name: 'New Envelope',
                      kind: 'percentNet',
                      value: 0,
                      balance: 0,
                      countsAsSavings: true,
                      remaining: null,
                    },
                  ])
                }
                className={`${tapClass} text-[14px] font-medium text-accent hover:text-accent-hover sm:text-[13px]`}
              >
                + Add envelope
              </button>
            </div>
          </details>

          <details className="rounded-apple border border-border-default p-4">
            <summary className="min-h-11 cursor-pointer text-[15px] font-medium text-ink-heading sm:min-h-0 sm:text-[14px]">
              Settings & Funds
            </summary>
            <div className="mt-3 space-y-3">
              <ProfileRow label="Hourly rate ($)" value={profile.hourlyRate} onChange={(v) => setProfile({ ...profile, hourlyRate: v })} />
              <ProfileRow label="Typical hours / check" value={profile.typicalHours} onChange={(v) => setProfile({ ...profile, typicalHours: v })} />
              <ProfileRow label="Checks / month" value={profile.checksPerMonth} onChange={(v) => setProfile({ ...profile, checksPerMonth: v })} />
              <ProfileRow label="HYSA APY (%)" value={profile.hysaApy} onChange={(v) => setProfile({ ...profile, hysaApy: v })} />
              <ProfileRow label="HYSA interest to date ($)" value={profile.hysaInterestToDate} onChange={(v) => setProfile({ ...profile, hysaInterestToDate: v })} />
              <div className="space-y-3 border-t border-border-default pt-3">
                {funds.map((fund) => (
                  <div key={fund.id}>
                    <p className="text-[13px] text-ink-body sm:text-[12px]">{fund.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-[11px] text-ink-caption">
                        saved
                        <input type="number" min="0" aria-label={`${fund.name} current`} value={Math.round(fund.current * 100) / 100} onChange={(e) => updateFund(fund.id, { current: num(e.target.value) })} className={`${editorInputClass} w-20`} />
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-ink-caption">
                        target
                        <input type="number" min="0" aria-label={`${fund.name} target`} value={fund.target ?? 0} onChange={(e) => updateFund(fund.id, { target: num(e.target.value) || null })} className={`${editorInputClass} w-20`} />
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-ink-caption">
                        $/chk (0 = auto)
                        <input type="number" min="0" aria-label={`${fund.name} per-check contribution, zero means automatic`} value={fund.perCheck} onChange={(e) => updateFund(fund.id, { perCheck: num(e.target.value) })} className={`${editorInputClass} w-16`} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>

        </div>

        <details className="rounded-apple border border-border-default p-4" open>
          <summary className="min-h-11 cursor-pointer text-[15px] font-medium text-ink-heading sm:min-h-0 sm:text-[14px]">
            Paycheck History
          </summary>
          {paychecks.length === 0 ? (
            <p className="mt-3 text-[13px] font-light text-pretty text-ink-caption sm:text-[12px]">
              None yet. Add one above — you can always remove it, which reverses its allocations.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border-default">
              {paychecks.map((check) => (
                <PaycheckRow
                  key={check.id}
                  check={check}
                  profile={profile}
                  envelopeNames={envelopeNames}
                  fundNames={fundNames}
                  expanded={expandedId === check.id}
                  onToggle={() => setExpandedId(expandedId === check.id ? null : check.id)}
                  removing={removingId === check.id}
                  onAskRemove={() => setRemovingId(check.id)}
                  onCancelRemove={() => setRemovingId(null)}
                  onConfirmRemove={() => removePaycheck(check)}
                />
              ))}
            </ul>
          )}
        </details>
      </main>
      </SignedIn>
    </div>
  )
}

const STATUS_LABELS: Record<FundStatus['state'], string | null> = {
  done: 'funded',
  overdue: 'past due',
  behind: 'behind',
  stalled: 'not funding',
  upcoming: 'upcoming',
  onTrack: null,
  noTarget: null,
}

function StatusChip({ state }: { state: FundStatus['state'] }) {
  const label = STATUS_LABELS[state]
  if (label === null) return null
  const tone =
    state === 'done' || state === 'upcoming'
      ? 'bg-surface-tint text-ink-rose'
      : 'bg-accent/10 text-accent'
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>
  )
}

/** Plain-language next step for a fund that needs attention. */
function riskAdvice(fund: Fund, status: FundStatus): string {
  if (status.state === 'overdue') {
    return `its ${formatDay(fund.deadline as string)} date has passed with ${currency(status.remaining)} still to go.`
  }
  if (status.state === 'stalled') {
    return 'it has a target but no date, so nothing is being set aside. Add a date or a $/check amount.'
  }
  const needed = status.needed
  if (needed === null) return 'it needs a closer look.'
  return `set to ${currency(status.contributing)}/check but needs ${currency(
    needed,
  )} to make ${formatDay(fund.deadline as string)}. Raise it by ${currency(status.shortfall)} or set $/chk to 0 for auto.`
}

function PaycheckRow({
  check,
  profile,
  envelopeNames,
  fundNames,
  expanded,
  onToggle,
  removing,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  check: Paycheck
  profile: Profile
  envelopeNames: Map<string, string>
  fundNames: Map<string, string>
  expanded: boolean
  onToggle: () => void
  removing: boolean
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}) {
  const gross = grossOf(check, profile)
  const rate = effectiveTaxRate(check.net, gross)
  /* Names come from current state, so a since-renamed envelope still resolves;
     a since-deleted one falls back to its id rather than vanishing. */
  const lines = [
    ...Object.entries(check.envelopeAmounts).map(([id, amount]) => ({
      id,
      label: envelopeNames.get(id) ?? id,
      amount,
    })),
    ...Object.entries(check.fundAmounts).map(([id, amount]) => ({
      id: `fund:${id}`,
      label: fundNames.get(id) ?? id,
      amount,
    })),
  ].sort((a, b) => b.amount - a.amount)

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left sm:min-h-0"
      >
        <span className="text-[14px] tabular-nums text-ink-body sm:text-[13px]">
          {check.date} · {currency(check.net)}
          {check.hours !== null && (
            <span className="text-[12px] font-light text-ink-caption sm:text-[11px]">
              {' '}
              · {check.hours} hrs
            </span>
          )}
        </span>
        <span className="shrink-0 text-[12px] text-ink-rose">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      {expanded && (
        <div className="mt-2 rounded-apple bg-surface-tint p-3">
          <p className="text-[12px] tabular-nums text-ink-caption sm:text-[11px]">
            Gross {currency(gross)}
            {check.grossEstimated ? ' (estimated)' : ` (exact, ${check.hours} hrs)`}
            {rate !== null && ` · taxes took ${Math.round(rate * 100)}%`}
          </p>
          <ul className="mt-2 space-y-1">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-3 text-[13px] sm:text-[12px]">
                <span className="truncate text-ink-body">{line.label}</span>
                <span className="shrink-0 tabular-nums text-ink-caption">{currency(line.amount)}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 border-t border-border-default pt-1 text-[13px] sm:text-[12px]">
              <span className="text-ink-body">Stayed in checking</span>
              <span className="shrink-0 tabular-nums text-ink-rose">{currency(check.leftover)}</span>
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {removing ? (
              <>
                <button
                  type="button"
                  onClick={onConfirmRemove}
                  className={`${tapClass} text-[13px] font-medium text-accent`}
                >
                  Confirm remove
                </button>
                <button
                  type="button"
                  onClick={onCancelRemove}
                  className={`${tapClass} text-[13px] text-ink-caption`}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onAskRemove}
                className={`${tapClass} text-[13px] text-ink-rose hover:text-accent`}
              >
                Remove this paycheck
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

/** The line under a fund's bar: progress, pace, and dates. */
function fundCaption(fund: Fund, status: FundStatus): string {
  if (!fund.target) return 'no target set'
  const parts = [`${currency(fund.current)} of ${currency(fund.target)}`]
  if (status.state === 'upcoming' && fund.startDate) {
    parts.push(
      status.needed !== null && status.needed > 0
        ? `about ${currency(status.needed)}/check from ${formatDay(fund.startDate)}`
        : `starts ${formatDay(fund.startDate)}`,
    )
  } else if (status.contributing > 0) {
    parts.push(`${currency(status.contributing)}/check`)
  }
  if (fund.deadline) parts.push(`by ${formatDay(fund.deadline)}`)
  return parts.join(' · ')
}

const RECENT_EXTRAS = 5

/**
 * Money put away on a whim. Roll lands a whole-dollar amount in her range —
 * or she types her own — and Put away logs it for today. Lives beside the
 * paycheck split rather than inside it, so it never changes an allocation.
 */
function RandomSavings({
  extras,
  onChange,
  range,
  onRangeChange,
}: {
  extras: ExtraSaving[]
  onChange: (next: ExtraSaving[]) => void
  range: RollRange
  onRangeChange: (next: RollRange) => void
}) {
  const [amountInput, setAmountInput] = useState('')
  /* The last number a roll landed on. An amount counts as rolled only while
     the field still holds it, so a typed-over roll logs as typed. */
  const [lastRoll, setLastRoll] = useState<number | null>(null)
  /* Bumps on every roll; the amount remounts under a new key and the
     pop-in replays. Zero means no roll yet, so nothing animates on load. */
  const [rollCount, setRollCount] = useState(0)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const amount = Number.parseFloat(amountInput)
  const valid = Number.isFinite(amount) && amount > 0
  const total = extras.reduce((s, x) => s + x.amount, 0)
  const shown = showAll ? extras : extras.slice(0, RECENT_EXTRAS)

  function roll() {
    const next = rollAmount(range, lastRoll)
    setLastRoll(next)
    setAmountInput(String(next))
    setRollCount((c) => c + 1)
    setError('')
  }

  function putAway() {
    if (!valid) {
      setError('Roll an amount or type one in.')
      return
    }
    const rounded = Math.round(amount * 100) / 100
    onChange([
      { id: crypto.randomUUID(), date: todayKey(), amount: rounded, rolled: rounded === lastRoll },
      ...extras,
    ])
    setAmountInput('')
    setLastRoll(null)
    setError('')
  }

  return (
    <section className="rounded-apple border border-border-default p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium text-ink-heading">Random Savings</h2>
        {total > 0 && <span className="text-[12px] tabular-nums text-ink-caption">{currency(total)} total</span>}
      </div>

      <div className="mt-3 flex items-center gap-2 sm:gap-3">
        {/* The input drops its own outline; the field's border carries focus instead. */}
        <label className="flex min-w-0 flex-1 items-baseline gap-1 rounded-apple border border-border-default bg-surface-tint px-4 py-1.5 focus-within:border-accent">
          <span className="text-[26px] font-semibold text-ink-caption">$</span>
          <span key={rollCount} className={`t-digit-group min-w-0 flex-1 ${rollCount > 0 ? 'is-animating' : ''}`}>
            <span className="t-digit w-full">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0"
                aria-label="Amount to put away"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value)
                  setError('')
                }}
                className="w-full bg-transparent text-[34px] leading-tight font-semibold tabular-nums text-ink-heading outline-none [appearance:textfield] placeholder:text-ink-caption/40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </span>
          </span>
        </label>
        <button
          type="button"
          onClick={roll}
          aria-label="Roll a random amount"
          className="min-h-11 shrink-0 rounded-apple border border-border-default bg-surface-base px-4 py-2.5 text-[15px] font-medium text-ink-heading hover:bg-surface-tint sm:text-[14px]"
        >
          🎲 Roll
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="flex items-center gap-1.5 text-[12px] text-ink-caption">
          Rolls between $
          <input
            type="number"
            min="1"
            aria-label="Smallest roll"
            value={range.min}
            onChange={(e) => onRangeChange({ ...range, min: Number.parseFloat(e.target.value) || 0 })}
            className={`${editorInputClass} w-16`}
          />
          and $
          <input
            type="number"
            min="1"
            aria-label="Largest roll"
            value={range.max}
            onChange={(e) => onRangeChange({ ...range, max: Number.parseFloat(e.target.value) || 0 })}
            className={`${editorInputClass} w-16`}
          />
        </p>
        <button
          type="button"
          onClick={putAway}
          className={`${tapClass} text-[14px] font-medium text-accent hover:text-accent-hover sm:text-[13px]`}
        >
          {valid ? `Put away ${currency(amount)}` : 'Put away'}
        </button>
      </div>
      {error && <p className="mt-1 text-[13px] text-accent sm:text-[12px]">{error}</p>}

      {extras.length > 0 && (
        <ul className="mt-3 divide-y divide-border-default border-t border-border-default">
          {shown.map((x) => (
            <li key={x.id} className="flex min-h-11 items-center justify-between gap-3 py-1 sm:min-h-0">
              <span className="text-[14px] tabular-nums text-ink-body sm:text-[13px]">
                {formatDay(x.date)} · {currency(x.amount)}
                {x.rolled && (
                  <span className="text-ink-caption" role="img" aria-label="rolled">
                    {' '}
                    🎲
                  </span>
                )}
              </span>
              {removingId === x.id ? (
                <span className="flex shrink-0 items-center gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      onChange(extras.filter((e) => e.id !== x.id))
                      setRemovingId(null)
                    }}
                    className={`${tapClass} text-[13px] font-medium text-accent sm:text-[12px]`}
                  >
                    Confirm remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemovingId(null)}
                    className={`${tapClass} text-[13px] text-ink-caption sm:text-[12px]`}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setRemovingId(x.id)}
                  className={`${tapClass} shrink-0 text-[13px] text-ink-rose hover:text-accent sm:text-[12px]`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {extras.length > RECENT_EXTRAS && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className={`${tapClass} mt-1 text-[13px] text-ink-rose hover:text-accent sm:text-[12px]`}
        >
          {showAll ? 'Show fewer' : `Show all ${extras.length}`}
        </button>
      )}
    </section>
  )
}

function PersonalCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-apple border border-border-default bg-surface-base p-4">
      <p className="text-[13px] text-ink-body sm:text-[12px]">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink-heading">{value}</p>
      <p className="mt-0.5 text-[12px] font-light text-pretty text-ink-caption sm:text-[11px]">{note}</p>
    </div>
  )
}

function ProfileRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px]">{label}</span>
      <input
        type="number"
        min="0"
        step="any"
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value) || 0)}
        className={`${inputClass} w-24`}
      />
    </label>
  )
}

export default App
