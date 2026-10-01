// Search lifecycle on serverless (audit 2026-09-30): requests are killed at 60 s, instances do not share memory,
// the provider fails transiently. Each case asserts the behaviour that keeps paid work and the member's people safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IcypeasClient, personKey } from '../src/lib/icypeas';
import { LiveSearch } from '../src/lib/live-search';
import { Store } from '../src/lib/store';
import type { Candidate } from '../src/lib/contracts';
import { input, item, lead, live, testStore } from './pg';

const tick = () => new Promise(r => setTimeout(r, 5));

type Page = { leads: unknown[]; token?: string };
type Hooks = { pages: Page[]; files?: unknown[][]; onPage?: (n: number) => Promise<void> | void; onBulk?: (n: number) => Promise<Response | void> | Response | void; onRead?: (n: number) => Promise<void> | void };
function mock(o: Hooks) {
  const calls: { path: string; body: { pagination?: { token?: string }; data?: string[][]; file?: string } }[] = [];
  let pages = 0, bulks = 0, reads = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === 'find-companies') return Response.json({ success: true, leads: [] }); // the company fallback finds none here
    if (path === 'find-people') {
      const n = ++pages; if (o.onPage) await o.onPage(n);
      const page = o.pages[body.pagination?.token ? Number(body.pagination.token.slice(1)) : 0] ?? { leads: [] };
      return Response.json({ success: true, leads: page.leads, ...(page.token ? { pagination: { token: page.token } } : {}) });
    }
    if (path === 'bulk-search') {
      const n = ++bulks; if (o.onBulk) { const r = await o.onBulk(n); if (r) return r; }
      return Response.json({ success: true, file: 'file' + n });
    }
    if (path === 'bulk-single-searchs/read') {
      const n = ++reads; if (o.onRead) await o.onRead(n);
      return Response.json({ success: true, items: (o.files ?? [])[Number(String(body.file).slice(4)) - 1] ?? [] });
    }
    throw Error('unexpected ' + path);
  };
  return { calls, client: new IcypeasClient('k', transport), count: (p: string) => calls.filter(c => c.path === p).length };
}
async function setup(balance = 10) {
  const store = await testStore();
  const user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', balance);
  const admin = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin');
  return { store, user, admin };
}
const one = <T>(store: Store, sql: string, ...p: unknown[]) => store.db.get<T>(sql, ...p);

// A request killed (60 s cap) while collecting people: the people it picked are saved with the search, so the next poll
// resumes with them; if the member abandons the search instead, closing it releases them for the next search.
function killedWhileCollecting() {
  const ppl = Array.from({ length: 25 }, (_, i) => lead('p' + i));
  return mock({ pages: [{ leads: ppl.slice(0, 6), token: 't1' }, { leads: ppl.slice(6) }], onPage: n => n === 2 ? new Promise<void>(() => {}) : undefined }); // page 2 never returns
}
test('killed mid-searching: the next poll resumes with the people already picked, none are burned', async () => {
  const m = killedWhileCollecting(), { store, user } = await setup();
  try {
    void live(store, m.client).start(user.id, input(3)); // want = 10 -> page 1 gives 6, page 2 hangs
    while (m.count('find-people') < 2) await tick();
    await store.db.run('UPDATE provider_runs SET updated_at=0'); // > 90 s later, a poll from another instance
    const s = await live(new Store(store.db), m.client).poll(user.id, (await one<{ id: string }>(store, 'SELECT id FROM searches'))!.id);
    assert.equal(s.status, 'awaiting_provider');
    const sent = m.calls.find(c => c.path === 'bulk-search')!.body.data!.map(r => r[1]);
    assert.deepEqual(sent.slice(0, 6), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'the people picked before the kill are sent first');
    assert.equal((await one<{ n: number }>(store, 'SELECT count(*)::int n FROM provider_seen'))!.n, sent.length, 'every claimed person was sent');
  } finally { await store.close(); }
});
test('killed mid-searching, then abandoned: closing it releases the people never sent', async () => {
  const m = killedWhileCollecting(), { store, user } = await setup();
  try {
    void live(store, m.client).start(user.id, input(3));
    while (m.count('find-people') < 2) await tick();
    const first = (await one<{ id: string }>(store, 'SELECT id FROM searches'))!.id;
    await store.db.run('UPDATE provider_runs SET updated_at=0'); // the member left; a new search closes the old one
    await live(new Store(store.db), m.client).start(user.id, input(1));
    assert.equal((await store.getSearch(user.id, first)).status, 'partial');
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')!.body.data!.map(r => r[1]).slice(0, 4), ['p0', 'p1', 'p2', 'p3'], 'released people are offered again first');
  } finally { await store.close(); }
});

