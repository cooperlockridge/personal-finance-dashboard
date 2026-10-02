-- Change requests for the shared budget (2026-10-02).
--
-- Laken types what she wants changed into the app. /api/requests stores it
-- here, and once a day the watchdog on Cooper's Mac claims each 'new' row,
-- works it, and writes the outcome back. Same access rule as the budget
-- tables: RLS on with no policies, so only the secret key behind /api can read
-- or write.

create table public.budget_requests (
  id bigint generated always as identity primary key,
  budget_id text not null references public.budgets (id) on delete cascade,
  clerk_user_id text not null,
  -- The member's label when the request was made, so the list can say who
  -- asked without a join.
  author_label text not null,
  body text not null check (char_length(body) between 1 and 2000),
  -- new → in_progress → done | blocked | needs_answer. An answer puts a
  -- needs_answer row back to new. 'undone' is a done data change she took back.
  status text not null default 'new'
    check (status in ('new', 'in_progress', 'needs_answer', 'done', 'blocked', 'undone')),
  -- 'data' changed numbers in budgets.data; 'code' changed the app itself.
  -- Null until the watchdog decides.
  lane text check (lane in ('data', 'code')),
  question text,
  answer text check (answer is null or char_length(answer) <= 2000),
  -- One or two plain sentences she reads in the app.
  summary text,
  changes jsonb,              -- [{ "label": text, "before": text|null, "after": text|null }]
  -- The budget as it was just before a data change. Undo restores it.
  snapshot_id bigint references public.budget_snapshots (id) on delete set null,
  applied_version bigint,     -- budgets.version right after the data patch landed
  commit_sha text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index budget_requests_budget_id_created_at_idx
  on public.budget_requests (budget_id, created_at desc);
create index budget_requests_status_idx
  on public.budget_requests (status, created_at);

alter table public.budget_requests enable row level security;

revoke all on public.budget_requests from anon, authenticated;
revoke all on sequence public.budget_requests_id_seq from anon, authenticated;

-- Two more reasons a snapshot gets kept: 'watchdog' is the budget just before
-- the watchdog patched it, 'undo' is the budget just before an undo put that
-- copy back. budget_snapshots_reason_check is the name Postgres gave the
-- inline check in the first migration.
alter table public.budget_snapshots
  drop constraint budget_snapshots_reason_check;
alter table public.budget_snapshots
  add constraint budget_snapshots_reason_check
  check (reason in ('device-import', 'conflict', 'watchdog', 'undo'));
