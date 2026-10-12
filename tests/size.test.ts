import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { searchSchema } from '../src/lib/schemas';
import { assistForm, sizeOf } from '../src/lib/contracts';
import { audienceOf } from '../src/lib/audience';
import { companiesQuery, cursorKey, IcypeasClient, peopleQuery } from '../src/lib/icypeas';
import { testStore } from './pg';

// Owner 2026-10-11 (Q6, Q11, Q2): the member picks a ceiling on company size, a thousand employees by default and never above; a company
// of unknown size passes. Free counts, Saudi Arabia: unknown sizes are 92% of salon people, under 1% in tech and restaurants.
const form = (o: Record<string, unknown> = {}) => ({ sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', title: '', count: 5, confirmed: true, requestId: randomUUID(), ...o });
const salons = (size: string) => audienceOf(JSON.stringify(form({ sector: 'صالونات التجميل النسائية', size })));

test('company size is a ceiling, a thousand by default and at most; older ranges read as their upper bound', () => {
  assert.equal(searchSchema.parse(form()).size, '1000');
  for (const [old, now] of [['all', '1000'], ['1-10', '10'], ['11-50', '50'], ['51-200', '200'], ['500', '500']]) assert.equal(searchSchema.parse(form({ size: old })).size, now, old);
  for (const wrong of ['5000', '20', 'huge', 42, { toString: 1 }]) assert.equal(searchSchema.safeParse(form({ size: wrong })).success, false, 'the server takes the listed sizes or an older range only');
  assert.equal(assistForm({ size: '11-50' }, 50).size, '50', 'an older link or saved audience');
  for (const [given, now] of [['20', '50'], ['0', '10'], ['5000', '1000'], [{ toString: 1 }, '1000'], [undefined, '1000'], ['', '1000'], [' ', '1000'], ['-', '1000']] as const) assert.equal(sizeOf(given), now, 'a link or the assistant: the nearest ceiling above');
});

test('where unknown sizes are rare the provider filters the size; salons and the other word niches keep their unknown sizes', () => {
  const tech = audienceOf(JSON.stringify(form({ size: '50' })));
  for (const stage of [0, 1]) assert.deepEqual(peopleQuery(tech, stage)['currentCompany.headcount'], { '>=': 1, '<=': 50 });
  assert.deepEqual(peopleQuery(audienceOf(JSON.stringify(form())))['currentCompany.headcount'], { '>=': 1, '<=': 1000 }, 'a thousand by default');
  assert.equal(peopleQuery(salons('10'), 0)['currentCompany.headcount'], undefined);
  assert.notEqual(cursorKey(salons('10')), cursorKey(salons('1000')), 'a salons search keeps one place in the pages per ceiling: its size filter is not in the query');
  // Companies: a recorded size of 0 is common (Saudi tech 23%, dental 22%, free counts 2026-10-12), above 1000 rare (tech 0.25%).
  assert.deepEqual(companiesQuery({ ...tech, mode: 'companies' }, 0).headcount, { '<=': 50 }, 'a smaller ceiling keeps the zeros');
  assert.equal(companiesQuery({ ...audienceOf(JSON.stringify(form())), mode: 'companies' }, 0).headcount, undefined, 'at a thousand: no filter, the few above it drop after the page');
  assert.equal(companiesQuery({ ...salons('10'), mode: 'companies' }, 0).headcount, undefined);
});

test('a company known to be above the ceiling is dropped from the page; an unknown size passes', async () => {
  const leads = [5, 2000, undefined].map((size, i) => ({ firstname: 'A', lastname: 'P' + i, profileUrl: 'https://www.linkedin.com/in/p' + i, lastJobTitle: 'Owner', address: 'Riyadh, Saudi Arabia',
    lastCompanyName: 'Salon ' + i, lastCompanyWebsite: 'https://www.salon' + i + '.example/', lastCompanyIndustry: 'Personal Care Services', ...(size === undefined ? {} : { lastCompanySize: size }) }));
  const client = new IcypeasClient('unit-test-secret', async () => Response.json({ success: true, leads }));
  assert.deepEqual((await client.people(salons('10'), null, 0)).leads.map(l => l.lastCompanyName).sort(), ['Salon 0', 'Salon 2']);
});

test('the free count asks the provider once per stage where its size filter already holds; the anyIndustry niches also count the known sizes', async () => {
  let calls = 0;
  const client = new IcypeasClient('unit-test-secret', async () => { calls++; return Response.json({ success: true, total: 10 }); });
  const tech = await client.count(audienceOf(JSON.stringify(form())));
  assert.equal(tech.reachable, tech.total);
  const techCalls = calls;
  await client.count(salons('1000'));
  assert.equal(calls - techCalls, 2 * techCalls * 2, 'salons: four stages, each counted with and without a known size');
});

test('a search in ten countries with many long job titles still keeps its place in the pages (the key has a size limit)', async () => {
  const store = await testStore(), user = await store.addUser('A', 'a@example.test', 'secure-password', 'member', 5);
  try {
    const raw = JSON.parse(JSON.stringify(audienceOf(JSON.stringify(form({ sector: 'صالونات التجميل النسائية', countries: ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'JO', 'LB', 'MA'] })))));
    raw.titles = Array.from({ length: 15 }, () => randomBytes(45).toString('base64').slice(0, 60)); // titles the database cannot compress
    await store.saveCursor(user.id, cursorKey(audienceOf(JSON.stringify(raw))), 0, null, '[]');
  } finally { await store.close(); }
});
