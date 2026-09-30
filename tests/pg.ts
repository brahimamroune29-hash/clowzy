import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { Db, type Driver, type Row } from '../src/lib/db';
import { Store } from '../src/lib/store';

const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8');
// A fresh in-process Postgres per test with the production schema, behind the same Db as production.
export async function testDb() {
  const pg = await PGlite.create({ parsers: { 20: Number } }); // int8 as a JS number, like the production driver
  await pg.exec(schema);
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
