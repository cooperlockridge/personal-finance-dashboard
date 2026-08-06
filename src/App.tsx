import { useEffect, useState } from 'react'
import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/clerk-react'
import {
  DEFAULT_ENVELOPES,
  DEFAULT_FUNDS,
  DEFAULT_PROFILE,
  buildPaycheck,
  currency,
  grossForCheck,
  learnedWithholding,
  neededPerCheck,
  usePersistentState,
  type Envelope,
  type EnvelopeKind,
  type Fund,
  type Paycheck,
} from './lib/finance'

const inputClass =
  'rounded-apple border border-border-default bg-surface-base px-3 py-1.5 text-[14px] text-ink-body tabular-nums'
const editorInputClass =
  'rounded-apple border border-border-default bg-surface-base px-2.5 py-1 text-[13px] text-ink-body tabular-nums'

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
  return (
    <div className="flex items-center gap-5">
      <svg width="176" height="176" viewBox="0 0 176 176" role="img" aria-label="Paycheck split">
        {arcs.map(({ slice, a0, a1 }) => (
          <path
            key={slice.id}
            d={arcPath(88, 88, 62, a0, a1)}
            fill="none"
            stroke={slice.color}
            strokeWidth={hovered?.id === slice.id ? 30 : 24}
            strokeLinecap="butt"
            onMouseEnter={() => setHovered(slice)}
            onMouseLeave={() => setHovered(null)}
          >
            <title>{`${slice.label}: ${currency(slice.amount)}`}</title>
          </path>
        ))}
        <text x="88" y="83" textAnchor="middle" className="fill-ink-caption" fontSize="10" fontWeight="300">
          {shown ? shown.label : centerLabel}
        </text>
        <text x="88" y="100" textAnchor="middle" className="fill-ink-heading" fontSize="15" fontWeight="600">
          {shown ? currency(shown.amount) : centerValue}
        </text>
      </svg>
      <ul className="grid flex-1 grid-cols-1 gap-1">
        {slices.map((slice) => (
          <li
            key={slice.id}
            className="flex items-center gap-2 text-[12px]"
            onMouseEnter={() => setHovered(slice)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} />
            <span className="truncate text-ink-body">{slice.label}</span>
            <span className="ml-auto tabular-nums text-ink-caption">{currency(slice.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function App() {
  const [profile, setProfile] = usePersistentState('pfd2:profile', DEFAULT_PROFILE)
  const [envelopes, setEnvelopes] = usePersistentState<Envelope[]>('pfd2:envelopes', DEFAULT_ENVELOPES)
  const [funds, setFunds] = usePersistentState<Fund[]>('pfd2:funds', DEFAULT_FUNDS)
  const [paychecks, setPaychecks] = usePersistentState<Paycheck[]>('pfd2:paychecks', [])
  const [amountInput, setAmountInput] = useState('')
  const [hoursInput, setHoursInput] = useState('')
  const [dateInput, setDateInput] = useState(() => new Date().toISOString().slice(0, 10))
  const [formError, setFormError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

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
    if (next !== envelopes) setEnvelopes(next)
    if (funds.some((f) => f.id === 'craft')) {
      setFunds(funds.filter((f) => f.id !== 'craft'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const now = new Date()
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthNet = paychecks.filter((p) => p.date.startsWith(monthKey)).reduce((s, p) => s + p.net, 0)

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
  const latestGross = latest ? (latest.gross ?? grossForCheck(profile, latest.hours)) : null
  const taxRate =
    latest && latestGross && latest.net <= latestGross
      ? Math.round((1 - latest.net / latestGross) * 100)
      : null

  const savingsRows = [
    ...envelopes
      .filter((e) => e.countsAsSavings)
      .map((e) => ({ id: e.id, label: e.name, amount: e.balance })),
    { id: 'funds', label: 'Sinking funds', amount: funds.reduce((s, f) => s + f.current, 0) },
    { id: 'interest', label: 'HYSA interest', amount: profile.hysaInterestToDate },
  ].sort((a, b) => b.amount - a.amount)
  const savingsTotal = savingsRows.reduce((s, r) => s + r.amount, 0)
  const savingsMax = Math.max(...savingsRows.map((r) => r.amount), 1)
  const generalBalance = envelopes.find((e) => e.id === 'general')?.balance ?? 0
  const estMonthlyInterest = (generalBalance * profile.hysaApy) / 100 / 12

  function addPaycheck() {
    const net = Number.parseFloat(amountInput)
    if (!Number.isFinite(net) || net <= 0) {
      setFormError('Enter the take-home amount from her deposit.')
      return
    }
    setFormError('')
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
    setPaychecks(paychecks.filter((p) => p.id !== check.id))
    setEnvelopes(
      envelopes.map((env) => {
        const amount = check.envelopeAmounts[env.id] ?? 0
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
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-3">
          <h1 className="text-[16px] font-semibold text-ink-heading">Laken's Finance</h1>
          <div className="flex items-center gap-4">
            <span className="text-[12px] font-light tabular-nums text-ink-rose">
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
      <main className="mx-auto max-w-[1200px] space-y-4 px-6 py-4">
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Total Savings" value={currency(savingsTotal)} />
          <StatTile label={`Income (${monthLabel.slice(0, 3)})`} value={currency(monthNet)} />
          <StatTile
            label="Effective Tax Rate"
            value={taxRate === null ? '—' : `${taxRate}%${latest?.grossEstimated ? ' est.' : ''}`}
          />
          <StatTile
            label="HYSA Interest"
            value={`≈ ${currency(estMonthlyInterest)}/mo`}
            note={`${currency(profile.hysaInterestToDate)} to date`}
          />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className="rounded-apple border border-border-default bg-surface-tint p-5 lg:col-span-5">
            <h2 className="text-[15px] font-medium text-ink-heading">This Paycheck</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="Take-home $"
                aria-label="Take-home paycheck amount"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className={`${inputClass} w-32`}
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
                className={`${inputClass} w-24`}
              />
              <input
                type="date"
                aria-label="Paycheck date"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className={inputClass}
              />
              <button
                type="button"
                onClick={addPaycheck}
                className="rounded-apple bg-pink px-4 py-1.5 text-[14px] font-medium text-ink-heading hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {formError && <p className="mt-2 text-[12px] text-accent">{formError}</p>}
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
            <section className="rounded-apple border border-border-default p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[15px] font-medium text-ink-heading">Savings Breakdown</h2>
                <span className="text-[12px] tabular-nums text-ink-caption">{currency(savingsTotal)} total</span>
              </div>
              <div className="mt-3 space-y-2">
                {savingsRows.map((row) => (
                  <div key={row.id} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-[12px] text-ink-body">{row.label}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded-[4px] bg-surface-tint">
                      <div
                        className="h-full rounded-[4px]"
                        style={{
                          width: `${Math.max(0.5, (row.amount / savingsMax) * 100)}%`,
                          background: '#e87ba4',
                        }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-ink-caption">
                      {currency(row.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-apple border border-border-default p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[15px] font-medium text-ink-heading">Sinking Funds</h2>
                <span className="text-[11px] font-light text-ink-caption">
                  each check auto-funds what the date needs
                </span>
              </div>
              <div className="mt-3 space-y-2.5">
                {funds.map((fund) => {
                  const progress = fund.target && fund.target > 0 ? Math.min(1, fund.current / fund.target) : null
                  const perCheck = fund.perCheck > 0 ? fund.perCheck : neededPerCheck(fund, now, profile)
                  return (
                    <div key={fund.id} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-[12px] text-ink-body">{fund.name}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-tint">
                        {progress !== null && (
                          <div className="h-full rounded-full bg-pink" style={{ width: `${progress * 100}%` }} />
                        )}
                      </div>
                      <span className="w-44 shrink-0 text-right text-[11px] tabular-nums text-ink-caption">
                        {fund.target
                          ? `${currency(fund.current)} of ${currency(fund.target)}${
                              perCheck && perCheck > 0 ? ` · ${currency(perCheck)}/check` : ''
                            }`
                          : 'no target set'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <details className="rounded-apple border border-border-default p-4">
            <summary className="cursor-pointer text-[14px] font-medium text-ink-heading">Envelopes</summary>
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
                      className="shrink-0 text-[12px] text-ink-rose hover:text-accent"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
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
                className="text-[13px] font-medium text-accent hover:text-accent-hover"
              >
                + Add envelope
              </button>
            </div>
          </details>

          <details className="rounded-apple border border-border-default p-4">
            <summary className="cursor-pointer text-[14px] font-medium text-ink-heading">
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
                    <p className="text-[12px] text-ink-body">{fund.name}</p>
                    <div className="mt-1 flex items-center gap-2">
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

          <details className="rounded-apple border border-border-default p-4">
            <summary className="cursor-pointer text-[14px] font-medium text-ink-heading">
              Recent Paychecks
            </summary>
            {paychecks.length === 0 ? (
              <p className="mt-3 text-[12px] font-light text-pretty text-ink-caption">
                None yet. Removing one reverses its allocations.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {paychecks.map((check) => (
                  <li key={check.id} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] tabular-nums text-ink-body">
                      {check.date} · {currency(check.net)}
                      {check.hours !== null && (
                        <span className="text-[11px] font-light text-ink-caption"> · {check.hours} hrs</span>
                      )}
                    </span>
                    {removingId === check.id ? (
                      <span className="flex shrink-0 items-center gap-3">
                        <button type="button" onClick={() => removePaycheck(check)} className="text-[12px] font-medium text-accent">
                          Confirm
                        </button>
                        <button type="button" onClick={() => setRemovingId(null)} className="text-[12px] text-ink-caption">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRemovingId(check.id)}
                        className="shrink-0 text-[12px] text-ink-rose hover:text-accent"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </main>
      </SignedIn>
    </div>
  )
}

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-apple border border-border-default bg-surface-base p-4">
      <p className="text-[12px] text-ink-caption">{label}</p>
      <p className="mt-1 text-[21px] font-semibold tabular-nums text-ink-heading">{value}</p>
      {note && <p className="mt-0.5 text-[11px] font-light text-ink-caption">{note}</p>}
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
