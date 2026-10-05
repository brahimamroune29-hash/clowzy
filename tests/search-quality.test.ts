import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKeys, cursorKey, IcypeasClient, siteOf, titleTier } from '../src/lib/icypeas';
import { audienceOf } from '../src/lib/audience';
import { rememberCandidates } from '../src/lib/catalog';
import type { Candidate } from '../src/lib/contracts';
import { hookDb, input, item, lead, live, testStore } from './pg';
import { randomUUID } from 'node:crypto';

// Client report 2026-10-05: restaurants in Saudi Arabia delivered Kudu 3 times and Al Tazaj twice (10 emails, 7 companies),
// and a salons search spent its whole budget on people whose salon has no website.
type Row = string[];
const person = (id: string, title: string, site: string) => ({ ...lead(id), lastJobTitle: title, lastCompanyName: 'Co ' + (site || id), lastCompanyWebsite: site ? 'https://www.' + site + '/' : '' });
function provider(o: { people?: unknown[][]; found?: (row: Row) => string | null }) {
  const bulks: Row[][] = [];
  const page = (list: unknown[][], token?: string) => {
    const i = token ? Number(token) : 0;
    return Response.json({ success: true, total: 99, leads: list[i] ?? [], ...(i + 1 < list.length ? { pagination: { token: String(i + 1) } } : {}) });
  };
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') return page(body.query?.profileLocation?.exclude ? [] : o.people ?? [], body.pagination?.token);
    if (path === 'find-companies') return Response.json({ success: true, leads: [] });
    if (path === 'bulk-search') { bulks.push(body.data); return Response.json({ success: true, file: 'f' + bulks.length }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: bulks[Number(String(body.file).slice(1)) - 1].map((row, i) => item(i, o.found?.(row) ?? null)) });
    throw new Error('Unexpected path ' + path);
  };
  return { bulks, client: new IcypeasClient('unit-test-secret', transport) };
}
async function setup() {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  return { store, user, eligible: () => store.db.run('UPDATE provider_runs SET updated_at=0') };
}
const last = (rows: Row[]) => rows.map(r => r[1]);

test('titles rank decision makers first: owner, then CEO/GM, then marketing heads, then other heads, managers, staff', () => {
  const order = ['Cashier', 'Assistant Manager', 'store manager', 'Head of Operations', 'Marketing Manager', 'General Manager', 'Co-Founder', 'مدير التسويق', 'المالك', 'مشرف مبيعات',
    'Vice President of Sales', 'HR Business Partner', 'Product Owner', 'Marketing Coordinator', 'Brand Ambassador', 'Assistant General Manager', 'Managing Partner'];
  assert.deepEqual([...order].sort((a, b) => titleTier(a) - titleTier(b)), ['Co-Founder', 'المالك', 'Managing Partner', 'General Manager', 'Marketing Manager', 'مدير التسويق',
    'Assistant General Manager', 'Head of Operations', 'Vice President of Sales', 'store manager', 'Assistant Manager', 'مشرف مبيعات', 'Marketing Coordinator',
    'Cashier', 'HR Business Partner', 'Product Owner', 'Brand Ambassador'], 'a vice president is no CEO, a product owner or HR partner owns nothing, an assistant ranks one step down');
});

test('one company, one key: other spellings of its name match, a placeholder employer has none', () => {
  const key = (company: string) => companyKeys({ company });
  assert.deepEqual(key('Shawarmer - شاورمر'), key('shawarmer'));
  assert.deepEqual(key('KUDU Co.'), key('Kudu'));
  assert.deepEqual(key('Al Tazaj LLC'), key('al tazaj'));
  assert.deepEqual(key('Cipher | سايڤر'), key('Cipher'));
  assert.deepEqual(key('شركة هرفي'), key('هرفي'));
  assert.notDeepEqual(key('Kudu'), key('Kudo'));
  for (const placeholder of ['Self-employed', 'Confidential', 'Freelance', '', 'Beauty Salon', 'مطعم', 'Al']) assert.deepEqual(key(placeholder), [], placeholder + ': many businesses, not one');
});

