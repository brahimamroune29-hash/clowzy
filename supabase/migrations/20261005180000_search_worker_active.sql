-- Records production as found on 2026-10-05: the worker job is active. It was switched on by hand once the bearer endpoint was
-- checked, as 20261002215234 asks; the Vercel logs show /api/cron/search every minute. Applying this changes nothing there.
select cron.alter_job(jobid,active:=true) from cron.job where jobname='clowzy-search-worker';
