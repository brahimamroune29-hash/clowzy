import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { companiesQuery, cursorKey, IcypeasClient } from '../src/lib/icypeas';
import { contactsCsv } from '../src/lib/csv';
import { expectedEmails } from '../src/lib/contracts';
import { item, live, testStore } from './pg';

const companies = (count = 2, extra = {}) => audienceOf(JSON.stringify({ mode: 'companies', sector: 'العقارات', countries: ['SA', 'AE'], city: '', title: '', size: '11-50', count, confirmed: true, requestId: randomUUID(), ...extra }));
const company = (id: string, o: Record<string, unknown> = {}) => ({ name: 'Company ' + id, url: 'https://www.linkedin.com/company/' + id, address: 'Riyadh, Riyadh, Saudi Arabia', website: 'https://www.' + id + '.example/about', industry: 'Real Estate', numberOfEmployees: 20, ...o });

// find-companies pages and verification result files, a site reader answering per host, and a log of what was asked.
function mock(o: { pages?: unknown[][]; files?: unknown[][]; emails?: Record<string, string>; site?: (website: string) => Promise<string> } = {}) {
  const calls: { path: string; body: { query?: Record<string, unknown>; task?: string; data?: string[][]; pagination?: { token?: string }; file?: string } }[] = [];
  let submitted = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === 'find-people') return Response.json({ success: true, leads: [] }); // nobody: a people search falls back at once
    if (path === 'find-companies/count') return Response.json({ success: true, total: body.query?.location?.exclude ? 40 : 60 });
    if (path === 'find-companies') {
      const n = body.pagination?.token ? Number(body.pagination.token.slice(1)) : 0, pages = o.pages ?? [[company('a'), company('b')]];
      return Response.json({ success: true, leads: body.query?.location?.exclude ? [] : pages[n] ?? [], ...(pages[n + 1] && !body.query?.location?.exclude ? { pagination: { token: 't' + (n + 1) } } : {}) });
    }
    if (path === 'bulk-search') return Response.json({ success: true, file: 'file' + ++submitted });
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: (o.files ?? [])[Number(String(body.file).slice(4)) - 1] ?? [] });
    throw Error('Unexpected path ' + path);
  };
  const site = async (website: string) => (o.emails ?? { 'www.a.example': 'info@a.example', 'www.b.example': 'sales@b.example' })[new URL(website).host] ?? '';
  return { calls, client: new IcypeasClient('unit-test-secret', transport, o.site ?? site), count: (p: string) => calls.filter(c => c.path === p).length };
}

test('companies are searched by headquarters, industry and headcount; the job title plays no part', () => {
  const q = companiesQuery({ ...companies(), titles: ['CEO'] });
  assert.deepEqual(q, { location: { include: ['AE', 'SA'] }, industry: { include: ['Real Estate', 'Real Estate Agents and Brokers', 'Commercial Real Estate', 'Leasing Residential Real Estate', 'Leasing Non-residential Real Estate'] }, headcount: { '>=': 11, '<=': 50 } });
  assert.deepEqual(companiesQuery(companies(), 1).location, { include: ['United Arab Emirates', 'الإمارات', 'Saudi Arabia', 'السعودية'], exclude: ['AE', 'SA'] });
  assert.notEqual(cursorKey(companies()), cursorKey({ ...companies(), mode: 'people' }), 'a companies search never continues a people cursor');
});

test('a company page keeps only companies with their own website, in the chosen countries, whose site shows an email', async () => {
  const m2 = mock({ pages: [[company('a'), company('b'), company('social', { website: 'https://instagram.com/x' }), company('far', { address: 'Cairo, Egypt' }), company('none', { website: '' })]], emails: { 'www.a.example': 'info@a.example', 'www.far.example': 'info@far.example' } });
  const page2 = await m2.client.companies(companies(), null, 0);
  assert.equal(page2.returned, 5, 'every company returned is paid for (0.02 each)');
  assert.deepEqual(page2.leads.map(l => [l.lastCompanyName, l.email]), [['Company a', 'info@a.example']], 'b shows no email; a social page, another country and no website are skipped');
  assert.equal((await m2.client.count(companies())).total, 100, 'the free count asks the companies list');
  assert.equal(m2.count('find-companies/count'), 2);
});