test('one person per company in a search, the most senior first; a colleague is tried only when the first had no email', async () => {
  const p = provider({
    people: [[person('cashier', 'Cashier', 'kudu.example'), person('owner', 'Owner', 'kudu.example'), person('mgr', 'Restaurant Manager', 'kudu.example'), person('ceo', 'CEO', 'other.example')]],
    found: row => ({ ceo: 'ceo@other.example', mgr: 'mgr@kudu.example' } as Record<string, string>)[row[1]] ?? null,
  });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    const first = await search.start(user.id, input(2));
    assert.deepEqual(last(p.bulks[0]), ['owner', 'ceo'], 'the owner goes first; nobody else at Kudu in the same batch');
    await eligible(); await search.poll(user.id, first.id);
    assert.deepEqual(last(p.bulks[1]), ['mgr'], 'the owner had no email: the next person at Kudu is tried, alone');
    await eligible(); const done = await search.poll(user.id, first.id);
    assert.equal(done.status, 'completed'); assert.equal(done.delivered, 2);
    assert.deepEqual((await store.snapshot(user.id)).contacts.map(c => c.email).sort(), ['ceo@other.example', 'mgr@kudu.example']);
    assert.ok(!p.bulks.flat().some(r => r[1] === 'cashier'), 'once Kudu has an email in this search, its other people are never sent');
  } finally { await store.close(); }
});

test('two leads of one organisation under different websites are charged once (the email domain is the same company)', async () => {
  const p = provider({
    people: [[person('a', 'CEO', 'taza.example'), person('b', 'CFO', 'tazaj.example'), person('c', 'CEO', 'third.example')]],
    found: row => ({ a: 'a@taza.example', b: 'b@taza.example', c: 'c@third.example' } as Record<string, string>)[row[1]] ?? null,
  });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    const first = await search.start(user.id, input(3));
    assert.equal(p.bulks[0].length, 3);
    await eligible(); const after = await search.poll(user.id, first.id);
    assert.deepEqual((await store.snapshot(user.id)).contacts.map(c => c.email).sort(), ['a@taza.example', 'c@third.example']);
    assert.equal(after.delivered, 2); assert.equal((await store.user(user.id)).balance, 8, 'one credit per organisation');
  } finally { await store.close(); }
});

test('batch size follows the find rate this search has measured, up to 100 people', async () => {
  const pages = Array.from({ length: 6 }, (_, n) => Array.from({ length: 25 }, (_, i) => person('p' + (n * 25 + i), 'CEO', 'site-p' + (n * 25 + i) + '.example')));
  const p = provider({ people: pages, found: row => ['p0', 'p1'].includes(row[1]) ? row[1] + '@site-' + row[1] + '.example' : null });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    const first = await search.start(user.id, input(10));
    assert.equal(p.bulks[0].length, 34, 'before anything came back: the optimistic 30% prior');
    await eligible(); await search.poll(user.id, first.id);
    await eligible(); await search.poll(user.id, first.id); // 3 pages per request: the rest of the batch is collected by the next poll
    assert.equal(p.bulks[1].length, 100, '2 found in 34: the next batch is as large as allowed, not 27');
  } finally { await store.close(); }
});

test('colleagues at a company without a website are matched by its name and sent one at a time too', async () => {
  const at = (id: string, company: string) => ({ ...person(id, 'CEO', ''), lastCompanyName: company });
  const p = provider({ people: [[at('a', 'Kudu'), at('b', 'KUDU Co.'), at('c', 'Kudu'), at('d', 'Al Baik')]] });
  const { store, user } = await setup();
  try {
    await live(store, p.client).start(user.id, input(1));
    assert.deepEqual(last(p.bulks[0]), ['a', 'd'], 'one person of Kudu in the batch, whatever the spelling');
  } finally { await store.close(); }
});

test('people whose company has no website go after everyone with one, and wait in the list while more pages remain', async () => {
  const more = provider({ people: [[person('none', 'CEO', ''), person('b', 'CEO', 'b.example'), person('c', 'CEO', 'c.example'), person('d', 'CEO', 'd.example'), person('e', 'CEO', 'e.example')], [person('f', 'CEO', 'f.example')]] });
  const { store, user } = await setup();
  try {
    await live(store, more.client).start(user.id, input(1));
    assert.deepEqual(last(more.bulks[0]), ['b', 'c', 'd', 'e']);
    assert.ok((await store.cursor(user.id, cursorKey(input(1)))).leftovers.includes('"lastname":"none"'), 'kept for later, not dropped');
  } finally { await store.close(); }
  const ends = provider({ people: [[person('none', 'CEO', ''), person('b', 'CEO', 'b.example')], [person('c', 'CEO', 'c.example')]] });
  const s2 = await setup();
  try {
    await live(s2.store, ends.client).start(s2.user.id, input(1));
    assert.deepEqual(ends.bulks[0].map(r => r[2]), ['b.example', 'c.example', 'Co none'], 'once nobody else is left, they are tried too');
  } finally { await s2.store.close(); }
});

