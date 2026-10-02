-- pg_net in this project grants PUBLIC access to its request queue and postgres cannot revoke it.
-- Use one bounded direct request instead: no persisted bearer header. The job is still disabled.
create extension if not exists http with schema extensions;
select cron.schedule('clowzy-search-worker','* * * * *',$job$
  do $tick$
  declare response extensions.http_response;
  begin
    if exists(select 1 from clowzy.searches s join clowzy.users u on u.id=s.user_id
      where s.status='awaiting_provider' and u.active=1) then
      perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','65000');
      perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','10000');
      select * into response from extensions.http((
        'GET','https://app.clowzy.io/api/cron/search',
        array[extensions.http_header('Authorization','Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name='clowzy_cron_secret'))],
        null,null)::extensions.http_request);
      if response.status<>200 or response.content::jsonb->>'handled' is null then
        raise exception 'Clowzy worker failed: HTTP %',response.status;
      end if;
    end if;
  end $tick$;
$job$);
select cron.alter_job(jobid,active:=false) from cron.job where jobname='clowzy-search-worker';
-- pg_net stays installed, but this job never uses its queue or writes its bearer there.
