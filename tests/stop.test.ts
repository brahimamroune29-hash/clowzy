import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IcypeasClient } from '../src/lib/icypeas';
import type { Store } from '../src/lib/store';
import { hookDb, input, item, lead, live, testStore } from './pg';

// Client request 2026-10-11: a member can stop a running search, and so can the owner (any member's search).
// Owner decision: nothing new is sent; the batch already at the provider (paid) is read and delivered, then the search closes.

type Calls = { submits: number };
const provider = (calls: Calls, found: (string | null)[]): typeof fetch => async (url, init) => {
  const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
  if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [lead('a'), lead('b')] });
  if (path === 'find-companies') return Response.json({ success: true, leads: [] });
  if (path === 'bulk-search') { calls.submits++; return Response.json({ success: true, file: 'f' + calls.submits }); }
  if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: found.map((email, i) => item(i, email)) }); // fewer rows than people: the batch is not done
  throw new Error('Unexpected ' + path);
};
const people = async (store: Store) => ({ alice: await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5) });

test('a member stops a search: no new batch goes out, the batch at the provider is delivered, and the search closes stopped', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example', 'person@company-b.example'])));
    const first = await s.start(alice.id, input(3));
    assert.equal(calls.submits, 1);
    const stopping = await s.requestStop(alice.id, first.id);
    assert.equal(stopping.status, 'awaiting_provider', 'the paid batch is still read');
    assert.match(stopping.message ?? '', /إيقاف/);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const done = await s.poll(alice.id, first.id);
    assert.equal(done.status, 'stopped');
    assert.equal(done.delivered, 2);
    assert.equal(calls.submits, 1, 'nothing sent after the stop');
    assert.equal((await store.user(alice.id)).balance, 3, 'charged for the two delivered only');
    assert.equal(await store.reserved(alice.id), 0);
  } finally { await store.close(); }
});

test('a stopped search does not wait a quarter of an hour on a slow batch: after the stop window it closes with what came', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    // The provider has answered for one person of two: the batch is not done.
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example'])));
    const first = await s.start(alice.id, input(3));
    await s.requestStop(alice.id, first.id);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    assert.equal((await s.poll(alice.id, first.id)).status, 'awaiting_provider', 'inside the window the batch still has time');
    await store.db.run('UPDATE provider_runs SET updated_at=0, stop_requested=?, submitted_at=?', Date.now() - 31000, Date.now() - 31000);
    const done = await s.poll(alice.id, first.id);
    assert.equal(done.status, 'stopped');
    assert.equal(done.delivered, 1);
    assert.equal(calls.submits, 1);
  } finally { await store.close(); }
});

test('a stop that lands after a batch is picked and before it is paid for sends nothing', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    // The batch is picked and saved as 'submitting'; the next read of the run is the check right before the paid submit.
    const driver = (store.db as unknown as { driver: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }).driver;
    let fired = false;
    hookDb(store, async text => {
      if (fired || !text.startsWith('SELECT * FROM provider_runs')) return;
      if (!(await driver.query("SELECT 1 FROM provider_runs WHERE phase='submitting'")).rows.length) return;
      fired = true;
      await driver.query('UPDATE provider_runs SET stop_requested=$1', [Date.now()]);
    });
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example', 'person@company-b.example'])));
    const result = await s.start(alice.id, input(3));
    assert.ok(fired, 'the stop landed during the submit');
    assert.equal(calls.submits, 0, 'the picked batch was never paid for');
    assert.equal(result.status, 'stopped');
    assert.equal(result.delivered, 0);
    assert.equal(await store.reserved(alice.id), 0);
  } finally { await store.close(); }
});

test('only the member who ran a search, or the owner, can stop it', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  const bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  const owner = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin', 0);
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example', 'person@company-b.example'])));
    const first = await s.start(alice.id, input(3));
    await assert.rejects(s.requestStop(bob.id, first.id), (e: { status?: number }) => e.status === 404);
    assert.equal((await store.db.get<{ stop_requested: number | null }>('SELECT stop_requested FROM provider_runs'))!.stop_requested, null);
    const stopping = await s.requestStop(owner.id, first.id);
    assert.equal(stopping.id, first.id);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    assert.equal((await s.poll(alice.id, first.id)).status, 'stopped');
  } finally { await store.close(); }
});

