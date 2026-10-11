import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IcypeasClient } from '../src/lib/icypeas';
import { input, item, lead, live, testStore } from './pg';

// Owner 2026-10-11 (Q2): after the first 100 people of the requested place, a find rate under 3% moves the search to the companies'
// own emails in that place now. Salons in Saudi Arabia found 0.6% over 1,016 people, 74% of a 21-minute search, before switching.
test('a people search finding under 3% after its first 100 people switches to company emails in the same place, not after every page', async () => {
  const store = await testStore(), alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 50);
  const rows = new Map<string, number>();
  let people = 0, sent = 0, companyPages = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') {
      if (body.query?.profileLocation?.exclude) return Response.json({ success: true, leads: [] });
      const leads = Array.from({ length: 25 }, () => lead('p' + ++people)); // pages that never run out
      return Response.json({ success: true, leads, pagination: { token: 't' + people } });
    }
    if (path === 'find-companies') { companyPages++; return Response.json({ success: true, leads: [] }); }
    if (path === 'bulk-search') { sent += body.data.length; rows.set('f' + rows.size, body.data.length); return Response.json({ success: true, file: 'f' + (rows.size - 1) }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: Array.from({ length: rows.get(body.file)! }, (_, i) => item(i, null)) });
    throw new Error('Unexpected ' + path);
  };
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', transport));
    let result = await s.start(alice.id, input(10));
    for (let n = 0; n < 40 && result.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await s.poll(alice.id, result.id); }
    assert.ok(sent >= 100, 'the first 100 people are tried: ' + sent);
    assert.ok(sent < 200, 'not every person up to the cap of paid checks (200 for 10 emails): ' + sent);
    assert.ok(companyPages > 0, 'the companies of the same place were searched');
    assert.equal(result.status, 'partial');
    assert.ok(!result.message?.includes('أعد البحث بالمعايير نفسها'), 'no advice to try the same low-yield people again: ' + result.message);
  } finally { await store.close(); }
});

test('a search started before 2026-10-11 with widening on keeps its old course: no early switch', async () => {
  const store = await testStore(), alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 50);
  const rows = new Map<string, number>();
  let people = 0, sent = 0, companyPages = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') {
      if (body.query?.profileLocation?.exclude) return Response.json({ success: true, leads: [] });
      return Response.json({ success: true, leads: Array.from({ length: 25 }, () => lead('p' + ++people)), pagination: { token: 't' + people } });
    }
    if (path === 'find-companies') { companyPages++; return Response.json({ success: true, leads: [] }); }
    if (path === 'bulk-search') { sent += body.data.length; rows.set('f' + rows.size, body.data.length); return Response.json({ success: true, file: 'f' + (rows.size - 1) }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: Array.from({ length: rows.get(body.file)! }, (_, i) => item(i, null)) });
    throw new Error('Unexpected ' + path);
  };
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', transport));
    let result = await s.start(alice.id, { ...input(10), widen: true });
    for (let n = 0; n < 40 && result.status === 'awaiting_provider' && sent < 150; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await s.poll(alice.id, result.id); }
    assert.ok(sent >= 134, 'past the first 100 people: ' + sent);
    assert.equal(companyPages, 0, 'still on people, as before');
    assert.equal((await store.db.get<{ mode: string | null }>('SELECT mode FROM provider_runs'))!.mode, null);
  } finally { await store.close(); }
});
