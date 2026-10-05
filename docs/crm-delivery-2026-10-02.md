# Clowzy CRM — local delivery, 2026-10-02

Implemented all eight approved additions: saved audiences, independent search worker and completion notifications, private lists/tags/notes, five contact stages, generic/GoHighLevel CSV with selected columns and preview, total/reserved/available credits, owner cost scenarios, exclusions and audited deletion requests.

## Shared catalog

New verified supplier results are written into `clowzy.lead_catalog` in the delivery transaction, before replacing supplier industry names with the member's display labels. Only supplier fields are copied; account IDs, notes, stages, lists and saved searches never enter the catalog. Existing contacts are not backfilled: their stored sector describes the requested audience and cannot prove the supplier's actual industry.

`CATALOG_REUSE_ENABLED=false` is the agreed setting: the owner explicitly said on 2026-10-02 that supplier reuse rights have not been confirmed. The reuse path is implemented and tested locally but must remain off until that confirmation. `CRM_ENABLED=false` is the safe deployment default until the database upgrade is applied. Recording verified results and cross-account delivery are separate switches.

When reuse is authorized, the search matches exact provider industries and countries, person/company type, normalized city, title and numeric size. Missing facts fail narrowed filters. Verification older than 30 days is skipped (configurable 1–90 days). Matching a niche label alone is insufficient. New subscribers pay one credit per new delivered email, including cached emails; existing emails in that subscriber's account never charge twice. Search reservation, cache delivery, debit and completion commit together. If the catalog supplies only part of a request, the provider searches for the remainder through the existing lifecycle.

## Isolation and deletion

The project uses custom application sessions and a server-only `clowzy_app` Postgres role, not Supabase Auth. Therefore `auth.uid()` policies would block the current backend. New private-schema tables enable RLS and grant policies only to this trusted role; `anon`, `authenticated` and `public` have no access. Do not expose `clowzy` in the Supabase Data API or grant browser roles access. API methods validate account ownership; list/contact composite foreign keys add protection against mismatched membership and metadata records.

A member can request deletion only of an owned contact. The owner reviews a concrete deletion warning, then approves. A narrowly granted security-definer function deletes that email from the central catalog and all member contacts (CRM notes/memberships cascade), records a suppression, clears relevant finished-run people and cursor buffers, and retains ledger/audit history. The approval itself is audited without retaining the email in the approved request. Suppressions keep only the minimum email needed to block future delivery. No automatic credit refund. Locks serialize suppression with catalog writes and deliveries. Historical downloaded CSV files cannot be revoked.

Exclusions prevent new deliveries for an email or domain and do not erase existing contacts. They can still incur supplier work when the email is unknown before verification. Global suppression remains effective with shared reuse disabled.

## Deployment steps — not executed on production

1. Back up the database and rehearse the upgrade in a disposable/staging project. Apply the prior `rate_hits` upgrade in README if not already present.
2. As database owner, apply `supabase/migrations/20261002095426_crm_catalog.sql`. Its filename was created by Supabase CLI. The SQL uses one transaction. The existing `clowzy_app` role must be present to receive grants/policies.
3. A new database uses `db/schema.sql`, then the existing role setup in README, then `db/crm-access.sql` after creating the role. That access script is repeatable. Keep the schema private and verify the real server role can select/insert each new table and execute only the intended deletion function. Run Supabase security/performance advisors before deploying.
4. Set `CRM_ENABLED=true` for the app and worker. Keep `CATALOG_REUSE_ENABLED=false`. Set optional USD rates only from the supplier plan and the actual commercial assumptions; blank rates display as unknown.
5. Deploy the reviewed app only after staging checks. Run one supervised long-lived `npm run worker` process with the same server-only environment. A Next/Vercel web deployment alone does not run this worker. The worker advances up to ten oldest pending searches per tick, using expiring database leases and the existing paid-request claims. Provider spacing remains per process; run one worker and check supplier throttling in staging when browser polls overlap.
6. Verify staging with two member accounts and an owner: private edits, list ownership, cached delivery with a synthetic provider, duplicate request, credit reservation, closing a browser mid-search, CSV preview/download, exclusions and deletion approval. Confirm provider license before enabling shared reuse.

Rollback: set both flags false, stop the worker, and restore the prior app version if necessary. Keep the added tables; do not drop them or financial history as a quick rollback. Fresh records and notes remain recoverable. Source snapshot before the feature: `/tmp/clowzy-crm-before-2026-10-02/source.tar.gz` (no secrets).

## Metrics and limits

Owner counts come from persisted provider runs, catalog rows, cache delivery events and ledger debits. Cost/value/margin are rate-based all-history scenarios, not billed supplier costs, collected revenue or actual profit. Submissions include unsuccessful attempts; uncertain submits may be missing until reconciled. Cache delivery events begin when CRM is enabled. Lists and saved audiences are capped at 100 per account; private notes at 4,000 characters and 20 tags. Custom export covers up to 1,000 selected/matching contacts, with a five-row preview; ordinary existing export is preserved. Contacts remain loaded through the existing full snapshot, so database pagination is the next upgrade if account histories become too large.

## Local verification

See the final verification results below. Local PostgreSQL engine and mocked-provider/browser tests do not establish production migration, supplier rights, live-provider behavior or continuously running worker availability.

HighLevel CSV: the profile splits person names into First Name/Last Name and uses Business Name for company associations, following [HighLevel's company import instructions](https://help.gohighlevel.com/support/solutions/articles/155000007236-how-to-import-companies-via-csv). Email is required in this profile so company email rows have an identifier. Review field mappings during import; notes, contact type, stage and job title may need configured custom fields. This export does not create HighLevel opportunities or send data automatically. See [official CSV import documentation](https://help.gohighlevel.com/support/solutions/articles/155000005143). No live HighLevel import was performed.

Verified locally: 122 tests passing (full suite), lint, TypeScript and production build passing; targeted CRM tests also cover failure notifications. The actual CLI-generated upgrade SQL runs successfully against a disposable PGlite database with backend, anonymous and authenticated roles. Browser checks use the real API handler with intercepted traffic routed into disposable PGlite: private list/contact edits, CSV preview/download, saved audiences, malformed saved links, Arabic/English and 390px mobile overflow checks pass. Desktop/mobile screenshots were inspected. No live Supabase migration, provider call, deployment or permanent worker service was executed.

## Supplied database trial — 2026-10-02

Applied the CRM upgrade to the database supplied in `.env.local` after confirming the admin and application connection URLs target the same project and there were no pending provider searches. A private data snapshot of the 15 existing tables was saved at `.data/pre-crm-20261002.json`; this is a data snapshot, not a full pg_dump. Verified all 11 new tables have RLS, trusted app grants, and no anonymous/authenticated SELECT grants. Real `clowzy_app` CRM reads, owner operations, and a list insertion inside a rolled-back transaction passed. Enabled `CRM_ENABLED=true` locally and kept `CATALOG_REUSE_ENABLED=false`. Removed unused `APP_MODE=demo`; it has no runtime references in the current application. No Vercel environment change, production deployment, live provider generation, or permanent worker service was performed.
