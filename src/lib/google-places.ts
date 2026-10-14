import { z } from 'zod';
import type { Resolved } from './contracts';
import { nicheOf, type NicheName } from './niches';
import { cityNames, englishName } from './places';

// Client 2026-10-14 (owner's answers Q5, Q10-Q12): a local-business company search goes on with Google Maps once the
// provider's list runs out. Google's terms forbid saving its business names, addresses and phones (Maps Platform terms
// 3.2.3), so only a place's website leaves this file; its name is used here alone, to drop labs and suppliers by name.
type Scope = Pick<Resolved, 'countries' | 'city' | 'industries'> & Partial<Pick<Resolved, 'mode' | 'sector'>>;

// Businesses people walk into or call locally (owner: «restaurants, dental clinics, shops, like that»).
const LOCAL: readonly NicheName[] = ['مكاتب العقارات', 'عيادات الأسنان', 'عيادات التجميل', 'العيادات الخاصة', 'النوادي الرياضية', 'أخصائيو التغذية',
  'مراكز التدريب', 'مراكز اللغات', 'مكاتب المحاماة', 'شركات التصميم الداخلي', 'شركات الأثاث', 'شركات التكييف', 'شركات التنظيف', 'معارض السيارات',
  'تأجير السيارات', 'مراكز صيانة السيارات', 'الفنادق والشاليهات', 'مكاتب السياحة والسفر', 'المطاعم', 'محلات المجوهرات', 'منظمو الأعراس',
  'استوديوهات التصوير', 'شركات المسابح', 'شركات الألمنيوم والزجاج', 'شركات الأمن والكاميرات', 'صالونات التجميل النسائية', 'صالونات الحلاقة الرجالية',
  'مراكز العناية بالأظافر', 'خبيرات المكياج', 'مراكز السبا والمساج', 'مراكز الليزر وإزالة الشعر', 'متاجر مستحضرات التجميل', 'محلات العطور',
  'مراكز العلاج الطبيعي', 'محلات النظارات والبصريات', 'العيادات البيطرية', 'الصيدليات', 'مراكز الطب البديل والحجامة', 'استوديوهات اليوغا والبيلاتس',
  'المقاهي', 'المخابز ومحلات الحلويات', 'عربات الطعام', 'السوبرماركت والبقالات', 'محلات الملابس والأزياء', 'محلات الجوالات والإلكترونيات',
  'محلات الورد والهدايا', 'محلات قطع غيار السيارات', 'مغاسل وتلميع السيارات', 'المغاسل والدراي كلين', 'محلات مواد البناء', 'شركات تنسيق الحدائق',
  'شركات المطابخ', 'شركات مكافحة الحشرات', 'شركات نقل العفش', 'المدارس الخاصة', 'الحضانات ورياض الأطفال', 'مراكز الدروس الخصوصية',
  'وسطاء التأمين', 'مكاتب الاستقدام', 'مكاتب الترجمة', 'شركات الطباعة'];

// The local niche a search is about: its own label, or a provider category that is exactly one local niche's (Dentists, Restaurants;
// not Personal Care Services, which four niches share).
const localNiche = (input: Scope) => {
  if (LOCAL.includes(input.sector as NicheName)) return nicheOf(input.sector!);
  const same = LOCAL.map(nicheOf).filter(n => n && [...n.industries].sort().join() === [...input.industries].sort().join());
  return same.length === 1 ? same[0] : undefined;
};
// On whenever the key is set (an empty key turns it off).
export const mapsEnabled = (input: Scope) => !!process.env.GOOGLE_PLACES_API_KEY?.trim() && input.mode === 'companies' && !!localNiche(input);

