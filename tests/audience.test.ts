import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf, resolveAudience, SECTOR_INDUSTRIES, TITLE_VARIANTS, type AiMapper } from '../src/lib/audience';
import { INDUSTRIES } from '../src/lib/industries';
import { gulf, sectors, titles, type SearchInput } from '../src/lib/contracts';
import { peopleQuery, IcypeasError } from '../src/lib/icypeas';
import { countryFromText, isCountry } from '../src/lib/places';
import { AppError } from '../src/lib/store';
import { testStore } from './pg';

const form = (o: Partial<SearchInput> = {}): SearchInput => ({ sector: 'التقنية والبرمجيات', countries: ['SA'], city: '', title: '', size: 'all', count: 5, confirmed: true, requestId: randomUUID(), ...o });
const noAi: AiMapper = { sector: async () => { throw new Error('AI must not be called for a listed option'); }, title: async () => { throw new Error('AI must not be called'); } };

test('every listed sector and title maps to exact Icypeas names; the lists the member sees match the server tables', () => {
  assert.ok(sectors.length >= 30, 'about 30 sectors');
  assert.deepEqual(Object.keys(SECTOR_INDUSTRIES), [...sectors]);
  for (const [sector, names] of Object.entries(SECTOR_INDUSTRIES)) for (const n of names) assert.ok(INDUSTRIES.includes(n), sector + ': ' + n);
  assert.deepEqual(Object.keys(TITLE_VARIANTS), [...titles]);
  for (const variants of Object.values(TITLE_VARIANTS)) assert.ok(variants.some(v => /^[A-Za-z]/.test(v)) && variants.some(v => /[؀-ۿ]/.test(v)), 'Arabic and English titles together');
});

test('several countries search together: codes first, then the names Arabic-localized profiles use', async () => {
  const store = await testStore();
  try {
    const a = await resolveAudience(store, form({ countries: ['QA', 'SA', 'AE'] }), noAi);
    assert.deepEqual(peopleQuery(a).profileLocation, { include: ['AE', 'QA', 'SA'] });
    assert.deepEqual(peopleQuery(a, 1).profileLocation, { include: ['United Arab Emirates', 'الإمارات', 'Qatar', 'قطر', 'Saudi Arabia', 'السعودية'], exclude: ['AE', 'QA', 'SA'] });
    const same = await resolveAudience(store, form({ countries: ['SA', 'AE', 'QA'] }), noAi);
    assert.deepEqual(peopleQuery(same), peopleQuery(a), 'the same audience in another order is the same query (same cursor)');
    const all = await resolveAudience(store, form({ countries: [...gulf] }), noAi);
    assert.equal(peopleQuery(all).profileLocation.include.length, 6);
    const oman = await resolveAudience(store, form({ countries: ['OM'] }), noAi);
    assert.deepEqual(peopleQuery(oman, 1).profileLocation.include, ['Oman', 'سلطنة عمان'], 'never bare عمان: it also matches Amman');
    assert.throws(() => peopleQuery({ ...all, city: 'الرياض' }), (e: IcypeasError) => e.status === 400, 'a city needs exactly one country');
  } finally { await store.close(); }
});

test('a listed title searches its Arabic and English forms; a typed English title is used as is; an Arabic one goes through the AI once', async () => {
  const store = await testStore();
  let calls = 0;
  const ai: AiMapper = { ...noAi, title: async text => { calls++; assert.equal(text, 'مدير مستودع'); return ['Warehouse Manager', 'Warehouse Supervisor']; } };
  try {
    const listed = await resolveAudience(store, form({ title: 'مدير التسويق' }), noAi);
    assert.ok(peopleQuery(listed).currentJobTitle!.include.includes('Marketing Manager'));
    assert.ok(peopleQuery(listed).currentJobTitle!.include.includes('مدير التسويق'));
    assert.deepEqual(peopleQuery(await resolveAudience(store, form({ title: 'Marketing Director' }), noAi)).currentJobTitle, { include: ['Marketing Director'] });
    const typed = await resolveAudience(store, form({ title: 'مدير مستودع' }), ai);
    assert.deepEqual(typed.titles, ['مدير مستودع', 'Warehouse Manager', 'Warehouse Supervisor']);
    await resolveAudience(store, form({ title: '  مُدير   مستودع ' }), ai);
    assert.equal(calls, 1, 'cached by the normalized text: the same words never pay twice or change the cursor');
    const down: AiMapper = { ...noAi, title: async () => { throw new Error('down'); } };
    assert.deepEqual((await resolveAudience(store, form({ title: 'مدير مخازن' }), down)).titles, ['مدير مخازن'], 'the AI being down never blocks a search: the Arabic words still search');
  } finally { await store.close(); }
});

