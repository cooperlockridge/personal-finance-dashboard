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

## Staying signed in

Clerk runs as a development instance here, and its session lasts a week at
most. After one Clerk sign-in, `/api/device` sets a year-long `HttpOnly`
cookie that `/api/budget` accepts in place of a Clerk token, so a device that
has signed in once stays signed in. The cookie renews itself once it is 30
days old, and the header's **Sign out** clears it.

Production and Preview need `DEVICE_SESSION_SECRET` (32+ characters). Without
it no cookie is issued and sign-in behaves as it did before. Changing the
secret signs every device out; removing a row from `budget_members` locks that
login out on its next request.

## Use it from Claude (MCP connector)

`/api/mcp` is a remote MCP server, so the whole dashboard works from a Claude
chat: log a paycheck, check fund progress, move money, change settings.

**Connect (once per Claude account):** in Claude, open Settings → Connectors →
Add custom connector, name it `Laken's Finance`, and paste

```
https://personal-finance-dashboard-ashen.vercel.app/api/mcp
```

Claude opens the app's **Connect to Claude** screen. Sign in if asked, tap
**Allow**, and the connector is ready on web, desktop and phone. Turn it on in a
chat from the tools menu, then ask things like "I got paid $1,043.18 for 52
hours today" or "how's the Christmas fund doing?".

How it works:

- OAuth 2.1 with PKCE and dynamic client registration, all stateless: client
  ids, codes and tokens are HMAC-signed with a key derived from
  `DEVICE_SESSION_SECRET` (`api/_lib/oauth.ts`). Codes only go back to
  claude.ai, claude.com or loopback. Access tokens last a day and refresh for
  180 days.
- Approval happens in the app itself (`/?connect=…`, `src/ConnectClaude.tsx`),
  so a remembered device needs no sign-in, and only a `budget_members` login
  can approve.
- Every tool reads and writes through the same `handleBudget` and
  `handleRequests` the app uses (`api/_lib/budgetStore.ts`), so membership,
  the shape check and the version-guarded save are shared. A save that loses a
  race is redone on the fresh copy. The math is `src/lib/finance.ts`.
- Removing a row from `budget_members` cuts that login's connector off on its
  next call. Changing `DEVICE_SESSION_SECRET` disconnects every connector (and
  signs out every device).

Tools (`api/_lib/mcpTools.ts`, 36 in all): `get_overview`, `get_budget`, `get_settings`,
`list_envelopes`, `list_funds`, `get_savings_breakdown`, `list_paychecks`,
`get_paycheck`, `preview_paycheck`, `get_month_summary`, `compare_months`,
`list_random_savings`, `roll_random_amount`, `plan_fund`, `add_paycheck`,
`remove_paycheck`, `edit_paycheck`, `update_settings`, `set_roll_range`,
`add_envelope`, `update_envelope`, `adjust_envelope`, `move_money`,
`remove_envelope`, `add_fund`, `update_fund`, `adjust_fund`, `remove_fund`,
`add_random_saving`, `remove_random_saving`, `list_requests`,
`submit_request`, `answer_request`, `undo_request`.

For everything else there is a catch-all: `get_budget_schema` explains every
field of the budget document, and `patch_budget` edits it directly with JSON
Patch operations against the version Claude read (`dryRun` previews the
change). A patch is refused if the budget has moved on since that version, or
if the result would break the app: `api/_lib/budgetSchema.ts` checks types,
fields and duplicate ids, and only problems the patch itself adds count, so an
old record never blocks an edit.

To try it locally with the MCP Inspector (`npx @modelcontextprotocol/inspector`),
point it at a deployed URL; `vite dev` does not serve `/api`.

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
