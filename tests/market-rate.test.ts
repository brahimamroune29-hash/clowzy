import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testStore } from './pg';
import type { Store } from '../src/lib/store';

// A finished search is 'completed' (full) or 'partial' (short); only those reflect a market. Failed/unknown
// (technical errors) and in-flight searches must not count toward how a market really performs.
async function addSearch(store: Store, userId: string, sector: string, countries: string[], requested: number, delivered: number, status = 'partial') {
  await store.db.run(
    'INSERT INTO searches(id,user_id,request_id,filters,title,requested,delivered,duplicates,status,created_at) VALUES(?,?,?,?,?,?,?,0,?,?)',
    randomUUID(), userId, randomUUID(),
    JSON.stringify({ mode: 'people', sector, countries, city: '', title: '', size: 'all', count: requested }),
    sector, requested, delivered, status, new Date().toISOString());
}

// marketRate: how much of what was asked for actually arrived in this niche+country, across every member's
// finished searches — so the pre-search warning can tell a dead market (salons in Lebanon) from a thin one.
test('marketRate: dead market -> 0, rich -> real rate, thin history -> null, failed excluded', async () => {
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password-123', 'member', 10);

  // Dead market: salons in Lebanon, three searches that asked for 20 and delivered 0.
  for (let i = 0; i < 3; i++) await addSearch(store, alice.id, 'صالونات التجميل', ['LB'], 20, 0);
  // Rich market: restaurants in Saudi Arabia, two searches that asked for 20 and delivered 16.
  for (let i = 0; i < 2; i++) await addSearch(store, alice.id, 'المطاعم', ['SA'], 20, 16, 'completed');
  // A huge FAILED search in the rich market must not drag its rate down.
  await addSearch(store, alice.id, 'المطاعم', ['SA'], 1000, 0, 'failed');

  const dead = await store.marketRate('صالونات التجميل', ['LB']);
  assert.ok(dead, 'enough history to judge');
  assert.equal(dead!.rate, 0, 'dead market reads a 0 rate');

  const rich = await store.marketRate('المطاعم', ['SA']);
  assert.ok(rich, 'enough history to judge');
  assert.ok(Math.abs(rich!.rate - 0.8) < 0.001, 'rich market ~0.8, the failed search excluded');

  // A country that shares the niche but not this run's countries has no history.
  assert.equal(await store.marketRate('المطاعم', ['EG']), null, 'no history -> null');

  // Thin history (one small search) is not enough to judge.
  await addSearch(store, alice.id, 'العيادات', ['KW'], 5, 1);
  assert.equal(await store.marketRate('العيادات', ['KW']), null, 'too little history -> null');
});
