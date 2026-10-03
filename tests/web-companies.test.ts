import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundedCompanies, webCompanies, webEnabled } from '../src/lib/web-companies';
import { IcypeasClient, stageCount } from '../src/lib/icypeas';
import { audienceOf } from '../src/lib/audience';
import { randomUUID } from 'node:crypto';
import { item, live, testStore } from './pg';

const scope = { mode: 'companies' as const, countries: ['SA'], city: 'الرياض', size: 'all' as const, industries: ['Dentists'], titles: [] };
const source = (url = 'https://smile.example/contact', content = 'Smile Clinic in Riyadh, Saudi Arabia. We provide dental treatment and implants.') => ({ type: 'url_citation', url_citation: { url, title: 'Smile Clinic', content } });
const select = (index = 0, extra = {}) => ({ index, name: 'Smile Clinic', industry: 'Dentists', evidence: 2, ...extra });

test('web companies require real citation URLs, verbatim service evidence and the exact requested location; dedupe by domain', () => {
  const raw = [source(), source('https://smile.example/about'), source('https://other.example', 'Smile Clinic in Jeddah, Saudi Arabia. We provide dental treatment and implants.'), source('https://whatclinic.com/riyadh'), source('https://wrong.example', 'Smile Clinic in Riyadh, United States. We provide dental treatment and implants.')];
  const found = groundedCompanies(raw, { companies: [select(), select(1), select(2), select(3), select(4), select(99), select(0, { evidence: 99 }), select(0, { industry: 'Real Estate' })] }, scope);
  assert.equal(found.length, 1); assert.equal(found[0].address, 'Riyadh, Saudi Arabia');
  assert.equal(found[0].website, 'https://smile.example/contact');
  assert.equal(groundedCompanies(raw, { companies: [select()] }, scope, ['smile.example']).length, 0);
  assert.equal(groundedCompanies([source('https://user:pass@smile.example')], { companies: [select()] }, scope).length, 0);
  assert.equal(groundedCompanies([source()], { companies: [select(0, { name: 'Invented clinic' })] }, scope).length, 0);
});

test('an exhausted provider continues through web citations, then the same verified delivery and debit pipeline', async t => {
  const oldKey = process.env.OPENROUTER_API_KEY, oldFlag = process.env.WEB_DISCOVERY_ENABLED;
  process.env.OPENROUTER_API_KEY = 'unit-test-key'; process.env.WEB_DISCOVERY_ENABLED = 'true';
  const store = await testStore(), user = await store.addUser('Web trial', 'web@example.com', 'secure-password', 'member', 5);
  let submits = 0, searches = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body));
    if (path.endsWith('find-companies')) return Response.json({ success: true, leads: [] });
    if (path.endsWith('bulk-search')) { submits++; assert.equal(body.task, 'domain-search'); assert.deepEqual(body.data, [['smile.example']]); return Response.json({ success: true, file: 'web1' }); }
    if (path.endsWith('bulk-single-searchs/read')) return Response.json({ success: true, items: [item(0, 'info@smile.example')] });
    if (body.tools) searches++;
    return Response.json({ choices: [{ message: body.tools ? { annotations: searches === 1 ? [] : [source()] } : { content: JSON.stringify({ companies: [select()] }) } }] });
  };
  t.mock.method(globalThis, 'fetch', transport);
  try {
    const input = audienceOf(JSON.stringify({ ...scope, sector: 'عيادات الأسنان', title: '', count: 1, confirmed: true, requestId: randomUUID() })), client = new IcypeasClient('test', transport);
    let result = await live(store, client).start(user.id, input);
    for (let n = 0; n < 8 && result.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await live(store, client).poll(user.id, result.id); }
    assert.equal(result.status, 'completed'); assert.equal(result.delivered, 1); assert.equal(submits, 1); assert.equal(searches, 2, 'an empty search engine must not stop the other bounded sources');
    assert.equal((await store.user(user.id)).balance, 4); assert.equal(await store.reserved(user.id), 0);
    assert.equal((await store.snapshot(user.id)).contacts[0].email, 'info@smile.example');
    await live(store, client).poll(user.id, result.id); assert.equal(submits, 1); assert.equal((await store.user(user.id)).balance, 4);
    const capped = await store.addUser('Capped', 'capped@example.com', 'secure-password', 'member', 5);
    for (let i = 0; i < 12; i++) await store.hit('web-day:' + capped.id, 12, 86400000);
    let stopped = await live(store, client).start(capped.id, { ...input, requestId: randomUUID() });
    for (let n = 0; n < 8 && stopped.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); stopped = await live(store, client).poll(capped.id, stopped.id); }
    assert.equal(stopped.status, 'failed'); assert.match(stopped.message ?? '', /حد اكتشاف المواقع اليومي/);
    assert.equal(searches, 2, 'daily budget exhausted before another paid web request'); assert.equal(submits, 1); assert.equal(await store.reserved(capped.id), 0);
  } finally {
    await store.close();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldFlag === undefined) delete process.env.WEB_DISCOVERY_ENABLED; else process.env.WEB_DISCOVERY_ENABLED = oldFlag;
  }
});