// A run left in 'delivering' by a request killed under the previous code: the next poll re-reads the (repeatable, already
// paid) results instead of closing the search.
test('killed during delivery: the stale poll must re-deliver the paid batch, not close it', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }], files: [[item(0, 'a@company-a.example'), item(1, 'b@company-b.example'), item(2, null)]] });
  const { store, user } = await setup();
  try {
    const s = await live(store, m.client).start(user.id, input(2));
    // Exactly the state a killed poll leaves: claim committed, delivery transaction rolled back with the connection.
    await store.db.run("UPDATE provider_runs SET phase='delivering', updated_at=0");
    let r = await live(new Store(store.db), m.client).poll(user.id, s.id);
    for (let i = 0; i < 3 && r.status === 'awaiting_provider'; i++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); r = await live(store, m.client).poll(user.id, s.id); }
    assert.equal(r.delivered, 2, `found emails paid at the provider were dropped: status=${r.status}, delivered=${r.delivered}`);
  } finally { await store.close(); }
});

// Past the 15-minute batch deadline, a transient read error keeps the batch for the next poll.
test('expired batch + one transient read error: the batch must survive for the next poll', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b'].map(lead) }], files: [[item(0, 'a@company-a.example'), item(1, 'b@company-b.example')]], onRead: n => { if (n === 1) throw new Error('blip'); } });
  const { store, user } = await setup();
  try {
    const s = await live(store, m.client).start(user.id, input(2));
    await store.db.run('UPDATE provider_runs SET submitted_at=?, updated_at=0', Date.now() - 20 * 60000); // member returns 20 min later (tab was closed)
    let r = await live(store, m.client).poll(user.id, s.id);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    r = await live(store, m.client).poll(user.id, s.id);
    assert.equal(r.delivered, 2, `batch lost on a single blip: status=${r.status}, delivered=${r.delivered}`);
  } finally { await store.close(); }
});
test('results that keep failing to read (10 in a row, past the deadline) close the batch with what was delivered', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b'].map(lead) }], onRead: () => { throw new Error('down'); } });
  const { store, user } = await setup();
  try {
    const s = await live(store, m.client).start(user.id, input(2));
    await store.db.run('UPDATE provider_runs SET submitted_at=?, updated_at=0', Date.now() - 61 * 60000);
    assert.equal((await live(store, m.client).poll(user.id, s.id)).status, 'awaiting_provider', 'one error, even an hour later, closes nothing');
    await store.db.run('UPDATE provider_runs SET read_errors=9, updated_at=0');
    const r = await live(store, m.client).poll(user.id, s.id);
    assert.equal(r.status, 'partial', 'the tenth failed read in a row closes it');
    assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

// The reservation is what open searches can still charge: requested minus delivered.
test('reservation must shrink as emails are delivered (member can afford a second search)', async () => {
  const { store, user, admin } = await setup(10);
  try {
    const a = await store.enqueueSearch(user.id, input(5));
    await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?", a.id);
    const c = (e: string): Candidate => ({ name: e, email: e + '@x.example', company: 'C', title: '', sector: '', country: '', city: '', website: '', size: '', source: 'Icypeas', email_status: 'VERIFIED' });
    await store.deliverBatch(user.id, a.id, ['a', 'b', 'c', 'd'].map(c)); // 4 of 5 delivered: balance 6, A can charge at most 1 more
    assert.equal((await store.user(user.id)).balance, 6);
    const b = await store.enqueueSearch(user.id, input(5)).then(() => 'ok', (e: Error) => e.message); // 6 - 1 = 5 available
    const set = await store.adjustCredits(admin.id, user.id, 'set', 6, 'correction', randomUUID()).then(() => 'ok', (e: Error) => e.message); // 6 >= 1 + 5 still chargeable
    assert.deepEqual([b, set], ['ok', 'ok'], 'over-reserved: blocks affordable search and owner correction');
  } finally { await store.close(); }
});

// Provider refuses the batch (InsufficientCredits): the picked people go back to the front of the member's list, so the
// retry (after a top-up) resends them instead of paying for new pages.
test('provider out of credits: a retry must resubmit the same people, not burn new pages', async () => {
  const ppl = Array.from({ length: 25 }, (_, i) => lead('p' + i));
  let broke = true;
  const m = mock({ pages: [{ leads: ppl.slice(0, 12), token: 't1' }, { leads: ppl.slice(12) }],
    onBulk: () => broke ? Response.json({ success: false, validationErrors: [{ type: 'InsufficientCredits' }] }) : undefined });
  const { store, user } = await setup();
  try {
    const r1 = await live(store, m.client).start(user.id, input(3)); // want 10
    assert.equal(r1.status, 'failed');
    const first = m.calls.find(c => c.path === 'bulk-search')!.body.data!.map(r => r[1]);
    broke = false; // owner tops up the provider, member retries (new request id)
    await live(store, m.client).start(user.id, input(3));
    const second = m.calls.filter(c => c.path === 'bulk-search')[1].body.data!.map(r => r[1]);
    assert.deepEqual(second, first, `retry skipped the refused people ${first.join(',')} and sent ${second.join(',')}`);
  } finally { await store.close(); }
});

// Two serverless instances each keep their own 1/s bulk spacing: a 429 on the paid submit is retried once.
test('two instances submitting in the same second: the second search must not fail on a 429', async () => {
  let last = 0;
  const m = mock({ pages: [{ leads: Array.from({ length: 25 }, (_, i) => lead('p' + i)) }],
    onBulk: () => { const t = Date.now(), tooSoon = t - last < 1000; last = t; return tooSoon ? Response.json({}, { status: 429 }) : undefined; } });
  const { store, user } = await setup(20);
  const bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 20);
  const gaps = { read: 2100, bulk: 1100 };
  try {
    const [a, b] = await Promise.all([
      new LiveSearch(store, m.client, gaps, { read: 0, bulk: 0 }).start(user.id, input(2)),  // instance 1
      new LiveSearch(store, m.client, gaps, { read: 0, bulk: 0 }).start(bob.id, input(2)),   // instance 2
    ]);
    assert.deepEqual([a.status, b.status], ['awaiting_provider', 'awaiting_provider'], `statuses ${a.status}/${b.status}: ${b.message || a.message}`);
  } finally { await store.close(); }
});

// One HTTP request makes at most 3 paid page calls (each up to 20 s), then pauses; the next poll continues.
// Worst case: the member re-runs filters whose people were all tried already.
test('one request is bounded in sequential provider calls (fits the 60 s function cap)', async () => {
  const people = Array.from({ length: 1000 }, (_, i) => lead('p' + i));
  const pages = Array.from({ length: 40 }, (_, i) => ({ leads: people.slice(i * 25, i * 25 + 25), token: i < 39 ? 't' + (i + 1) : undefined }));
  const m = mock({ pages });
  const { store, user } = await setup(60);
  try {
    for (const p of people) await store.claimPerson(user.id, personKey(p), 'Person ' + p.lastname, p.lastCompanyName);
    await live(store, m.client).start(user.id, input(50));
    assert.ok(m.count('find-people') <= 3, `one request made ${m.count('find-people')} sequential paid page calls (20 s timeout each, 0.5 credit each)`);
  } finally { await store.close(); }
});

// A connection that never opened sent nothing: retried once, and if it fails again the search fails cleanly (not "uncertain").
test('a paid submit that never connected is retried once, then fails cleanly with the people released', async () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  const m = mock({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }], onBulk: () => { throw refused(); } });
  const { store, user } = await setup();
  try {
    const r = await live(store, m.client).start(user.id, input(2));
    assert.equal(m.count('bulk-search'), 2, 'one retry');
    assert.equal(r.status, 'failed', 'nothing reached the provider: a clean failure the member can retry');
    assert.equal((await one<{ n: number }>(store, 'SELECT count(*)::int n FROM provider_seen'))!.n, 0);
  } finally { await store.close(); }
});

