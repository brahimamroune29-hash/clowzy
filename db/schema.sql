-- clowzy platform schema (Postgres / Supabase). Applied once per database, by the database owner.
-- The app connects as its own role (see README: clowzy_app) with row access to this schema only.
-- Names are schema-qualified so applying it never depends on the session's search_path.
-- Timestamps are ISO-8601 UTC text (lexicographic order = time order); provider timers are epoch ms (bigint).
create schema if not exists clowzy;

create table clowzy.users (
  id text primary key, name text not null, email text unique not null, password_hash text not null,
  role text not null check (role in ('admin', 'member')), active integer not null default 1,
  balance integer not null default 0 check (balance >= 0), created_at text not null, terms_accepted_at text
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
  fetched integer not null default 0 -- people actually returned by the provider (the daily cap); scanned may be raised to stop paging
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
