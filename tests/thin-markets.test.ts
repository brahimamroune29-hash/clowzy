import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { fewReachable } from '../src/lib/contracts';
import { cursorKey, IcypeasClient, peopleQuery, personKey, submitCap } from '../src/lib/icypeas';
import type { Store } from '../src/lib/store';
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

// Dental Lebanon, the same member's second search (2026-10-07): 35 company attempts went out one or two at a time, because a
// company this member had already tried (its website comes next) cut a batch short, and a website batch left with its first company.
// Owner 2026-10-08: a company batch waits for ten, or for what the place has left.
const clinics = (...ids: string[]) => ids.map(id => ({ name: 'Clinic ' + id, url: 'https://www.linkedin.com/company/' + id, address: 'Riyadh, Saudi Arabia', website: 'https://www.clinic' + id + '.example/', industry: 'Medical Practices', numberOfEmployees: 20 }));
const letters = (s: string) => s.split('');
// Pages of 25 companies; tried: companies an earlier search of this member already sent; mailto: those whose website shows an address.
async function companyRun(t: { after: (fn: () => void) => void }, firms: ReturnType<typeof clinics>, { tried = [] as string[], mailto = [] as string[], count = 3, setup = undefined as ((store: Store) => void) | undefined } = {}) {
  const before = process.env.PUBLISHED_EMAIL_ENABLED; process.env.PUBLISHED_EMAIL_ENABLED = 'true';
  t.after(() => { if (before === undefined) delete process.env.PUBLISHED_EMAIL_ENABLED; else process.env.PUBLISHED_EMAIL_ENABLED = before; });
  const bulks: { task: string; data: string[][] }[] = [], read = new Set<string>(), calls = { pages: 0 };
  const idOf = (name: string) => name.slice('Clinic '.length);
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-companies') {
      if (body.query?.location?.exclude) return Response.json({ success: true, leads: [] });
      const from = Number(body.pagination?.token ?? 0); calls.pages++;
      return Response.json({ success: true, leads: firms.slice(from, from + 25), ...(from + 25 < firms.length ? { pagination: { token: String(from + 25) } } : {}) });
    }
    if (path === 'bulk-search') { bulks.push(body); return Response.json({ success: true, file: 'f' + bulks.length }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: bulks[Number(String(body.file).slice(1)) - 1].data.map((_, i) => item(i, null)) });
    throw new Error('Unexpected ' + path);
  };
  const client = new IcypeasClient('unit-test-secret', transport, async url => {
    const host = new URL(url).hostname; read.add(host);
    return mailto.includes(/^www\.clinic(\w+)\./.exec(host)?.[1] ?? '') ? `<a href="mailto:info@${host.replace(/^www\./, '')}">info</a>` : '';
  });
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  t.after(() => store.close());
  for (const f of firms.filter(f => tried.includes(idOf(f.name))))
    await store.claimPerson(user.id, personKey({ kind: 'company', lastCompanyWebsite: f.website }), '', '');
  setup?.(store);
  const request = audienceOf(JSON.stringify({ sector: 'العيادات الخاصة', countries: ['SA'], city: '', title: '', size: 'all', count, widen: false, confirmed: true, requestId: randomUUID(), mode: 'companies' }));
  const s = live(store, client), first = await s.start(user.id, request);
  const poll = async () => { await store.db.run('UPDATE provider_runs SET updated_at=0'); return s.poll(user.id, first.id); };
  return { bulks, read, calls, first, poll, store, user, request, sent: () => bulks.map(b => [b.task, b.data.length] as [string, number]) };
}

test('company websites are read ten at a time, not three', async t => {
  const { sent, read, poll } = await companyRun(t, clinics(...letters('abcdefg')), { count: 2 });
  assert.deepEqual(sent(), [['domain-search', 7]], 'domain search first (2 at 30%)');
  await poll();
  assert.equal(read.size, 7, 'then the websites of all seven companies with no domain result, up to ten per round');
});

test('companies this member already tried wait for the next batch instead of cutting the current one short', async t => {
  const { sent } = await companyRun(t, clinics(...letters('abcdefghijkl')), { tried: letters('bdfhjl') });
  assert.deepEqual(sent(), [['domain-search', 6]], 'the six new companies in one batch, not one at a time');
});