// Two batches can pass the provider's balance check together; rows it could not pay for end INSUFFICIENT_FUNDS.
test('rows the provider could not pay for end the search with the provider-balance message, and those people are released', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }], files: [[item(0, 'a@company-a.example'), { _id: 'x', status: 'INSUFFICIENT_FUNDS', userData: { externalId: '1' } }, { _id: 'y', status: 'INSUFFICIENT_FUNDS', userData: { externalId: '2' } }]] });
  const { store, user } = await setup();
  try {
    const s = await live(store, m.client).start(user.id, input(3));
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const r = await live(store, m.client).poll(user.id, s.id);
    assert.equal(r.delivered, 1);
    assert.equal(r.status, 'partial');
    assert.match(r.message!, /رصيد مزوّد البيانات/);
    assert.equal(m.count('bulk-search'), 1, 'no further batch while the provider is out of credit');
    assert.equal((await one<{ n: number }>(store, 'SELECT count(*)::int n FROM provider_seen'))!.n, 1, 'b and c were never searched');
  } finally { await store.close(); }
});

// An interrupted submit after emails were already delivered in this search: finish with what arrived, not "unknown".
test('a stale submit after earlier deliveries closes the search with what arrived', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }] });
  const { store, user } = await setup();
  try {
    const s = await live(store, m.client).start(user.id, input(3));
    await store.db.run("UPDATE searches SET delivered=1 WHERE id=?", s.id);
    await store.db.run("UPDATE provider_runs SET phase='submitting', updated_at=0");
    const r = await live(store, m.client).poll(user.id, s.id);
    assert.equal(r.status, 'partial');
    assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

// Members pay only for delivered emails; the provider is paid for every person fetched. A daily cap keeps one member from
// spending the provider account on searches that deliver little (owner's decision 2026-09-30: 1,000 people a day).
test('a member\'s provider work is capped at 1,000 people a day: new searches are refused, a running one stops', async () => {
  const m = mock({ pages: [{ leads: Array.from({ length: 25 }, (_, i) => lead('p' + i)), token: 't1' }, { leads: Array.from({ length: 25 }, (_, i) => lead('q' + i)) }] });
  const { store, user } = await setup(50);
  try {
    const earlier = await live(store, m.client).start(user.id, input(1)); // earlier today: 990 people fetched
    await store.db.run('UPDATE provider_runs SET fetched=990 WHERE search_id=?', earlier.id);
    await store.db.run("UPDATE searches SET status='completed' WHERE id=?", earlier.id); await store.db.run('DELETE FROM reservations');
    const before = m.count('find-people'), s = await live(store, m.client).start(user.id, input(20));
    assert.equal(m.count('find-people'), before + 1, 'one page reaches the cap, none past it');
    assert.equal(s.status, 'awaiting_provider', 'the people picked before the cap are still searched');
    await assert.rejects(live(store, m.client).start(user.id, input(1)), (e: Error) => /حد البحث اليومي/.test(e.message));
  } finally { await store.close(); }
});

// The owner sees failed or uncertain searches in the activity log, not only in the server log.
test('a failed search is recorded in the owner\'s activity log with the member and the reason', async () => {
  const m = mock({ pages: [{ leads: ['a', 'b'].map(lead) }], onBulk: () => Response.json({ success: false, validationErrors: [{ type: 'InsufficientCredits' }] }) });
  const { store, user, admin } = await setup();
  try {
    await live(store, m.client).start(user.id, input(2));
    const audit = (await store.snapshot(admin.id)).admin!.audit;
    assert.ok(audit.some(a => a.action.includes('تنبيه') && a.detail.includes('Alice') && a.detail.includes('رصيد مزوّد البيانات')), JSON.stringify(audit));
  } finally { await store.close(); }
});
