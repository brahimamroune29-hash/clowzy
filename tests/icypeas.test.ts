import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IcypeasClient, IcypeasError, peopleQuery, personKey, safeWebsite } from '../src/lib/icypeas';
import { LiveSearch } from '../src/lib/live-search';
import { Store } from '../src/lib/store';
import { expectedEmails, type SearchInput } from '../src/lib/contracts';
import { hookDb, testStore } from './pg';

const input = (count = 2): SearchInput => ({ sector: 'التقنية والبرمجيات', country: 'السعودية', city: '', title: '', size: 'all', count, confirmed: true, requestId: randomUUID() });
const lead = (id: string) => ({ firstname: 'Person', lastname: id, profileUrl: 'https://www.linkedin.com/in/' + id, lastJobTitle: 'CEO', address: 'Riyadh, Riyadh, Saudi Arabia', lastCompanyName: 'Company ' + id, lastCompanyWebsite: 'https://www.company-' + id + '.example/about', lastCompanyIndustry: 'Software Development', lastCompanySize: 12 });
const item = (i: number, email: string | null, certainty = 'ultra_sure', status = email ? 'DEBITED' : 'DEBITED_NOT_FOUND') => ({ _id: 'item' + i, status, userData: { externalId: String(i) }, results: { emails: email ? [{ email, certainty }] : [] } });
const fresh = () => ({ gaps: { read: 0, bulk: 0 }, slots: { read: 0, bulk: 0 } });
const live = (store: Store, client: IcypeasClient, o = fresh()) => new LiveSearch(store, client, o.gaps, o.slots);

// pages: find-people pages, a page's token points at the next page ('t1' -> pages[1]). files: result rows per bulk submission.
function mockTransport(o: { pages?: { leads: unknown[]; token?: string }[]; broad?: { leads: unknown[]; token?: string }[]; files?: unknown[][]; bulkThrow?: boolean; bulkHttp?: number; bulkBody?: unknown; onRead?: (n: number) => Promise<void>; http?: number; expired?: string } = {}) {
  type Body = { query?: { location?: { include?: string[]; exclude?: string[] } }; pagination?: { size?: number; token?: string }; data?: string[][]; file?: string };
  const calls: { path: string; body: Body }[] = [];
  let submitted = 0, reads = 0;
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
      if (o.bulkBody) return Response.json(o.bulkBody);
      return Response.json({ success: true, file: 'file' + ++submitted, status: 'in_progress' });
    }
    if (path === 'bulk-single-searchs/read') {
      const n = ++reads;
      if (o.onRead) await o.onRead(n);
      return Response.json({ success: true, items: files[Number(String(body.file).slice(4)) - 1] ?? [], sorts: [[], []] });
    }
    throw Error('Unexpected path ' + path);
  };
  return { calls, client: new IcypeasClient('unit-test-secret', transport), count: (p: string) => calls.filter(c => c.path === p).length };
}
async function setup() {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 10);
  return { store, user, bob };
}
const eligible = (store: Store) => store.db.run('UPDATE provider_runs SET updated_at=0');

