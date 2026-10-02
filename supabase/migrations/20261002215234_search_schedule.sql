-- Infrastructure migration: run as the database owner on hosted Supabase.
-- Put the existing CRON_SECRET in Vault as clowzy_cron_secret before activation.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Requests briefly contain the bearer header. Only the trusted database owner may read them.
revoke all on schema net from public,anon,authenticated,clowzy_app,clowzy_backup;
revoke all on all tables in schema net from public,anon,authenticated,clowzy_app,clowzy_backup;
revoke all on vault.secrets,vault.decrypted_secrets from public,anon,authenticated,clowzy_app,clowzy_backup;

select cron.schedule('clowzy-search-worker','* * * * *',$job$
  select net.http_get(
    url := 'https://app.clowzy.io/api/cron/search',
    headers := jsonb_build_object('Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='clowzy_cron_secret')),
    timeout_milliseconds := 65000
  ) where exists (
    select 1 from clowzy.searches s join clowzy.users u on u.id=s.user_id
    where s.status='awaiting_provider' and u.active=1
  );
$job$);
-- Activate only after the new release is promoted and its bearer endpoint is checked.
select cron.alter_job(jobid,active:=false) from cron.job where jobname='clowzy-search-worker';
