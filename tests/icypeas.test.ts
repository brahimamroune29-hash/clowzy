import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IcypeasClient, IcypeasError, peopleQuery, safeWebsite } from '../src/lib/icypeas';
import { LiveSearch } from '../src/lib/live-search';
import { Store } from '../src/lib/store';
import type { SearchInput } from '../src/lib/contracts';

const input = (count = 2): SearchInput => ({ sector: 'التقنية والبرمجيات', country: 'السعودية', city: '', title: '', size: 'all', count, confirmed: true, requestId: randomUUID() });
const lead = (id: string) => ({ firstname: 'Person', lastname: id, profileUrl: 'https://www.linkedin.com/in/' + id, lastJobTitle: 'CEO', address: 'Riyadh, Riyadh, Saudi Arabia', lastCompanyName: 'Company ' + id, lastCompanyWebsite: 'https://www.company-' + id + '.example/about', lastCompanyIndustry: 'Software Development', lastCompanySize: 12 });
const item = (i: number, email: string | null, certainty = 'ultra_sure', status = email ? 'DEBITED' : 'DEBITED_NOT_FOUND') => ({ _id: 'item' + i, status, userData: { externalId: String(i) }, results: { emails: email ? [{ email, certainty }] : [] } });
const fresh = () => ({ gaps: { read: 0, bulk: 0 }, slots: { read: 0, bulk: 0 } });
const live = (store: Store, client: IcypeasClient, o = fresh()) => new LiveSearch(store, client, o.gaps, o.slots);

// pages: find-people pages, a page's token points at the next page ('t1' -> pages[1]). files: result rows per bulk submission.
function mockTransport(o: { pages?: { leads: unknown[]; token?: string }[]; broad?: { leads: unknown[]; token?: string }[]; files?: unknown[][]; bulkThrow?: boolean; bulkHttp?: number; http?: number; expired?: string } = {}) {
  type Body = { query?: { location?: { include?: string[]; exclude?: string[] } }; pagination?: { size?: number; token?: string }; data?: string[][]; file?: string };
  const calls: { path: string; body: Body }[] = [];
  let submitted = 0;
  const pages = o.pages ?? [{ leads: [lead('a'), lead('b'), lead('c')] }];
  const files = o.files ?? [[item(0, 'a@company-a.example'), item(1, 'b@company-b.example', 'probable'), item(2, 'c@company-c.example', 'very_sure'), { _id: 'bad', status: 'DEBITED', results: 'oops' }]];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'unit-test-secret');
    assert.equal(init?.redirect, 'error');
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (o.http) return Response.json({}, { status: o.http });
    if (path === 'find-people/count') return Response.json({ success: true, total: 5 });
    if (path === 'find-people') {
      if (o.expired && body.pagination?.token === o.expired) return Response.json({ success: false, validationErrors: ['token expired'] });
      const list = body.query?.location?.exclude ? (o.broad ?? []) : pages;
      const page = list[body.pagination?.token ? Number(body.pagination.token.slice(1)) : 0] ?? { leads: [] };
      return Response.json({ success: true, total: 99, leads: page.leads, ...(page.token ? { pagination: { size: 100, token: page.token } } : {}) });
    }
    if (path === 'bulk-search') {
      if (o.bulkThrow) throw new Error('timeout includes unit-test-secret');
      if (o.bulkHttp) return Response.json({}, { status: o.bulkHttp });
      return Response.json({ success: true, file: 'file' + ++submitted, status: 'in_progress' });
    }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: files[Number(String(body.file).slice(4)) - 1] ?? [], sorts: [[], []] });
    throw Error('Unexpected path ' + path);
  };
  return { calls, client: new IcypeasClient('unit-test-secret', transport), count: (p: string) => calls.filter(c => c.path === p).length };
}
function setup(file = ':memory:') {
  const store = new Store(file), user = store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10), bob = store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 10);
  return { store, user, bob };
}
const eligible = (store: Store) => store.db.prepare('UPDATE provider_runs SET updated_at=0').run();

