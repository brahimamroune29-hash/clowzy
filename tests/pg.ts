import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { Db, type Driver, type Row } from '../src/lib/db';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store';
import { audienceOf } from '../src/lib/audience';
import type { Resolved } from '../src/lib/contracts';
import type { IcypeasClient } from '../src/lib/icypeas';
import { LiveSearch } from '../src/lib/live-search';

const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8');
// A fresh in-process Postgres per test with the production schema, behind the same Db as production.
export async function testDb(withRoles = false, upgrade = false) {
  const pg = await PGlite.create({ parsers: { 20: Number } }); // int8 as a JS number, like the production driver
  if(withRoles) await pg.exec('create role clowzy_app; create role clowzy_backup; create role anon; create role authenticated;');
  await pg.exec(upgrade?schema.slice(0,schema.indexOf('-- Shared supplier data')):schema);
  if(upgrade) {
    await pg.exec(readFileSync(join(process.cwd(),'supabase/migrations/20261002095426_crm_catalog.sql'),'utf8'));
    await pg.exec(readFileSync(join(process.cwd(),'supabase/migrations/20261002175425_launch_hardening.sql'),'utf8'));
  }
  await pg.exec('set search_path to clowzy'); // production: the app role's default (ALTER ROLE ... SET search_path)
  const wrap = (s: PGlite | Transaction): Driver => ({
    async query(text, params) { const r = await s.query<Row>(text, params); return { rows: r.rows, count: r.affectedRows ?? 0 }; },
    begin: fn => s === pg ? pg.transaction(tx => fn(wrap(tx))) : fn(wrap(s)),
    end: () => pg.close(),
  });
  return new Db(wrap(pg));
}
export const testStore = async () => new Store(await testDb());

// Wraps a store's driver (and every transaction driver it hands out) so a test can observe or fail queries.
export function hookDb(store: Store, onQuery: (text: string) => void | Promise<void>) {
  const wrap = (d: Driver): Driver => ({
    async query(text, params) { await onQuery(text); return d.query(text, params); },
    begin: fn => d.begin(tx => fn(wrap(tx))),
    end: () => d.end(),
  });
  const db = store.db as unknown as { driver: Driver };
  db.driver = wrap(db.driver);
}

// Shared fixtures for the provider tests (icypeas, lifecycle): a Saudi tech audience, provider leads and result rows.
export const input = (count = 2): Resolved => audienceOf(JSON.stringify({ sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', title: '', size: 'all', count, confirmed: true, requestId: randomUUID() }));
export const lead = (id: string) => ({ firstname: 'Person', lastname: id, profileUrl: 'https://www.linkedin.com/in/' + id, lastJobTitle: 'CEO', address: 'Riyadh, Riyadh, Saudi Arabia', lastCompanyName: 'Company ' + id, lastCompanyWebsite: 'https://www.company-' + id + '.example/about', lastCompanyIndustry: 'Software Development', lastCompanySize: 12 });
export const item = (i: number, email: string | null, certainty = 'ultra_sure', status = email ? 'DEBITED' : 'DEBITED_NOT_FOUND') => ({ _id: 'item' + i, status, userData: { externalId: String(i) }, results: { emails: email ? [{ email, certainty }] : [] } });
// No spacing between provider calls, and slots of its own (the production ones are shared per process).
export const live = (store: Store, client: IcypeasClient) => new LiveSearch(store, client, { read: 0, bulk: 0 }, { read: 0, bulk: 0 });