test('an address in a US town named like the country is dropped; other addresses we cannot read are kept; booking pages are not a salon\'s domain', async () => {
  const lebanon = audienceOf(JSON.stringify({ sector: 'التقنية والبرمجيات', countries: ['LB'], city: '', title: '', size: 'all', count: 2, confirmed: true, requestId: randomUUID() }));
  const at = (id: string, address: string) => ({ ...person(id, 'CEO', id + '.example'), address });
  const leads = [at('ohio', 'Lebanon, Ohio'), at('nh', 'Lebanon, New Hampshire'), at('zip', 'Lebanon, OH 45036, US'), at('pa', 'Lebanon, PA'), at('tn', 'Lebanon, TN 37087'), at('area', 'Lebanon, Missouri Area'),
    at('beirut', 'Beirut, Lebanon'), at('arabic', 'لبنان - بيروت'), at('blank', '')];
  const client = new IcypeasClient('unit-test-secret', async () => Response.json({ success: true, leads }));
  for (const stage of [0, 1]) assert.deepEqual((await client.people(lebanon, null, stage)).leads.map(l => l.lastname), ['beirut', 'arabic', 'blank'], 'stage ' + stage + ': River Valley Club (NH) and Guys & Dolls (OH) on 2026-10-05');
  const gulf = (code: string, addresses: string[]) => new IcypeasClient('unit-test-secret', async () => Response.json({ success: true, leads: addresses.map((a, i) => at('g' + i, a)) }))
    .people(audienceOf(JSON.stringify({ sector: 'التقنية والبرمجيات', countries: [code], city: '', title: '', size: 'all', count: 2, confirmed: true, requestId: randomUUID() })), null, 1);
  assert.equal((await gulf('SA', ['السعودية - جدة', 'Riyadh, Saudi Arabia.', 'Riyadh, Riyadh Province, Saudi Arabia 12345', 'Saudi Arabia, Riyadh'])).leads.length, 4, 'the name stage keeps Gulf profiles placeOf cannot parse');
  assert.equal((await gulf('KW', ['Kuwait City', 'الكويت العاصمة'])).leads.length, 2);
  assert.equal((await gulf('TN', ['Tunis, TN'])).leads.length, 1, 'a state code that is the searched country\'s own code stays');
  for (const url of ['https://www.fresha.com/book-now/lea-hd-beauty-center-em48qfnv/all-offer', 'https://booksy.com/en-us/1_salon', 'https://www.treatwell.co.uk/place/x/', 'https://salon.square.site'])
    assert.equal(siteOf({ lastCompanyWebsite: url } as never), '', url);
});

const known = (email: string, company: string, website: string): Candidate => ({ kind: 'person', name: email.split('@')[0], email, company, title: 'CEO', sector: 'Software Development',
  country: 'السعودية', city: 'Riyadh', website, size: '12', source: 'clowzy', email_status: 'VERIFIED' });
test('every delivery keeps one email per company, the saved catalog too, and an address the member already has never takes a new one\'s place', async t => {
  process.env.CRM_ENABLED = 'true'; process.env.CATALOG_REUSE_ENABLED = 'true';
  t.after(() => { delete process.env.CRM_ENABLED; delete process.env.CATALOG_REUSE_ENABLED; });
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  try {
    await rememberCandidates(store, [known('ali@acme.test', 'Acme', 'https://acme.test'), known('omar@acme.test', 'Acme', 'https://acme.test')]);
    const none = new IcypeasClient('unit-test-secret', async (url) => { if (String(url).endsWith('bulk-search')) throw new Error('nothing to submit'); return Response.json({ success: true, leads: [] }); });
    const first = await live(store, none).start(user.id, input(2));
    assert.equal(first.delivered, 1, 'two catalog people of Acme: one email'); assert.equal((await store.user(user.id)).balance, 4);
    const event = await store.db.get<{ detail: string }>("SELECT detail FROM audit WHERE action='search-coverage'");
    assert.deepEqual(JSON.parse(event!.detail).counts, { sameCompany: 1 }, 'the owner sees how often the rule holds an email back');
    const second = await store.enqueueSearch(user.id, input(2));
    await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?", second.id);
    const owned = (await store.snapshot(user.id)).contacts[0].email;
    assert.equal(await store.deliverBatch(user.id, second.id, [known(owned, 'Acme', 'https://acme.test'), known('sara@acme.test', 'Acme', 'https://acme.test'), known('huda@acme.test', 'Acme', 'https://acme.test')]), 1);
    assert.deepEqual((await store.db.all<{ email: string }>('SELECT email FROM contacts WHERE search_id=?', second.id)).map(c => c.email), ['sara@acme.test'], owned + ' is a duplicate, counted; sara is the company\'s one email');
  } finally { await store.close(); }
});

