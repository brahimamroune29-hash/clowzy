// Read-only check against the configured real Postgres driver; no supplier calls or table writes.
import { loadEnvConfig } from '@next/env';
import assert from 'node:assert/strict';
import { Db, pgDriver } from '../src/lib/db';
loadEnvConfig(process.cwd());
async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const db = new Db(pgDriver(process.env.DATABASE_URL));
  try {
    const tags = ['VIP', 'عميل'], payload = { name: 'Test', countries: ['SA'] };
    const row = await db.get<{ tags: string[]; payload: typeof payload; text: string }>(
      'SELECT ?::jsonb AS tags, ?::jsonb AS payload, ?::text AS text', JSON.stringify(tags), JSON.stringify(payload), JSON.stringify(payload));
    assert.deepEqual(row?.tags, tags);
    assert.deepEqual(row?.payload, payload);
    assert.equal(row?.text, JSON.stringify(payload));
    assert.deepEqual(await db.all('SELECT jsonb_array_elements_text(?::jsonb) AS value', JSON.stringify(tags)), tags.map(value => ({ value })));
    console.log('PASS real Postgres JSON arrays, objects, catalog filtering and unchanged text parameters');
  } finally { await db.end(); }
}
void main().catch(e => { console.error(e instanceof Error ? e.message : 'Postgres check failed'); process.exitCode = 1; });
