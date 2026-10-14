import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { DEFAULT_SIZE, freeMail, SUBMIT_MULTIPLE, type Candidate, type Resolved } from './contracts';
import { cityNames, countryLabel, englishName, NON_ARAB_HQ, norm, placeOf } from './places';
import { bestEmail, categoryWords, companyEmails, emailsIn, safeGet, type Get } from './site-email';
import { directoryPath, webCompanies, webEnabled } from './web-companies';
import { mapsCompanies, mapsEnabled } from './google-places';
import { anyIndustry, nicheKeywords, nicheNames, ANY_INDUSTRY_EXCLUDED } from './niches';
import type {CoverageCounts} from './coverage';

// status: HTTP status for the API response. uncertain: a paid request may have reached Icypeas.
// rejected: Icypeas refused this exact request (validation / 4xx), e.g. an expired pagination token.
export class IcypeasError extends Error {
  constructor(message: string, public status = 502, public uncertain = false, public rejected = false) { super(message); }
}
export function providerInfo() {
  return { configured: !!process.env.ICYPEAS_API_KEY?.trim(), maxCount: 50 };
}
// Two stages per search, both by where the person lives (profileLocation; `location` also matches the employer's office:
// Qatar tech 16,771 vs 4,655 living there, free counts 2026-09-30): people tagged with a country code first, then people
// whose profile names the country without the code (Arabic-localized profiles, e.g. 1.7M in Saudi Arabia). Never bare
// 'عمان' for Oman: it also matches Amman.
const broadArabic: Record<string, string> = { OM: 'سلطنة عمان' };
const plain = (s: string) => s.replace(/[\u064B-\u0652]/g, '');
const LOW_CREDITS = 200; // owner's choice 2026-10-01: about three 50-email searches left
const ACCOUNT_EMAIL = 'raheem@clowzy.io'; // the Icypeas account behind ICYPEAS_API_KEY; repeated in provider-credits.yml
export const BATCH = 100; // people per email submission: one results read covers a whole batch (reads return <= 100 rows)
export const PAGE = 25; // people per find-people page (0.02 credit each); constant so a saved cursor stays valid across searches
export const submitCap = (count: number) => count * SUBMIT_MULTIPLE;
// People (or companies) returned per search incl. ones already seen (paid pages, 0.02 credit each): a little above the attempts,
// since some returned people are skipped (no company domain, another country, already tried).
export const fetchCap = (count: number) => count * 25;
export const publishedEnabled = () => process.env.PUBLISHED_EMAIL_ENABLED === 'true';

export const STAGES = 2;
export type Audience = Pick<Resolved, 'countries' | 'city' | 'size' | 'industries' | 'titles'> & Partial<Pick<Resolved, 'mode' | 'sector'>>;
const dentalOnly = (input: Audience) => input.industries.length === 1 && input.industries[0] === 'Dentists';
const dataStages = (input: Audience) => (input.mode === 'companies' && dentalOnly(input)) || anyIndustry(input.sector) ? 4 : STAGES;
// After the provider's stages: Google Maps for a local business (google-places.ts), then the web search.
export const mapsStage = (input: Audience, stage: number) => mapsEnabled(input) && stage === dataStages(input);
export const webStage = (input: Audience, stage: number) => webEnabled(input) && stage === dataStages(input) + Number(mapsEnabled(input));
// The broadened data stages of an anyIndustry niche keep a business only when its name says what it is (nicheNames).
const onNiche = (input: Audience, stage: number, company?: string | null) => stage < 2 || stage >= dataStages(input) || !anyIndustry(input.sector)
  || nicheNames(input.sector).some(w => norm(company || '').includes(norm(w)));
