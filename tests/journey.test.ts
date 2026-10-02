import { SECTOR_INDUSTRIES } from '../src/lib/audience';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/[...path]/route';
import type { Store } from '../src/lib/store';
import { testStore } from './pg';

// The member journey through the real API handler (invite -> password -> terms -> count -> search -> poll -> export),
// with a fake Icypeas behind global fetch and a mocked clock, including the ways the provider can fail.
const APP = 'https://clowzy.test';
process.env.APP_URL = APP;
process.env.DATABASE_URL = 'postgres://unused'; // getStore() returns the test store set on globalThis below
process.env.ICYPEAS_API_KEY = 'journey-secret';
process.env.OPENROUTER_API_KEY = 'journey-ai-secret';
const holder = globalThis as unknown as { waslStore?: Store };
let clock = Date.parse('2026-10-01T08:00:00Z');

type Lead = ReturnType<typeof lead>;
const lead = (id: string) => ({ firstname: 'Person', lastname: id, profileUrl: 'https://www.linkedin.com/in/' + id, lastJobTitle: 'CEO', address: 'Riyadh, Saudi Arabia', lastCompanyName: 'Co ' + id, lastCompanyWebsite: 'https://co-' + id + '.example', lastCompanyIndustry: 'Software Development', lastCompanySize: 12 });
const people = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => lead(prefix + i));

// strict/broad: people per stage. found: ids with a very_sure email. pendingReads: reads answered "in progress" first.
type Fake = { strict?: Lead[]; broad?: Lead[]; found?: (id: string) => boolean; submit?: 'ok' | 'no-credits' | 'throw'; down?: boolean; pendingReads?: number; neverDone?: boolean; ai?: 'down' };
function provider(o: Fake = {}) {
  const strict = o.strict ?? people('s', 30), broad = o.broad ?? [], found = o.found ?? (() => true), files: string[][] = [], calls: string[] = [], queries: { profileLocation?: unknown; 'currentCompany.industry'?: { include: string[] }; currentJobTitle?: { include: string[] } }[] = [];
  let pending = o.pendingReads ?? 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init.body));
    calls.push(path);
    queries.push(body.query);
    if (String(url).startsWith('https://openrouter.ai/')) {
      if (o.ai === 'down') return Response.json({}, { status: 500 });
      const asked = body.messages[1].content as string;
      if (String(body.messages[0].content).startsWith('You are the assistant')) return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: 'جهّزت لك البحث.', action:'prepare', choices:[],
        search: { mode: 'people', field: 'الصحة والطب', specialty: 'عيادات الأسنان', other: '', countries: ['AE', 'ZZ'], city: 'Dubai', title: 'مدير العيادة أو المدير الطبي', size: 'all', count: 4 } }) } }] });
      const content = asked.startsWith('Sector:') ? { industries: [{ name: 'Retail Health and Personal Care Products', ar: 'متاجر العناية الشخصية' }, { name: 'Cosmetics', ar: 'مستحضرات التجميل' }] } : { titles: ['Warehouse Manager'] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (o.down) throw new TypeError('fetch failed');
    const list = body.query?.profileLocation?.exclude ? broad : strict;
    if (path === 'find-people/count') return Response.json({ success: true, total: list.length });
    if (path === 'find-companies') return Response.json({ success: true, leads: [] }); // the company fallback finds none here
    if (path === 'find-people') {
      const from = body.pagination?.token ? Number(body.pagination.token.slice(1)) : 0, to = from + body.pagination.size;
      return Response.json({ success: true, total: list.length, leads: list.slice(from, to), ...(to < list.length ? { pagination: { token: 'p' + to } } : {}) });
    }
    if (path === 'bulk-search') {
      if (o.submit === 'no-credits') return Response.json({ success: false, validationErrors: [{ message: 'InsufficientCredits' }] });
      if (o.submit === 'throw') throw new TypeError('socket hang up');
      files.push(body.data.map((row: string[]) => row[1]));
      return Response.json({ success: true, file: 'f' + files.length });
    }
    if (path === 'bulk-single-searchs/read') {
      const ids = files[Number(body.file.slice(1)) - 1], waiting = o.neverDone || pending-- > 0;
      return Response.json({ success: true, items: ids.map((id, i) => ({ _id: 'i' + i, status: waiting ? 'IN_PROGRESS' : found(id) ? 'DEBITED' : 'DEBITED_NOT_FOUND', userData: { externalId: String(i) },
        results: { emails: !waiting && found(id) ? [{ email: id + '@co-' + id + '.example', certainty: 'very_sure' }] : [] } })) });
    }
    throw new Error('unexpected provider path ' + path);
  }) as typeof fetch;
  return { calls, queries, submits: () => calls.filter(c => c === 'bulk-search').length };
}