test('a companies search verifies the site emails, delivers each as the company, and charges one credit per verified email', async () => {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  try {
    // b: a NOT_FOUND row that still carries the email, and a stray row for an email never sent: neither is delivered.
    const m = mock({ files: [[item(0, 'info@a.example', 'ultra_sure', 'FOUND'), item(1, 'sales@b.example', 'probable', 'NOT_FOUND'), { ...item(0, 'other@a.example'), _id: 'stray' }]] });
    const first = await live(store, m.client).start(user.id, companies(2));
    assert.equal(first.status, 'awaiting_provider');
    const sent = m.calls.find(c => c.path === 'bulk-search')!.body;
    assert.equal(sent.task, 'email-verification');
    assert.deepEqual(sent.data, [['info@a.example'], ['sales@b.example']]);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const done = await live(store, m.client).poll(user.id, first.id);
    assert.equal(done.delivered, 1); assert.equal(done.status, 'partial');
    const [contact] = (await store.snapshot(user.id)).contacts;
    assert.deepEqual([contact.kind, contact.name, contact.company, contact.title, contact.email, contact.email_status], ['company', 'Company a', 'Company a', '', 'info@a.example', 'VERIFIED']);
    assert.equal((await store.user(user.id)).balance, 9, 'one credit for the verified email; the unverified one is free');
    assert.match(done.message ?? '', /الشركات/, 'the closing message speaks of companies');
    assert.ok(contactsCsv([contact]).split('\r\n')[1].startsWith('"","","info@a.example","Company a"'), 'a company row has no person name in the file');
    assert.match((await store.getSearch(user.id, first.id)).title, /^شركات · /);
    const again = await live(store, m.client).start(user.id, companies(2));
    assert.equal(m.count('bulk-search'), 1, 'a company already tried for this member is not verified (paid) again');
    assert.equal(again.delivered, 0);
  } finally { await store.close(); }
});

test('reading the sites of one page is cut at 10 seconds: a site that never answers costs time, not the search', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = mock({ site: () => new Promise<string>(() => {}) });
  let done = false;
  const page = m.client.companies(companies(), null, 0).finally(() => { done = true; });
  for (let i = 0; i < 30 && !done; i++) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(500); }
  const result = await page;
  assert.deepEqual([result.returned, result.leads.length], [2, 0], 'the page is kept (paid), its silent sites give no email');
});

test('a people search short of its count is completed with the companies\' own verified emails, once, labelled as such', async () => {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  try {
    const m = mock({ files: [[item(0, 'info@a.example', 'very_sure', 'FOUND'), item(1, null, 'ultra_sure', 'NOT_FOUND')]] });
    const people = audienceOf(JSON.stringify({ ...JSON.parse(JSON.stringify(companies(2))), mode: 'people', title: 'مدير التسويق' }));
    const first = await live(store, m.client).start(user.id, people);
    assert.equal(m.count('find-people'), 2, 'the people first (both stages, nobody)');
    assert.equal(m.calls.find(c => c.path === 'bulk-search')?.body.task, 'email-verification', 'then the companies of the same filters');
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const done = await live(store, m.client).poll(user.id, first.id);
    assert.equal(done.delivered, 1); assert.equal(done.status, 'partial');
    assert.equal((await store.snapshot(user.id)).contacts[0].kind, 'company');
    assert.equal(done.message, 'بحثنا عن بريد 0 من الأشخاص المطابقين، ثم كمّلنا بإيميلات الشركات نفسها بعد فحص 2 منها، فوصلك 1 من 2. لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.');
    assert.equal(m.count('find-people'), 2, 'never back to the people after the fallback');
    assert.equal((await store.user(user.id)).balance, 9);
  } finally { await store.close(); }
});

test('the expected count for companies follows the companies rate', () => {
  assert.equal(expectedEmails(0, 1000, 10, 'companies'), 75, '25 companies tried per requested email, about 3 in 10 with a verified site email');
  assert.equal(expectedEmails(0, 5, 10, 'companies'), 1);
});