test('query: country code first, then name-only people; city narrowed; headcount range; Arabic free text is a 400', () => {
  const q = peopleQuery({ ...input(), country: 'الإمارات', city: 'دبي', size: '11-50' });
  assert.deepEqual(q.location, { include: ['Dubai, AE'] });
  // The broad stage also matches Arabic-localized profiles ("<province> <city> <country>") by "<city> <country>" phrases.
  assert.deepEqual(peopleQuery({ ...input(), country: 'الإمارات', city: 'دبي' }, 1).location, { include: ['Dubai, United Arab Emirates', 'دبي الإمارات'], exclude: ['Dubai, AE'] });
  assert.deepEqual(peopleQuery({ ...input(), city: 'مكة' }, 1).location.include, ['Mecca, Saudi Arabia', 'مكة السعودية'], 'never bare مكة: Jeddah addresses start with the province مكة');
  assert.deepEqual(peopleQuery({ ...input(), city: 'Jeddah' }, 1).location.include, ['Jeddah, Saudi Arabia', 'جدة السعودية'], 'typed in English: the same query as جدة');
  assert.deepEqual(peopleQuery({ ...input(), city: 'دبي' }, 1).location.include, ['Dubai, Saudi Arabia', 'دبي السعودية'], 'scoped to the chosen country');
  assert.deepEqual(peopleQuery({ ...input(), country: 'عُمان', city: 'مسقط' }, 1).location.include, ['Muscat, Oman', 'مسقط عمان'], 'addresses spell عمان without diacritics');
  assert.deepEqual(peopleQuery({ ...input(), country: 'الجزائر', city: 'الجزائر' }, 1).location.include, ['Algiers, Algeria', 'الجزائر الجزائر', 'الجزائر العاصمة الجزائر']);
  assert.deepEqual(peopleQuery({ ...input(), city: 'Tabuk' }, 1).location, { include: ['Tabuk, Saudi Arabia'], exclude: ['Tabuk, SA'] });
  assert.deepEqual(peopleQuery({ ...input(), city: 'constructor' }, 1).location.include, ['constructor, Saudi Arabia'], 'object property names are plain text, not a crash');
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
  const { store, user, bob } = await setup(), m = mockTransport(), search = live(store, m.client), request = input();
  try {
    const [first, repeated] = await Promise.all([search.start(user.id, request), search.start(user.id, request)]);
    assert.equal(first.id, repeated.id); assert.equal(first.status, 'awaiting_provider'); assert.equal(await store.reserved(user.id), 2);
    assert.equal(m.count('bulk-search'), 1);
    assert.equal(m.calls.find(c => c.path === 'find-people')?.body.pagination?.size, 25, 'small constant pages (0.02 each), not 100');
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')?.body.data, [['Person', 'a', 'company-a.example'], ['Person', 'b', 'company-b.example'], ['Person', 'c', 'company-c.example']]);
    await assert.rejects(search.poll(bob.id, first.id));
    await eligible(store); const done = await search.poll(user.id, first.id);
    assert.equal(done.status, 'completed'); assert.equal(done.delivered, 2);
    assert.deepEqual((await store.snapshot(user.id)).contacts.map(c => c.email).sort(), ['a@company-a.example', 'c@company-c.example'], 'probable email is not delivered');
    assert.equal((await store.user(user.id)).balance, 8); assert.equal(await store.reserved(user.id), 0);
    const contact = (await store.snapshot(user.id)).contacts[0];
    assert.equal(contact.source, 'Icypeas'); assert.equal(contact.email_status, 'VERIFIED'); assert.equal(contact.sector, 'التقنية والبرمجيات');
    await eligible(store); await search.poll(user.id, first.id); await search.start(user.id, request);
    assert.equal(m.count('bulk-search'), 1); assert.equal((await store.user(user.id)).balance, 8);
  } finally { await store.close(); }
});

test('short batches top up from the next people page, never submitting more than 10x the requested count', async () => {
  const pages = [{ leads: ['a', 'b', 'c', 'd'].map(lead), token: 't1' }, { leads: ['e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(lead) }];
  const nf = (n: number) => Array.from({ length: n }, (_, i) => item(i, null));
  const m = mockTransport({ pages, files: [nf(4), nf(4), [item(0, 'i@company-i.example'), item(1, null)]] });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1));
    let final = first;
    for (let i = 0; i < 5 && final.status === 'awaiting_provider'; i++) { await eligible(store); final = await search.poll(user.id, first.id); }
    assert.equal(m.calls.filter(c => c.path === 'find-people')[1]?.body.pagination?.token, 't1');
    const sent = m.calls.filter(c => c.path === 'bulk-search').flatMap(c => c.body.data ?? []);
    assert.equal(sent.length, 10, 'cap: 10 people for 1 requested email');
    assert.equal(final.status, 'completed'); assert.equal(final.delivered, 1); assert.equal((await store.user(user.id)).balance, 9);
  } finally { await store.close(); }
});