export const stageCount = (input: Audience) => dataStages(input) + Number(mapsEnabled(input)) + Number(webEnabled(input));
const dentalExclusions = ['lab', 'labs', 'laboratory', 'laboratories', 'مختبر', 'معمل', 'supplies', 'supply', 'supplier', 'suppliers', 'equipment', 'study', 'academy', 'education', 'course', 'courses', 'factory', 'تجهيز', 'مستلزمات', 'مصنع', 'دورات'];
const nonClinic = /\b(labs?|laborator(?:y|ies)|suppl(?:y|ies|iers?)|equipment|study|academy|education|courses?|factory)\b|مختبر|معمل|تجهيز|مستلزمات|مصنع|دورات/i;
// A dental search keeps clinics only: suppliers, labs and courses are filed under Dentists too (Matest Dental Supplies, 2026-10-07).
export const clinicLike = (input: Audience, name?: string | null) => !dentalOnly(input) || !nonClinic.test(name || '');
const supplierDescription = /\b(?:exclusive|authorized|sole)\s+(?:agent|distributor)|\b(?:distributor|supplier|manufacturer)\s+(?:of|for)\b|توريد|موزع|موزّع|وكيل حصري|تصنيع أجهزة/i;
// The two stages' places (strict codes, then names) and the headcount range, shared by the people and companies queries.
function where(input: Audience) {
  const typed = input.city.trim(), city = Object.hasOwn(cityNames, typed) ? cityNames[typed] : typed, codes = [...new Set(input.countries)].sort();
  if (/[؀-ۿ]/.test(city)) throw new IcypeasError('اكتب المدينة بالإنجليزية أو اختر مدينة رئيسية، أو اتركها فارغة.', 400);
  if (city && codes.length !== 1) throw new IcypeasError('اختر دولة واحدة عند تحديد المدينة.', 400);
  const max = Number(input.size); // the ceiling (contracts.ts SIZES)
  const strict = codes.map(cc => city ? `${city}, ${cc}` : cc);
  // Arabic-localized profiles read "<province> <city> <country>" (e.g. 'مكة جدة السعودية') and match as ordered phrases, so the
  // broad stage adds "<city> <country>" for each Arabic spelling of the city: never the province alone ('مكة' also matches Jeddah)
  // nor another country ('دبي السعودية': 3 people). Free counts on 2026-09-30, Jeddah e-commerce broad stage: 113 -> 228 people.
  const broad = city
    ? [`${city}, ${englishName(codes[0])}`, ...Object.keys(cityNames).filter(k => cityNames[k].toLowerCase() === city.toLowerCase()).map(k => `${k} ${plain(countryLabel(codes[0]))}`)]
    : codes.flatMap(cc => [englishName(cc), broadArabic[cc] ?? countryLabel(cc)]);
  return { strict, broad, max };
}
// The category and keyword filters of a stage: the niche's keywords in its categories, or for an anyIndustry niche the keywords
// in every category but ANY_INDUSTRY_EXCLUDED (stages 0-1), then its categories without the keywords (stages 2-3, disjoint for free counts).
function activity(input: Audience, stage: number): { industry: { include?: string[]; exclude?: string[] }; keyword?: { include?: string[]; exclude?: string[] } } {
  const words = [...nicheKeywords(input.sector)];
  if (anyIndustry(input.sector)) return stage < 2 ? { industry: { exclude: ANY_INDUSTRY_EXCLUDED }, keyword: { include: words } } : { industry: { include: input.industries }, keyword: { exclude: words } };
  return { industry: { include: input.industries }, ...(words.length ? { keyword: { include: words } } : {}) };
}
// A company known to be above the size ceiling is dropped; an unknown size passes (owner 2026-10-11). The provider's filter already did
// this outside the word niches (peopleQuery).
export const withinSize = (input: Audience, lead: Lead) => lead.lastCompanySize == null || lead.lastCompanySize <= Number(input.size);
export function peopleQuery(input: Audience, stage = 0) {
  const { strict, broad, max } = where(input), { industry, keyword } = activity(input, stage);
  return {
    profileLocation: stage % 2 === 0 ? { include: strict } : { include: broad, exclude: strict },
    'currentCompany.industry': industry,
    ...(keyword ? { 'currentCompany.keyword': keyword } : {}),
    ...(input.titles.length ? { currentJobTitle: { include: input.titles } } : {}),
    // ponytail: the provider's size filter also drops companies of unknown size. It is used where those are rare (Saudi free counts,
    // 2026-10-11/12: tech 0.6%, restaurants 1%, the beauty field 0.4%, spas 2%, cafés 0%); the anyIndustry niches (salons, barbers, nails,
    // makeup: keywords in every category, 92% unknown among salon people) filter after the page instead (withinSize). Count unknown sizes
    // per field before the search if another market turns out to have many.
    ...(!anyIndustry(input.sector) ? { 'currentCompany.headcount': { '>=': 1, '<=': max } } : {}),
    // Owner 2026-10-11: a company known to be headquartered outside the Arab League is left out, unless the member chose its country; an
    // unknown headquarters passes. Free counts: Saudi tech 23,981 -> 15,580, UAE tech 27,784 -> 10,645, Saudi salons 761 -> 622.
    'currentCompany.location': { exclude: NON_ARAB_HQ.filter(c => !input.countries.includes(c)) },
  };
}

