# Personal Finance Dashboard

A weekly paycheck allocator: enter the post-tax deposit and see exactly where every dollar goes.

The core idea — all budgeting rules run on **take-home dollars only**. Anything pre-tax
(taxes today; 401k or insurance later) is represented by the gap between gross pay
(hourly rate × typical hours, set once in the Paycheck Profile) and the entered net,
so pre-tax and post-tax math never get mixed.

## Tech Stack

- [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) for dev server and builds
- [Tailwind CSS](https://tailwindcss.com/) for styling

## Getting Started

```bash
npm install
npm run dev
```

Then open the printed localhost URL in your browser.

## Scripts

| Command           | Description              |
| ----------------- | ------------------------ |
| `npm run dev`     | Start the dev server     |
| `npm run build`   | Type-check and build     |
| `npm run preview` | Preview the built app    |

## Supabase keepalive

Vercel Cron calls `/api/keepalive` once daily at noon UTC. On Hobby, execution
can occur anywhere within that hour. Production must have `CRON_SECRET`,
`SUPABASE_URL`, and `SUPABASE_SECRET_KEY`; Vercel supplies the existing cron
secret in the Authorization header. Missing or incorrect authorization fails
closed before any database request.

An authorized invocation performs three sequential reads of at most one budget
ID each. It never changes budget data or returns IDs. Any failed read makes the
invocation fail. Server logs report `keepalive completed` with the read count,
or `keepalive failed` with the upstream status.

Supabase evaluates low activity over the previous week; a single daily read
can still trigger a warning. Its [project pausing guidance](https://supabase.com/docs/guides/platform/free-project-pausing)
says a few database requests each day are typically sufficient. This keepalive
reduces risk; a paid plan is the guarantee against inactivity pausing. After
deploying a change, check the next daily cron's status and Supabase request logs.

## Features

- Weekly post-tax paycheck entry with a live allocation split
- Editable percentage envelopes (defaults: Rent & Bills 50 / Savings 20 / Spending 30)
- Paycheck profile (hourly rate, typical hours) with derived gross and effective tax rate
- Sinking funds with a start date and a deadline day; each check auto-funds what the date needs
- Random savings: roll a whole-dollar amount in your range (or type one) and log it as extra savings
- Paychecks persist in `localStorage` on the device

## Roadmap

- [ ] Spending charts
- [ ] Savings goals
- [ ] Account balances
- [ ] Shared sync (so it works across her phone and laptop)
