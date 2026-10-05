-- A search short of its count widens its place (client request 2026-10-05): provider_runs.scope is the place it has reached.
alter table clowzy.provider_runs add column if not exists scope integer not null default 0;