// Companies by headquarters (`location`), the same two stages; job titles do not apply to a company.
export function companiesQuery(input: Audience, stage = 0) {
  const { strict, broad, max } = where(input), { industry, keyword } = activity(input, stage);
  return {
    location: stage % 2 === 0 ? { include: strict } : { include: broad, exclude: strict },
    // Many dental clinics are filed under general health care. Search those only with dental evidence and a clinic-like
    // name, never by widening the user's location. Excluding Dentists keeps the extra stages disjoint for free counts.
    ...(dentalOnly(input) && stage >= 2 ? {
      industry: { include: ['Hospitals and Health Care', 'Medical Practices', 'Hospital & Health Care', 'Health, Wellness & Fitness', 'Wellness and Fitness Services', 'Outpatient Care Centers'], exclude: ['Dentists'] },
      keyword: { include: ['dental', 'dentist', 'dentistry', 'أسنان', 'اسنان'] },
      name: { include: ['dental', 'dentist', 'dentistry', 'أسنان', 'اسنان', 'clinic', 'عياد', 'مستوصف', 'مجمع', 'مركز', 'center', 'centre'], exclude: dentalExclusions },
    } : { industry, ...(keyword ? { keyword } : {}), ...(dentalOnly(input) ? { name: { exclude: dentalExclusions } } : {}) }),
    // Companies often record a size of 0 (Saudi tech 23%, dental 22%) and rarely exceed 1000 (tech 0.25%), free counts 2026-10-12: at the
    // default ceiling no filter (withinSize drops those few after the page); a smaller one keeps the zeros and loses only unknown sizes (2-6%).
    ...(!anyIndustry(input.sector) && input.size !== DEFAULT_SIZE ? { headcount: { '<=': max } } : {}),
  };
}
export const queryOf = (input: Audience, stage = 0) => webStage(input, stage)
  ? { web: 3, countries: input.countries, city: input.city, industries: input.industries, ...(input.sector ? { sector:input.sector } : {}) }
  : mapsStage(input, stage) ? { maps: 1, countries: input.countries, city: input.city, sector: input.sector }
  : input.mode === 'companies' ? companiesQuery(input, stage) : peopleQuery(input, stage);

// A member's place in the results, per audience: covers both stages, so a changed broad query never reuses an old token.
export const cursorKey = (input: Audience) => {
  const queries = Array.from({ length: stageCount(input) }, (_, stage) => queryOf(input, stage));
  const key = input.mode === 'companies' ? { discovery: 'domain-search', ...(publishedEnabled() ? { published: 2 } : {}), queries } : queries;
  // A fingerprint: the full queries (ten countries, the headquarters list, many titles) outgrow the primary key's size limit. The anyIndustry
  // niches add their ceiling, which filters after the page and so is not in their queries.
  return createHash('sha256').update(JSON.stringify(anyIndustry(input.sector) ? { size: input.size, key } : key)).digest('hex');
};