function browser() {
  let cookie = '';
  const ip = '10.0.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
  return async function call(path: string, body?: unknown, lang = 'ar') {
    const method = body === undefined ? 'GET' : 'POST';
    const req = new NextRequest(APP + '/api/' + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { host: 'clowzy.test', origin: APP, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-lang': lang, ...(cookie ? { cookie } : {}) } });
    const res = await (method === 'GET' ? GET : POST)(req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}
type Call = ReturnType<typeof browser>;

async function setup(t: TestContext, credits = 20) {
  clock += 86400000; // a fresh day per test: rate limits, and the shared provider spacing (a long test may tick past an hour)
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  const store = holder.waslStore = await testStore();
  t.after(() => store.close());
  await store.addUser('المالك', 'owner@clowzy.test', 'owner-password-1', 'admin');
  const owner = browser();
  assert.equal((await owner('auth/login', { email: 'owner@clowzy.test', password: 'owner-password-1' })).status, 200);
  const invite = await owner('admin/invite', { name: 'سارة', email: 'sara@clinic.test', credits });
  assert.equal(invite.status, 200);
  const member = browser();
  assert.equal((await member('invitation?token=' + invite.data.token)).data.name, 'سارة');
  assert.equal((await member('auth/accept', { token: invite.data.token, password: 'sara-password-1' })).status, 200);
  assert.equal((await member('terms', {})).status, 200);
  return { store, owner, member, token: invite.data.token as string };
}
const form = (count: number) => ({ sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', title: '', size: 'all', count, confirmed: true, requestId: randomUUID() });
const me = async (member: Call) => (await member('bootstrap?view=full')).data;
async function finish(t: TestContext, member: Call, id: string, stepMs = 10000) {
  for (let i = 0; i < 200; i++) {
    t.mock.timers.tick(stepMs);
    const r = await member('search/poll', { searchId: id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.status !== 'awaiting_provider') return r.data;
  }
  throw new Error('the search never finished');
}

test('journey: invited member searches, gets the requested emails, pays one credit each, exports them', async t => {
  const { store, owner, member, token } = await setup(t);
  const fake = provider();
  assert.equal((await browser()('auth/accept', { token, password: 'another-password' })).status, 410); // the link works once
  const count = await member('search/count', form(3));
  assert.deepEqual(count.data, { total: 30, strict: 30, industryLabels: ['التقنية والبرمجيات'], industries: SECTOR_INDUSTRIES['التقنية والبرمجيات'] }, 'English pages show the provider names');
  const input = form(3), started = await member('search', input);
  assert.equal(started.status, 200);
  assert.equal((await member('search', input)).data.id, started.data.id); // a double click is the same search
  const done = await finish(t, member, started.data.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.delivered, 3);
  const account = await me(member);
  assert.equal(account.user.balance, 17);
  assert.equal(account.contacts.length, 3);
  const csv = await member('export', { searchId: started.data.id });
  assert.equal(csv.status, 200);
  assert.equal(csv.data.trim().split('\n').length, 4); // header + 3 contacts
  // A second search with the same filters goes deeper: new people, never the same emails again.
  const again = await member('search', form(2));
  const second = await finish(t, member, again.data.id);
  assert.equal(second.delivered, 2);
  assert.equal(new Set((await me(member)).contacts.map((c: { email: string }) => c.email)).size, 5);
  assert.equal((await me(member)).user.balance, 15);
  assert.equal(fake.submits(), 2);
  // The member cannot reach the owner's tools; the owner sees the spend.
  assert.equal((await member('admin/credits', { userId: account.user.id, mode: 'add', amount: 100, reason: 'hack', requestId: randomUUID() })).status, 403);
  const admin = await me(owner);
  assert.equal(admin.admin.totals.delivered, 5);
  assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM reservations'))!.n, 0);
});

test('journey: fewer emails than requested -> charged only for what arrived, and told why', async t => {
  const { member } = await setup(t);
  provider({ strict: people('s', 12), found: id => id === 's3' });
  const started = await member('search', form(5));
  const done = await finish(t, member, started.data.id);
  assert.equal(done.status, 'partial');
  assert.equal(done.delivered, 1);
  assert.match(done.message, /بحثنا عن بريد 12/);
  assert.equal((await me(member)).user.balance, 19);
});

test('journey: nobody matches -> nothing charged, clear advice', async t => {
  const { member } = await setup(t);
  provider({ strict: [] });
  assert.equal((await member('search/count', form(3))).data.total, 0);
  const done = await member('search', form(3));
  assert.equal(done.data.status, 'partial');
  assert.equal(done.data.delivered, 0);
  assert.match(done.data.message, /لا يوجد أشخاص/);
  assert.equal((await me(member)).user.balance, 20);
});

test('journey: provider account out of credits -> the search fails cleanly, nothing charged, member can retry later', async t => {
  const { store, member } = await setup(t);
  provider({ submit: 'no-credits' });
  const r = await member('search', form(3));
  assert.equal(r.data.status, 'failed');
  assert.match(r.data.message, /رصيد مزوّد البيانات/);
  assert.equal((await me(member)).user.balance, 20);
  assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM reservations'))!.n, 0);
  provider(); // topped up
  t.mock.timers.tick(60000);
  const retry = await member('search', form(3));
  assert.equal((await finish(t, member, retry.data.id)).delivered, 3); // the same people are offered again
});

test('journey: provider unreachable -> error shown, nothing charged', async t => {
  const { member } = await setup(t);
  provider({ down: true });
  const count = await member('search/count', form(3));
  assert.equal(count.status, 502);
  const r = await member('search', form(3));
  assert.equal(r.data.status, 'failed');
  assert.equal((await me(member)).user.balance, 20);
});

test('journey: the paid submit times out -> marked uncertain, nothing charged, credits released', async t => {
  const { store, member } = await setup(t);
  provider({ submit: 'throw' });
  const r = await member('search', form(3));
  assert.equal(r.data.status, 'unknown');
  assert.equal((await me(member)).user.balance, 20);
  assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM reservations'))!.n, 0);
});

test('journey: slow provider -> the page keeps polling until the emails arrive', async t => {
  const { member } = await setup(t);
  provider({ pendingReads: 6 });
  const started = await member('search', form(2));
  const done = await finish(t, member, started.data.id);
  assert.equal(done.delivered, 2);
});

test('journey: provider never finishes a batch -> closed after the deadline, nothing charged', async t => {
  const { store, member } = await setup(t);
  provider({ neverDone: true });
  const started = await member('search', form(2));
  const done = await finish(t, member, started.data.id, 60000);
  assert.equal(done.delivered, 0);
  assert.notEqual(done.status, 'awaiting_provider');
  assert.equal((await me(member)).user.balance, 20);
  assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM reservations'))!.n, 0);
});

test('journey: member closes the tab mid-search -> the next search closes it with what arrived', async t => {
  const { member } = await setup(t);
  provider();
  const abandoned = await member('search', form(3));
  t.mock.timers.tick(20 * 60000); // back 20 minutes later, no polls in between
  const next = await member('search', form(2));
  await finish(t, member, next.data.id);
  const searches = (await me(member)).searches as { id: string; status: string; delivered: number }[];
  const old = searches.find(s => s.id === abandoned.data.id)!;
  assert.equal(old.status, 'completed');
  assert.equal(old.delivered, 3);
  assert.equal((await me(member)).user.balance, 15);
});

test('journey: no credits left -> the search is refused before anything is spent', async t => {
  const { member } = await setup(t, 0);
  const fake = provider();
  const r = await member('search', {...form(1), sector: 'محلات العطور'});
  assert.equal(r.status, 400);
  assert.equal(fake.submits(), 0);
  const count = await member('search/count', { ...form(1), sector: 'محلات العطور' });
  assert.equal(count.status, 400, 'no count (and no paid AI mapping) for a member who cannot search');
  assert.match(count.data.error, /رصيدك صفر/);
  assert.equal(fake.calls.length, 0, 'nothing reached the provider or the AI');
});

test('journey: a member cannot see or export another member\'s results', async t => {
  const { owner, member } = await setup(t);
  provider();
  const started = await member('search', form(2));
  await finish(t, member, started.data.id);
  const invite = await owner('admin/invite', { name: 'خالد', email: 'khaled@shop.test', credits: 5 });
  const other = browser();
  await other('auth/accept', { token: invite.data.token, password: 'khaled-password-1' });
  await other('terms', {});
  assert.equal((await other('search/poll', { searchId: started.data.id })).status, 404);
  assert.equal((await other('export', { searchId: started.data.id })).status, 400);
  const ids = (await me(member)).contacts.map((c: { id: string }) => c.id);
  assert.equal((await other('export', { ids })).status, 403);
});

test('journey: owner deactivates a member mid-search -> signed out, search cancelled, nothing more charged', async t => {
  const { owner, member } = await setup(t);
  provider();
  const account = await me(member);
  const started = await member('search', form(3));
  assert.equal((await owner('admin/status', { userId: account.user.id, active: false })).status, 200);
  assert.equal((await member('search/poll', { searchId: started.data.id })).status, 401);
  const users = (await me(owner)).admin.users as { id: string; balance: number }[];
  assert.equal(users.find(u => u.id === account.user.id)!.balance, 20);
});

test('journey: several Gulf countries in one search, and «أخرى» typed in Arabic for the sector and the title', async t => {
  const { member } = await setup(t);
  const fake = provider();
  const typed = { ...form(2), countries: ['SA', 'AE', 'QA'], sector: 'محلات العطور', title: 'مدير مستودع' };
  const count = await member('search/count', typed);
  assert.equal(count.status, 200);
  assert.deepEqual(count.data.industryLabels, ['متاجر العناية الشخصية', 'مستحضرات التجميل'], 'the member sees what their words were mapped to');
  const q = fake.queries.find(x => x?.profileLocation)!;
  assert.deepEqual(q.profileLocation, { include: ['AE', 'QA', 'SA'] });
  assert.deepEqual(q['currentCompany.industry']!.include, ['Retail Health and Personal Care Products', 'Cosmetics']);
  assert.deepEqual(q.currentJobTitle!.include, ['مدير مستودع', 'Warehouse Manager']);
  const aiCalls = fake.calls.filter(c => c.startsWith('https://openrouter.ai/')).length;
  const started = await member('search', typed);
  const done = await finish(t, member, started.data.id);
  assert.equal(done.delivered, 2);
  assert.equal(fake.calls.filter(c => c.startsWith('https://openrouter.ai/')).length, aiCalls, 'the search reuses the mapping: no second AI call, same query');
  assert.match(done.title, /محلات العطور · السعودية، الإمارات، قطر/);
});

test('journey: the AI is unavailable -> «أخرى» explains it; listed options keep working', async t => {
  const { member } = await setup(t);
  provider({ ai: 'down' });
  const other = await member('search/count', { ...form(2), sector: 'محلات الورد' });
  assert.equal(other.status, 503);
  assert.match(other.data.error, /«أخرى»/);
  assert.equal((await member('search/count', form(2))).status, 200);
});

test('journey: the assistant turns a description into a checked search; an English page reads the server in English', async t => {
  const { member } = await setup(t);
  provider();
  const r = await member('assist', { messages: [{ role: 'user', content: 'عيادات أسنان في دبي، أبغى المدير' }] });
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /عيادات الأسنان.*دبي.*4/);
  assert.deepEqual([r.data.search.specialty, r.data.search.countries, r.data.search.city, r.data.search.count], ['عيادات الأسنان', ['AE'], 'Dubai', 4], 'an invalid country code is dropped');
  assert.equal((await member('assist', { messages: [] })).status, 400);
  const english = await member('search/count', { ...form(2), city: 'الخبر الشمالية' }, 'en');
  assert.equal(english.status, 400);
  assert.equal(english.data.error, 'Type the city in English, pick a main city, or leave it empty.');
  assert.match((await member('search/count', { ...form(2), city: 'الخبر الشمالية' })).data.error, /اكتب المدينة/, 'Arabic stays the default');
});

test('journey: newer terms -> the member accepts them again before anything else', async t => {
  const { store, member } = await setup(t);
  await store.db.run("UPDATE users SET terms_accepted_at='2026-09-28T10:00:00.000Z' WHERE email='sara@clinic.test'"); // accepted the old terms
  assert.equal((await member('export', {})).status, 403);
  const gated = await member('bootstrap?view=full');
  assert.equal(gated.status, 200, 'the page still loads, to show the new terms');
  assert.deepEqual([gated.data.user.email, gated.data.ledger, gated.data.contacts], ['sara@clinic.test', [], []], 'but none of the member\'s data');
  assert.equal((await member('terms', {})).status, 200);
  assert.notEqual((await member('export', {})).status, 403);
  assert.equal((await me(member)).ledger.length, 1, 'the starting credits, once accepted');
});

test('journey: the owner forgets the password -> the recovery code from settings signs in once and gives a new code', async t => {
  const { owner } = await setup(t);
  assert.equal((await owner('admin/recovery-code', { password: 'wrong' })).status, 400);
  const { code } = (await owner('admin/recovery-code', { password: 'owner-password-1' })).data;
  assert.equal((await owner('bootstrap?view=overview')).data.admin.recovery, true);
  const lost = browser();
  assert.equal((await lost('auth/recover', { email: 'owner@clowzy.test', code: 'AAAA-AAAA-AAAA-AAAA-AAAA', password: 'new-owner-password' })).status, 401);
  const r = await lost('auth/recover', { email: 'owner@clowzy.test', code, password: 'new-owner-password' });
  assert.equal(r.status, 200);
  assert.ok(r.data.code, 'the new code');
  assert.equal((await lost('bootstrap?view=overview')).data.user.role, 'admin', 'signed in');
  assert.equal((await owner('bootstrap?view=overview')).status, 401, 'the old session ended');
  assert.equal((await lost('auth/recover', { email: 'owner@clowzy.test', code, password: 'other-owner-password' })).status, 401, 'used once');
});

test('journey: the owner sees the provider credits, flagged under 200', async t => {
  const { owner } = await setup(t);
  let credits = 975.1;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/find-people/count')) return Response.json({ success: true, total: 1 });
    assert.equal(JSON.parse(String(init.body)).email, 'raheem@clowzy.io');
    return Response.json({ plan: 'Basic', status: 'paid', credits });
  }) as typeof fetch;
  assert.deepEqual((await owner('provider/verify', {})).data, { ok: true, credits: 975, low: false });
  credits = 199.9;
  assert.deepEqual((await owner('provider/verify', {})).data, { ok: true, credits: 199, low: true });
  globalThis.fetch = (async (url: string) => String(url).endsWith('/find-people/count') ? Response.json({ success: true, total: 1 }) : Response.json({ validationErrors: [{ message: 'email' }] })) as typeof fetch;
  assert.equal((await owner('provider/verify', {})).status, 502, 'a wrong account email is an error, not a balance of zero');
});

test('journey: database limits reject API, search and count before any paid or provider call', async t => {
  const { store, member } = await setup(t);
  const fake = provider(), account = await me(member), id = account.user.id;
  const window = Date.now() - Date.now() % 60000;
  for (const [prefix, max, path, payload] of [
    ['count', 60, 'search/count', form(2)],
    ['search', 20, 'search', form(2)],
    ['api', 120, 'bootstrap?view=full', undefined],
  ] as const) {
    await store.db.run('INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,?) ON CONFLICT(key,window_start) DO UPDATE SET count=excluded.count', prefix + ':' + id, window, max);
    assert.equal((await member(path, payload)).status, 429, prefix);
    assert.equal(fake.calls.length, 0, 'no provider or AI call after the shared limit');
  }
});

test('journey: reserved credits and the shared daily AI allowance stop uncached mapping before payment', async t => {
  const { member, store } = await setup(t, 2), fake = provider({ neverDone: true });
  const uid = (await me(member)).user.id;
  const started = await member('search', form(2));
  assert.equal(started.status, 200);
  const before = fake.calls.length;
  assert.equal((await member('search/count', {...form(1), sector:'متاجر الورود'})).status, 400);
  assert.equal(fake.calls.length, before, 'reserved money cannot fund new AI calls');
  await store.finishSearch(started.data.id);
  const stamp = Date.now() - Date.now() % 86400000;
  await store.db.run('INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,150) ON CONFLICT(key,window_start) DO UPDATE SET count=150', 'assist-day:'+uid, stamp);
  assert.equal((await member('search/count', {...form(1), sector:'متاجر الورود'})).status, 429);
  assert.equal((await member('search/count', {...form(1), title:'مسؤول التخزين'})).status, 429, 'title fallback cannot swallow a budget rejection');
  assert.equal(fake.calls.length, before);
  assert.equal((await member('search/count', form(1))).status, 200, 'listed filters still work without AI');
});

test('cron API requires its own bearer secret and does not accept a member session instead', async t => {
  const {member}=await setup(t);
  const oldSecret=process.env.CRON_SECRET,oldCrm=process.env.CRM_ENABLED;
  process.env.CRON_SECRET='a-secure-cron-test-token-'.repeat(3);process.env.CRM_ENABLED='true';
  t.after(()=>{if(oldSecret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldSecret;if(oldCrm===undefined)delete process.env.CRM_ENABLED;else process.env.CRM_ENABLED=oldCrm;});
  assert.equal((await member('cron/search')).status,401);
  assert.equal((await member('cron/search',{})).status,401);
  const req=new NextRequest('https://deployment-test.vercel.app/api/cron/search',{headers:{host:'deployment-test.vercel.app',authorization:'Bearer '+process.env.CRON_SECRET}});
  const response=await GET(req,{params:Promise.resolve({path:['cron','search']})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{handled:0});
});
