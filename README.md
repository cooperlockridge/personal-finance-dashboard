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

## Features

- Weekly post-tax paycheck entry with a live allocation split
- Editable percentage envelopes (defaults: Rent & Bills 50 / Savings 20 / Spending 30)
- Paycheck profile (hourly rate, typical hours) with derived gross and effective tax rate
- Paychecks persist in `localStorage` on the device

## Roadmap

- [ ] Spending charts
- [ ] Savings goals
- [ ] Account balances
- [ ] Shared sync (so it works across her phone and laptop)