test('stopping a search that already ended changes nothing', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example', 'person@company-b.example'])));
    const first = await s.start(alice.id, input(2));
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    assert.equal((await s.poll(alice.id, first.id)).status, 'completed');
    assert.equal((await s.requestStop(alice.id, first.id)).status, 'completed');
  } finally { await store.close(); }
});

test('reads that keep failing after a stop close the search as stopped after the stop window, not after a quarter of an hour', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    const failing: typeof fetch = async (url, init) => String(url).endsWith('bulk-single-searchs/read') ? new Response('unavailable', { status: 503 }) : provider(calls, [])(url, init);
    const s = live(store, new IcypeasClient('unit-test-secret', failing));
    const first = await s.start(alice.id, input(3));
    await s.requestStop(alice.id, first.id);
    await store.db.run('UPDATE provider_runs SET stop_requested=?, submitted_at=?', Date.now() - 31000, Date.now() - 31000);
    let done = first;
    for (let i = 0; i < 3; i++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); done = await s.poll(alice.id, first.id); }
    assert.equal(done.status, 'stopped', 'three failed reads in a row after the wait');
    assert.equal(calls.submits, 1);
    assert.equal(await store.reserved(alice.id), 0);
  } finally { await store.close(); }
});

test('a member who stopped and left the page (no background worker): their next search closes the stopped one and is accepted', async () => {
  const store = await testStore(), { alice } = await people(store), calls = { submits: 0 };
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', provider(calls, ['person@company-a.example'])));
    const first = await s.start(alice.id, input(3));
    await s.requestStop(alice.id, first.id);
    await store.db.run('UPDATE provider_runs SET updated_at=0, stop_requested=?, submitted_at=?', Date.now() - 31000, Date.now() - 31000);
    await s.start(alice.id, input(3)); // refused («a search is running») if the stopped one were still open
    assert.equal((await store.getSearch(alice.id, first.id)).status, 'stopped');
  } finally { await store.close(); }
});

test('a stop that lands while a request is buying provider pages stops before the next page, and nothing is sent', async () => {
  const store = await testStore(), { alice } = await people(store);
  let pages = 0, submits = 0;
  try {
    const endless: typeof fetch = async (url, init) => {
      const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
      if (path === 'find-people' && !body.query?.profileLocation?.exclude) {
        if (++pages === 1) await store.db.run('UPDATE provider_runs SET stop_requested=?', Date.now()); // pressed during the first page
        return Response.json({ success: true, leads: [lead('p' + pages)], pagination: { token: 'next' + pages } });
      }
      if (path === 'bulk-search') submits++;
      return provider({ submits: 0 }, [])(url, init);
    };
    const s = live(store, new IcypeasClient('unit-test-secret', endless));
    const first = await s.start(alice.id, input(3));
    assert.equal(pages, 1, 'no page bought after the stop');
    assert.equal((await s.poll(alice.id, first.id)).status, 'stopped');
    assert.equal(submits, 0);
    assert.equal(await store.reserved(alice.id), 0);
  } finally { await store.close(); }
});

// Adversarial review 2026-10-11: the four ways the first stop code still failed, each red before its fix.
type Driver = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const path = (url: unknown) => String(url).replace('https://app.icypeas.com/api/', '');
const base = (found: string[], onSubmit?: () => Promise<void>, onRead?: () => Response | null): typeof fetch => async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (path(url) === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [lead('a'), lead('b')] });
  if (path(url) === 'find-companies') return Response.json({ success: true, leads: [] });
  if (path(url) === 'bulk-search') { await onSubmit?.(); return Response.json({ success: true, file: 'f1' }); }
  if (path(url) === 'bulk-single-searchs/read') return onRead?.() ?? Response.json({ success: true, items: found.map((e, i) => item(i, e)) });
  throw new Error('Unexpected ' + path(url));
};

