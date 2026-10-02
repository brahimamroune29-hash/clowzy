-- Shared provider pacing across serverless instances. No provider secrets or contact data live here.
create table clowzy.provider_slots(kind text primary key check(kind in ('read','bulk')),available_at bigint not null);
alter table clowzy.provider_slots enable row level security;
revoke all on clowzy.provider_slots from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on clowzy.provider_slots from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on clowzy.provider_slots from authenticated; end if;
  if exists(select 1 from pg_roles where rolname='clowzy_app') then
    grant select,insert,update on clowzy.provider_slots to clowzy_app;
    create policy server_only on clowzy.provider_slots to clowzy_app using(true) with check(true);
  end if;
end $$;

-- Deduplication needs a stable identifier, not the raw profile URL/name.
update clowzy.provider_seen set person_key=encode(sha256(convert_to(person_key,'UTF8')),'hex') where person_key !~ '^[a-f0-9]{64}$';

-- Terminal searches keep delivery/financial evidence, but no longer need the raw supplier batch.
create function clowzy.clear_finished_batch() returns trigger language plpgsql security definer set search_path=clowzy,pg_temp as $$
begin
  if new.status not in ('queued','awaiting_provider') then
    update clowzy.provider_runs set people='[]' where search_id=new.id;
  end if;
  return new;
end $$;
revoke all on function clowzy.clear_finished_batch() from public;
create trigger clear_finished_batch after update of status on clowzy.searches for each row execute function clowzy.clear_finished_batch();
update clowzy.provider_runs set people='[]' where search_id in(select id from clowzy.searches where status not in ('queued','awaiting_provider'));

-- Preserve positions in in-flight batches: externalId is an array index. A tombstone is skipped by the application.
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
  delete from clowzy.lead_catalog where email=address;
  delete from clowzy.contacts where email=address;
end $$;
revoke all on function clowzy.suppress_contact(text,text) from public;

-- The dedicated backup reader must see every row under RLS, without BYPASSRLS or write privileges.
do $$ declare tab text; begin
  if exists(select 1 from pg_roles where rolname='clowzy_backup') then
    grant usage on schema clowzy to clowzy_backup;
    grant select on all sequences in schema clowzy to clowzy_backup;
    for tab in select tablename from pg_tables where schemaname='clowzy' loop
      execute format('grant select on clowzy.%I to clowzy_backup',tab);
      if not exists(select 1 from pg_policies where schemaname='clowzy' and tablename=tab and policyname='backup_readonly') then
        execute format('create policy backup_readonly on clowzy.%I for select to clowzy_backup using(true)',tab);
      end if;
    end loop;
  end if;
end $$;
