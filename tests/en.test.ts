import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { english, englishBody } from '../src/lib/en';
import { cleanSearch } from '../src/lib/ai';
import { assistForm } from '../src/lib/contracts';

const arabic = /[؀-ۿ]/;

test('every Arabic sentence the server can send has its English: a new message without a translation fails here', () => {
  const files = ['src/lib/crm.ts','src/lib/store.ts', 'src/lib/live-search.ts', 'src/lib/icypeas.ts', 'src/app/api/[...path]/route.ts', 'src/lib/access.ts', 'src/lib/audience.ts'];
  const missing: string[] = [];
  for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(/'([^'\n]*[؀-ۿ][^'\n]*[.…])\s?'/g)) {
    const text = m[1].trim();
    if (arabic.test(english(text))) missing.push(file + ': ' + text);
  }
  assert.deepEqual(missing, []);
});

test('messages built from parts and numbers come out whole in English', () => {
  const cases = [
    'بحثنا عن بريد 20 من الأشخاص المطابقين، ولم نجد بريدًا موثّقًا لأيّ منهم. أعد البحث بالمعايير نفسها لتجربة أشخاص آخرين، أو وسّعها لنتائج أكثر.',
    'بحثنا عن بريد 3 من الأشخاص المطابقين، ووجدنا بريدًا موثّقًا لـ 2 منهم، منها 1 مكرر مستبعد. جرّبنا كل المطابقين المتاحين. لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.',
    'بحثنا عن بريد 0 من الأشخاص المطابقين، ثم كمّلنا بإيميلات الشركات نفسها بعد فحص 2 منها، فوصلك 1 من 2. لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.',
    'تحققنا من بريد 4 من الشركات المطابقة، وصحّ بريد 3 منها. أعد البحث بالمعايير نفسها لتجربة شركات أخرى، أو وسّعها لنتائج أكثر.',
    'رصيد مزوّد البيانات لا يكفي لإكمال البحث الآن. حُسب فقط ما وصل. تواصل مع مالك المنصة.',
    'حُسب فقط ما وصل. بلغت حد البحث اليومي لحسابك. يمكنك البحث مجددًا بعد 24 ساعة من أول بحث اليوم، أو تواصل مع مالك المنصة.',
  ];
  for (const ar of cases) assert.ok(!arabic.test(english(ar)), english(ar));
  assert.equal(english('لم نجد مجالًا مهنيًا يطابق «محلات العطور». جرّب كلمات أوضح أو اختر من القائمة.'), 'No business field matches “محلات العطور”. Try clearer words or pick from the list.', 'the member\'s own words stay as typed');
  assert.deepEqual(englishBody({ error: 'راجع البيانات المدخلة.', searches: [{ title: 'العقارات · السعودية', message: 'حُسب فقط ما وصل.' }] }),
    { error: 'Check what you entered.', searches: [{ title: 'العقارات · السعودية', message: 'You paid only for what arrived.' }] }, 'only errors and messages; data stays');
});

test('the assistant\'s search is checked against the platform\'s lists before the page uses it', () => {
  assert.deepEqual(cleanSearch({ mode: 'people', field: 'الصحة والطب', specialty: 'عيادات الأسنان', countries: ['ae', 'XX', 'QM'], city: 'Dubai', title: 'مدير العيادة أو المدير الطبي', size: '11-50', count: 400 }),
    { mode: 'people', field: 'الصحة والطب', specialty: 'عيادات الأسنان', other: '', countries: ['AE'], city: 'Dubai', title: 'مدير العيادة أو المدير الطبي', size: '11-50', count: 50 });
  const fixed = cleanSearch({ field: 'Health', specialty: 'المدارس', countries: ['SA', 'AE'], city: 'Riyadh', size: 'huge', mode: 'x' })!;
  assert.deepEqual([fixed.field, fixed.specialty, fixed.city, fixed.size, fixed.mode, fixed.count], ['التعليم والتدريب', 'المدارس', '', 'all', 'people', 10], 'a specialty finds its field; a city needs one country; bad values fall back');
  assert.equal(cleanSearch({ field: 'غير موجود', other: 'محلات العطور', countries: ['KW'] })!.other, 'محلات العطور', 'no field fits: the member\'s own words');
  assert.equal(cleanSearch({ field: '', other: '' }), undefined, 'nothing to search for');
  assert.equal(cleanSearch({ mode: 'companies', field: 'العقارات والبناء', title: 'مدير التسويق' })!.title, '', 'a company has no job title');
});

test('a suggestion arriving in a link is checked in the browser: wrong types never crash the page, the count fits the balance', () => {
  for (const raw of [null, 5, 'x', { other: 5, countries: 'SA' }, { countries: [1, 'sa', 'AE'], size: 'huge', count: 'many', mode: 'admin' }]) assert.doesNotThrow(() => assistForm(raw, 10));
  assert.deepEqual(assistForm({ countries: [1, 'sa', 'AE'], size: 'huge', count: 40, mode: 'admin', title: 'مدير مستودع', city: 'Dubai' }, 3),
    { mode: 'people', sector: undefined, countries: ['AE'], city: 'Dubai', title: 'مدير مستودع', size: 'all', count: 3 });
  assert.equal(assistForm({ specialty: 'عيادات الأسنان', field: 'الصحة والطب' }, 10).sector, 'عيادات الأسنان');
});