test('people already sent for this member are not paid for again by a later search', async () => {
  const m = mockTransport({ pages: [{ leads: ['a', 'b', 'c'].map(lead) }], files: [[item(0, 'a@company-a.example'), item(1, null), item(2, null)]] });
  const { store, user, bob } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1)); await eligible(store); await search.poll(user.id, first.id);
    const again = await search.start(user.id, input(1));
    assert.equal(again.status, 'partial'); assert.equal(again.delivered, 0); assert.equal(m.count('bulk-search'), 1);
    assert.equal(await store.reserved(user.id), 0); assert.equal((await store.user(user.id)).balance, 9);
    await search.start(bob.id, input(1));
    assert.equal(m.count('bulk-search'), 2, 'another member is not affected by Alice\'s history');
  } finally { await store.close(); }
});

test('a batch that never completes is closed after the deadline and the reservation is released', async () => {
  const m = mockTransport({ files: [[item(0, null, 'x', 'IN_PROGRESS')]] });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input());
    await eligible(store); assert.equal((await search.poll(user.id, first.id)).status, 'awaiting_provider');
    assert.equal(await store.reserved(user.id), 2);
    await store.db.run('UPDATE provider_runs SET submitted_at=0,updated_at=0');
    const closed = await search.poll(user.id, first.id);
    assert.equal(closed.status, 'partial'); assert.equal(await store.reserved(user.id), 0); assert.equal((await store.user(user.id)).balance, 10);
  } finally { await store.close(); }
});

test('one results read per poll, spaced by the shared account budget', async () => {
  const m = mockTransport({ files: [[item(0, null, 'x', 'IN_PROGRESS')]] });
  const { store, user } = await setup(), search = live(store, m.client, { gaps: { read: 60000, bulk: 0 }, slots: { read: 0, bulk: 0 } });
  try {
    const first = await search.start(user.id, input());
    await eligible(store); await search.poll(user.id, first.id); await eligible(store); await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-single-searchs/read'), 1);
  } finally { await store.close(); }
});

test('lost bulk submission is marked unknown, never retried, never debits the member or leaks the key', async () => {
  const { store, user } = await setup(), m = mockTransport({ bulkThrow: true }), search = live(store, m.client), request = input();
  try {
    const first = await search.start(user.id, request);
    assert.equal(first.status, 'unknown'); assert.ok(!first.message?.includes('unit-test-secret'));
    await search.start(user.id, request); await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-search'), 1); assert.equal((await store.user(user.id)).balance, 10); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('no people never reaches the paid email search; restart resumes a waiting batch without resubmitting', async () => {
  const empty = await setup(), m0 = mockTransport({ pages: [{ leads: [] }] });
  try {
    const r = await live(empty.store, m0.client).start(empty.user.id, input());
    assert.equal(r.delivered, 0); assert.equal(m0.count('bulk-search'), 0); assert.equal(await empty.store.reserved(empty.user.id), 0);
  } finally { await empty.store.close(); }
  const { store, user } = await setup(), m = mockTransport();
  try {
    const first = await live(store, m.client).start(user.id, input());
    const restarted = new Store(store.db); // a new server instance: nothing in memory, the same database
    await eligible(restarted); assert.equal((await live(restarted, m.client).poll(user.id, first.id)).delivered, 2); assert.equal(m.count('bulk-search'), 1);
  } finally { await store.close(); }
});

test('disabling a member cancels their waiting search and releases the reservation', async () => {
  const { store, user } = await setup(), admin = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin'), m = mockTransport();
  try {
    const first = await live(store, m.client).start(user.id, input());
    await store.setActive(admin.id, user.id, false);
    assert.equal((await store.db.get<{ status: string }>('SELECT status FROM searches WHERE id=?', first.id))?.status, 'cancelled');
    assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
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
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1));
    await eligible(store); const p1 = search.poll(user.id, first.id);
    await eligible(store); const p2 = search.poll(user.id, first.id); // a second tab while the first read is in flight
    await Promise.all([p1, p2]);
    assert.equal(m.count('bulk-search'), 2, 'initial batch + exactly one follow-up');
    assert.ok(((await store.db.get<{ submitted: number }>('SELECT submitted FROM provider_runs'))?.submitted ?? 0) <= 10, '10x cap holds');
    await eligible(store); const final = await search.poll(user.id, first.id);
    assert.equal(final.delivered, 1, 'the follow-up batch paid at the provider is delivered, not orphaned');
    assert.equal((await store.user(user.id)).balance, 9); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('a repeat search continues from the member\'s cursor (leftovers, then the next page) instead of rescanning the top', async () => {
  const pages = [{ leads: ['a', 'b', 'c', 'd', 'e'].map(lead), token: 't1' }, { leads: ['f', 'g', 'h'].map(lead) }];
  const m = mockTransport({ pages, files: [[item(0, 'a@company-a.example')], [item(0, 'e@company-e.example')]] });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1)); await eligible(store); await search.poll(user.id, first.id);
    const before = m.calls.filter(c => c.path === 'find-people').length;
    await search.start(user.id, input(1));
    const second = m.calls.filter(c => c.path === 'find-people').slice(before);
    assert.deepEqual(second.map(c => c.body.pagination?.token), ['t1'], 'continues at page 2, never page 1 again');
    assert.deepEqual(m.calls.filter(c => c.path === 'bulk-search')[1]?.body.data?.map(r => r[1]), ['e', 'f', 'g', 'h']);
  } finally { await store.close(); }
});

