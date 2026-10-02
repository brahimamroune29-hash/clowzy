-- For fresh installations: run after creating the clowzy_app role.
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