test('a website batch reads ten sites, and waits for ten addresses (or the end of the pages) before it is verified', async t => {
  const { sent, read, poll } = await companyRun(t, clinics(...letters('abcdefghijkl')), { tried: letters('abcdefghijkl'), mailto: ['a', 'k'] });
  assert.equal(read.size, 10, 'ten websites in the first round');
  assert.deepEqual(sent(), [], 'one address found among ten sites: not verified alone while pages remain');
  await poll();
  assert.equal(read.size, 12, 'the last two websites');
  assert.deepEqual(sent(), [['email-verification', 2]], 'the pages are done: both addresses verified together');
});

test('every website round reads ten new sites, however many addresses the earlier rounds found', async t => {
  const ids = letters('abcdefghijklmnopqrst'), { sent, read, poll } = await companyRun(t, clinics(...ids), { tried: ids, mailto: ['a', 'b'] });
  assert.equal(read.size, 10);
  await poll();
  assert.equal(read.size, 20, 'ten more, not eight beside the two addresses already found');
  await poll(); // the next stage's page comes back empty: the pages are done
  assert.deepEqual(sent(), [['email-verification', 2]]);
});

test('websites with no address at the end of the pages close the place quietly, nothing sent', async t => {
  const ids = letters('abc'), { sent, read, poll } = await companyRun(t, clinics(...ids), { tried: ids });
  assert.equal(read.size, 3);
  const after = await poll();
  assert.notEqual(after.status, 'failed', after.message);
  assert.deepEqual(sent(), [], 'an empty batch is never submitted');
});

test('a website batch does not buy more pages once ten companies of the other kind are waiting', async t => {
  const fresh = Array.from({ length: 73 }, (_, i) => 'n' + i), { sent, read, calls, poll } = await companyRun(t, clinics('t0', 't1', ...fresh), { tried: ['t0', 't1'] });
  assert.equal(calls.pages, 1, 'one page: its 23 new companies are already more than a batch');
  assert.equal(read.size, 2, 'the two websites are read at once');
  await poll();
  assert.deepEqual(sent(), [['domain-search', 10]], 'then the waiting new companies, ten (3 at 30%)');
  assert.equal(calls.pages, 1);
});

test('website batches never take a search past its cap of paid checks (20 per requested email)', async t => {
  const tried = Array.from({ length: 30 }, (_, i) => 't' + i), { sent, poll } = await companyRun(t, clinics('n0', 'n1', 'n2', 'n3', ...tried), { tried, mailto: tried, count: 1 });
  for (let i = 0; i < 12 && (await poll()).status === 'awaiting_provider'; i++);
  assert.ok(sent().reduce((n, [, k]) => n + k, 0) <= submitCap(1), JSON.stringify(sent()));
});

test('a company already tried joins a website batch as a website check, even if its old claim is released meanwhile', async t => {
  const ids = ['t0', 't1', 't2'];
  const { store, user, request, bulks, first } = await companyRun(t, clinics(...ids), { tried: ids, mailto: ['t0'], setup: store => {
    const seen = store.seen.bind(store); let raced = false;
    store.seen = async (u, k) => { // another search of this member releases the company between the check and the claim
      const yes = await seen(u, k);
      if (yes && !raced) { raced = true; await store.unmarkSeen(u, [k]); }
      return yes;
    };
  } });
  const domainKey = personKey({ kind: 'company', lastCompanyWebsite: 'https://www.clinict1.example/' });
  const kept = (await store.db.get<{ people: string }>('SELECT people FROM provider_runs WHERE search_id=?', first.id))!.people + (await store.cursor(user.id, cursorKey(request))).leftovers + JSON.stringify(bulks);
  assert.ok(!await store.seen(user.id, domainKey) || kept.includes('clinict1'), 'claimed for a domain search, then dropped by the website batch');
});

test('a sent batch is read about three seconds later, not five', async () => {
  let reads = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [{ ...at('Kudu', 'kudu.example'), address: 'Riyadh, Saudi Arabia' }] });
    if (path === 'bulk-search') return Response.json({ success: true, file: 'f1' });
    if (path === 'bulk-single-searchs/read') { reads++; return Response.json({ success: true, items: [item(0, 'owner@kudu.example')] }); }
    throw new Error('Unexpected ' + path);
  };
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  try {
    const s = live(store, new IcypeasClient('unit-test-secret', transport)), first = await s.start(user.id, input(1));
    await store.db.run('UPDATE provider_runs SET updated_at=?', Date.now() - 3000);
    assert.equal((await s.poll(user.id, first.id)).delivered, 1);
    assert.equal(reads, 1);
  } finally { await store.close(); }
});
