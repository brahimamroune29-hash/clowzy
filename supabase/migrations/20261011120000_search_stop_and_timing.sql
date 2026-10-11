-- Client request 2026-10-11, two columns on a search's run:
--  · stop_requested: a member, or the owner, can stop a running search. Null while it runs; set to the time of the request.
--    Nothing new is sent after it; the batch already at the provider is read and delivered, then the search closes 'stopped'.
--  · timing: milliseconds and counts per stage (pageMs/pages, submitMs/submits, readMs/reads, deliverMs), to see where a slow
--    search spends its time. One value per search, updated in place: no audit row per stage.
-- Safe before or after the code ships: the old code never reads either column.
alter table clowzy.provider_runs add column if not exists stop_requested bigint;
alter table clowzy.provider_runs add column if not exists timing jsonb;
