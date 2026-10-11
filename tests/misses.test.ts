import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { IcypeasClient } from '../src/lib/icypeas';
import { input, item, lead, live, testDb, testStore } from './pg';

// Owner decision 2026-10-11 (Q10): a person the provider found no email for is not paid for again by another member for 30 days,
// at the same company domain. Each member already never pays twice for the same person (provider_seen).
const provider = (sent: string[][], people = [lead('a')]): typeof fetch => async (url, init) => {
  const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
  if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : people });
  if (path === 'find-companies') return Response.json({ success: true, leads: [] });
  if (path === 'bulk-search') { sent.push(...body.data); return Response.json({ success: true, file: 'f' + sent.length }); }
  if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: people.map((_, i) => item(i, null)) });
  throw new Error('Unexpected ' + path);
};
const search = async (store: Awaited<ReturnType<typeof testStore>>, userId: string, sent: string[][], people?: ReturnType<typeof lead>[]) => {
  const s = live(store, new IcypeasClient('unit-test-secret', provider(sent, people))), first = await s.start(userId, input(1));
  await store.db.run('UPDATE provider_runs SET updated_at=0');
  return s.poll(userId, first.id);
};

test('a person the provider found no email for is not sent again by another member within 30 days', async () => {
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  try {
    const sentByAlice: string[][] = [], sentByBob: string[][] = [];
    await search(store, alice.id, sentByAlice);
    assert.equal(sentByAlice.length, 1, 'Alice paid for the lookup');
    const bobs = await search(store, bob.id, sentByBob);
    assert.deepEqual(sentByBob, [], 'Bob did not pay for the same person at the same domain');
    assert.equal(bobs.delivered, 0);
    assert.equal(await store.reserved(bob.id), 0);
  } finally { await store.close(); }
});

test('after 30 days, or at another company domain, the person is tried again', async () => {
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  const carol = await store.addUser('Carol', 'carol@example.com', 'secure-password', 'member', 5);
  try {
    await search(store, alice.id, []);
    const moved = { ...lead('a'), lastCompanyWebsite: 'https://www.new-employer.example/' };
    const sentByBob: string[][] = [];
    await search(store, bob.id, sentByBob, [moved]);
    assert.equal(sentByBob.length, 1, 'another domain is another lookup');
    await store.db.run('UPDATE provider_misses SET checked_at=?', Date.now() - 31 * 86400000);
    const sentByCarol: string[][] = [];
    await search(store, carol.id, sentByCarol);
    assert.equal(sentByCarol.length, 1, 'a month later the answer may have changed');
  } finally { await store.close(); }
});

// A company the provider found nothing for at its domain still has its website: the second member goes straight to it (no second
// domain search), and the website read is shared too (30 days), so it is not read again.
const companies = () => audienceOf(JSON.stringify({ mode: 'companies', sector: 'العقارات', countries: ['SA', 'AE'], city: '', title: '', size: '11-50', count: 1, widen: false, confirmed: true, requestId: randomUUID() }));
const company = { name: 'Company a', url: 'https://www.linkedin.com/company/a', address: 'Riyadh, Riyadh, Saudi Arabia', website: 'https://www.a.example/about', industry: 'Real Estate', numberOfEmployees: 20 };

test('a company with no email at its domain still gets its published address for the next member, from a shared website read', async t => {
  const flag = process.env.PUBLISHED_EMAIL_ENABLED; process.env.PUBLISHED_EMAIL_ENABLED = 'true';
  t.after(() => { if (flag === undefined) delete process.env.PUBLISHED_EMAIL_ENABLED; else process.env.PUBLISHED_EMAIL_ENABLED = flag; });
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  const tasks: string[] = [];
  let reads = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split('/').pop(), b = JSON.parse(String(init?.body));
    if (path === 'find-companies') return Response.json({ success: true, leads: b.query.location.exclude ? [] : [company] });
    if (path === 'bulk-search') { tasks.push(b.task); return Response.json({ success: true, file: 'f' + tasks.length }); }
    if (path === 'read') return Response.json({ success: true, items: [item(0, tasks[Number(b.file.slice(1)) - 1] === 'email-verification' ? 'info@a.example' : null)] });
    throw Error('Unexpected ' + path);
  };
  const client = new IcypeasClient('test', transport, async () => { reads++; return 'info@a.example'; });
  const run = async (userId: string) => {
    let result = await live(store, client).start(userId, companies());
    for (let n = 0; n < 8 && result.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await live(store, client).poll(userId, result.id); }
    return result;
  };
  try {
    assert.equal((await run(alice.id)).delivered, 1);
    assert.deepEqual(tasks, ['domain-search', 'email-verification']);
    const readByAlice = reads;
    assert.ok(readByAlice > 0);
    assert.equal((await run(bob.id)).delivered, 1, 'Bob still gets the published address');
    assert.deepEqual(tasks.slice(2), ['email-verification'], 'no second domain search');
    assert.equal(reads, readByAlice, 'the website was not read again');
  } finally { await store.close(); }
});

