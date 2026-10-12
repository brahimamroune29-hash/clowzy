import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { catalogMatches } from '../src/lib/catalog';
import { IcypeasClient } from '../src/lib/icypeas';
import { item, lead, live, testStore } from './pg';

// Adversarial review 2026-10-12: people picked before the deploy were picked with no size or headquarters filter. Across the deploy a
// company above the ceiling must never be sent, and a pick whose headquarters was never checked must not be lent through the catalog.
const provider = () => {
  const bulks: string[][][] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people' || path === 'find-companies') return Response.json({ success: true, leads: [] });
    if (path === 'bulk-search') { bulks.push(body.data); return Response.json({ success: true, file: 'f' + bulks.length }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: bulks[Number(String(body.file).slice(1)) - 1].map((row, i) => item(i, row[0].toLowerCase() + '@' + row[2])) });
    throw new Error('Unexpected ' + path);
  };
  return { bulks, client: new IcypeasClient('unit-test-secret', transport) };
};
const form = () => ({ sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', title: '', count: 2, widen: false, confirmed: true, requestId: randomUUID() });
const big = { ...lead('big'), firstname: 'Bill', lastCompanyName: 'Giant Corp', lastCompanyWebsite: 'https://giant.example', lastCompanySize: 5000 };
const unchecked = { ...lead('us'), firstname: 'Sam', lastCompanyName: 'US Owned Arabia', lastCompanyWebsite: 'https://usowned.example', lastCompanySize: 12 };
async function legacyRun(store: Awaited<ReturnType<typeof testStore>>, userId: string, picked: object[]) {
  const s = await store.enqueueSearch(userId, audienceOf(JSON.stringify({ ...form(), size: 'all' })));
  await store.db.run(`UPDATE searches SET status='awaiting_provider', filters=replace(filters,'"size":"1000"','"size":"all"') WHERE id=?`, s.id);
  await store.db.run(`INSERT INTO provider_runs(search_id,phase,people,updated_at) VALUES(?,'paused',?,0)`, s.id, JSON.stringify(picked));
  return s.id;
}

test('a run paused across the deploy never sends a company above the ceiling, and its unchecked picks are not lent through the catalog', async t => {
  process.env.CRM_ENABLED = 'true'; process.env.CATALOG_REUSE_ENABLED = 'true';
  t.after(() => { delete process.env.CRM_ENABLED; delete process.env.CATALOG_REUSE_ENABLED; });
  const store = await testStore(), a = await store.addUser('A', 'a@example.test', 'secure-password', 'member', 10), b = await store.addUser('B', 'b@example.test', 'secure-password', 'member', 10);
  try {
    const p = provider(), search = live(store, p.client), id = await legacyRun(store, a.id, [big, unchecked]);
    await search.poll(a.id, id);
    await store.db.run('UPDATE provider_runs SET updated_at=0'); await search.poll(a.id, id);
    assert.ok(!p.bulks.flat().some(row => row.includes('giant.example')), 'Giant Corp (5,000 people) was never sent');
    assert.ok(!(await store.snapshot(a.id)).contacts.some(c => c.company === 'Giant Corp'));
    assert.equal((await store.db.get<{ hq: string | null }>("SELECT payload->>'hq' hq FROM lead_catalog WHERE email='sam@usowned.example'"))?.hq ?? null, null, 'its headquarters were never checked');
    assert.deepEqual(await catalogMatches(store, b.id, audienceOf(JSON.stringify(form())), 50), []);
  } finally { await store.close(); }
});

test('a run stopped across the deploy hands its old picks back, and the next search still never sends a company above the ceiling', async () => {
  const store = await testStore(), a = await store.addUser('A', 'a@example.test', 'secure-password', 'member', 10);
  try {
    const p = provider(), search = live(store, p.client), id = await legacyRun(store, a.id, [big]);
    await search.requestStop(a.id, id);
    const next = await search.start(a.id, audienceOf(JSON.stringify(form())));
    await store.db.run('UPDATE provider_runs SET updated_at=0'); await search.poll(a.id, next.id);
    assert.ok(!p.bulks.flat().some(row => row.includes('giant.example')), 'Giant Corp (5,000 people) was never sent');
  } finally { await store.close(); }
});
