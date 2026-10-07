import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { IcypeasClient } from '../src/lib/icypeas';
import { english } from '../src/lib/en';
import { countryFromText, farther, nearby, placeOf } from '../src/lib/places';
import { item, lead, live, testStore } from './pg';

// Client 2026-10-05: «إذا ما لقي إيميلات، يوسع… ولا مرة بدي يكون ناقص». Owner: widen the place only (city, then the whole country,
// then the region's other countries), on by default with a box to turn it off, and the companies' own emails come last.
const ask = (o: Record<string, unknown>) => audienceOf(JSON.stringify({ sector: 'التقنية والبرمجيات', countries: ['LB'], city: '', title: '', size: 'all', count: 2, confirmed: true, requestId: randomUUID(), ...o }));
const at = (id: string, address: string) => ({ ...lead(id), address });
// One page per place (people by profile location, companies by headquarters); every person found, no company has an email.
function provider(people: Record<string, unknown[]>, found = (row: string[]) => !!row) {
  const calls: { path: string; place: string }[] = [], bulks: string[][][] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    const where = body.query?.profileLocation ?? body.query?.location;
    if (path === 'find-people' || path === 'find-companies') {
      const place = where?.exclude ? 'broad' : String(where?.include);
      calls.push({ path, place });
      return Response.json({ success: true, leads: path === 'find-people' && place !== 'broad' ? people[place] ?? [] : [] });
    }
    if (path === 'bulk-search') { bulks.push(body.data); return Response.json({ success: true, file: 'f' + bulks.length }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: bulks[Number(String(body.file).slice(1)) - 1].map((row, i) => item(i, found(row) ? row[1] + '@' + row[2] : null)) });
    throw new Error('Unexpected ' + path);
  };
  return { calls, client: new IcypeasClient('unit-test-secret', transport) };
}
async function run(people: Record<string, unknown[]>, request: ReturnType<typeof ask>, found?: (row: string[]) => boolean, before?: (store: Awaited<ReturnType<typeof testStore>>, userId: string) => Promise<unknown>) {
  const p = provider(people, found), store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  await before?.(store, user.id);
  const search = live(store, p.client);
  let s = await search.start(user.id, request);
  for (let n = 0; n < 80 && s.status === 'awaiting_provider'; n++) { await store.db.run('UPDATE provider_runs SET updated_at=0'); s = await search.poll(user.id, s.id); }
  return { ...p, s, contacts: (await store.snapshot(user.id)).contacts.map(c => c.email).sort(), close: () => store.close() };
}

test('each country widens to its own region only, in a fixed order', () => {
  assert.deepEqual(nearby(['LB']), ['SY', 'JO', 'PS', 'IQ']);
  assert.deepEqual(nearby(['SA']), ['AE', 'KW', 'QA', 'BH', 'OM', 'YE']);
  assert.deepEqual(nearby(['SA', 'AE']), ['KW', 'QA', 'BH', 'OM', 'YE']);
  assert.deepEqual(nearby(['TR']), []);
  assert.deepEqual([placeOf('Sanaa, Yemen').code, countryFromText('اليمن')], ['YE', 'YE'], 'not YD, old South Yemen: the Gulf widening ends in Yemen');
});

test('after its own region, a search moves to the other regions, nearest first, each region as one place', () => {
  const gulf = ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'YE'], levant = ['LB', 'SY', 'JO', 'PS', 'IQ'], nile = ['EG', 'SD'], maghreb = ['MA', 'DZ', 'TN', 'LY', 'MR'];
  assert.deepEqual(farther(['LB']), [gulf, nile, maghreb]);
  assert.deepEqual(farther(['SA', 'AE']), [levant, nile, maghreb]);
  assert.deepEqual(farther(['EG']), [levant, gulf, maghreb]);
  assert.deepEqual(farther(['DZ']), [nile, levant, gulf]);
  assert.deepEqual(farther(['SA', 'EG']), [levant, maghreb], 'a region the member already picked is not widened to again');
  assert.deepEqual(farther(['TR']), []);
});

test('a place that used up its attempts still lets the next place be searched, with attempts of its own', async () => {
  const lebanon = Array.from({ length: 25 }, (_, i) => at('lb' + i, 'Beirut, Lebanon'));
  const r = await run({ LB: lebanon, SY: [at('damascus', 'Damascus, Syria')] }, ask({ count: 1 }), row => !row[1].startsWith('lb'));
  try {
    assert.equal(r.s.status, 'completed', 'Lebanon: 20 attempts, no email; Syria: found');
    assert.deepEqual(r.contacts, ['damascus@company-damascus.example']);
  } finally { await r.close(); }
});

