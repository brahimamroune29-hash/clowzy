import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { fewReachable } from '../src/lib/contracts';
import { IcypeasClient, peopleQuery } from '../src/lib/icypeas';
import { companyEmails } from '../src/lib/site-email';
import { searchTick } from '../src/lib/search-worker';
import { input, item, live, testStore } from './pg';

// Client report 2026-10-05, salons in Lebanon: 11 minutes for 5 emails, of which a perfume shop, a Gmail on a developer's
// portfolio site and two US towns called Lebanon. Phase 2: thin markets, honest expectations, a worker that keeps going.
const salons = (mode: 'people' | 'companies' = 'people') => audienceOf(JSON.stringify({ sector: 'صالونات التجميل النسائية', countries: ['LB'], city: '', title: '', size: 'all', count: 10, confirmed: true, requestId: randomUUID(), mode }));
const at = (name: string, site: string) => ({ firstname: 'A', lastname: name, profileUrl: 'https://www.linkedin.com/in/' + site, lastJobTitle: 'Owner', address: 'Beirut, Lebanon', lastCompanyName: name, lastCompanyWebsite: 'https://www.' + site + '/', lastCompanyIndustry: 'Personal Care Services', lastCompanySize: 3 });

test('salon searches stay on salons: clinics are left out of the word stages, and the broadened stages keep salon-named businesses', async () => {
  for (const clinic of ['Dentists', 'Medical Practices']) assert.ok(peopleQuery(salons(), 0)['currentCompany.industry'].exclude?.includes(clinic), clinic);
  const leads = [at('Mobarak Perfumes', 'abdallah.mobi'), at('Jolie Beauty Salon', 'jolie.example'), at('صالون ريم', 'reem.example')];
  const people = new IcypeasClient('unit-test-secret', async () => Response.json({ success: true, leads }));
  assert.deepEqual((await people.people(salons(), null, 2)).leads.map(l => l.lastCompanyName), ['Jolie Beauty Salon', 'صالون ريم'], 'Personal Care Services also holds perfume shops');
  assert.equal((await people.people(salons(), null, 0)).leads.length, 3, 'the word stages matched salon words already');
  const firms = leads.map(l => ({ name: l.lastCompanyName, url: '', address: l.address, website: l.lastCompanyWebsite, industry: l.lastCompanyIndustry, numberOfEmployees: 3 }));
  const companies = new IcypeasClient('unit-test-secret', async () => Response.json({ success: true, leads: firms }));
  assert.deepEqual((await companies.companies(salons('companies'), null, 3)).leads.map(l => l.lastCompanyName), ['Jolie Beauty Salon', 'صالون ريم']);
});

test('a webmail address published on a site speaks for the business only when the site is visibly the business\'s', async () => {
  const page = (email: string, extra = '') => async () => `${extra}<a href="mailto:${email}">${email}</a>`;
  assert.deepEqual(await companyEmails('https://abdallah.mobi/', page('abdallah.moubarak92@gmail.com'), undefined, true, 3, 'Mobarak Perfumes'), [], 'a developer portfolio listed as a perfume shop');
  assert.deepEqual(await companyEmails('https://www.guys-dolls-beauty-salon.com/', page('reba121992@gmail.com'), undefined, true, 3, 'Guys & Dolls Beauty Salon'), ['reba121992@gmail.com']);
  assert.deepEqual(await companyEmails('https://leahd.example/', page('lea.hd@gmail.com'), undefined, true, 3, 'LEA HD Beauty Concept'), ['lea.hd@gmail.com'], 'the domain spells the name');
  assert.deepEqual(await companyEmails('https://reem.example/', page('reem.salon@gmail.com', '<h1>صالون ريم</h1>'), undefined, true, 3, 'صالون ريم'), ['reem.salon@gmail.com'], 'an Arabic name shown on the page');
  assert.deepEqual(await companyEmails('https://jolieetco.co/', page('jolie@jolieetco.co'), undefined, true, 3, 'Jolie et co.'), ['jolie@jolieetco.co'], 'the site\'s own domain needs no name check');
  assert.deepEqual(await companyEmails('https://beautywebstudio.com/', page('dev.portfolio@gmail.com'), undefined, true, 3, 'Mobarak Beauty Salon'), [], 'words like beauty or salon name a kind of business, not this one');
});