test('emails from the saved catalog do not count as the provider\'s find rate', async t => {
  process.env.CRM_ENABLED = 'true'; process.env.CATALOG_REUSE_ENABLED = 'true';
  t.after(() => { delete process.env.CRM_ENABLED; delete process.env.CATALOG_REUSE_ENABLED; });
  const pages = Array.from({ length: 3 }, (_, n) => Array.from({ length: 25 }, (_, i) => person('p' + (n * 25 + i), 'CEO', 'site-p' + (n * 25 + i) + '.example')));
  const p = provider({ people: pages });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    await rememberCandidates(store, [known('ali@acme.test', 'Acme', 'https://acme.test'), known('sara@beta.test', 'Beta', 'https://beta.test')]);
    const first = await search.start(user.id, input(4));
    assert.equal(first.delivered, 2); assert.equal(p.bulks[0].length, 7, '2 left at the 30% prior');
    await eligible(); await search.poll(user.id, first.id);
    assert.equal(p.bulks[1].length, 40, '0 found in 7: the 5% floor, not 2 catalog emails in 7 people');
  } finally { await store.close(); }
});

test('colleagues held back for a company this search delivered are not left for the next search with the same filters', async () => {
  const p = provider({
    people: [[person('owner', 'Owner', 'kudu.example'), person('cashier', 'Cashier', 'kudu.example'), person('x', 'CEO', 'x.example')], [person('x2', 'Cashier', 'x.example'), person('y', 'CEO', 'y.example'), person('z', 'CEO', 'z.example')]],
    found: row => row[1] === 'owner' ? 'owner@kudu.example' : null,
  });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    const first = await search.start(user.id, input(1));
    assert.deepEqual(last(p.bulks[0]), ['owner', 'x', 'y', 'z']);
    await eligible(); assert.equal((await search.poll(user.id, first.id)).status, 'completed');
    const left = (await store.cursor(user.id, cursorKey(input(1)))).leftovers;
    assert.doesNotMatch(left, /"lastname":"cashier"/, 'Kudu has its email: its cashier would open the next search');
    assert.match(left, /"lastname":"x2"/, 'x had no email: its colleague stays a candidate');
  } finally { await store.close(); }
});

test('the daily limit still sends the people without a website already fetched, instead of ending the search', async () => {
  const p = provider({ people: [[{ ...person('n1', 'CEO', '') }, { ...person('n2', 'CEO', '') }], [person('s1', 'CEO', 's1.example')]] });
  const { store, user } = await setup(), earlier = await store.enqueueSearch(user.id, input(1));
  await store.db.run("UPDATE searches SET status='partial' WHERE id=?", earlier.id);
  await store.db.run("INSERT INTO provider_runs(search_id,phase,updated_at) VALUES(?,'finished',0)", earlier.id);
  let checks = 0; // 1: the new search's own check, 2: before page 1, 3: before page 2, when today's work runs out
  hookDb(store, async text => { if (text.startsWith('SELECT COALESCE(sum(r.fetched)') && ++checks === 3) await store.db.run('UPDATE provider_runs SET fetched=2600 WHERE search_id=?', earlier.id); });
  try {
    await live(store, p.client).start(user.id, input(1));
    assert.deepEqual(last(p.bulks[0] ?? []), ['n1', 'n2']);
  } finally { await store.close(); }
});

test('the end-of-search advice names only the filters the member set', async () => {
  const p = provider({ people: [[person('a', 'CEO', 'a.example')]] });
  const { store, user, eligible } = await setup(), search = live(store, p.client);
  try {
    const first = await search.start(user.id, input(2));
    await eligible(); const done = await search.poll(user.id, first.id);
    assert.equal(done.status, 'partial');
    assert.doesNotMatch(done.message ?? '', /احذف/, 'no filter was set, so none is to be removed: ' + done.message);
    assert.match(done.message ?? '', /أضف دولًا أو اختر نشاطًا أوسع/);
  } finally { await store.close(); }
  const p2 = provider({ people: [[person('a', 'CEO', 'a.example')]] });
  const s2 = await setup(), narrow = { ...input(2), city: 'الرياض', size: '1-10' as const };
  try {
    const first = await live(s2.store, p2.client).start(s2.user.id, narrow);
    await s2.eligible(); const done = await live(s2.store, p2.client).poll(s2.user.id, first.id);
    assert.match(done.message ?? '', /احذف حجم الشركة أو المدينة أو أضف دولًا\./);
  } finally { await s2.store.close(); }
});
