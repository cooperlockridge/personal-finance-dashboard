import { useState } from 'react'
import {
  DEFAULT_PROFILE,
  DEFAULT_RULES,
  allocate,
  currency,
  grossPerWeek,
  usePersistentState,
  type Paycheck,
  type Rule,
} from './lib/finance'

const inputClass =
  'rounded-apple border border-border-default bg-surface-base px-4 py-2 text-[15px] text-ink-body tabular-nums'

function App() {
  const [profile, setProfile] = usePersistentState('pfd:profile', DEFAULT_PROFILE)
  const [rules, setRules] = usePersistentState<Rule[]>('pfd:rules', DEFAULT_RULES)
  const [paychecks, setPaychecks] = usePersistentState<Paycheck[]>('pfd:paychecks', [])
  const [amountInput, setAmountInput] = useState('')
  const [dateInput, setDateInput] = useState(() => new Date().toISOString().slice(0, 10))
  const [formError, setFormError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

  const gross = grossPerWeek(profile)
  const totalPercent = rules.reduce((sum, r) => sum + r.percent, 0)
  const latest = paychecks[0]

  const now = new Date()
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthChecks = paychecks.filter((p) => p.date.startsWith(monthKey))
  const monthNet = monthChecks.reduce((sum, p) => sum + p.net, 0)

  const savingsPercent = rules
    .filter((r) => /sav/i.test(r.name))
    .reduce((sum, r) => sum + r.percent, 0)

  const typedNet = Number.parseFloat(amountInput)
  const previewNet = Number.isFinite(typedNet) && typedNet > 0 ? typedNet : latest?.net
  const preview = previewNet !== undefined ? allocate(previewNet, rules) : []

  const taxRate =
    latest && latest.net <= gross ? Math.round((1 - latest.net / gross) * 100) : null

  function addPaycheck() {
    const net = Number.parseFloat(amountInput)
    if (!Number.isFinite(net) || net <= 0) {
      setFormError('Enter the take-home amount from her deposit.')
      return
    }
    setFormError('')
    setPaychecks([{ id: crypto.randomUUID(), date: dateInput, net }, ...paychecks])
    setAmountInput('')
  }

  function updateRule(id: string, patch: Partial<Rule>) {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <div className="min-h-dvh bg-surface-base text-ink-body">
      <header className="border-b border-border-default">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-3">
          <span className="text-[16px] font-medium text-ink-heading">Finance</span>
          <span className="text-[12px] font-light text-ink-rose">
            ${profile.hourlyRate}/hr · {profile.typicalHours} hrs/week
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
            label={`Income (${monthLabel.slice(0, 3)})`}
            value={currency(monthNet)}
            note={`${monthChecks.length} paycheck${monthChecks.length === 1 ? '' : 's'} entered`}
          />
          <SummaryCard
            label="Gross / Week"
            value={currency(gross)}
            note={`$${profile.hourlyRate}/hr × ${profile.typicalHours} hrs`}
          />
          <SummaryCard
            label="Effective Tax Rate"
            value={taxRate === null ? '—' : `${taxRate}%`}
            note="Latest paycheck vs gross"
          />
          <SummaryCard
            label={`Savings (${monthLabel.slice(0, 3)})`}
            value={savingsPercent > 0 ? currency((monthNet * savingsPercent) / 100) : '—'}
            note="At current allocation"
          />
        </section>

        <section className="rounded-apple border border-border-default bg-surface-tint p-6">
          <h2 className="text-[16px] font-medium text-ink-heading">This Week's Paycheck</h2>
          <p className="mt-1 text-[12px] font-light text-pretty text-ink-caption">
            Enter the post-tax amount that hit her account — the split below updates as you type.
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
              className={`${inputClass} w-48`}
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
          {Number.isFinite(typedNet) && typedNet > gross && (
            <p className="mt-2 text-[12px] text-ink-rose">
              Heads up: that's more than her usual gross ({currency(gross)}) — double-check the
              amount or update her hours below.
            </p>
          )}

          {preview.length > 0 && previewNet !== undefined && (
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {preview.map((slice) => (
                <div
                  key={slice.id}
                  className="rounded-apple border border-border-default bg-surface-base p-4"
                >
                  <p className="text-[12px] font-light text-ink-caption">
                    {slice.name} · {slice.percent}%
                  </p>
                  <p className="mt-1 text-[27px] font-medium tabular-nums text-ink-heading">
                    {currency(slice.amount)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section className="rounded-apple border border-border-default">
            <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
              <h2 className="text-[16px] font-medium text-ink-heading">Allocation Envelopes</h2>
              <span
                className={`text-[12px] tabular-nums ${
                  totalPercent === 100 ? 'font-light text-ink-caption' : 'font-medium text-accent'
                }`}
              >
                Total {totalPercent}%
              </span>
            </div>
            <div className="space-y-4 p-6">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-4">
                  <input
                    type="text"
                    aria-label="Envelope name"
                    value={rule.name}
                    onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                    className={`${inputClass} min-w-0 flex-1`}
                  />
                  <input
                    type="number"
                    aria-label={`${rule.name} percent`}
                    min="0"
                    max="100"
                    value={rule.percent}
                    onChange={(e) =>
                      updateRule(rule.id, { percent: Number.parseFloat(e.target.value) || 0 })
                    }
                    className={`${inputClass} w-20`}
                  />
                  <button
                    type="button"
                    onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
                    className="text-[14px] text-ink-rose hover:text-accent"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {totalPercent !== 100 && (
                <p className="text-[12px] text-accent">
                  Envelopes should add up to 100% so every dollar has a home.
                </p>
              )}
              <button
                type="button"
                onClick={() =>
                  setRules([...rules, { id: crypto.randomUUID(), name: 'New Envelope', percent: 0 }])
                }
                className="text-[14px] font-medium text-accent hover:text-accent-hover"
              >
                + Add envelope
              </button>
            </div>
          </section>

          <section className="rounded-apple border border-border-default">
            <div className="border-b border-border-default px-6 py-4">
              <h2 className="text-[16px] font-medium text-ink-heading">Paycheck Profile</h2>
            </div>
            <div className="space-y-4 p-6">
              <label className="flex items-center justify-between gap-4">
                <span className="text-[15px]">Hourly rate ($)</span>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  value={profile.hourlyRate}
                  onChange={(e) =>
                    setProfile({ ...profile, hourlyRate: Number.parseFloat(e.target.value) || 0 })
                  }
                  className={`${inputClass} w-24`}
                />
              </label>
              <label className="flex items-center justify-between gap-4">
                <span className="text-[15px]">Typical hours / week</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={profile.typicalHours}
                  onChange={(e) =>
                    setProfile({ ...profile, typicalHours: Number.parseFloat(e.target.value) || 0 })
                  }
                  className={`${inputClass} w-24`}
                />
              </label>
              <p className="text-[12px] font-light text-pretty text-ink-caption">
                Anything withheld before her deposit (taxes, and any future 401k or insurance) is
                covered by the gap between gross ({currency(gross)}) and what she enters — the
                envelopes only ever split take-home dollars.
              </p>
            </div>
          </section>
        </div>

        <section className="rounded-apple border border-border-default">
          <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
            <h2 className="text-[16px] font-medium text-ink-heading">Recent Paychecks</h2>
            <span className="text-[11px] font-light text-ink-caption">
              Saved on this device
            </span>
          </div>
          {paychecks.length === 0 ? (
            <p className="px-6 py-8 text-center text-[14px] text-pretty text-ink-caption">
              No paychecks yet — add the first one above.
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
                    </p>
                    <p className="truncate text-[12px] font-light tabular-nums text-ink-caption">
                      {check.date} ·{' '}
                      {allocate(check.net, rules)
                        .map((s) => `${s.name} ${currency(s.amount)}`)
                        .join(' · ')}
                    </p>
                  </div>
                  {removingId === check.id ? (
                    <span className="flex shrink-0 items-center gap-4">
                      <button
                        type="button"
                        onClick={() => {
                          setPaychecks(paychecks.filter((p) => p.id !== check.id))
                          setRemovingId(null)
                        }}
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

export default App