test('an expired cursor restarts from the top; a rejected submission frees the people it picked', async () => {
  const m = mockTransport({ expired: 'old' }), { store, user } = await setup();
  try {
    await store.saveCursor(user.id, JSON.stringify(peopleQuery(input())), 0, 'old', '[]');
    const r = await live(store, m.client).start(user.id, input());
    assert.deepEqual(m.calls.filter(c => c.path === 'find-people').slice(0, 2).map(c => c.body.pagination?.token), ['old', undefined], 'expired token, then the same stage from the top');
    assert.equal(r.status, 'awaiting_provider'); assert.equal(m.count('bulk-search'), 1);
  } finally { await store.close(); }
  const m2 = mockTransport({ bulkHttp: 429 }), s2 = await setup();
  try {
    const r = await live(s2.store, m2.client).start(s2.user.id, input());
    assert.equal(r.status, 'failed'); assert.equal(await s2.store.reserved(s2.user.id), 0);
    assert.equal((await s2.store.db.get<{ n: number }>('SELECT count(*) n FROM provider_seen'))?.n, 0, 'nothing reached the provider');
  } finally { await s2.store.close(); }
});

test('people matched by country code are used first; name-only matches fill the batch after them', async () => {
  const m = mockTransport({ pages: [{ leads: [lead('a')] }], broad: [{ leads: [lead('b')] }], files: [[item(0, 'a@company-a.example'), item(1, null)]] });
  const { store, user } = await setup();
  try {
    await live(store, m.client).start(user.id, input(1));
    assert.deepEqual(m.calls.filter(c => c.path === 'find-people').map(c => c.body.query?.location), [{ include: ['SA'] }, { include: ['Saudi Arabia'], exclude: ['SA'] }]);
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')?.body.data?.map(r => r[1]), ['a', 'b']);
  } finally { await store.close(); }
});

