-- clowzy platform schema (Postgres / Supabase). Applied once per database, by the database owner.
-- The app connects as its own role (see README: clowzy_app) with row access to this schema only.
-- Names are schema-qualified so applying it never depends on the session's search_path.
-- Timestamps are ISO-8601 UTC text (lexicographic order = time order); provider timers are epoch ms (bigint).
create schema if not exists clowzy;

create table clowzy.users (
  id text primary key, name text not null, email text unique not null, password_hash text not null,
  role text not null check (role in ('admin', 'member')), active integer not null default 1,
  balance integer not null default 0 check (balance >= 0), created_at text not null, terms_accepted_at text,
  recovery_hash text -- the owner's recovery code, hashed (store.ts createRecoveryCode)
);
create table clowzy.sessions (
  token_hash text primary key, user_id text not null references clowzy.users(id), expires_at text not null
);
create table clowzy.invitations (
  id text primary key, token_hash text unique not null, name text not null, email text not null,
  credits integer not null, expires_at text not null, used_at text, created_at text not null
);
create table clowzy.searches (
  id text primary key, user_id text not null references clowzy.users(id), request_id text not null,
  filters text not null, title text not null, requested integer not null, delivered integer not null default 0,
  duplicates integer not null default 0, status text not null, created_at text not null,
  unique (user_id, request_id)
);
create table clowzy.contacts (
  id text primary key, user_id text not null references clowzy.users(id), search_id text not null references clowzy.searches(id),
  name text not null, email text not null, company text not null, title text not null, sector text not null,
  country text not null, city text not null, website text not null, size text not null,
  source text not null, email_status text not null, created_at text not null,
  kind text not null default 'person', -- 'company': a company's own email (companies search)
  unique (user_id, email)
);
create table clowzy.ledger (
  seq bigint generated always as identity, -- insertion order for rows sharing a timestamp
  id text primary key, user_id text not null references clowzy.users(id), amount integer not null,
  kind text not null, reason text not null, reference text unique not null, balance_after integer not null, created_at text not null
);
create table clowzy.exports (
  id text primary key, user_id text not null references clowzy.users(id), row_count integer not null, created_at text not null
);
create table clowzy.audit (
  id text primary key, actor_id text not null references clowzy.users(id), action text not null, detail text not null, created_at text not null
);
create table clowzy.reset_tokens (
  token_hash text primary key, user_id text not null references clowzy.users(id), expires_at text not null, used_at text
);
create table clowzy.reservations (
  search_id text primary key references clowzy.searches(id), user_id text not null references clowzy.users(id),
  amount integer not null check (amount > 0)
);
create table clowzy.provider_runs (
  search_id text primary key references clowzy.searches(id), phase text not null, people text not null default '[]',
  file text, scanned integer not null default 0, submitted integer not null default 0,
  submitted_at bigint, message text not null default '', updated_at bigint not null, read_errors integer not null default 0,
  fetched integer not null default 0, -- people actually returned by the provider (the daily cap); scanned may be raised to stop paging
  mode text, -- 'companies' once a people search short of its count falls back to the companies' own emails
  people_checked integer not null default 0, -- people sent for email discovery before that fallback
  scope integer not null default 0 -- the place a widening search has reached (live-search.ts placesOf): 0 is the member's own
);
create table clowzy.provider_cursors (
  user_id text not null references clowzy.users(id), query_key text not null, stage integer not null default 0, token text,
  leftovers text not null default '[]', primary key (user_id, query_key)
);
create table clowzy.provider_seen (
  user_id text not null references clowzy.users(id), person_key text not null, primary key (user_id, person_key)
);

-- «أخرى»: one AI mapping per kind ('sector' | 'title') and normalized text, so the same words never pay twice.
create table clowzy.ai_cache (
  kind text not null, input text not null, output text not null, created_at text not null, primary key (kind, input)
);

-- Login attempts per key and minute, shared by every server instance (store.hit).
create table clowzy.rate_hits (
  key text not null, window_start bigint not null, count integer not null, primary key (key, window_start)
);