// Q11: one query returns at most 60 places, so a search without a city goes through the country's main cities in turn.
// ponytail: these cities only (60 places each at most); smaller towns are never searched. Add cities where a country runs short.
const MAIN_CITIES: Record<string, string[]> = {
  SA: ['Riyadh', 'Jeddah', 'Dammam', 'Mecca', 'Medina', 'Khobar', 'Taif', 'Abha', 'Tabuk', 'Buraidah'], AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Al Ain', 'Ras Al Khaimah'],
  QA: ['Doha', 'Al Rayyan', 'Al Wakrah'], KW: ['Kuwait City', 'Hawalli', 'Salmiya', 'Farwaniya'], BH: ['Manama', 'Muharraq', 'Riffa'], OM: ['Muscat', 'Salalah', 'Sohar', 'Nizwa'],
  EG: ['Cairo', 'Giza', 'Alexandria', 'Mansoura', 'Tanta'], JO: ['Amman', 'Irbid', 'Zarqa', 'Aqaba'], LB: ['Beirut', 'Tripoli', 'Jounieh', 'Sidon', 'Zahle'],
  SY: ['Damascus', 'Aleppo', 'Homs', 'Latakia'], IQ: ['Baghdad', 'Erbil', 'Basra', 'Sulaymaniyah', 'Najaf'], PS: ['Ramallah', 'Nablus', 'Hebron', 'Gaza'],
  MA: ['Casablanca', 'Rabat', 'Marrakesh', 'Tangier', 'Fes', 'Agadir'], DZ: ['Algiers', 'Oran', 'Constantine', 'Setif', 'Annaba'], TN: ['Tunis', 'Sfax', 'Sousse'],
  LY: ['Tripoli', 'Benghazi', 'Misrata'], SD: ['Khartoum', 'Omdurman', 'Port Sudan'], YE: ['Sanaa', 'Aden'], MR: ['Nouakchott', 'Nouadhibou'],
  SO: ['Mogadishu', 'Hargeisa'], DJ: ['Djibouti'], KM: ['Moroni'],
};
export const mapsPlaces = (input: Scope) => input.countries.flatMap(cc => {
  const city = input.city.trim(), country = englishName(cc);
  return (city ? [cityNames[city] ?? city] : MAIN_CITIES[cc] ?? ['']).map(c => ({ cc, place: [c, country].filter(Boolean).join(', ') }));
});

const cursorSchema = z.object({ at: z.number().int().nonnegative(), page: z.string().min(1).max(2000).optional(), n: z.number().int().positive().optional() });
const PAGES = 3; // Google's own end: 60 places a query. Also stops a page token Google repeats from paying forever.
const answer = z.object({ places: z.array(z.object({ displayName: z.object({ text: z.string() }).optional(), websiteUri: z.string().optional() })).max(20).optional(), nextPageToken: z.string().optional() });

// One page (up to 20 places) of one city per call; the token holds the city reached, Google's page token and the page count.
// ponytail: regionCode only biases Google, and a lead's place is the city searched: a border town's business may be filed under it.
export async function mapsCompanies(input: Scope, token: string | null | undefined, transport: typeof fetch) {
  let cursor: z.infer<typeof cursorSchema> = { at: 0 };
  try { cursor = cursorSchema.parse(JSON.parse(token ?? '')); } catch { /* none yet, or unreadable: the first city */ }
  const places = mapsPlaces(input), n = cursor.n ?? 1;
  const at = places[cursor.at], next = (page?: string) => page && n < PAGES ? JSON.stringify({ at: cursor.at, page, n: n + 1 }) : cursor.at + 1 < places.length ? JSON.stringify({ at: cursor.at + 1 }) : null;
  if (!at) return { companies: [], returned: 0, token: null };
  try {
    const res = await transport('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY?.trim() ?? '', 'X-Goog-FieldMask': 'places.displayName,places.websiteUri,nextPageToken' },
      body: JSON.stringify({ textQuery: localNiche(input)!.en + ' in ' + at.place, pageSize: 20, regionCode: at.cc, ...(cursor.page ? { pageToken: cursor.page } : {}) }),
      signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = answer.parse(await res.json()), found = data.places ?? [];
    // address: the city we searched, not Google's address for the place.
    return { companies: found.map(p => ({ name: p.displayName?.text ?? '', website: p.websiteUri ?? '', address: at.place })), returned: found.length, token: next(data.nextPageToken) };
  } catch (e) {
    // Q12, the count first: a refused page token (saved by an earlier search), a slow answer or an outage ends this city, not the
    // search. The host's logs show it; a key Google refuses shows once per city searched.
    // The status alone: an unreadable answer's message could quote a business name.
    console.warn('Google Maps skipped a city:', e instanceof Error && /^HTTP \d+$/.test(e.message) ? e.message : 'no readable answer');
    return { companies: [], returned: 0, token: next() };
  }
}
