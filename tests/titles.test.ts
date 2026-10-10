import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf, resolveAudience, type AiMapper } from '../src/lib/audience';
import { catalogMatches, rememberCandidates } from '../src/lib/catalog';
import { assistForm, type Candidate, findTitles, labelsEn, TITLE_VARIANTS, titles } from '../src/lib/contracts';
import { cleanSearch } from '../src/lib/ai';
import { peopleQuery } from '../src/lib/icypeas';
import { searchSchema } from '../src/lib/schemas';
import { testStore } from './pg';

// Client 2026-10-09: «يختار أكثر من واحد… شغلتين أو ثلاثة»، and the title field searches as you type, like the activity field.
// Owner's decisions the same day: up to three titles; a typed title not in the list is still accepted; the list grows to the
// common titles (each checked with free provider counts in Saudi Arabia, the Emirates and Lebanon); decision makers first.
const base = { mode: 'people', sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', size: 'all', count: 5, widen: true, confirmed: true, requestId: randomUUID() };
const noAi: AiMapper = { sector: async () => { throw new Error('AI must not be called for a listed option'); }, title: async () => { throw new Error('AI must not be called for a listed title'); } };

test('typing finds a title by its Arabic name, its English name or a word people use for it', () => {
  assert.ok(findTitles('product').includes('مدير المنتج'));
  assert.ok(findTitles('منتج').includes('مدير المنتج'));
  assert.ok(findTitles('مستودع').includes('مدير المستودع'));
  assert.equal(findTitles('dentist')[0], 'طبيب الأسنان');
  assert.ok(findTitles('CEO').includes('الرئيس التنفيذي أو المدير العام'), 'a common English form, not only the label');
  // Words match from their start, exact words first (review 2026-10-09: «CTO» picked the CEO through «director»).
  assert.equal(findTitles('CTO')[0], 'مدير تقنية المعلومات');
  assert.equal(findTitles('IT')[0], 'مدير تقنية المعلومات');
  assert.equal(findTitles('PR')[0], 'مدير العلاقات العامة');
  assert.equal(findTitles('art')[0], 'المدير الإبداعي');
  assert.ok(!findTitles('art').includes('الشريك'), '«art» is not in «Partner»');
  assert.ok(findTitles('مستودع').includes('مدير المستودع') && findTitles('مدير منتج').includes('مدير المنتج'), 'the Arabic article does not hide a word');
  // Final review 2026-10-09: everyday words and abbreviations, the label before a provider form, and nothing for punctuation.
  for (const [typed, first] of [['account', 'مدير حسابات العملاء'], ['دكتور', 'الطبيب'], ['صاحب', 'المالك أو المؤسس'], ['gm', 'الرئيس التنفيذي أو المدير العام'],
    ['مدير مشروع', 'مدير المشاريع'], ['مدير التسويق الرقمي', 'مسؤول التسويق الرقمي'], ['صيدلية', 'الصيدلي'], ['محاسبة', 'المحاسب'], ['مدير المستودعات', 'مدير المستودع'], ['مسؤول مبيعات', 'مندوب المبيعات']])
    assert.equal(findTitles(typed)[0], first, typed);
  assert.deepEqual(findTitles('..'), []); assert.deepEqual(findTitles('؟؟'), []);
  assert.deepEqual(findTitles(''), [...titles], 'an empty box lists every title');
  assert.deepEqual(findTitles('zzqx'), []);
});

test('the list holds the common titles, each with Arabic and English forms and an English name', () => {
  assert.ok(titles.length >= 40, 'about forty titles: ' + titles.length);
  // The provider matches a form anywhere in a job title: «Principal» alone was 1,867 people in the Emirates, 147 of them school principals.
  assert.ok(!TITLE_VARIANTS['مدير المدرسة'].includes('Principal'));
  for (const t of titles) {
    assert.ok(TITLE_VARIANTS[t].some(v => /^[A-Za-z]/.test(v)) && TITLE_VARIANTS[t].some(v => /[؀-ۿ]/.test(v)), t);
    assert.ok(labelsEn[t], 'English name for ' + t);
  }
});

test('a search takes up to three titles; one title from an older page or a stored search reads as a list of one', () => {
  assert.deepEqual(searchSchema.parse({ ...base, title: 'مدير التسويق' }).title, ['مدير التسويق']);
  assert.deepEqual(searchSchema.parse({ ...base, title: '' }).title, []);
  assert.deepEqual(searchSchema.parse(base).title, []);
  assert.deepEqual(searchSchema.parse({ ...base, title: ['مدير التسويق', 'المالك أو المؤسس', 'Growth Lead'] }).title, ['مدير التسويق', 'المالك أو المؤسس', 'Growth Lead']);
  assert.deepEqual(searchSchema.parse({ ...base, title: [' مدير التسويق ', 'مدير التسويق', ''] }).title, ['مدير التسويق'], 'trimmed, blanks and repeats dropped');
  assert.throws(() => searchSchema.parse({ ...base, title: ['a1', 'b2', 'c3', 'd4'] }), 'a fourth title is refused');
});

test('several titles search together: a person matching any of them, every Arabic and English form sent at once', async () => {
  const store = await testStore();
  let calls = 0;
  const ai: AiMapper = { ...noAi, title: async text => { calls++; assert.equal(text, 'مدير مستودع جديد'); return ['New Warehouse Manager']; } };
  try {
    const two = await resolveAudience(store, searchSchema.parse({ ...base, title: ['مدير التسويق', 'المالك أو المؤسس'] }), noAi);
    for (const v of ['Marketing Manager', 'مدير التسويق', 'Owner', 'Founder']) assert.ok(peopleQuery(two).currentJobTitle!.include.includes(v), v);
    const mixed = await resolveAudience(store, searchSchema.parse({ ...base, title: ['مدير التسويق', 'مدير مستودع جديد', 'Growth Lead'] }), ai);
    assert.equal(calls, 1, 'only the typed Arabic title goes through the AI');
    for (const v of ['Marketing Manager', 'مدير مستودع جديد', 'New Warehouse Manager', 'Growth Lead']) assert.ok(mixed.titles.includes(v), v);
    assert.equal(new Set(mixed.titles).size, mixed.titles.length, 'no form sent twice');
    assert.deepEqual((await resolveAudience(store, searchSchema.parse({ ...base, mode: 'companies', title: ['مدير التسويق'] }), noAi)).titles, [], 'a company search has no job title');
  } finally { await store.close(); }
});

test('a search stored with one title before this change runs and repeats exactly as it did', () => {
  const stored = JSON.stringify({ ...base, title: 'مدير التسويق' });
  assert.deepEqual(audienceOf(stored).titles, TITLE_VARIANTS['مدير التسويق']);
  assert.deepEqual(audienceOf(stored).title, ['مدير التسويق']);
  assert.deepEqual(assistForm({ ...JSON.parse(stored), other: 'التقنية والبرمجيات' }, 50).title, ['مدير التسويق'], '«search again» fills the new field');
});

test('the assistant can fill up to three titles; an older link with one title still works', () => {
  assert.deepEqual(assistForm({ title: ['مدير التسويق', 'Growth Lead', 'المالك أو المؤسس', 'مدير المبيعات'] }, 50).title, ['مدير التسويق', 'Growth Lead', 'المالك أو المؤسس']);
  assert.deepEqual(assistForm({ title: 'مدير التسويق' }, 50).title, ['مدير التسويق']);
  assert.deepEqual(assistForm({ mode: 'companies', title: ['مدير التسويق'] }, 50).title, []);
  assert.deepEqual(cleanSearch({ other: 'محلات الساعات', title: ['مدير التسويق', 'المالك أو المؤسس'] })?.title, ['مدير التسويق', 'المالك أو المؤسس']);
  assert.deepEqual(cleanSearch({ other: 'محلات الساعات', title: 'مدير التسويق' })?.title, ['مدير التسويق']);
});

test('a search stored with one title before this change, sent again with the same request id, is the same search, not a conflict', async () => {
  const store = await testStore();
  try {
    const user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
    const request = audienceOf(JSON.stringify({ ...base, title: 'مدير التسويق' }));
    const first = await store.enqueueSearch(user.id, request);
    await store.db.run(`UPDATE searches SET filters=replace(filters,'"title":["مدير التسويق"]','"title":"مدير التسويق"') WHERE id=?`, first.id); // as the live version stored it
    assert.match((await store.getSearch(user.id, first.id)).filters, /"title":"مدير التسويق"/);
    assert.equal((await store.enqueueSearch(user.id, request)).id, first.id);
  } finally { await store.close(); }
});

test('an identical request stored before this change still lends what it delivered', async t => {
  process.env.CRM_ENABLED = 'true'; process.env.CATALOG_REUSE_ENABLED = 'true';
  t.after(() => { delete process.env.CRM_ENABLED; delete process.env.CATALOG_REUSE_ENABLED; });
  const store = await testStore(); t.after(() => store.close());
  const a = await store.addUser('A', 'a@example.test', 'secure-password', 'member', 5), b = await store.addUser('B', 'b@example.test', 'secure-password', 'member', 5);
  const request = audienceOf(JSON.stringify({ ...base, countries: ['LB'], count: 2 }));
  const found: Candidate[] = [{ kind: 'person', name: 'Omar', email: 'omar@damascus.example', company: 'Damascus Soft', title: 'CEO', sector: 'Software Development', country: 'سوريا', city: 'Damascus', website: 'https://damascus.example', size: '12', source: 'clowzy', email_status: 'VERIFIED' }];
  const first = await store.enqueueSearch(a.id, request); await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?", first.id);
  await store.deliverBatch(a.id, first.id, found); await rememberCandidates(store, found);
  await store.db.run(`UPDATE searches SET filters=replace(filters,'"title":[]','"title":""') WHERE id=?`, first.id);
  assert.deepEqual((await catalogMatches(store, b.id, { ...request, requestId: randomUUID() }, 50)).map(c => c.email), ['omar@damascus.example']);
});
