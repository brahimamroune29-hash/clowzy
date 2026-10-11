-- Shared lookups (owner decision 2026-10-11), 30 days, for every member; rows older than that are deleted as new ones are written:
--  · provider_misses: a person or company the provider found nothing for, at that company domain, is not paid for again. Keys are
--    hashes (icypeas.ts missKey): no name, email or domain in clear.
--  · site_reads: what a company's website publishes (or none), not read again. Delivery still refuses suppressed addresses.
-- Private like the catalog: the server's role only, read-only for the backup role. Safe before or after the code ships.
create table if not exists clowzy.provider_misses (key text primary key, checked_at bigint not null);
create index if not exists provider_misses_age on clowzy.provider_misses(checked_at);
create table if not exists clowzy.site_reads (site text primary key, emails jsonb not null, read_at bigint not null);
create index if not exists site_reads_age on clowzy.site_reads(read_at);
do $$ declare tab text; begin
  foreach tab in array array['provider_misses','site_reads'] loop
    execute format('alter table clowzy.%I enable row level security',tab);
    execute format('revoke all on clowzy.%I from public',tab);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on clowzy.%I from anon',tab); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on clowzy.%I from authenticated',tab); end if;
    if exists(select 1 from pg_roles where rolname='clowzy_app') then
      execute format('grant select,insert,update,delete on clowzy.%I to clowzy_app',tab);
      if not exists(select 1 from pg_policies where schemaname='clowzy' and tablename=tab and policyname='server_only') then
        execute format('create policy server_only on clowzy.%I to clowzy_app using(true) with check(true)',tab);
      end if;
    end if;
    if exists(select 1 from pg_roles where rolname='clowzy_backup') then
      execute format('grant select on clowzy.%I to clowzy_backup',tab);
      if not exists(select 1 from pg_policies where schemaname='clowzy' and tablename=tab and policyname='backup_readonly') then
        execute format('create policy backup_readonly on clowzy.%I for select to clowzy_backup using(true)',tab);
      end if;
    end if;
  end loop;
end $$;
-- A suppressed address also leaves the shared website cache (the rest as in 20261002175425_launch_hardening.sql).
create or replace function clowzy.suppress_contact(actor text,address text) returns void
language plpgsql security definer set search_path=clowzy,pg_temp as $$
declare identities jsonb;
begin
  if not exists(select 1 from clowzy.users where id=actor and role='admin' and active=1) then raise exception 'Owner required'; end if;
  lock table clowzy.catalog_suppressions in share row exclusive mode;
  address := lower(trim(address));
  select coalesce(jsonb_agg(jsonb_build_object('name',lower(trim(name)),'company',lower(trim(company)))),'[]') into identities
    from (select name,company from clowzy.contacts where email=address
          union select payload->>'name',payload->>'company' from clowzy.lead_catalog where email=address) known;
  insert into clowzy.catalog_suppressions(email,created_at) values(address,to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) on conflict do nothing;
  with source as (
    select 'run' kind,search_id id,'' uid,people payload from clowzy.provider_runs where people<>'[]'
    union all select 'cursor',query_key,user_id,leftovers from clowzy.provider_cursors where leftovers<>'[]'
  ), cleaned as (
    select kind,id,uid,jsonb_agg(case when lower(coalesce(p->>'email',''))=address or exists(
      select 1 from jsonb_array_elements(identities) i
      where i->>'name'<>'' and i->>'company'<>''
        and i->>'name'=lower(trim(coalesce(nullif(trim(concat_ws(' ',p->>'firstname',p->>'lastname')),''),p->>'lastCompanyName','')))
        and i->>'company'=lower(trim(coalesce(p->>'lastCompanyName','')))
    ) then '{"suppressed":true}'::jsonb else p end order by ordinal)::text payload
    from source cross join lateral jsonb_array_elements(payload::jsonb) with ordinality as item(p,ordinal)
    group by kind,id,uid
  ), cleaned_runs as (
    update clowzy.provider_runs r set people=c.payload from cleaned c where c.kind='run' and r.search_id=c.id
  ) update clowzy.provider_cursors r set leftovers=c.payload from cleaned c where c.kind='cursor' and r.query_key=c.id and r.user_id=c.uid;
  update clowzy.site_reads set emails=emails-address where emails @> jsonb_build_array(address); -- the shared website cache too
  delete from clowzy.lead_catalog where email=address;
  delete from clowzy.contacts where email=address;
end $$;
revoke all on function clowzy.suppress_contact(text,text) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='clowzy_app') then grant execute on function clowzy.suppress_contact(text,text) to clowzy_app; end if;
end $$;