test('query: country code first, then name-only people; city narrowed; headcount range; Arabic free text is a 400', () => {
  const q = peopleQuery({ ...input(), country: 'الإمارات', city: 'دبي', size: '11-50' });
  assert.deepEqual(q.location, { include: ['Dubai, AE'] });
  assert.deepEqual(peopleQuery({ ...input(), country: 'الإمارات', city: 'دبي' }, 1).location, { include: ['Dubai, United Arab Emirates'], exclude: ['Dubai, AE'] });
  assert.deepEqual(peopleQuery(input(), 1).location, { include: ['Saudi Arabia'], exclude: ['SA'] });
  assert.deepEqual(q['currentCompany.industry'], { include: ['Software Development', 'IT Services and IT Consulting'] });
  assert.deepEqual(q['currentCompany.headcount'], { '>=': 11, '<=': 50 });
  for (const [country, cc, name] of [['قطر', 'QA', 'Qatar'], ['الكويت', 'KW', 'Kuwait'], ['البحرين', 'BH', 'Bahrain'], ['عُمان', 'OM', 'Oman']] as const) {
    assert.deepEqual(peopleQuery({ ...input(), country }).location, { include: [cc] });
    assert.deepEqual(peopleQuery({ ...input(), country }, 1).location, { include: [name], exclude: [cc] });
  }
  assert.throws(() => peopleQuery({ ...input(), title: 'مدير' }), (e: IcypeasError) => e.status === 400);
  assert.equal(safeWebsite('javascript:alert(1)'), ''); assert.equal(safeWebsite('company.example'), 'https://company.example/');
});

test('start is paid once per request; only ultra/very sure emails are delivered and charged; malformed rows are skipped', async () => {
  const { store, user, bob } = setup(), m = mockTransport(), search = live(store, m.client), request = input();
  try {
    const [first, repeated] = await Promise.all([search.start(user.id, request), search.start(user.id, request)]);
    assert.equal(first.id, repeated.id); assert.equal(first.status, 'awaiting_provider'); assert.equal(store.reserved(user.id), 2);
    assert.equal(m.count('bulk-search'), 1);
    assert.equal(m.calls.find(c => c.path === 'find-people')?.body.pagination?.size, 25, 'small constant pages (0.02 each), not 100');
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')?.body.data, [['Person', 'a', 'company-a.example'], ['Person', 'b', 'company-b.example'], ['Person', 'c', 'company-c.example']]);
    await assert.rejects(search.poll(bob.id, first.id));
    eligible(store); const done = await search.poll(user.id, first.id);
    assert.equal(done.status, 'completed'); assert.equal(done.delivered, 2);
    assert.deepEqual(store.snapshot(user.id).contacts.map(c => c.email).sort(), ['a@company-a.example', 'c@company-c.example'], 'probable email is not delivered');
    assert.equal(store.user(user.id).balance, 8); assert.equal(store.reserved(user.id), 0);
    const contact = store.snapshot(user.id).contacts[0];
    assert.equal(contact.source, 'Icypeas'); assert.equal(contact.email_status, 'VERIFIED'); assert.equal(contact.sector, 'التقنية والبرمجيات');
    eligible(store); await search.poll(user.id, first.id); await search.start(user.id, request);
    assert.equal(m.count('bulk-search'), 1); assert.equal(store.user(user.id).balance, 8);
  } finally { store.close(); }
});

test('short first batch tops up with the next people page, never submitting more than 5x the requested count', async () => {
  const pages = [{ leads: ['a', 'b', 'c', 'd'].map(lead), token: 't1' }, { leads: [lead('e'), lead('f')] }];
  const m = mockTransport({ pages, files: [[0, 1, 2, 3].map(i => item(i, null)), [item(0, 'e@company-e.example')]] });
  const { store, user } = setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1));
    eligible(store); const done = await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-search'), 2, 'second batch after the first found nothing');
    assert.equal(m.calls.filter(c => c.path === 'find-people')[1]?.body.pagination?.token, 't1');
    const sent = m.calls.filter(c => c.path === 'bulk-search').flatMap(c => c.body.data ?? []);
    assert.equal(sent.length, 5, 'cap: 5 people for 1 requested email');
    eligible(store); const final = await search.poll(user.id, done.id);
    assert.equal(final.status, 'completed'); assert.equal(final.delivered, 1); assert.equal(store.user(user.id).balance, 9);
  } finally { store.close(); }
});

test('people already sent for this member are not paid for again by a later search', async () => {
  const m = mockTransport({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }], files: [[item(0, 'a@company-a.example'), item(1, null), item(2, null)]] });
  const { store, user, bob } = setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1)); eligible(store); await search.poll(user.id, first.id);
    const again = await search.start(user.id, input(1));
    assert.equal(again.status, 'partial'); assert.equal(again.delivered, 0); assert.equal(m.count('bulk-search'), 1);
    assert.equal(store.reserved(user.id), 0); assert.equal(store.user(user.id).balance, 9);
    await search.start(bob.id, input(1));
    assert.equal(m.count('bulk-search'), 2, 'another member is not affected by Alice\'s history');
  } finally { store.close(); }
});

