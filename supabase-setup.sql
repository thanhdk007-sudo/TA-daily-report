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

drop policy if exists "Authenticated team can manage turnaround reports" on public.turnaround_reports;
create policy "Authenticated team can manage turnaround reports"
on public.turnaround_reports for all to authenticated
using ((select public.is_turnaround_team_member()))
with check ((select public.is_turnaround_team_member()));

drop policy if exists "Authenticated team can manage equipment actuals" on public.turnaround_equipment_actuals;
create policy "Authenticated team can manage equipment actuals"
on public.turnaround_equipment_actuals for all to authenticated
using ((select public.is_turnaround_team_member()))
with check ((select public.is_turnaround_team_member()));

drop policy if exists "Authenticated team can manage equipment overrides" on public.turnaround_equipment_overrides;
create policy "Authenticated team can manage equipment overrides"
on public.turnaround_equipment_overrides for all to authenticated
using ((select public.is_turnaround_team_member()))
with check ((select public.is_turnaround_team_member()));

drop policy if exists "Authenticated team can manage activity statuses" on public.turnaround_activity_statuses;
create policy "Authenticated team can manage activity statuses"
on public.turnaround_activity_statuses for all to authenticated
using ((select public.is_turnaround_team_member()))
with check ((select public.is_turnaround_team_member()));

-- Add each team email here in lowercase before inviting the user in Supabase Auth:
-- insert into public.turnaround_team_members (email) values ('member@company.com') on conflict do nothing;

grant select, insert, update, delete on public.turnaround_reports to authenticated;
grant select, insert, update, delete on public.turnaround_equipment_actuals to authenticated;
grant select, insert, update, delete on public.turnaround_equipment_overrides to authenticated;
grant select, insert, update, delete on public.turnaround_activity_statuses to authenticated;

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
