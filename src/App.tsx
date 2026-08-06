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
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold">Finance Dashboard</h1>
          <span className="text-sm text-slate-500">August 2026</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summary.map((card) => (
            <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-500">{card.label}</p>
              <p className="mt-1 text-2xl font-semibold">{card.value}</p>
              <p className="mt-1 text-xs text-slate-400">{card.note}</p>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="font-medium">Recent Transactions</h2>
            <span className="text-xs text-slate-400">Sample data</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {sampleTransactions.map((tx) => (
              <li key={tx.date + tx.name} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium">{tx.name}</p>
                  <p className="text-xs text-slate-400">
                    {tx.date} · {tx.category}
                  </p>
                </div>
                <span
                  className={`text-sm font-medium ${
                    tx.amount.startsWith('+') ? 'text-emerald-600' : 'text-slate-700'
                  }`}
                >
                  {tx.amount}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          Budgets, charts, and account syncing coming soon
        </section>
      </main>
    </div>
  )
}

export default App