test('a batch that never completes is closed after the deadline and the reservation is released', async () => {
  const m = mockTransport({ files: [[item(0, null, 'x', 'IN_PROGRESS')]] });
  const { store, user } = setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input());
    eligible(store); assert.equal((await search.poll(user.id, first.id)).status, 'awaiting_provider');
    assert.equal(store.reserved(user.id), 2);
    store.db.prepare('UPDATE provider_runs SET submitted_at=0,updated_at=0').run();
    const closed = await search.poll(user.id, first.id);
    assert.equal(closed.status, 'partial'); assert.equal(store.reserved(user.id), 0); assert.equal(store.user(user.id).balance, 10);
  } finally { store.close(); }
});

test('one results read per poll, spaced by the shared account budget', async () => {
  const m = mockTransport({ files: [[item(0, null, 'x', 'IN_PROGRESS')]] });
  const { store, user } = setup(), search = live(store, m.client, { gaps: { read: 60000, bulk: 0 }, slots: { read: 0, bulk: 0 } });
  try {
    const first = await search.start(user.id, input());
    eligible(store); await search.poll(user.id, first.id); eligible(store); await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-single-searchs/read'), 1);
  } finally { store.close(); }
});

test('lost bulk submission is marked unknown, never retried, never debits the member or leaks the key', async () => {
  const { store, user } = setup(), m = mockTransport({ bulkThrow: true }), search = live(store, m.client), request = input();
  try {
    const first = await search.start(user.id, request);
    assert.equal(first.status, 'unknown'); assert.ok(!first.message?.includes('unit-test-secret'));
    await search.start(user.id, request); await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-search'), 1); assert.equal(store.user(user.id).balance, 10); assert.equal(store.reserved(user.id), 0);
  } finally { store.close(); }
});

test('no people never reaches the paid email search; restart resumes a waiting batch without resubmitting', async () => {
  const empty = setup(), m0 = mockTransport({ pages: [{ leads: [] }] });
  try {
    const r = await live(empty.store, m0.client).start(empty.user.id, input());
    assert.equal(r.delivered, 0); assert.equal(m0.count('bulk-search'), 0); assert.equal(empty.store.reserved(empty.user.id), 0);
  } finally { empty.store.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'clowzy-icy-')), file = join(dir, 'db.sqlite'), { store, user } = setup(file), m = mockTransport();
  try {
    const first = await live(store, m.client).start(user.id, input()); store.close();
    const reopened = new Store(file);
    try { eligible(reopened); assert.equal((await live(reopened, m.client).poll(user.id, first.id)).delivered, 2); assert.equal(m.count('bulk-search'), 1); }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disabling a member cancels their waiting search and releases the reservation', async () => {
  const { store, user } = setup(), admin = store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin'), m = mockTransport();
  try {
    const first = await live(store, m.client).start(user.id, input());
    store.setActive(admin.id, user.id, false);
    assert.equal(store.db.prepare('SELECT status FROM searches WHERE id=?').get(first.id)?.status, 'cancelled');
    assert.equal(store.reserved(user.id), 0);
  } finally { store.close(); }
});

test('missing key never calls the provider; provider errors are clear', async () => {
  let called = false;
  const client = new IcypeasClient('', async () => { called = true; return Response.json({}); });
  await assert.rejects(client.people(input()), (e: IcypeasError) => e.status === 503); assert.equal(called, false);
  await assert.rejects(mockTransport({ http: 401 }).client.verify(), /غير صالح/);
});


test('two overlapping polls deliver once and submit the next batch once (no paid-but-lost batch)', async () => {
  const pages = [{ leads: ['a', 'b', 'c', 'd'].map(lead), token: 't1' }, { leads: [lead('e')] }];
  const m = mockTransport({ pages, files: [[0, 1, 2, 3].map(i => item(i, null)), [item(0, 'e@company-e.example')]] });
  const { store, user } = setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1));
    eligible(store); const p1 = search.poll(user.id, first.id);
    eligible(store); const p2 = search.poll(user.id, first.id); // a second tab while the first read is in flight
    await Promise.all([p1, p2]);
    assert.equal(m.count('bulk-search'), 2, 'initial batch + exactly one follow-up');
    assert.ok((store.db.prepare('SELECT submitted FROM provider_runs').get()?.submitted as number) <= 5, '5x cap holds');
    eligible(store); const final = await search.poll(user.id, first.id);
    assert.equal(final.delivered, 1, 'the follow-up batch paid at the provider is delivered, not orphaned');
    assert.equal(store.user(user.id).balance, 9); assert.equal(store.reserved(user.id), 0);
  } finally { store.close(); }
});