test('a typed sector maps to exact industry names only; nonsense or an AI outage is a clear error, never a random search', async () => {
  const store = await testStore();
  const ai = (answer: { name: string; ar: string }[] | Error): AiMapper => ({ ...noAi, sector: async () => { if (answer instanceof Error) throw answer; return answer; } });
  try {
    const perfume = await resolveAudience(store, form({ sector: 'محلات العطور' }), ai([{ name: 'Retail Health and Personal Care Products', ar: 'متاجر العناية الشخصية' }, { name: 'Perfume Kingdom', ar: 'مخترع' }, { name: 'Cosmetics', ar: 'مستحضرات التجميل' }]));
    assert.deepEqual(perfume.industries, ['Retail Health and Personal Care Products', 'Cosmetics'], 'names outside the provider list are dropped');
    assert.deepEqual(perfume.industryLabels, ['متاجر العناية الشخصية', 'مستحضرات التجميل']);
    const cafes = await resolveAudience(store, form({ sector: 'مطاعم وكافيهات' }), ai([{ name: 'Restaurants', ar: 'المطاعم' }, { name: 'Bars, Taverns, and Nightclubs', ar: 'الحانات والنوادي الليلية' }]));
    assert.deepEqual(cafes.industryLabels, ['المطاعم'], 'alcohol, nightlife and gambling are never searched: they embarrass a Gulf member');
    let asked = 0;
    const nonsense: AiMapper = { ...noAi, sector: async () => { asked++; return [{ name: 'Not An Industry', ar: 'x' }]; } };
    for (let i = 0; i < 2; i++) await assert.rejects(resolveAudience(store, form({ sector: 'كلام بلا معنى' }), nonsense), (e: AppError) => e.status === 400);
    assert.equal(asked, 1, 'an answer with no usable industry is cached too: nonsense is not paid for on every field change');
    await assert.rejects(resolveAudience(store, form({ sector: 'محلات الورد' }), ai(new Error('down'))), (e: AppError) => e.status === 503);
    const english = await resolveAudience(store, form({ sector: 'متاجر الهدايا' }), ai([{ name: 'Retail Office Supplies and Gifts', ar: 'Gift shops' }]));
    assert.deepEqual(english.industryLabels, ['متاجر الهدايا'], 'members read Arabic only: a label without Arabic falls back to their own words');
    const listed = await resolveAudience(store, form({ sector: 'عيادات الأسنان' }), noAi);
    assert.deepEqual(listed.industries, ['Dentists']);
  } finally { await store.close(); }
});

test('filters saved before multi-country (country name, no resolved lists) still run and repeat', () => {
  const old = JSON.stringify({ sector: 'العقارات', country: 'قطر', city: '', title: 'Marketing Director', size: 'all', count: 3, confirmed: true, requestId: randomUUID() });
  const a = audienceOf(old);
  assert.deepEqual(a.countries, ['QA']);
  assert.deepEqual(a.industries, SECTOR_INDUSTRIES['العقارات']);
  assert.deepEqual(a.titles, ['Marketing Director']);
  assert.deepEqual(peopleQuery(a).profileLocation, { include: ['QA'] });
});

test('a typed country resolves to its code by exact name (Arabic or English, common short forms); anything else is refused', () => {
  for (const [text, code] of [['الأردن', 'JO'], ['الاردن', 'JO'], ['المغرب', 'MA'], ['Jordan', 'JO'], ['امريكا', 'US'], ['أمريكا', 'US'], ['بريطانيا', 'GB'], ['فلسطين', 'PS'], ['السعودية', 'SA'], ['تركيا', 'TR']] as const)
    assert.equal(countryFromText(text), code, text);
  for (const text of ['السودا', 'كوريا', 'xyz', '']) assert.equal(countryFromText(text), '', text);
  assert.ok(isCountry('JO')); assert.ok(!isCountry('EU')); assert.ok(!isCountry('ZZ')); assert.ok(!isCountry('sa'));
});