test('a stop that lands during the last check before the paid submit is still seen: nothing is sent', async () => {
  const store = await testStore(), { alice } = await people(store);
  const driver = (store.db as unknown as { driver: Driver }).driver;
  let armed = false, fired = false, submits = 0;
  try {
    hookDb(store, async text => {
      if (text.startsWith('UPDATE provider_runs SET phase=$1,people=$2,updated_at=$3')) { armed = true; return; }
      if (fired || !armed || !text.startsWith('SELECT * FROM searches WHERE user_id')) return;
      fired = true;
      await driver.query('UPDATE provider_runs SET stop_requested=$1', [Date.now()]);
    });
    const s = live(store, new IcypeasClient('unit-test-secret', base(['person@company-a.example', 'person@company-b.example'], async () => { submits++; })));
    await s.start(alice.id, input(3));
    assert.ok(fired);
    assert.equal(submits, 0);
  } finally { await store.close(); }
});

test('one failed read after the stop window does not throw away a paid batch whose emails are ready', async () => {
  const store = await testStore(), { alice } = await people(store);
  let reads = 0;
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', base(['person@company-a.example', 'person@company-b.example'], undefined,
      () => ++reads === 1 ? new Response('unavailable', { status: 503 }) : null)));
    const first = await s.start(alice.id, input(3));
    await s.requestStop(alice.id, first.id);
    await store.db.run('UPDATE provider_runs SET stop_requested=?, submitted_at=?', Date.now() - 31000, Date.now() - 31000);
    let done = first;
    for (let i = 0; i < 2 && done.status === 'awaiting_provider'; i++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); done = await s.poll(alice.id, first.id); }
    assert.equal(done.delivered, 2);
    assert.equal(done.status, 'stopped');
  } finally { await store.close(); }
});

test('a batch sent just after a stop gets its own wait, counted from the submit', async () => {
  const store = await testStore(), { alice } = await people(store);
  const driver = (store.db as unknown as { driver: Driver }).driver;
  try {
    // the stop was pressed while a slow submit (~26 s) was on its way
    const s = live(store, new IcypeasClient('unit-test-secret', base(['person@company-a.example'], async () => {
      await driver.query('UPDATE provider_runs SET stop_requested=$1', [Date.now() - 26000]);
    })));
    const first = await s.start(alice.id, input(3));
    const run = (await store.db.get<{ submitted_at: number; stop_requested: number }>('SELECT submitted_at, stop_requested FROM provider_runs'))!;
    await store.db.run('UPDATE provider_runs SET updated_at=0, submitted_at=?, stop_requested=?', run.submitted_at - 5000, run.stop_requested - 5000);
    assert.equal((await s.poll(alice.id, first.id)).status, 'awaiting_provider', 'a batch 5 s old still has time');
  } finally { await store.close(); }
});

test('a stopped search that then hits a provider error closes stopped, not failed', async () => {
  const store = await testStore(), { alice } = await people(store);
  try {
    const failing: typeof fetch = async (url, init) => {
      if (path(url) === 'find-people' && !JSON.parse(String(init?.body)).query?.profileLocation?.exclude) {
        await store.db.run('UPDATE provider_runs SET stop_requested=?', Date.now());
        return new Response('bad', { status: 503 });
      }
      return base([])(url, init);
    };
    assert.equal((await live(store, new IcypeasClient('unit-test-secret', failing)).start(alice.id, input(3))).status, 'stopped');
  } finally { await store.close(); }
});

test('a failed read is counted in the run\'s timing and never hides the read error', async () => {
  const store = await testStore(), { alice } = await people(store);
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', base(['person@company-a.example', 'person@company-b.example'], undefined, () => new Response('x', { status: 503 }))));
    const first = await s.start(alice.id, input(3));
    await store.db.run(`UPDATE provider_runs SET updated_at=0, timing='{"reads":5,"other":1}'::jsonb`);
    await s.poll(alice.id, first.id);
    const row = (await store.db.get<{ timing: Record<string, number>; read_errors: number }>('SELECT timing, read_errors FROM provider_runs'))!;
    assert.deepEqual([row.timing.reads, row.timing.other, row.read_errors], [6, 1, 1]);
    assert.equal(typeof row.timing.readMs, 'number');
  } finally { await store.close(); }
});