test('the free count also says how many work at a company with a page; few of them means fewer emails than asked', async () => {
  const client = new IcypeasClient('unit-test-secret', async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query;
    return Response.json({ success: true, total: query['currentCompany.headcount'] ? 10 : 100 });
  });
  assert.deepEqual(await client.count(input(10)), { total: 200, strict: 100, reachable: 20 });
  const sized = await client.count({ ...input(10), size: '1-10' });
  assert.equal(sized.reachable, sized.total, 'a size filter already counts only people at companies with a page');
  assert.equal(fewReachable(192, 10), true, 'salons in Lebanon: 192 at companies with a page, about 5% of them findable');
  assert.equal(fewReachable(13900, 10), false); assert.equal(fewReachable(undefined, 10), false);
});

test('one background tick keeps a search moving instead of a single step a minute, within the tick\'s time', async t => {
  process.env.CRM_ENABLED = 'true'; t.after(() => delete process.env.CRM_ENABLED);
  const store = await testStore(); t.after(() => store.close());
  const user = await store.addUser('Worker', 'worker@example.com', 'secure-password', 'member', 5), search = await store.enqueueSearch(user.id, input(1));
  await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?", search.id);
  let calls = 0;
  assert.equal(await searchTick(store, async (uid, sid) => { if (++calls === 3) await store.finishSearch(sid); return store.getSearch(uid, sid); }, 3, { every: 5, until: 2000 }), 1);
  assert.equal(calls, 3, 'it polled until the search ended');
  const other = await store.enqueueSearch(user.id, input(1));
  await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?", other.id);
  calls = 0;
  await searchTick(store, async (uid, sid) => { calls++; return store.getSearch(uid, sid); }, 3, { every: 20, until: 100 });
  assert.ok(calls >= 2 && calls <= 6, 'bounded by the tick time: ' + calls);
});

test('each delivered batch records how long it waited on the provider, beside its coverage counts', async () => {
  let reads = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [{ ...at('Kudu', 'kudu.example'), address: 'Riyadh, Saudi Arabia' }] });
    if (path === 'find-companies') return Response.json({ success: true, leads: [] });
    if (path === 'bulk-search') return Response.json({ success: true, file: 'f1' });
    if (path === 'bulk-single-searchs/read') { reads++; return Response.json({ success: true, items: [item(0, 'owner@kudu.example')] }); }
    throw new Error('Unexpected ' + path);
  };
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', transport)), first = await s.start(user.id, input(1));
    await store.db.run('UPDATE provider_runs SET updated_at=0, submitted_at=?', Date.now() - 12000);
    await s.poll(user.id, first.id);
    assert.equal(reads, 1);
    const event = await store.db.get<{ detail: string }>("SELECT detail FROM audit WHERE action='search-coverage'");
    const counts = JSON.parse(event!.detail).counts;
    assert.ok(counts.waitMs >= 12000 && counts.waitMs < 60000, 'waited ' + counts.waitMs);
  } finally { await store.close(); }
});

test('company websites are read six at a time, not three', async t => {
  const before = process.env.PUBLISHED_EMAIL_ENABLED; process.env.PUBLISHED_EMAIL_ENABLED = 'true';
  t.after(() => { if (before === undefined) delete process.env.PUBLISHED_EMAIL_ENABLED; else process.env.PUBLISHED_EMAIL_ENABLED = before; });
  const firms = 'abcdefg'.split('').map(id => ({ name: 'Clinic ' + id, url: 'https://www.linkedin.com/company/' + id, address: 'Riyadh, Saudi Arabia', website: 'https://www.clinic' + id + '.example/', industry: 'Medical Practices', numberOfEmployees: 20 }));
  const bulks: string[][][] = [], read = new Set<string>();
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-companies') return Response.json({ success: true, leads: body.query?.location?.exclude ? [] : firms });
    if (path === 'bulk-search') { bulks.push(body.data); return Response.json({ success: true, file: 'f' + bulks.length }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: bulks[Number(String(body.file).slice(1)) - 1].map((_, i) => item(i, null)) });
    throw new Error('Unexpected ' + path);
  };
  const client = new IcypeasClient('unit-test-secret', transport, async url => { read.add(new URL(url).hostname); return ''; });
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  try {
    const request = audienceOf(JSON.stringify({ sector: 'العيادات الخاصة', countries: ['SA'], city: '', title: '', size: 'all', count: 2, confirmed: true, requestId: randomUUID(), mode: 'companies' }));
    const s = live(store, client), first = await s.start(user.id, request);
    assert.equal(bulks[0].length, 7, 'domain search first (2 at 30%)');
    await store.db.run('UPDATE provider_runs SET updated_at=0'); await s.poll(user.id, first.id);
    assert.equal(read.size, 6, 'then the websites of the companies with no domain result, six per round');
  } finally { await store.close(); }
});