const text = z.string().nullish();
const leadSchema = z.object({
  firstname: text, lastname: text, profileUrl: text, lastJobTitle: text, address: text,
  lastCompanyName: text, lastCompanyWebsite: text, lastCompanyIndustry: text, lastCompanySize: z.number().nullish(),
  email: text, // companies search only: the email read from the company's site, sent for verification
});
const companySchema = z.object({ name: text, description: text, url: text, address: text, website: text, industry: text, numberOfEmployees: z.number().nullish() });
// hqChecked: found by a query that left out foreign headquarters (peopleQuery) or that asked for the chosen countries' (companiesQuery).
export type Lead = z.infer<typeof leadSchema> & { kind?: 'company'; suppressed?: boolean; published?: boolean; publicationPending?: boolean; alternateEmails?: string[]; hqChecked?: boolean };
const itemSchema = z.object({
  _id: z.string(), status: z.string(),
  userData: z.object({ externalId: z.string().nullish() }).nullish(),
  results: z.object({ emails: z.array(z.object({ email: z.string(), certainty: z.string().nullish() })).nullish() }).nullish(),
});
const pending = ['NONE', 'SCHEDULED', 'IN_PROGRESS'];
// Link pages, social networks, store builders, forms, short links and booking platforms (salons book through Fresha, Booksy...)
// host many companies: their domain is not the company's (a salon delivered hello@fresha.com on 2026-10-05).
const sharedHost = /(^|\.)(linktr\.ee|lnk\.bio|linkin\.bio|bio\.link|beacons\.ai|taplink\.cc|instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.me|x\.com|twitter\.com|t\.co|tiktok\.com|snapchat\.com|linkedin\.com|youtube\.com|youtu\.be|wa\.me|wa\.link|whatsapp\.com|t\.me|goo\.gl|g\.co|g\.page|google\.com|business\.site|blogspot\.com|wordpress\.com|wixsite\.com|myshopify\.com|salla\.sa|zid\.store|youcan\.shop|expandcart\.com|wuilt\.com|zyda\.com|odoo\.com|forms\.gle|bit\.ly|tinyurl\.com|calendly\.com|about\.me|carrd\.co|github\.io|notion\.site|fresha\.com|booksy\.com|vagaro\.com|setmore\.com|square\.site|squareup\.com|treatwell\.[a-z.]+|planity\.com|mindbodyonline\.com|simplybook\.me|glossgenius\.com|styleseat\.com|schedulicity\.com|gettimely\.com|zenoti\.com|phorest\.com|acuityscheduling\.com|godaddysites\.com|site123\.me|webflow\.io)$/i;
const sure = ['ultra_sure', 'very_sure'];
// Placeholder employers: without a website there is nothing to find an email at.
const genericCompany = /^(confidential\b|private (company|office|sector)$|self[- ]?employed|freelancer?$|stealth\b|n\/?a$|none$|-+$)/i;
export const siteOf = (lead: Lead) => {
  try {
    const website = (lead.lastCompanyWebsite || '').trim(), url = new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website);
    const site = url.hostname.replace(/^www\d*\./i, '').toLowerCase();
    return site.includes('.') && !/^[\d.]+$/.test(site) && !sharedHost.test(site) && !freeMail.test(site) && !directoryPath(url.pathname) ? site : '';
  } catch { return ''; }
};
const domainOf = (lead: Lead) => { const name = (lead.lastCompanyName || '').trim(); return siteOf(lead) || (genericCompany.test(name) ? '' : name); };
// The organisation behind a lead or a delivered contact: its own website (never a shared host), its email's domain (webmail
// names nobody's company), and its name without legal words or a second spelling after « - » or « | » (Kudu's staff share no
// website, 2026-10-05). A search delivers one email per organisation: two that share a key are the same company.
// ponytail: two different businesses with one name count as one within a search; add the city to the name key if that bites.
const legalWords = /\b(co|company|llc|l\.l\.c|ltd|limited|inc|corp|est|wll|w\.l\.l|sal|s\.a\.l|sarl)\b\.?|^(شركه|مؤسسه) /g;
const orgName = (company: string) => {
  const name = genericCompany.test(company.trim()) ? '' : norm(company.split(/\s[-–—|]\s|[|(]/)[0]).replace(legalWords, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return name.split(' ').every(w => w.length < 2 || categoryWords.has(w)) ? '' : name; // «Beauty Salon» is many salons' company name
};
export const companyKeys = (c: { website?: string | null; email?: string | null; company?: string | null }) => {
  const domain = (c.email || '').split('@')[1]?.trim().toLowerCase() || '', name = orgName(c.company || '');
  return [siteOf({ lastCompanyWebsite: c.website }), domain && !freeMail.test(domain) ? domain : '', name && 'name:' + name].filter(Boolean);
};
export const leadKeys = (l: Lead) => companyKeys({ website: l.lastCompanyWebsite, email: l.email, company: l.lastCompanyName });
// Who answers for a company, most likely first, when several of its people match: owner, CEO or general manager, marketing
// heads, other heads, managers, supervisors and specialists, then everyone else. A product owner, an HR business partner or a
// vice president is none of the first two (review 2026-10-05); an assistant or deputy ranks one step down, a trainee last.
const TIERS = [/\b(owner|co-?founder|founder|proprietor|partner)\b|مالك|مؤسس|صاحب|شريك/i,
  /\b(ceo|chief executive|general manager|managing director|gm|president)\b|المدير العام|مدير عام|الرئيس التنفيذي|المدير التنفيذي/i,
  /\bcmo\b|\b(marketing|growth|brand)\b.*\b(head|director|manager|chief|lead)\b|\b(head|director|chief|vp) of (marketing|growth|brand)\b|(مدير|رئيس) (قسم )?(ال)?تسويق/i,
  /\b(chief|c[otfi]o|vp|director|head)\b|رئيس|مدير إدارة/i,
  /\bmanager\b|مدير/i,
  /\b(supervisor|lead|specialist|coordinator|executive|officer)\b|مشرف|منسق|أخصائي|اخصائي|مسؤول/i];
const notOwner = /\b(product|process) owner\b|\b(business|channel|hr|account) partner\b|\bpartner (manager|success|relations)\b/gi;
export const titleTier = (title: string) => {
  const t = title.replace(notOwner, ' ').replace(/\bvice[- ]president\b/gi, 'vp'), i = TIERS.findIndex(re => re.test(t)), tier = i < 0 ? TIERS.length : i;
  return /\b(intern|trainee|junior)\b|متدرب/i.test(t) ? TIERS.length : /\b(assistant|deputy)\b|مساعد/i.test(t) ? Math.min(tier + 1, TIERS.length) : tier;
};
// The provider matched the country; the address is checked too, so nobody from another country is sent. US towns carry the
// names of Arab countries and match them as text (Lebanon in Ohio and New Hampshire: 2 of 5 «Lebanese» salons on 2026-10-05),
// so an address naming a US state or the US is dropped. Any other address we cannot read passes: the provider matched it on
// location data the address may not show, and Gulf profiles come in forms placeOf cannot parse ('Kuwait City', 'السعودية - جدة').
const usStates = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
const usCodes = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const usPlace = new RegExp(`,\\s*((${usStates})(\\s+Area)?|(${usCodes})(\\s+\\d{5}(-\\d{4})?)?)\\s*(,|$)|\\b(US|USA)\\s*$`);
const inCountries = (lead: Lead, codes: string[]) => {
  const { code } = placeOf(lead.address), us = usPlace.exec(lead.address || '');
  return code ? codes.includes(code) : !us || codes.includes(us[4] ?? ''); // 'Tunis, TN' in a Tunisia search is Tunisia
};
// A company found by the companies search stands under its own name.
export const leadName = (lead: Lead) => [lead.firstname, lead.lastname].filter(Boolean).join(' ').trim() || (lead.kind === 'company' || lead.email ? lead.lastCompanyName?.trim() || '' : '');
const nameKey = (name: string, company: string) => (name + '|' + company).trim().toLowerCase();
export const personKey = (lead: Lead) => createHash('sha256').update(lead.kind === 'company' ? (lead.published ? 'published-email-v2:' : 'domain-search:') + siteOf(lead) + (lead.published && !lead.publicationPending && lead.email ? ':'+lead.email.toLowerCase() : '') : lead.profileUrl?.trim().toLowerCase() || nameKey(leadName(lead), lead.lastCompanyName || '')).digest('hex');
// A «no email» answer is shared for this person or company at this domain (provider_misses): another domain is another lookup.
export const missKey = (lead: Lead) => createHash('sha256').update(personKey(lead) + '|' + domainOf(lead)).digest('hex');
export const submissionTask = (l: Lead) => l.kind === 'company' && !l.published ? 'domain-search' : l.email || l.published ? 'email-verification' : 'email-search';
export function safeWebsite(value: string | null | undefined) {
  try { const u = new URL(/^https?:\/\//i.test(value || '') ? value! : 'https://' + value); return value && ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

export class IcypeasClient {
  constructor(private key = process.env.ICYPEAS_API_KEY?.trim() || '', private transport: typeof fetch = fetch, private siteReader: Get = safeGet) {}
  private async request(path: string, body: unknown, paid = false): Promise<Record<string, unknown>> {
    if (!this.key) throw new IcypeasError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.', 503);
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.transport('https://app.icypeas.com/api/' + path, {
          method: 'POST', headers: { Authorization: this.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store',
        });
      } catch (e) {
        // The provider's host is sometimes unreachable (2 of 3 connects timed out on 2026-09-30). A connection that never
        // opened sent nothing: retried once, and never "uncertain". Any other network error on a paid call may have arrived.
        const unsent = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes((e as { cause?: { code?: string } })?.cause?.code ?? '');
        if (unsent && attempt === 1) continue;
        throw new IcypeasError('انقطع الاتصال بمزوّد البيانات. حاول بعد قليل.', 502, paid && !unsent);
      }
      // A 429 is a refusal (nothing created): once more after the provider's 1-per-second spacing, e.g. two servers at once.
      if (res.status === 429 && attempt === 1) { await res.body?.cancel(); await sleep(1100); continue; }
      break;
    }
    if (!res.ok) {
      if (![401, 429].includes(res.status)) console.warn('Icypeas HTTP', res.status, path);
      const message = res.status === 401 ? 'مفتاح مزوّد البيانات غير صالح.' : res.status === 429 ? 'مزوّد البيانات مشغول حاليًا. حاول بعد دقيقة.' : 'تعذّر طلب مزوّد البيانات. حاول بعد قليل.';
      throw new IcypeasError(message, 502, paid && (res.status >= 500 || res.status === 408), res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status));
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!data) throw new IcypeasError('استجابة غير مقروءة من مزوّد البيانات.', 502, paid);
    if (data.success === false) {
      // Icypeas refuses a bulk submit unless the account balance covers 1 credit per submitted row.
      if (JSON.stringify(data.validationErrors ?? '').includes('InsufficientCredits')) {
        console.warn('Icypeas: insufficient credits on the provider account; top it up.');
        throw new IcypeasError('رصيد مزوّد البيانات لا يكفي لإكمال البحث الآن. تواصل مع مالك المنصة.', 503); // not "rejected": keep the member's cursor
      }
      throw new IcypeasError('رفض مزوّد البيانات الطلب. راجع المعايير أو رصيد المزوّد.', 502, false, true);
    }
    return data;
  }
  // The connection, and the provider account's credits (free route; owner's dashboard). The check every 6 hours
  // (.github/workflows/provider-credits.yml) emails the owner under the same LOW_CREDITS.
  async verify() {
    await this.request('find-people/count', { query: { location: { include: ['SA'] } } });
    const account = z.object({ credits: z.number() }).safeParse(await this.request('a/actions/subscription-information', { email: ACCOUNT_EMAIL }));
    if (!account.success) throw new IcypeasError('تعذّر قراءة رصيد مزوّد البيانات. راجع بريد حساب المزوّد على الخادم.');
    return { ok: true, credits: Math.floor(account.data.credits), low: account.data.credits < LOW_CREDITS };
  }
  // Free: people matching the search across both stages (stage 1 excludes stage 0), shown before the member pays for anything.
  // reachable: those working at a company with a page and a headcount (within the ceiling), the only ones whose email the provider finds
  // (salons in Lebanon: 483 people, 192 such, 2026-10-05); outside the anyIndustry niches the query already counts only those.
  // ponytail: in the anyIndustry niches total also counts companies known to be above the ceiling (none above 1,000 among Saudi salons,
  // 6% above 10); subtract a count of those if the warning needs to be exact.
  async count(input: Audience) {
    const queries = Array.from({ length: dataStages(input) }, (_, stage) => queryOf(input, stage)); // free database counts only; web has no known stock
    const counts = (list: object[]) => Promise.all(list.map(async query => {
      const n = z.number().int().nonnegative().safeParse((await this.request(input.mode === 'companies' ? 'find-companies/count' : 'find-people/count', { query })).total);
      if (!n.success) throw new IcypeasError('تغيّرت صيغة نتائج مزوّد البيانات. يلزم مراجعة الربط.');
      return n.data;
    }));
    const sum = (n: number[]) => n.reduce((a, b) => a + b, 0), totals = await counts(queries), total = sum(totals);
    const reachable = input.mode === 'companies' ? undefined : !anyIndustry(input.sector) ? total : sum(await counts(queries.map(q => ({ ...q, 'currentCompany.headcount': { '>=': 1, '<=': Number(input.size) } }))));
    return { total, strict: totals[0], ...(reachable === undefined ? {} : { reachable }), ...(webEnabled(input) || mapsEnabled(input) ? { supplementary: true } : {}) };
  }
  // One page of PAGE people (0.02 Icypeas credit each). token: continue where the previous page stopped.
  async people(input: Audience, token?: string | null, stage = 0): Promise<{ leads: Lead[]; returned: number; token: string | null }> {
    const raw = await this.request('find-people', { query: peopleQuery(input, stage), pagination: { size: PAGE, ...(token ? { token } : {}) } });
    const parsed = z.array(leadSchema).max(200).safeParse(raw.leads ?? []);
    if (!parsed.success) throw new IcypeasError('تغيّرت صيغة نتائج مزوّد البيانات. يلزم مراجعة الربط.');
    const next = z.object({ token: z.string().min(1) }).safeParse(raw.pagination);
    const leads: Lead[] = parsed.data.filter(lead => leadName(lead) && domainOf(lead) && inCountries(lead, input.countries) && onNiche(input, stage, lead.lastCompanyName) && clinicLike(input, lead.lastCompanyName) && withinSize(input, lead))
      .map(lead => ({ ...lead, hqChecked: true }));
    // ponytail: ranks within one page of 25, not a company's whole staff; query decision makers first if owners stay out of reach.
    leads.sort((a, b) => titleTier(a.lastJobTitle || '') - titleTier(b.lastJobTitle || ''));
    return { leads, returned: parsed.data.length, token: next.success ? next.data.token : null };
  }
  // Use the provider's native domain discovery. A missing/slow website must not discard a company whose mail server
  // works. These domains enter the same durable, bounded bulk queue as people; no client-side email guessing.
  async companies(input: Audience, token?: string | null, stage = 0): Promise<{ leads: Lead[]; returned: number; token: string | null }> {
    if (webStage(input, stage)) {
      try {
        const page = await webCompanies(input, token, this.transport);
        return { ...page, leads: page.companies.map(c => ({ kind: 'company' as const, lastCompanyName: c.name, lastCompanyWebsite: c.website, address: c.address, lastCompanyIndustry: c.industry, email: '' }))
          .filter(l => siteOf(l) && inCountries(l, input.countries) && clinicLike(input, l.lastCompanyName)) };
      } catch { throw new IcypeasError('تعذّر إكمال البحث المكمّل في المواقع. حُفظت النتائج التي وصلتك؛ حاول لاحقًا.', 503); }
    }
    if (mapsStage(input, stage)) {
      const page = await mapsCompanies(input, token, this.transport);
      // A place's name only drops labs and suppliers here: the company is named after its own website (google-places.ts).
      const leads = page.companies.filter(c => clinicLike(input, c.name)).map(c => ({ kind: 'company' as const, lastCompanyWebsite: c.website, address: c.address, lastCompanyIndustry: input.industries[0], email: '' }))
        .map(l => ({ ...l, lastCompanyName: siteOf(l) })).filter(l => l.lastCompanyName);
      return { leads, returned: page.returned, token: page.token };
    }
    const raw = await this.request('find-companies', { query: companiesQuery(input, stage), pagination: { size: PAGE, ...(token ? { token } : {}) } });
    const parsed = z.array(companySchema).max(200).safeParse(raw.leads ?? []);
    if (!parsed.success) throw new IcypeasError('تغيّرت صيغة نتائج مزوّد البيانات. يلزم مراجعة الربط.');
    const next = z.object({ token: z.string().min(1) }).safeParse(raw.pagination);
    const leads: Lead[] = parsed.data.filter(c => !dentalOnly(input) || !supplierDescription.test(c.description || '')).map(c => ({ kind: 'company' as const, firstname: '', lastname: '', profileUrl: c.url, lastJobTitle: '', address: c.address, lastCompanyName: c.name,
      lastCompanyWebsite: c.website, lastCompanyIndustry: c.industry, lastCompanySize: c.numberOfEmployees, email: '', hqChecked: true }))
      .filter(l => l.lastCompanyName?.trim() && siteOf(l) && inCountries(l, input.countries) && onNiche(input, stage, l.lastCompanyName) && clinicLike(input, l.lastCompanyName) && withinSize(input, l));
    return { leads, returned: parsed.data.length, token: next.success ? next.data.token : null };
  }
  // Up to ten website reads at a time (in parallel, 8 s in all) fit one server request; the caller persists the remaining queue
  // before another call. Three a round made the salons fallback 6 rounds of ~42 s (2026-10-05); ten since 2026-10-08 (live-search FILL).
  // known: sites any search read within 30 days (store.siteReads), not read again. read: the sites read in full now, to share; a read
  // cut by its time limit is not shared, so a slow site is read again next time.
  async published(leads: Lead[], known: Map<string, string[]>): Promise<{ leads: Lead[]; read: Map<string, string[]> }> {
    const read = new Map<string, string[]>();
    const out = await Promise.all(leads.map(async lead => {
      if (!lead.publicationPending) return lead;
      let emails = known.get(siteOf(lead));
      if (!emails) {
        // A site none of whose pages answered (down, refused, 5xx: the reader returns '') is not «no address»: not shared.
        const signal = AbortSignal.timeout(8000);
        let answered = false;
        const get = (url: string, s?: AbortSignal, sameHost?: boolean) => this.siteReader(url, s, sameHost).then(html => { answered ||= !!html; return html; });
        emails = await companyEmails(lead.lastCompanyWebsite || '', get, signal, true, 3, lead.lastCompanyName || '').catch(() => []);
        if (answered && !signal.aborted) read.set(siteOf(lead), emails);
      }
      return { ...lead, email:emails[0]||'', alternateEmails:emails.slice(1), publicationPending: false };
    }));
    return { leads: out.filter(lead => !!lead.email), read };
  }
  // Discovery costs 1 provider credit per found person/domain. Published contact addresses use verification, never guessing.
  async submit(leads: Lead[], name: string): Promise<string> {
    const task = submissionTask;
    if (!leads.length || leads.some(l => task(l) !== task(leads[0]))) throw new IcypeasError('دفعة بحث غير متجانسة. أعد المحاولة.',400);
    if (leads.some(l => l.published && (l.publicationPending || !z.email().safeParse(l.email).success))) throw new IcypeasError('لم يكتمل فحص البريد المنشور.',400);
    const raw = await this.request('bulk-search', {
      name, task: task(leads[0]), data: leads.map(l => task(l) === 'domain-search' ? [siteOf(l)] : l.email ? [l.email] : [l.firstname || '', l.lastname || '', domainOf(l)]),
      custom: { externalIds: leads.map((_, i) => String(i)) },
    }, true);
    const file = z.object({ file: z.string().min(1) }).safeParse(raw);
    if (!file.success) throw new IcypeasError('لم يصل رقم الطلب من مزوّد البيانات. لن نعيد الإرسال تلقائيًا.', 502, true);
    return file.data.file;
  }
  // One read (a batch has at most BATCH rows). Read-only; safe to repeat. Candidates come from finished rows only and
  // include emails Icypeas rates ultra_sure / very_sure (<1% expected bounce) or probable (<5%; charged anyway, so delivered
  // and labelled rather than wasted), sure ones first. Malformed rows are skipped, not fatal.
  async results(file: string, leads: Lead[]): Promise<{ done: boolean; candidates: Candidate[]; unpaid: Lead[]; missing: Lead[]; misses: Lead[]; coverage?:CoverageCounts }> {
    const raw = await this.request('bulk-single-searchs/read', { mode: 'bulk', file, limit: BATCH });
    const rows = Array.isArray(raw.items) ? raw.items : [];
    const items = rows.map(i => itemSchema.safeParse(i)).flatMap(r => r.success ? [r.data] : []);
    const finished = items.filter(item => !pending.includes(item.status)), malformed = rows.length - items.length;
    const candidates: Candidate[] = [], delivered = new Set<Lead>();
    const leadOf = (item: z.infer<typeof itemSchema>) => /^\d+$/.test(item.userData?.externalId ?? '') ? leads[Number(item.userData!.externalId)] : undefined;
    for (const item of finished) {
      const lead = leadOf(item);
      if (!lead || delivered.has(lead) || lead.suppressed || /NOT_FOUND/.test(item.status)) continue;
      const publicContact = lead.kind === 'company' && lead.published && !lead.publicationPending && !!lead.email;
      const usable = (item.results?.emails ?? []).filter(e => z.email().safeParse(e.email).success && (publicContact || !freeMail.test(e.email.split('@')[1]))
        && (lead.kind !== 'company' || ((publicContact ? e.email.toLowerCase() === lead.email!.toLowerCase() : emailsIn(e.email, siteOf(lead)).length > 0) && bestEmail([e.email]))));
      const select = (emails: typeof usable) => lead.kind === 'company' ? emails.find(e => e.email.toLowerCase() === bestEmail(emails.map(e=>e.email.toLowerCase()))) : emails[0];
      const email = select(usable.filter(e => sure.includes(e.certainty || ''))) ?? select(usable.filter(e => e.certainty === 'probable'));
      if (!email || (lead.email && email.email.toLowerCase() !== lead.email.toLowerCase())) continue; // a verification answers for the email it was sent
      delivered.add(lead);
      const place = placeOf(lead.address);
      candidates.push({
        kind: lead.kind === 'company' || lead.email ? 'company' : 'person', name: leadName(lead), email: email.email, company: lead.lastCompanyName || '', title: lead.lastJobTitle || '',
        sector: lead.lastCompanyIndustry || '', country: place.code ? countryLabel(place.code) : '', city: place.city,
        website: safeWebsite(lead.lastCompanyWebsite), size: lead.lastCompanySize == null ? '' : String(lead.lastCompanySize),
        source: 'clowzy', email_status: sure.includes(email.certainty || '') ? 'VERIFIED' : 'PROBABLE', hqChecked: !!lead.hqChecked,
      });
    }
    // Rows the provider could not pay for (its balance ran out after the batch was accepted) were never searched.
    const unpaid = finished.filter(i => i.status === 'INSUFFICIENT_FUNDS').flatMap(i => { const lead = leadOf(i); return lead && !lead.suppressed ? [lead] : []; });
    const missing = publishedEnabled() ? [...new Set(finished.filter(i => i.status !== 'INSUFFICIENT_FUNDS').map(leadOf))]
      .filter((lead): lead is Lead => !!lead && lead.kind === 'company' && !lead.suppressed && !delivered.has(lead))
      .flatMap<Lead>(lead=>!lead.published?[{...lead,email:'',published:true,publicationPending:true}]
        :lead.alternateEmails?.length?[{...lead,email:lead.alternateEmails[0],alternateEmails:lead.alternateEmails.slice(1),publicationPending:false}]:[]) : [];
    candidates.sort((a, b) => Number(a.email_status === 'PROBABLE') - Number(b.email_status === 'PROBABLE'));
    // Searched, charged, and still no usable email: shared for 30 days so no other member pays for the same lookup.
    // ponytail: a published address is left out (its site may list others, tried in turn: missing, above), so each member still pays
    // to verify a site's addresses; share them too, skipping to the next alternate on a miss, if that spend shows.
    const misses = [...new Set(finished.filter(i => /^DEBITED/.test(i.status)).map(leadOf))].filter((lead): lead is Lead => !!lead && !lead.suppressed && !lead.published && !delivered.has(lead));
    const coverage:CoverageCounts={attempted:leads.length,accepted:delivered.size,notFound:0,ownershipRejected:0,verificationRejected:0,unpaid:unpaid.length,unreturned:0,native:0,published:0};
    for(const lead of leads){
      if(delivered.has(lead)){coverage[lead.published?'published':'native']++;continue;}
      if(unpaid.includes(lead)||lead.suppressed)continue;
      const rows=finished.filter(i=>leadOf(i)===lead);
      if(!rows.length){coverage.unreturned++;continue;}
      if(rows.every(i=>/NOT_FOUND/.test(i.status)||!i.results?.emails?.length)){coverage.notFound++;continue;}
      const addresses=rows.flatMap(i=>i.results?.emails||[]);
      if(!addresses.some(e=>z.email().safeParse(e.email).success&&(!freeMail.test(e.email.split('@')[1])||lead.published)&&(!lead.email||e.email.toLowerCase()===lead.email.toLowerCase())&&(lead.kind!=='company'||(bestEmail([e.email])&&(lead.published||emailsIn(e.email,siteOf(lead)).length>0)))))coverage.ownershipRejected++;
      else coverage.verificationRejected++;
    }
    return { done: finished.length + malformed >= leads.length, candidates, unpaid, missing, misses, coverage }; // a malformed row counts as finished without email
  }
}
