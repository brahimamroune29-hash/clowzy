-- Apply after the existing audit rate_hits upgrade, as database owner.
begin;
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
create function clowzy.suppress_contact(actor text,address text) returns void
language plpgsql security definer set search_path=clowzy,pg_temp as $$
begin
  if not exists(select 1 from clowzy.users where id=actor and role='admin' and active=1) then raise exception 'Owner required'; end if;
  lock table clowzy.catalog_suppressions in share row exclusive mode;
  insert into clowzy.catalog_suppressions(email,created_at) values(address,to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) on conflict do nothing;
  update clowzy.provider_runs set people='[]' where search_id in (select search_id from clowzy.contacts where email=address) and phase='finished';
  update clowzy.provider_cursors set leftovers='[]' where user_id in (select user_id from clowzy.contacts where email=address);
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

commit;
