-- Laken joins the shared Lockridge budget (2026-09-23). Her Clerk user id came
-- from the not-a-member banner. Cooper is added in a later migration once his
-- id is known.
insert into public.budget_members (budget_id, clerk_user_id, label)
values ('lockridge', 'user_3HYWqfbhfJZ0HYQBwtHT5cdfcpy', 'Laken')
on conflict (clerk_user_id) do nothing;
