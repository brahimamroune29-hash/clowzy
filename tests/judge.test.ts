import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IcypeasClient } from '../src/lib/icypeas';
import { input, item, lead, live, testStore } from './pg';

// Owner 2026-10-12 (round 2, Q3): before any paid lookup an AI judge drops a page's clear mismatches (job title, field, a foreign brand);
// whoever it does not name stays; if it fails the page stays as it is and the search goes on. No name, profile link or place reaches it.
delete process.env.AI_JUDGE_ENABLED; // tests/pg.ts turns it off for every other test
process.env.OPENROUTER_API_KEY = 'unit-test-key';
const page = [{ ...lead('a'), firstname: 'Huda', lastJobTitle: 'CEO' }, { ...lead('b'), firstname: 'Omar', lastJobTitle: 'Sales Intern' }, { ...lead('c'), firstname: 'Lina', lastJobTitle: 'Founder' }];
const drop = (indexes: number[]) => Response.json({ choices: [{ message: { content: JSON.stringify({ drop: indexes }) } }] });
// A one-person search on that page: the model answers with `reply` (the provider has a fetch of its own); `onPage` runs as the page comes.
async function search(t: TestContext, reply: (body: string) => Response, onPage = () => {}) {
  const calls: string[] = [], sent: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/openrouter\.ai\//);
    calls.push(String(init.body));
    return reply(String(init.body));
  });
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  t.after(() => store.close());
  await live(store, new IcypeasClient('unit-test-secret', async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') {
      if (body.query?.profileLocation?.exclude) return Response.json({ success: true, leads: [] });
      onPage(); return Response.json({ success: true, leads: page });
    }
    if (path === 'find-companies') return Response.json({ success: true, leads: [] });
    if (path === 'bulk-search') { sent.push(...body.data); return Response.json({ success: true, file: 'f1' }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: [item(0, null)] });
    throw new Error('Unexpected ' + path);
  })).start(user.id, input(1));
  const { timing } = (await store.db.get<{ timing: Record<string, number> }>('SELECT timing FROM provider_runs'))!;
  return { calls, sent, timing };
}

test('a search pays only for whom the judge kept, sends it no name, profile link or place, and records what it did', async t => {
  // Drops the intern by title, whatever order the page reached the judge in (people are ranked by seniority first), and an index out of range.
  const { calls, sent, timing } = await search(t, body => {
    const { candidates } = JSON.parse(JSON.parse(body).messages[1].content) as { candidates: { i: number; title?: string }[] };
    return drop([...candidates.filter(c => /intern/i.test(c.title ?? '')).map(c => c.i), 99]);
  });
  assert.deepEqual(sent.map(row => row[0]).sort(), ['Huda', 'Lina'], 'the intern never reached a paid lookup');
  assert.ok(calls.length && calls.every(c => !/Huda|Omar|Lina|linkedin|Riyadh, Riyadh/.test(c)), 'no name, profile link or place sent to the model');
  assert.deepEqual([timing.judged, timing.dropped, timing.judgeErrors], [3, 1, 0]);
});

test('a judge that fails keeps the page: the search goes on, and the failure is counted', async t => {
  const { sent, timing } = await search(t, () => new Response('down', { status: 503 }));
  assert.equal(sent.length, 3);
  assert.deepEqual([timing.judged, timing.judgeErrors], [0, 1], 'a failed call judged nobody');
});

test('the judge can be switched off without a code change (AI_JUDGE_ENABLED=false)', async t => {
  process.env.AI_JUDGE_ENABLED = 'false';
  t.after(() => { delete process.env.AI_JUDGE_ENABLED; });
  const { calls, sent } = await search(t, () => drop([0, 1, 2]));
  assert.deepEqual([calls.length, sent.length], [0, 3]);
});

test('a page that comes late is judged only in the time left before 50 s (the function is killed at 60 s)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const timeouts: number[] = [], given: number[] = [], timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return timeout(ms); });
  await search(t, () => { given.push(timeouts.at(-1)!); return drop([]); }, () => t.mock.timers.tick(48000)); // the page took 48 s
  assert.equal(given[0], 2000);
});

test('a page that comes too late (past 49 s) is not judged at all: no call, counted as a failure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { calls, timing } = await search(t, () => drop([]), () => t.mock.timers.tick(49500));
  assert.deepEqual([calls.length, timing.judgeErrors], [0, 1]);
});