test('an empty page that still carries a token ends the stage instead of looping', async () => {
  const m = mockTransport({ pages: [{ leads: [], token: 't0' }], broad: [] });
  const { store, user } = await setup();
  try {
    const r = await live(store, m.client).start(user.id, input(1));
    assert.ok(m.count('find-people') <= 3, `bounded page calls, got ${m.count('find-people')}`);
    assert.equal(r.status, 'partial'); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('a transient error keeps the member\'s cursor; only a rejected token restarts the stage', async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('find-people')) { calls++; if (body.pagination?.token) throw new Error('network blip'); return Response.json({ success: true, leads: [lead('z')] }); }
    return Response.json({ success: true, file: 'file1' });
  };
  const { store, user } = await setup(), queryKey = JSON.stringify(peopleQuery(input()));
  try {
    await store.saveCursor(user.id, queryKey, 0, 'deep', '[]');
    const r = await live(store, new IcypeasClient('unit-test-secret', transport)).start(user.id, input());
    assert.equal(calls, 1, 'no silent restart from the top after a network error');
    assert.equal((await store.cursor(user.id, queryKey)).token, 'deep'); assert.equal(r.status, 'failed'); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('count is free: both stages via the count endpoint only, summed; Arabic free text is a 400 before any call', async () => {
  const m = mockTransport();
  assert.deepEqual(await m.client.count({ ...input(), city: 'الرياض', title: 'Marketing Director' }), { total: 10, strict: 5 }, 'stage 0 + stage 1 (each mocked at 5)');
  assert.deepEqual(m.calls.map(c => c.path), ['find-people/count', 'find-people/count'], 'no paid find-people or bulk-search call');
  assert.deepEqual(m.calls.map(c => c.body.query?.location), [{ include: ['Riyadh, SA'] }, { include: ['Riyadh, Saudi Arabia', 'الرياض السعودية'], exclude: ['Riyadh, SA'] }]);
  await assert.rejects(m.client.count({ ...input(), title: 'مدير تسويق' }), (e: unknown) => e instanceof IcypeasError && e.status === 400);
  assert.equal(m.calls.length, 2);
});

test('provider out of credits: a clear message, the search fails unpaid, the member keeps the reservation back', async () => {
  const bulkBody = { success: false, validationErrors: [{ field: 'user', message: 'insufficient_credits', type: 'InsufficientCredits' }] };
  const m = mockTransport({ bulkBody });
  const { store, user } = await setup();
  try {
    const r = await live(store, m.client).start(user.id, input(1));
    assert.equal(r.status, 'failed');
    assert.match(r.message || '', /رصيد مزوّد البيانات لا يكفي/);
    assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

// Remote-database failure modes (Supabase over the network), found by an adversarial review of the Postgres move.
test('a failure while claiming a new search leaves nothing reserved or pending (reservation and claim are one transaction)', async () => {
  const { store, user } = await setup();
  let fail = 2;
  hookDb(store, text => { if (text.includes('INSERT INTO provider_runs') && fail > 0) { fail--; throw new Error('connection reset'); } });
  const m = mockTransport(), search = live(store, m.client);
  try {
    await assert.rejects(search.start(user.id, input(3)), /connection reset/);
    await assert.rejects(search.start(user.id, input(3)), /connection reset/);
    assert.equal((await store.db.get<{ n: number }>('SELECT count(*) n FROM searches'))?.n, 0, 'the reservation rolled back with the claim');
    assert.equal(await store.reserved(user.id), 0);
    assert.equal((await search.start(user.id, input(3))).status, 'awaiting_provider', 'no stuck pending slots');
  } finally { await store.close(); }
});

test('a delivery that fails in the database is retried by the next poll, not abandoned (the batch is already paid)', async () => {
  const { store, user } = await setup(), m = mockTransport(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(2));
    let fail = 1;
    hookDb(store, text => { if (text.startsWith('INSERT INTO contacts') && fail > 0) { fail--; throw new Error('canceling statement due to statement timeout'); } });
    await eligible(store);
    assert.equal((await search.poll(user.id, first.id)).status, 'awaiting_provider');
    assert.equal((await store.db.get<{ phase: string }>('SELECT phase FROM provider_runs'))?.phase, 'waiting', 'claim released for a retry');
    await eligible(store);
    const done = await search.poll(user.id, first.id);
    assert.equal(done.status, 'completed'); assert.equal(done.delivered, 2);
    assert.equal(m.count('bulk-single-searchs/read'), 2); assert.equal(m.count('bulk-search'), 1);
    assert.equal((await store.user(user.id)).balance, 8); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('disabling a member while their search starts leaves it cancelled, with nothing reserved or fetched', async () => {
  const { store, user } = await setup(), admin = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin'), m = mockTransport();
  const enqueue = store.enqueueSearch.bind(store);
  store.enqueueSearch = async (id, raw) => { const s = await enqueue(id, raw); await store.setActive(admin.id, user.id, false); return s; };
  try {
    await live(store, m.client).start(user.id, input()).catch(() => undefined); // the member is disabled: the request itself fails
    assert.equal((await store.db.get<{ status: string }>('SELECT status FROM searches'))?.status, 'cancelled');
    assert.equal(await store.reserved(user.id), 0); assert.equal(m.count('find-people'), 0);
  } finally { await store.close(); }
});

test('an expired batch closed by one poll cannot be claimed by another: no paid pages after the search is finished', async () => {
  const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r; }); return { p, resolve }; };
  const releaseA = deferred(), releaseB = deferred(), claimSeen = deferred();
  const ids = (from: number) => Array.from({ length: 7 }, (_, i) => lead('p' + (from + i)));
  const m = mockTransport({ pages: [{ leads: ids(0), token: 't1' }, { leads: ids(7), token: 't2' }, { leads: ids(14) }],
    files: [[item(0, 'p0@company-p0.example'), item(1, 'p1@company-p1.example'), ...[2, 3, 4, 5, 6].map(i => item(i, null))]],
    onRead: async n => {
      if (n === 1) { await releaseA.p; throw new Error('provider timeout'); } // poll A: the read fails
      if (n === 2) await releaseB.p;                                        // poll B: the read succeeds, later
    } });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(2));
    hookDb(store, async text => {
      if (text.includes("SET phase='delivering'")) claimSeen.resolve();
      if (text.startsWith('UPDATE searches SET status=CASE')) releaseB.resolve();        // A is closing the search
      if (text.startsWith('DELETE FROM reservations WHERE search_id')) await claimSeen.p; // while B's claim is in flight
    });
    await store.db.run('UPDATE provider_runs SET submitted_at=0,updated_at=0'); // older than the batch deadline
    const pA = search.poll(user.id, first.id);
    while (m.count('bulk-single-searchs/read') < 1) await new Promise(r => setTimeout(r, 5));
    await eligible(store); // a second tab polls
    const pB = search.poll(user.id, first.id);
    while (m.count('bulk-single-searchs/read') < 2) await new Promise(r => setTimeout(r, 5));
    const pagesBefore = m.count('find-people');
    releaseA.resolve();
    await Promise.all([pA, pB]);
    assert.equal(m.count('find-people'), pagesBefore, 'no paid people pages after the search was closed');
    assert.equal((await store.db.get<{ status: string }>('SELECT status FROM searches'))?.status, 'partial');
    assert.equal((await store.db.get<{ phase: string }>('SELECT phase FROM provider_runs'))?.phase, 'finished');
  } finally { await store.close(); }
});

test('a database error before anything is sent fails the search cleanly and frees the picked people', async () => {
  const { store, user } = await setup();
  let fail = 1;
  hookDb(store, text => { if (text.includes('INSERT INTO provider_cursors') && fail > 0) { fail--; throw new Error('connection reset'); } });
  const m = mockTransport(), search = live(store, m.client);
  try {
    const r = await search.start(user.id, input(2));
    assert.equal(m.count('bulk-search'), 0, 'nothing reached the paid endpoint');
    assert.equal(r.status, 'failed', 'not "unknown": nothing was sent');
    assert.equal((await store.db.get<{ n: number }>('SELECT count(*) n FROM provider_seen'))?.n, 0);
    assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('no balance: the search is refused before any provider call', async () => {
  const { store, user } = await setup(), admin = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin'), m = mockTransport();
  try {
    await store.adjustCredits(admin.id, user.id, 'set', 0, 'test', randomUUID());
    await assert.rejects(live(store, m.client).start(user.id, input(1)), /لا يكفي/);
    assert.equal(m.calls.length, 0);
  } finally { await store.close(); }
});

// Production search 776c4fd4 (2026-09-29, e-commerce · Jeddah · 1-10, 3 emails): nobody in the strict stage, one broad page
// of 15 people, a first batch of 10 all NOT_FOUND. It stopped there with 5 fetched people and 5 submit slots unused.
const notFound = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: 'n' + i, status: 'NOT_FOUND', userData: { externalId: String(i) }, results: { emails: [] } }));
test('when the pages run out, the fetched leftovers are still tried up to the attempt cap before the search gives up', async () => {
  const m = mockTransport({ pages: [{ leads: [] }], broad: [{ leads: Array.from({ length: 15 }, (_, i) => lead('p' + i)) }],
    files: [notFound(10), [item(0, 'p10@company-p10.example'), ...[1, 2, 3, 4].map(i => item(i, null))]] });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, { ...input(3), sector: 'التجارة الإلكترونية', city: 'جدة', size: '1-10' });
    assert.equal(m.calls.filter(c => c.path === 'bulk-search')[0]?.body.data?.length, 10);
    await eligible(store); await search.poll(user.id, first.id);
    assert.equal(m.count('bulk-search'), 2, 'the 5 leftovers are submitted (cap 30, only 10 sent)');
    await eligible(store); const final = await search.poll(user.id, first.id);
    assert.equal(final.delivered, 1); assert.equal(final.status, 'partial'); assert.equal((await store.user(user.id)).balance, 9);
  } finally { await store.close(); }
});

test('a link page or social profile is not the company domain: the email search uses the company name instead', async () => {
  const site = (id: string, url: string) => ({ ...lead(id), lastCompanyWebsite: url });
  const m = mockTransport({ pages: [{ leads: [site('a', 'https://linktr.ee/livsho'), site('b', 'https://www.instagram.com/buymepickme.store/'), site('c', 'http://www.gomla.sa'),
    site('d', 'https://shop-d.salla.sa/'), site('e', 'https://mystore.youcan.shop:443/'), site('f', 'https://www.shop-f.example:8443/about'),
    site('g', 'https://www.google.com/maps/place/shop-g')] }] });
  const { store, user } = await setup();
  try {
    await live(store, m.client).start(user.id, input(2));
    assert.deepEqual(m.calls.find(c => c.path === 'bulk-search')?.body.data?.map(r => r[2]), ['Company a', 'Company b', 'gomla.sa', 'Company d', 'Company e', 'shop-f.example', 'Company g']);
  } finally { await store.close(); }
});

test('a search that ends short says why (people checked, verified emails found) and what to do next; the snapshot carries it', async () => {
  const widen = 'لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.', tried = 'جرّبنا كل المطابقين المتاحين. ' + widen;
  const abc = [{ leads: ['a', 'b', 'c'].map(lead) }];
  const cases: [number, Parameters<typeof mockTransport>[0], string][] = [
    [1, { pages: abc, files: [[item(0, null), item(1, null), item(2, null)]] }, 'بحثنا عن بريد 3 من الأشخاص المطابقين، ولم نجد بريدًا موثّقًا لأيّ منهم. ' + tried],
    [3, { pages: abc, files: [[item(0, 'a@company-a.example'), item(1, 'a@company-a.example'), item(2, null)]] }, 'بحثنا عن بريد 3 من الأشخاص المطابقين، ووجدنا بريدًا موثّقًا لـ 2 منهم، منها 1 مكرر مستبعد. ' + tried],
    [1, { pages: [{ leads: Array.from({ length: 12 }, (_, i) => lead('p' + i)), token: 't1' }, { leads: [lead('z')] }], files: [4, 4, 2].map(n => Array.from({ length: n }, (_, i) => item(i, null))) },
      'بحثنا عن بريد 10 من الأشخاص المطابقين، ولم نجد بريدًا موثّقًا لأيّ منهم. أعد البحث بالمعايير نفسها لتجربة أشخاص آخرين، أو وسّعها لنتائج أكثر.'],
  ];
  for (const [count, opts, expected] of cases) {
    const m = mockTransport(opts), { store, user } = await setup(), search = live(store, m.client);
    try {
      let final = await search.start(user.id, input(count));
      for (let i = 0; i < 5 && final.status === 'awaiting_provider'; i++) { await eligible(store); final = await search.poll(user.id, final.id); }
      assert.equal(final.status, 'partial'); assert.equal(final.message, expected);
      assert.equal((await store.snapshot(user.id)).searches[0].message, expected, 'the results page reads it from the snapshot');
    } finally { await store.close(); }
  }
  const empty = await setup();
  try {
    const r = await live(empty.store, mockTransport({ pages: [{ leads: [] }] }).client).start(empty.user.id, input(1));
    assert.equal(r.message, 'لا يوجد أشخاص جدد مطابقون لهذه المعايير حاليًا. ' + widen, 'nobody was checked');
  } finally { await empty.store.close(); }
});

test('the pre-search estimate: strict matches first at 18%, then broad ones at 8%, within the 10x people a search may try', () => {
  assert.equal(expectedEmails(0, 15, 3), 1, 'production 776c4fd4: 15 broad-only people for 3 emails -> 1.2, so warn');
  assert.equal(expectedEmails(5, 10, 3), 1);
  assert.equal(expectedEmails(93, 644, 10), 17, 'up to 100 people are tried: the 93 strict ones first');
  assert.equal(expectedEmails(0, 5, 1), 0, 'under one expected email reads as "may find none", never rounded up to 1');
  assert.equal(expectedEmails(0, 0, 5), 0);
});

test('starting a new search closes the member\'s abandoned ones with what came back, never paying for another batch for them', async () => {
  const m = mockTransport({ pages: [{ leads: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(lead) }], files: [[0, 1, 2, 3].map(i => item(i, null))] });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const old = await search.start(user.id, input(1));
    await store.db.run('UPDATE provider_runs SET submitted_at=0,updated_at=0'); // abandoned past the batch deadline, leftovers e-h unused
    const fresh = await search.start(user.id, { ...input(1), sector: 'العقارات' });
    assert.equal((await store.getSearch(user.id, old.id)).status, 'partial', 'closed, not continued');
    assert.equal(m.count('bulk-search'), 2, 'the old search\'s batch + the new search\'s batch only');
    assert.equal(fresh.status, 'awaiting_provider');
  } finally { await store.close(); }
});