test('a search short of its count widens to the next country of the region, people first, and says where', async () => {
  const r = await run({ LB: [at('beirut', 'Beirut, Lebanon')], SY: [at('damascus', 'Damascus, Syria')] }, ask({}));
  try {
    assert.equal(r.s.status, 'completed');
    assert.deepEqual(r.contacts, ['beirut@company-beirut.example', 'damascus@company-damascus.example']);
    assert.ok(!r.calls.some(c => c.path === 'find-companies'), 'the companies\' emails come only after every place');
  } finally { await r.close(); }
});

test('a city widens to its whole country before any other country', async () => {
  const r = await run({ 'Jeddah, SA': [at('jeddah', 'Jeddah, Makkah, Saudi Arabia')], SA: [at('riyadh', 'Riyadh, Saudi Arabia')] }, ask({ countries: ['SA'], city: 'جدة' }));
  try {
    assert.equal(r.s.status, 'completed');
    const strict = r.calls.filter(c => c.place !== 'broad').map(c => c.place);
    assert.deepEqual(strict.slice(0, 2), ['Jeddah, SA', 'SA']);
  } finally { await r.close(); }
});

test('the whole region short of its count (people, then the businesses\' own emails), the search moves on to the nearest region', async () => {
  const r = await run({ LB: [at('beirut', 'Beirut, Lebanon')], 'AE,BH,KW,OM,QA,SA,YE': [at('riyadh', 'Riyadh, Saudi Arabia')] }, ask({}));
  try {
    assert.equal(r.s.status, 'completed');
    assert.deepEqual(r.contacts, ['beirut@company-beirut.example', 'riyadh@company-riyadh.example']);
    assert.deepEqual(r.calls.filter(c => c.place !== 'broad').map(c => c.path.slice(5, 9) + ' ' + c.place),
      ['peop LB', 'peop SY', 'peop JO', 'peop PS', 'peop IQ', 'comp LB', 'comp SY', 'comp JO', 'comp PS', 'comp IQ', 'peop AE,BH,KW,OM,QA,SA,YE']);
    assert.ok(r.s.widenedTo?.includes('SA'), 'the page names the Gulf among the places searched');
  } finally { await r.close(); }
});

test('with nothing left anywhere, the companies\' own emails come after each region\'s people, from the member\'s place first; the message names the places', async () => {
  const r = await run({ LB: [at('beirut', 'Beirut, Lebanon')] }, ask({ count: 3 }));
  try {
    const firstCompanies = r.calls.findIndex(c => c.path === 'find-companies');
    assert.deepEqual(r.calls.slice(0, firstCompanies).filter(c => c.place !== 'broad').map(c => c.place), ['LB', 'SY', 'JO', 'PS', 'IQ']);
    assert.equal(r.calls[firstCompanies].place, 'LB');
    assert.equal(r.s.status, 'partial');
    assert.match(r.s.message ?? '', /^وسّعنا البحث إلى: سوريا، الأردن، فلسطين، العراق، السعودية، [^.]*موريتانيا\. /);
    assert.match(english(r.s.message ?? ''), /^We widened the search to: Syria, Jordan, Palestin[^,]*, Iraq, Saudi Arabia, [^.]*Mauritania\. /);
    assert.match(r.s.message ?? '', /لنتائج أكثر، اختر نشاطًا أوسع\.$/, 'every country of the region was tried: adding countries is no advice');
  } finally { await r.close(); }
});

test('the member can turn widening off: the search stays in its place', async () => {
  const r = await run({ LB: [at('beirut', 'Beirut, Lebanon')], SY: [at('damascus', 'Damascus, Syria')] }, ask({ widen: false }));
  try {
    assert.deepEqual(r.contacts, ['beirut@company-beirut.example']);
    assert.ok(!r.calls.some(c => c.place === 'SY'));
  } finally { await r.close(); }
});

test('a web-discovery cap closes that place only: the search moves on instead of ending short (dental Lebanon, 8 of 10, 2026-10-07)', async t => {
  const env = { key: process.env.OPENROUTER_API_KEY, web: process.env.WEB_DISCOVERY_ENABLED };
  process.env.OPENROUTER_API_KEY = 'unit-test-key'; process.env.WEB_DISCOVERY_ENABLED = 'true';
  t.after(() => { for (const [k, v] of [['OPENROUTER_API_KEY', env.key], ['WEB_DISCOVERY_ENABLED', env.web]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const day = 86400000, now = Date.now();
  const r = await run({ LB: [at('beirut', 'Beirut, Lebanon')], 'AE,BH,KW,OM,QA,SA,YE': [at('riyadh', 'Riyadh, Saudi Arabia')] }, ask({}), undefined,
    (store, userId) => store.db.run('INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,12)', 'web-day:' + userId, now - now % day)); // today's web rounds used up
  try {
    assert.equal(r.s.status, 'completed', r.s.message);
    assert.deepEqual(r.contacts, ['beirut@company-beirut.example', 'riyadh@company-riyadh.example']);
  } finally { await r.close(); }
});