create index reservations_owner on clowzy.reservations(user_id);
create index search_status on clowzy.searches(status, created_at);
create index searches_owner on clowzy.searches(user_id, created_at);
create index contacts_page on clowzy.contacts(user_id, created_at desc, id);
create index contacts_search on clowzy.contacts(user_id, search_id);
create index exports_owner on clowzy.exports(user_id, created_at desc);
create index sessions_owner on clowzy.sessions(user_id);
create index users_role on clowzy.users(role, created_at desc);
create index ledger_owner on clowzy.ledger(user_id, created_at);

-- Shared supplier data, available only to the server's role. No member-private CRM fields here.
create table clowzy.lead_catalog (
  email text primary key, kind text not null check (kind in ('person','company')), industry text not null,
  country_code text not null, city_key text not null, title_key text not null, headcount integer,
  payload jsonb not null, verified_at text not null
);
create index catalog_match on clowzy.lead_catalog(kind,country_code,industry,verified_at desc);
create table clowzy.catalog_suppressions (email text primary key, created_at text not null);
create table clowzy.crm_exclusions (
  user_id text not null references clowzy.users(id), value text not null, created_at text not null, primary key(user_id,value)
);
create index rate_hits_expiry on clowzy.rate_hits(window_start);
alter table clowzy.lead_catalog enable row level security;
alter table clowzy.catalog_suppressions enable row level security;
alter table clowzy.crm_exclusions enable row level security;

create table clowzy.saved_audiences(id text primary key,user_id text not null references clowzy.users(id),name text not null,filters jsonb not null,created_at text not null);
create table clowzy.crm_lists(id text primary key,user_id text not null references clowzy.users(id),name text not null,unique(id,user_id));
create table clowzy.crm_meta(contact_id text primary key references clowzy.contacts(id) on delete cascade,user_id text not null references clowzy.users(id),stage text not null check(stage in ('new','contacted','replied','interested','not_fit')),tags jsonb not null default '[]',notes text not null default '');
alter table clowzy.contacts add constraint contacts_id_owner unique(id,user_id);
alter table clowzy.crm_meta add constraint crm_meta_contact_owner foreign key(contact_id,user_id) references clowzy.contacts(id,user_id) on delete cascade;
create table clowzy.crm_memberships(user_id text not null,list_id text not null,contact_id text not null,primary key(list_id,contact_id),foreign key(list_id,user_id) references clowzy.crm_lists(id,user_id) on delete cascade,foreign key(contact_id,user_id) references clowzy.contacts(id,user_id) on delete cascade);
create table clowzy.crm_notifications(id text primary key,user_id text not null references clowzy.users(id),search_id text unique not null references clowzy.searches(id),message text not null,created_at text not null,read_at text);
create table clowzy.crm_deletions(id text primary key,user_id text not null references clowzy.users(id),email text not null,status text not null check(status in ('pending','approved')),created_at text not null);
create unique index crm_pending_deletion on clowzy.crm_deletions(user_id,email) where status='pending';
create table clowzy.crm_deliveries(contact_id text primary key,origin text not null check(origin in ('catalog','provider')),created_at text not null);
create table clowzy.crm_worker_leases(search_id text primary key references clowzy.searches(id),token text not null,expires_at bigint not null);
create index audiences_owner on clowzy.saved_audiences(user_id);
create index crm_meta_owner on clowzy.crm_meta(user_id);
create index notifications_owner on clowzy.crm_notifications(user_id,created_at desc);
create index crm_deletions_owner on clowzy.crm_deletions(user_id,created_at desc);
-- Only this narrow function can delete immutable delivery rows. Financial history remains intact.
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
-- These tables are private, not exposed through Supabase Data API. Trusted server role only.
do $$ declare tab text; begin
  foreach tab in array array['lead_catalog','catalog_suppressions','crm_exclusions','saved_audiences','crm_lists','crm_meta','crm_memberships','crm_notifications','crm_deletions','crm_deliveries','crm_worker_leases'] loop
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
  end loop;
  if exists(select 1 from pg_roles where rolname='clowzy_app') then grant execute on function clowzy.suppress_contact(text,text) to clowzy_app; end if;
end $$;

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