test('a database error while explaining a short search does not fail the poll: the search is already closed and released', async () => {
  const m = mockTransport({ pages: [{ leads: Array.from({ length: 10 }, (_, i) => lead('p' + i)), token: 't1' }], files: [4, 4, 2].map(n => Array.from({ length: n }, (_, i) => item(i, null))) });
  const { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(1));
    await eligible(store); await search.poll(user.id, first.id); await eligible(store); await search.poll(user.id, first.id); // batches 2 and 3: the cap
    let fail = 1;
    hookDb(store, text => { if (text.startsWith('SELECT stage,token,leftovers') && fail > 0) { fail--; throw new Error('connection reset'); } });
    await eligible(store); const final = await search.poll(user.id, first.id);
    assert.equal(final.status, 'partial'); assert.equal(await store.reserved(user.id), 0);
  } finally { await store.close(); }
});

test('start and poll report live progress: people sent for checking so far, next to emails delivered', async () => {
  const m = mockTransport(), { store, user } = await setup(), search = live(store, m.client);
  try {
    const first = await search.start(user.id, input(2));
    assert.equal(first.checked, 3, 'the first batch is being checked'); assert.equal(first.delivered, 0);
    await eligible(store); const done = await search.poll(user.id, first.id);
    assert.equal(done.checked, 3); assert.equal(done.delivered, 2);
    assert.equal((await store.snapshot(user.id)).searches[0].checked, 3, 'the results page starts from the saved progress');
  } finally { await store.close(); }
});

test('the paid people-page budget stays at 20 people per requested email, apart from the 10x email attempts', async () => {
  const people = Array.from({ length: 75 }, (_, i) => lead('p' + i));
  const m = mockTransport({ pages: [{ leads: people.slice(0, 25), token: 't1' }, { leads: people.slice(25, 50), token: 't2' }, { leads: people.slice(50) }] });
  const { store, user } = await setup();
  try {
    for (const p of people) await store.claimPerson(user.id, personKey(p), 'Person ' + p.lastname, p.lastCompanyName); // everyone was tried before
    const r = await live(store, m.client).start(user.id, input(1));
    assert.equal(m.count('find-people'), 1, 'one page of 25 reaches the 20-person budget: no second paid page');
    assert.equal(r.status, 'partial'); assert.equal(m.count('bulk-search'), 0);
  } finally { await store.close(); }
});