test('Arabic location prefixes and country aliases match, and evidence joins only pages from the same business host', () => {
  const arabic = source('https://dental.example', 'Smile Clinic لطب الأسنان بالرياض، KSA. We provide dental treatment and implants.');
  assert.equal(groundedCompanies([arabic], { companies: [select()] }, scope).length, 1);
  assert.equal(groundedCompanies([arabic], { companies: [select()] }, { ...scope, city: 'جدة' }).length, 0);
  const pages = [source('https://clinic.example', 'Smile Clinic. We provide dental treatment and implants.'), source('https://www.clinic.example/contact', 'Smile Clinic address: Riyadh, Saudi Arabia.')];
  assert.equal(groundedCompanies(pages, { companies: [select(0, { evidence: 2 })] }, scope).length, 1);
  assert.equal(groundedCompanies([pages[0], source('https://other.example/contact', pages[1].url_citation.content)], { companies: [select()] }, scope).length, 0);
  const national = groundedCompanies([source('https://clinic.example', 'Smile Clinic in Saudi Arabia. We provide dental treatment and implants.')], { companies: [select()] }, { ...scope, city: '' });
  assert.equal(national[0].address, 'Saudi Arabia', 'never invent a city for country-wide results');
  for (const host of ['exa.ai', 'saudi.vezeeta.com', 'linkedin.com', 'tradersunion.com', 'platform.tracxn.com', 'unknown.example/companies/smile']) assert.equal(groundedCompanies([source('https://' + host)], { companies: [select()] }, scope).length, 0);
});

test('web discovery is bounded, resumes excluding seen domains, and does not replace free stock counts or relax headcount', async t => {
  const oldKey = process.env.OPENROUTER_API_KEY, oldFlag = process.env.WEB_DISCOVERY_ENABLED;
  process.env.OPENROUTER_API_KEY = 'unit-test-key'; process.env.WEB_DISCOVERY_ENABLED = 'true';
  const calls: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (String(url).includes('icypeas')) return Response.json({ success: true, total: 4 });
    return Response.json({ choices: [{ message: body.tools ? { content: 'Untrusted free-form answer', annotations: [source()] } : { content: JSON.stringify({ companies: [select()] }) } }] });
  };
  t.mock.method(globalThis, 'fetch', transport);
  try {
    assert(webEnabled(scope)); assert.equal(stageCount(scope), 5);
    assert(!webEnabled({ ...scope, size: '11-50' })); assert(!webEnabled({ ...scope, mode: 'people' })); assert(webEnabled({ ...scope, city: '' }));
    const count = await new IcypeasClient('test', transport).count(scope);
    assert.equal(count.total, 16); assert.equal(count.supplementary, true); assert.equal(calls.length, 4, 'free count never invokes paid web discovery');
    calls.length = 0;
    const page = await webCompanies(scope, null, transport); assert.equal(page.companies.length, 1); assert(page.token);
    const body = calls[0] as { tools: { parameters: { max_uses: number; max_total_results: number } }[] };
    assert.equal(body.tools[0].parameters.max_uses, 3); assert.equal(body.tools[0].parameters.max_total_results, 40);
    const next = await webCompanies(scope, page.token, transport); assert.equal(next.companies.length, 0); assert(next.token);
    const last = await webCompanies(scope, next.token, transport); assert.equal(last.token, null, 'empty grounded pages still advance, but at most three');
    assert.deepEqual(calls.filter(c => c.tools).map(c => (c.tools as { parameters: { engine: string } }[])[0].parameters.engine), ['parallel', 'exa', 'perplexity']);
    const before = calls.length;
    await webCompanies(scope, JSON.stringify({ round: 3, seen: [] }), transport); assert.equal(calls.length, before);
  } finally {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldFlag === undefined) delete process.env.WEB_DISCOVERY_ENABLED; else process.env.WEB_DISCOVERY_ENABLED = oldFlag;
  }
});