test('a repeat search continues from the member\'s cursor (leftovers, then the next page) instead of rescanning the top', async () => {
  const pages = [{ leads: ['a', 'b', 'c', 'd', 'e'].map(lead), token: 't1' }, { leads: ['f', 'g', 'h'].map(lead) }];
  const m = mockTransport({ pages, files: [[item(0, 'a@company-a.example')], [item(0, 'e@company-e.example')]] });
  const { store, user } = setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1)); eligible(store); await search.poll(user.id, first.id);
    const before = m.calls.filter(c => c.path === 'find-people').length;
    await search.start(user.id, input(1));
    const second = m.calls.filter(c => c.path === 'find-people').slice(before);
    assert.deepEqual(second.map(c => c.body.pagination?.token), ['t1'], 'continues at page 2, never page 1 again');
    assert.deepEqual(m.calls.filter(c => c.path === 'bulk-search')[1]?.body.data?.map(r => r[1]), ['e', 'f', 'g', 'h']);
  } finally { store.close(); }
});

test('an expired cursor restarts from the top; a rejected submission frees the people it picked', async () => {
  const m = mockTransport({ expired: 'old' }), { store, user } = setup();
  try {
    store.saveCursor(user.id, JSON.stringify(peopleQuery(input())), 0, 'old', '[]');
    const r = await live(store, m.client).start(user.id, input());
    assert.deepEqual(m.calls.filter(c => c.path === 'find-people').slice(0, 2).map(c => c.body.pagination?.token), ['old', undefined], 'expired token, then the same stage from the top');
    assert.equal(r.status, 'awaiting_provider'); assert.equal(m.count('bulk-search'), 1);
  } finally { store.close(); }
  const m2 = mockTransport({ bulkHttp: 429 }), s2 = setup();
  try {
    const r = await live(s2.store, m2.client).start(s2.user.id, input());
    assert.equal(r.status, 'failed'); assert.equal(s2.store.reserved(s2.user.id), 0);
    assert.equal(s2.store.db.prepare('SELECT count(*) n FROM provider_seen').get()?.n, 0, 'nothing reached the provider');
  } finally { s2.store.close(); }
});

test('people matched by country code are used first; name-only matches fill the batch after them', async () => {
  const m = mockTransport({ pages: [{ leads: [lead('a')] }], broad: [{ leads: [lead('b')] }], files: [[item(0, 'a@company-a.example'), item(1, null)]] });
  const { store, user } = setup();
  try {
    await live(store, m.client).start(user.id, input(1));
    assert.deepEqual(m.calls.filter(c => c.path === 'find-people').map(c => c.body.query?.location), [{ include: ['SA'] }, { include: ['Saudi Arabia'], exclude: ['SA'] }]);
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')?.body.data?.map(r => r[1]), ['a', 'b']);
  } finally { store.close(); }
});

test('an empty page that still carries a token ends the stage instead of looping', async () => {
  const m = mockTransport({ pages: [{ leads: [], token: 't0' }], broad: [] });
  const { store, user } = setup();
  try {
    const r = await live(store, m.client).start(user.id, input(1));
    assert.ok(m.count('find-people') <= 3, `bounded page calls, got ${m.count('find-people')}`);
    assert.equal(r.status, 'partial'); assert.equal(store.reserved(user.id), 0);
  } finally { store.close(); }
});

test('a transient error keeps the member\'s cursor; only a rejected token restarts the stage', async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('find-people')) { calls++; if (body.pagination?.token) throw new Error('network blip'); return Response.json({ success: true, leads: [lead('z')] }); }
    return Response.json({ success: true, file: 'file1' });
  };
  const { store, user } = setup(), queryKey = JSON.stringify(peopleQuery(input()));
  try {
    store.saveCursor(user.id, queryKey, 0, 'deep', '[]');
    const r = await live(store, new IcypeasClient('unit-test-secret', transport)).start(user.id, input());
    assert.equal(calls, 1, 'no silent restart from the top after a network error');
    assert.equal(store.cursor(user.id, queryKey).token, 'deep'); assert.equal(r.status, 'failed'); assert.equal(store.reserved(user.id), 0);
  } finally { store.close(); }
});