// Second review 2026-10-11: the shared answers never cost a member a result, and never break a search.
const withPublished = (t: { after: (fn: () => void) => void }) => {
  const flag = process.env.PUBLISHED_EMAIL_ENABLED; process.env.PUBLISHED_EMAIL_ENABLED = 'true';
  t.after(() => { if (flag === undefined) delete process.env.PUBLISHED_EMAIL_ENABLED; else process.env.PUBLISHED_EMAIL_ENABLED = flag; });
};
const verifying = (found: (email: string) => boolean) => {
  const sent: { task: string; data: string[][] }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split('/').pop(), b = JSON.parse(String(init?.body));
    if (path === 'find-companies') return Response.json({ success: true, leads: b.query.location.exclude ? [] : [company] });
    if (path === 'bulk-search') { sent.push(b); return Response.json({ success: true, file: 'f' + sent.length }); }
    if (path === 'read') { const s = sent[Number(b.file.slice(1)) - 1]; return Response.json({ success: true, items: [item(0, s.task === 'email-verification' && found(s.data[0][0]) ? s.data[0][0] : null)] }); }
    throw Error('Unexpected ' + path);
  };
  return { sent, transport };
};
const companySearch = async (store: Awaited<ReturnType<typeof testStore>>, client: IcypeasClient, userId: string) => {
  let result = await live(store, client).start(userId, companies());
  for (let n = 0; n < 12 && result.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await live(store, client).poll(userId, result.id); }
  return result;
};

test('a website that did not answer is not shared as having no address: the next member reads it', async t => {
  withPublished(t);
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  try {
    await companySearch(store, new IcypeasClient('test', verifying(() => true).transport, async () => { throw new Error('ECONNREFUSED'); }), alice.id);
    assert.equal((await companySearch(store, new IcypeasClient('test', verifying(() => true).transport, async () => 'info@a.example'), bob.id)).delivered, 1);
  } finally { await store.close(); }
});

test('a published address another member found nothing for does not cost the next member the company\'s other addresses', async t => {
  withPublished(t);
  const store = await testStore();
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5), bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  try {
    const page = async () => 'info@a.example sales@a.example contact@a.example', contact = (e: string) => e === 'contact@a.example';
    assert.equal((await companySearch(store, new IcypeasClient('test', verifying(contact).transport, page), alice.id)).delivered, 1);
    assert.equal((await companySearch(store, new IcypeasClient('test', verifying(contact).transport, page), bob.id)).delivered, 1, 'Bob still gets contact@');
  } finally { await store.close(); }
});

test('the search works before the shared tables exist, and a shared answer that cannot be written does not hold back a paid batch', async () => {
  const store = await testStore(), alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  try {
    await store.db.run('DROP TABLE provider_misses');
    const found = live(store, new IcypeasClient('k', async (url, init) => {
      const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
      if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [lead('a'), lead('b')] });
      if (path === 'bulk-search') return Response.json({ success: true, file: 'f1' });
      if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: [item(0, 'person@company-a.example'), item(1, null)] });
      return Response.json({ success: true, leads: [] });
    }));
    let result = await found.start(alice.id, input(2));
    for (let n = 0; n < 4 && result.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); result = await found.poll(alice.id, result.id); }
    assert.equal(result.delivered, 1, 'the found email is delivered, the miss is only not shared');
    assert.notEqual(result.status, 'awaiting_provider');
    assert.equal((await store.db.get<{ read_errors: number }>('SELECT read_errors FROM provider_runs'))!.read_errors, 0);
  } finally { await store.close(); }
});

test('the shared tables are the server\'s only, and a suppressed address leaves the website cache and is never stored there', async () => {
  const db = await testDb(true, true); // the production migrations, roles included
  try {
    await db.run('GRANT USAGE ON SCHEMA clowzy TO clowzy_app,anon,authenticated');
    for (const role of ['anon', 'authenticated']) {
      await db.run('SET ROLE ' + role);
      for (const table of ['provider_misses', 'site_reads']) await assert.rejects(db.get('SELECT * FROM ' + table), /permission denied/);
      await db.run('RESET ROLE');
    }
    await db.run('SET ROLE clowzy_app');
    await db.run("INSERT INTO site_reads(site,emails,read_at) VALUES('a.example','[\"info@a.example\",\"sales@a.example\"]',1)");
    await db.run("INSERT INTO provider_misses(key,checked_at) VALUES('k',1)");
    await db.run('RESET ROLE');
    await db.run("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('owner','owner','owner@test.com','x','admin','2026-10-02')");
    await db.get("SELECT clowzy.suppress_contact('owner','INFO@a.example')");
    assert.deepEqual((await db.get<{ emails: string[] }>("SELECT emails FROM site_reads WHERE site='a.example'"))!.emails, ['sales@a.example']);
  } finally { await db.end(); }
  const store = await testStore();
  try {
    await store.db.run("INSERT INTO catalog_suppressions(email,created_at) VALUES('info@a.example','2026-10-11')");
    await store.rememberSiteReads(new Map([['a.example', ['info@a.example', 'sales@a.example']]]));
    assert.deepEqual((await store.siteReads(['a.example'])).get('a.example'), ['sales@a.example']);
  } finally { await store.close(); }
});
