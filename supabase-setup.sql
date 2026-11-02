create table if not exists public.turnaround_reports (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.turnaround_equipment_actuals (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.turnaround_equipment_overrides (
  work_package text not null,
  equipment_tag text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (work_package, equipment_tag)
);

create table if not exists public.turnaround_activity_statuses (
  activity_key text primary key,
  status text not null check (status in ('not-started', 'ongoing', 'done')),
  updated_at timestamptz not null default now()
);

create table if not exists public.turnaround_team_members (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

alter table public.turnaround_team_members enable row level security;
drop policy if exists "Team members can read their own membership" on public.turnaround_team_members;
create policy "Team members can read their own membership"
on public.turnaround_team_members for select to authenticated
using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
grant select on public.turnaround_team_members to authenticated;

create or replace function public.is_turnaround_team_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.turnaround_team_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_turnaround_team_member() from public;
grant execute on function public.is_turnaround_team_member() to authenticated;

alter table public.turnaround_reports enable row level security;
alter table public.turnaround_equipment_actuals enable row level security;
alter table public.turnaround_equipment_overrides enable row level security;
alter table public.turnaround_activity_statuses enable row level security;

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'turnaround_reports',
    'turnaround_equipment_actuals',
    'turnaround_equipment_overrides',
    'turnaround_activity_statuses'
  ]
  loop
    for policy_name in
      select policyname
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
    loop
      execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    end loop;
  end loop;
end
$$;

create policy "Anyone with the shared link can manage turnaround reports"
on public.turnaround_reports for all to anon, authenticated
using (true)
with check (true);

create policy "Anyone with the shared link can manage equipment actuals"
on public.turnaround_equipment_actuals for all to anon, authenticated
using (true)
with check (true);

create policy "Anyone with the shared link can manage equipment overrides"
on public.turnaround_equipment_overrides for all to anon, authenticated
using (true)
with check (true);

create policy "Anyone with the shared link can manage activity statuses"
on public.turnaround_activity_statuses for all to anon, authenticated
using (true)
with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.turnaround_reports to anon, authenticated;
grant select, insert, update, delete on public.turnaround_equipment_actuals to anon, authenticated;
grant select, insert, update, delete on public.turnaround_equipment_overrides to anon, authenticated;
grant select, insert, update, delete on public.turnaround_activity_statuses to anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'turnaround_reports',
    'turnaround_equipment_actuals',
    'turnaround_equipment_overrides',
    'turnaround_activity_statuses'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;
