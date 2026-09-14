-- Shared budget storage for Laken's Finance.
--
-- The browser never reaches Postgres directly. /api/budget verifies the Clerk
-- session token against Clerk's public keys, looks the user up in
-- budget_members, and talks to PostgREST with the project's secret key. So RLS
-- is on with no policies at all: anon and authenticated get nothing, and only
-- the secret key (which bypasses RLS) can read or write.

create table public.budgets (
  id text primary key,
  -- The whole app state ({ profile, envelopes, funds, paychecks, extras,
  -- rollRange }) as one document. Null until the first device syncs.
  data jsonb,
  -- Bumps on every save. A save must name the version it was based on, so a
  -- device holding stale numbers is rejected instead of overwriting.
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  -- Clerk user id of the last writer.
  updated_by text
);

create table public.budget_members (
  budget_id text not null references public.budgets (id) on delete cascade,
  -- One budget per login.
  clerk_user_id text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  primary key (budget_id, clerk_user_id)
);

-- Nothing a device held is ever thrown away. 'device-import' keeps a device's
-- local copy from before it first synced; 'conflict' keeps an edit that lost a
-- version race.
create table public.budget_snapshots (
  id bigint generated always as identity primary key,
  budget_id text not null references public.budgets (id) on delete cascade,
  clerk_user_id text not null,
  reason text not null check (reason in ('device-import', 'conflict')),
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index budget_snapshots_budget_id_created_at_idx
  on public.budget_snapshots (budget_id, created_at desc);

alter table public.budgets enable row level security;
alter table public.budget_members enable row level security;
alter table public.budget_snapshots enable row level security;

revoke all on public.budgets, public.budget_members, public.budget_snapshots
  from anon, authenticated;
revoke all on sequence public.budget_snapshots_id_seq from anon, authenticated;

-- Laken and Cooper share this one. Members are seeded in a later migration
-- once their Clerk user ids are known.
insert into public.budgets (id) values ('lockridge');
