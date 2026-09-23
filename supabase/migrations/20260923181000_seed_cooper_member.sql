-- Cooper joins the shared Lockridge budget (2026-09-23).
insert into public.budget_members (budget_id, clerk_user_id, label)
values ('lockridge', 'user_3HWmHWSzmzkTSFrU72WLSgm0jXl', 'Cooper')
on conflict (clerk_user_id) do nothing;
