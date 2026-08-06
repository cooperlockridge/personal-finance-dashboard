import { useState } from 'react'
import {
  DEFAULT_ENVELOPES,
  DEFAULT_FUNDS,
  DEFAULT_PROFILE,
  buildPaycheck,
  currency,
  grossForCheck,
  learnedWithholding,
  neededPerWeek,
  usePersistentState,
  type Envelope,
  type EnvelopeKind,
  type Fund,
  type Paycheck,
} from './lib/finance'

const inputClass =
  'rounded-apple border border-border-default bg-surface-base px-4 py-2 text-[15px] text-ink-body tabular-nums'
const smallInputClass =
  'w-24 rounded-apple border border-border-default bg-surface-base px-3 py-1 text-[14px] text-ink-body tabular-nums'

const KIND_LABELS: Record<EnvelopeKind, string> = {
  percentNet: '% of take-home',
  percentGross: '% of gross',
  fixedPerCheck: '$ per check',
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

  const now = new Date()
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const monthShort = monthLabel.slice(0, 3)
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthNet = paychecks
    .filter((p) => p.date.startsWith(monthKey))
    .reduce((sum, p) => sum + p.net, 0)

  const typedNet = Number.parseFloat(amountInput)
  const typedHours = Number.parseFloat(hoursInput)
  const hoursOrNull = Number.isFinite(typedHours) && typedHours > 0 ? typedHours : null
  const withholding = learnedWithholding(paychecks, profile)

  const preview =
    Number.isFinite(typedNet) && typedNet > 0
      ? buildPaycheck(typedNet, hoursOrNull, dateInput, profile, envelopes, funds, withholding)
      : null

  const latest = paychecks[0]
  const latestGross = latest ? (latest.gross ?? grossForCheck(profile, latest.hours)) : null
  const taxRate =
    latest && latestGross && latest.net <= latestGross
      ? Math.round((1 - latest.net / latestGross) * 100)
      : null

  const savingsBalance =
    envelopes.filter((e) => e.countsAsSavings).reduce((sum, e) => sum + e.balance, 0) +
    funds.reduce((sum, f) => sum + f.current, 0) +
    profile.hysaInterestToDate
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
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-3">
          <span className="text-[16px] font-medium text-ink-heading">Laken's Finance</span>
          <span className="text-[12px] font-light tabular-nums text-ink-rose">
            ${profile.hourlyRate}/hr · HYSA {profile.hysaApy}%
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-8 py-12">
        <div>
          <h1 className="text-[51px] font-bold text-balance text-ink-heading">Dashboard</h1>
          <p className="text-[16px] text-pretty text-ink-caption">{monthLabel}</p>
        </div>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label="Total Savings"
            value={currency(savingsBalance)}
            note="Envelopes + funds + HYSA interest"
          />
          <SummaryCard
            label={`Income (${monthShort})`}
            value={currency(monthNet)}
            note="Take-home entered this month"
          />
          <SummaryCard
            label="Effective Tax Rate"
            value={taxRate === null ? '—' : `${taxRate}%${latest?.grossEstimated ? ' est.' : ''}`}
            note="Latest paycheck vs gross"
          />
          <SummaryCard
            label="HYSA Interest"
            value={`≈ ${currency(estMonthlyInterest)}/mo`}
            note={`${currency(profile.hysaInterestToDate)} earned to date`}
          />
        </section>

        <section className="rounded-apple border border-border-default bg-surface-tint p-6">
          <h2 className="text-[16px] font-medium text-ink-heading">This Paycheck</h2>
          <p className="mt-1 text-[12px] font-light text-pretty text-ink-caption">
            Enter the post-tax deposit (and hours if known — otherwise assumes{' '}
            {profile.typicalHours}). Every envelope and fund below updates when you add it.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="Take-home amount"
              aria-label="Take-home paycheck amount"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className={`${inputClass} w-44`}
            />
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.5"
              placeholder={`Hours (${profile.typicalHours})`}
              aria-label="Hours worked this check"
              value={hoursInput}
              onChange={(e) => setHoursInput(e.target.value)}
              className={`${inputClass} w-32`}
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
              className="rounded-apple bg-pink px-5 py-2 text-[14px] font-medium text-ink-heading hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add Paycheck
            </button>
          </div>
          {formError && <p className="mt-2 text-[12px] text-accent">{formError}</p>}
          {preview && preview.net > preview.gross && (
            <p className="mt-2 text-[12px] text-ink-rose">
              Heads up: that's more than gross for {hoursOrNull ?? profile.typicalHours} hrs (
              {currency(preview.gross)}) — double-check the amount or hours.
            </p>
          )}

          {preview && (
            <div className="mt-5 space-y-4">
              <p className="text-[12px] font-light tabular-nums text-ink-rose">
                Gross for this check: {currency(preview.gross)}
                {!preview.grossEstimated
                  ? ` at ${hoursOrNull} hrs`
                  : withholding !== null
                    ? ` — estimated from her usual ${Math.round(withholding * 100)}% withholding (≈ ${
                        Math.round((preview.gross / profile.hourlyRate) * 10) / 10
                      } hrs)`
                    : ` — assumes ${profile.typicalHours} hrs; enter hours on a check once and this becomes a learned estimate`}
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {envelopes
                  .filter((env) => (preview.envelopeAmounts[env.id] ?? 0) > 0)
                  .map((env) => (
                    <PreviewCard
                      key={env.id}
                      label={env.name}
                      amount={preview.envelopeAmounts[env.id]}
                    />
                  ))}
                {funds
                  .filter((fund) => (preview.fundAmounts[fund.id] ?? 0) > 0)
                  .map((fund) => (
                    <PreviewCard
                      key={fund.id}
                      label={`${fund.name} fund`}
                      amount={preview.fundAmounts[fund.id]}
                    />
                  ))}
                <PreviewCard label="Stays in checking" amount={preview.leftover} highlight />
              </div>
              {preview.leftover < 0 && (
                <p className="text-[12px] text-accent">
                  The allocations exceed this paycheck by {currency(-preview.leftover)} — trim an
                  envelope or fund contribution.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-apple border border-border-default">
          <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
            <h2 className="text-[16px] font-medium text-ink-heading">Envelopes</h2>
            <span className="text-[12px] font-light text-ink-caption">
              Balances seeded from her spreadsheet
            </span>
          </div>
          <div className="divide-y divide-border-default">
            {envelopes.map((env) => (
              <div key={env.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                <input
                  type="text"
                  aria-label="Envelope name"
                  value={env.name}
                  onChange={(e) => updateEnvelope(env.id, { name: e.target.value })}
                  className={`${inputClass} w-44 min-w-0 flex-1`}
                />
                <select
                  aria-label={`${env.name} rule type`}
                  value={env.kind}
                  onChange={(e) => updateEnvelope(env.id, { kind: e.target.value as EnvelopeKind })}
                  className={`${inputClass} w-40`}
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
                  className={smallInputClass}
                />
                <label className="flex items-center gap-2 text-[12px] text-ink-caption">
                  {env.remaining !== null ? 'Left to pay' : 'Balance'}
                  <input
                    type="number"
                    aria-label={`${env.name} ${env.remaining !== null ? 'remaining' : 'balance'}`}
                    value={env.remaining !== null ? env.remaining : Math.round(env.balance * 100) / 100}
                    onChange={(e) =>
                      env.remaining !== null
                        ? updateEnvelope(env.id, { remaining: num(e.target.value) })
                        : updateEnvelope(env.id, { balance: num(e.target.value) })
                    }
                    className={smallInputClass}
                  />
                </label>
                {env.id === 'car' && env.remaining !== null && env.remaining > 0 && (
                  <span className="text-[12px] font-light text-ink-rose">
                    ≈ paid off in{' '}
                    {Math.ceil(env.remaining / Math.max(1, env.value * profile.checksPerMonth))} months
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setEnvelopes(envelopes.filter((e) => e.id !== env.id))}
                  className="ml-auto text-[14px] text-ink-rose hover:text-accent"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-border-default px-6 py-4">
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
              className="text-[14px] font-medium text-accent hover:text-accent-hover"
            >
              + Add envelope
            </button>
          </div>
        </section>

        <section className="rounded-apple border border-border-default">
          <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
            <h2 className="text-[16px] font-medium text-ink-heading">Sinking Funds</h2>
            <span className="text-[12px] font-light text-ink-caption">
              Auto-contributions with "$ / check" set
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
            {funds.map((fund) => {
              const progress =
                fund.target && fund.target > 0
                  ? Math.min(1, fund.current / fund.target)
                  : null
              const weekly = neededPerWeek(fund, now)
              const perCheckNeeded =
                weekly === null ? null : (weekly * 52) / 12 / profile.checksPerMonth
              return (
                <div key={fund.id} className="rounded-apple border border-border-default p-5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[15px] font-medium text-ink-heading">{fund.name}</p>
                    {fund.deadline && (
                      <span className="text-[11px] font-light text-ink-caption">
                        by{' '}
                        {new Date(`${fund.deadline}-01T00:00:00`).toLocaleDateString('en-US', {
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    )}
                  </div>
                  {progress !== null ? (
                    <>
                      <div className="mt-3 h-2 overflow-hidden rounded-apple bg-surface-tint">
                        <div
                          className="h-full rounded-apple bg-pink"
                          style={{ width: `${progress * 100}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[14px] tabular-nums text-ink-body">
                        {currency(fund.current)}{' '}
                        <span className="text-ink-caption">of {currency(fund.target ?? 0)}</span>
                      </p>
                      {perCheckNeeded !== null && perCheckNeeded > 0 && (
                        <p className="text-[12px] font-light tabular-nums text-ink-rose">
                          needs ≈ {currency(perCheckNeeded)}/check to hit the date
                        </p>
                      )}
                      {perCheckNeeded !== null && perCheckNeeded === 0 && (
                        <p className="text-[12px] font-light text-ink-rose">funded 🎉</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-3 text-[12px] font-light text-ink-caption">
                      No target yet — set one below.
                    </p>
                  )}
                  {fund.note && (
                    <p className="mt-1 text-[11px] font-light text-pretty text-ink-caption">
                      {fund.note}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-ink-caption">
                    <label className="flex items-center gap-2">
                      Saved
                      <input
                        type="number"
                        min="0"
                        aria-label={`${fund.name} current amount`}
                        value={Math.round(fund.current * 100) / 100}
                        onChange={(e) => updateFund(fund.id, { current: num(e.target.value) })}
                        className={smallInputClass}
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      Target
                      <input
                        type="number"
                        min="0"
                        aria-label={`${fund.name} target`}
                        value={fund.target ?? 0}
                        onChange={(e) =>
                          updateFund(fund.id, { target: num(e.target.value) || null })
                        }
                        className={smallInputClass}
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      $ / check
                      <input
                        type="number"
                        min="0"
                        aria-label={`${fund.name} per-check contribution`}
                        value={fund.perCheck}
                        onChange={(e) => updateFund(fund.id, { perCheck: num(e.target.value) })}
                        className={smallInputClass}
                      />
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section className="rounded-apple border border-border-default">
            <div className="border-b border-border-default px-6 py-4">
              <h2 className="text-[16px] font-medium text-ink-heading">Paycheck Profile</h2>
            </div>
            <div className="space-y-4 p-6">
              <ProfileRow
                label="Hourly rate ($)"
                value={profile.hourlyRate}
                onChange={(v) => setProfile({ ...profile, hourlyRate: v })}
              />
              <ProfileRow
                label="Typical hours / check"
                value={profile.typicalHours}
                onChange={(v) => setProfile({ ...profile, typicalHours: v })}
              />
              <ProfileRow
                label="Checks / month"
                value={profile.checksPerMonth}
                onChange={(v) => setProfile({ ...profile, checksPerMonth: v })}
              />
              <ProfileRow
                label="HYSA APY (%)"
                value={profile.hysaApy}
                onChange={(v) => setProfile({ ...profile, hysaApy: v })}
              />
              <ProfileRow
                label="HYSA interest to date ($)"
                value={profile.hysaInterestToDate}
                onChange={(v) => setProfile({ ...profile, hysaInterestToDate: v })}
              />
              <p className="text-[12px] font-light text-pretty text-ink-caption">
                When hours are entered, gross = rate × hours exactly. When they're not, gross is
                estimated from her usual withholding rate (learned from checks that did include
                hours{withholding !== null ? ` — currently ${Math.round(withholding * 100)}%` : ''});
                until one exists it assumes {profile.typicalHours} hrs (
                {currency(grossForCheck(profile, null))}). The Roth IRA envelope uses gross so her
                "10% pre-tax" math works even though she funds it from take-home.
              </p>
            </div>
          </section>

          <section className="rounded-apple border border-border-default">
            <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
              <h2 className="text-[16px] font-medium text-ink-heading">Recent Paychecks</h2>
              <span className="text-[11px] font-light text-ink-caption">Saved on this device</span>
            </div>
            {paychecks.length === 0 ? (
              <p className="px-6 py-8 text-center text-[14px] text-pretty text-ink-caption">
                No paychecks yet — add the first one above. Removing one reverses its allocations.
              </p>
            ) : (
              <ul>
                {paychecks.map((check, i) => (
                  <li
                    key={check.id}
                    className={`flex items-center justify-between gap-4 px-6 py-3 hover:bg-surface-tint ${
                      i > 0 ? 'border-t border-border-default' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-[15px] tabular-nums text-ink-heading">
                        {currency(check.net)}
                        {check.hours !== null && (
                          <span className="text-[12px] font-light text-ink-caption">
                            {' '}
                            · {check.hours} hrs
                          </span>
                        )}
                      </p>
                      <p className="truncate text-[12px] font-light tabular-nums text-ink-caption">
                        {check.date} · {currency(check.leftover)} kept
                      </p>
                    </div>
                    {removingId === check.id ? (
                      <span className="flex shrink-0 items-center gap-4">
                        <button
                          type="button"
                          onClick={() => removePaycheck(check)}
                          className="text-[14px] font-medium text-accent"
                        >
                          Confirm remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemovingId(null)}
                          className="text-[14px] text-ink-caption"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRemovingId(check.id)}
                        className="shrink-0 text-[14px] text-ink-rose hover:text-accent"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-apple border border-border-default bg-surface-base p-5">
      <p className="text-[14px] text-ink-caption">{label}</p>
      <p className="mt-2 text-[27px] font-medium tabular-nums text-ink-body">{value}</p>
      <p className="mt-1 text-[12px] font-light text-ink-caption">{note}</p>
    </div>
  )
}

function PreviewCard({
  label,
  amount,
  highlight = false,
}: {
  label: string
  amount: number
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-apple border p-4 ${
        highlight ? 'border-pink bg-surface-base' : 'border-border-default bg-surface-base'
      }`}
    >
      <p className="text-[12px] font-light text-ink-caption">{label}</p>
      <p className="mt-1 text-[21px] font-medium tabular-nums text-ink-heading">
        {currency(amount)}
      </p>
    </div>
  )
}

function ProfileRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-[15px]">{label}</span>
      <input
        type="number"
        min="0"
        step="any"
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value) || 0)}
        className={smallInputClass}
      />
    </label>
  )
}

export default App
