const summary = [
  { label: 'Total Balance', value: '$0.00', note: 'Across all accounts' },
  { label: 'Income (Aug)', value: '$0.00', note: 'This month' },
  { label: 'Spending (Aug)', value: '$0.00', note: 'This month' },
  { label: 'Savings Rate', value: '—', note: 'Income minus spending' },
]

const sampleTransactions = [
  { date: 'Aug 4', name: 'Grocery Store', category: 'Groceries', amount: '-$52.30' },
  { date: 'Aug 3', name: 'Coffee Shop', category: 'Dining', amount: '-$6.75' },
  { date: 'Aug 1', name: 'Paycheck', category: 'Income', amount: '+$1,850.00' },
]

function App() {
  return (
    <div className="min-h-dvh bg-surface-base text-ink-body">
      <header className="border-b border-border-default">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-3">
          <span className="text-[16px] font-medium text-ink-heading">Finance</span>
          <button
            type="button"
            className="rounded-apple bg-accent px-5 py-2 text-[14px] font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add Transaction
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-8 py-12">
        <div>
          <h1 className="text-[51px] font-bold text-balance text-ink-heading">Dashboard</h1>
          <p className="text-[16px] text-pretty text-ink-caption">August 2026</p>
        </div>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summary.map((card) => (
            <div
              key={card.label}
              className="rounded-apple border border-border-default bg-surface-base p-5"
            >
              <p className="text-[14px] text-ink-caption">{card.label}</p>
              <p className="mt-2 text-[27px] font-medium tabular-nums text-ink-body">
                {card.value}
              </p>
              <p className="mt-1 text-[12px] font-light text-ink-caption">{card.note}</p>
            </div>
          ))}
        </section>

        <section className="rounded-apple border border-border-default">
          <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
            <h2 className="text-[16px] font-medium text-ink-heading">Recent Transactions</h2>
            <span className="text-[11px] font-light text-ink-caption">Sample data</span>
          </div>
          <ul>
            {sampleTransactions.map((tx, i) => (
              <li
                key={tx.date + tx.name}
                className={`group flex items-center justify-between px-6 py-3 hover:bg-surface-raised ${
                  i > 0 ? 'border-t border-border-default' : ''
                }`}
              >
                <div>
                  <p className="text-[15px] text-ink-body group-hover:text-white">{tx.name}</p>
                  <p className="text-[12px] font-light text-ink-caption group-hover:text-ink-tertiary">
                    {tx.date} · {tx.category}
                  </p>
                </div>
                <span
                  className={`text-[15px] tabular-nums group-hover:text-white ${
                    tx.amount.startsWith('+') ? 'font-medium text-accent' : 'text-ink-body'
                  }`}
                >
                  {tx.amount}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-apple border border-dashed border-border-default p-8 text-center">
          <p className="text-[14px] text-pretty text-ink-caption">
            Budgets, charts, and account syncing coming soon
          </p>
        </section>
      </main>
    </div>
  )
}

export default App
