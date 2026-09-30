import { z } from 'zod';
import { SUBMIT_MULTIPLE, type Candidate, type Resolved } from './contracts';
import { cityNames, countryLabel, englishName, placeOf } from './places';

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
export const BATCH = 100; // people per email submission: one results read covers a whole batch (reads return <= 100 rows)
export const PAGE = 25; // people per find-people page (0.02 credit each); constant so a saved cursor stays valid across searches
export const submitCap = (count: number) => count * SUBMIT_MULTIPLE;
// People returned per search incl. ones already seen (paid pages, 0.02 credit each): kept at the pre-10x budget, apart from the attempts.
export const fetchCap = (count: number) => count * 20;

export const STAGES = 2;
export type Audience = Pick<Resolved, 'countries' | 'city' | 'size' | 'industries' | 'titles'>;
export function peopleQuery(input: Audience, stage = 0) {
  const typed = input.city.trim(), city = Object.hasOwn(cityNames, typed) ? cityNames[typed] : typed, codes = [...new Set(input.countries)].sort();
  if (/[؀-ۿ]/.test(city)) throw new IcypeasError('اكتب المدينة بالإنجليزية أو اختر مدينة رئيسية، أو اتركها فارغة.', 400);
  if (city && codes.length !== 1) throw new IcypeasError('اختر دولة واحدة عند تحديد المدينة.', 400);
  const [min, max] = input.size === 'all' ? [] : input.size.split('-').map(Number);
  const strict = codes.map(cc => city ? `${city}, ${cc}` : cc);
  // Arabic-localized profiles read "<province> <city> <country>" (e.g. 'مكة جدة السعودية') and match as ordered phrases, so the
  // broad stage adds "<city> <country>" for each Arabic spelling of the city: never the province alone ('مكة' also matches Jeddah)
  // nor another country ('دبي السعودية': 3 people). Free counts on 2026-09-30, Jeddah e-commerce broad stage: 113 -> 228 people.
  const broad = city
    ? [`${city}, ${englishName(codes[0])}`, ...Object.keys(cityNames).filter(k => cityNames[k].toLowerCase() === city.toLowerCase()).map(k => `${k} ${plain(countryLabel(codes[0]))}`)]
    : codes.flatMap(cc => [englishName(cc), broadArabic[cc] ?? countryLabel(cc)]);
  return {
    profileLocation: stage === 0 ? { include: strict } : { include: broad, exclude: strict },
    'currentCompany.industry': { include: input.industries },
    ...(input.titles.length ? { currentJobTitle: { include: input.titles } } : {}),
    ...(input.size !== 'all' ? { 'currentCompany.headcount': { '>=': min, '<=': max } } : {}),
  };
}

// A member's place in the results, per audience: covers both stages, so a changed broad query never reuses an old token.
export const cursorKey = (input: Audience) => JSON.stringify(Array.from({ length: STAGES }, (_, stage) => peopleQuery(input, stage)));

const text = z.string().nullish();
const leadSchema = z.object({
  firstname: text, lastname: text, profileUrl: text, lastJobTitle: text, address: text,
  lastCompanyName: text, lastCompanyWebsite: text, lastCompanyIndustry: text, lastCompanySize: z.number().nullish(),
});
export type Lead = z.infer<typeof leadSchema>;
const itemSchema = z.object({
  _id: z.string(), status: z.string(),
  userData: z.object({ externalId: z.string().nullish() }).nullish(),
  results: z.object({ emails: z.array(z.object({ email: z.string(), certainty: z.string().nullish() })).nullish() }).nullish(),
});
const pending = ['NONE', 'SCHEDULED', 'IN_PROGRESS'];
// Link pages, social networks, store builders, forms and short links host many companies: their domain is not the company's.
const sharedHost = /(^|\.)(linktr\.ee|lnk\.bio|linkin\.bio|bio\.link|beacons\.ai|taplink\.cc|instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.me|x\.com|twitter\.com|t\.co|tiktok\.com|snapchat\.com|linkedin\.com|youtube\.com|youtu\.be|wa\.me|wa\.link|whatsapp\.com|t\.me|goo\.gl|google\.com|business\.site|blogspot\.com|wordpress\.com|wixsite\.com|myshopify\.com|salla\.sa|zid\.store|youcan\.shop|expandcart\.com|wuilt\.com|zyda\.com|odoo\.com|forms\.gle|bit\.ly|tinyurl\.com|calendly\.com|about\.me|carrd\.co|github\.io|notion\.site)$/i;
// Personal mailboxes: never a company domain, and never delivered (the platform promises work emails only).
export const freeMail = /^((gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|aol|protonmail|proton|yandex|gmx)(\.[a-z]{2,3}){1,2}|(me|mac|mail|rocketmail)\.com|emirates\.net\.ae|eim\.ae|batelco\.com\.bh|omantel\.net\.om|qatar\.net\.qa|qualitynet\.net)$/i; // incl. Gulf ISP mailboxes
// Placeholder employers: without a website there is nothing to find an email at.
const genericCompany = /^(confidential\b|private (company|office|sector)$|self[- ]?employed|freelancer?$|stealth\b|n\/?a$|none$|-+$)/i;
const hostOf = (url: string) => { try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\d*\./i, '').toLowerCase(); } catch { return ''; } };
const domainOf = (lead: Lead) => {
  const site = hostOf((lead.lastCompanyWebsite || '').trim()), name = (lead.lastCompanyName || '').trim();
  return site && !sharedHost.test(site) && !freeMail.test(site) ? site : genericCompany.test(name) ? '' : name;
};
// The provider matched the search by profile location; the address is checked too, so nobody from another country is sent.
const inCountries = (lead: Lead, codes: string[]) => { const { code } = placeOf(lead.address); return !code || codes.includes(code); };
export const leadName = (lead: Lead) => [lead.firstname, lead.lastname].filter(Boolean).join(' ').trim();
const nameKey = (name: string, company: string) => (name + '|' + company).trim().toLowerCase();
export const personKey = (lead: Lead) => lead.profileUrl?.trim().toLowerCase() || nameKey(leadName(lead), lead.lastCompanyName || '');
export function safeWebsite(value: string | null | undefined) {
  try { const u = new URL(/^https?:\/\//i.test(value || '') ? value! : 'https://' + value); return value && ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

export class IcypeasClient {
  constructor(private key = process.env.ICYPEAS_API_KEY?.trim() || '', private transport: typeof fetch = fetch) {}
  private async request(path: string, body: unknown, paid = false): Promise<Record<string, unknown>> {
    if (!this.key) throw new IcypeasError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.', 503);
    let res: Response;
    try {
      res = await this.transport('https://app.icypeas.com/api/' + path, {
        method: 'POST', headers: { Authorization: this.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store',
      });
    } catch { throw new IcypeasError('انقطع الاتصال بمزوّد البيانات. حاول بعد قليل.', 502, paid); }
    if (!res.ok) {
      const message = res.status === 401 ? 'مفتاح مزوّد البيانات غير صالح.' : res.status === 429 ? 'مزوّد البيانات مشغول حاليًا. حاول بعد دقيقة.' : `تعذّر طلب مزوّد البيانات (HTTP ${res.status}).`;
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
  async verify() { await this.request('find-people/count', { query: { location: { include: ['SA'] } } }); return { ok: true }; }
  // Free: people matching the search across both stages (stage 1 excludes stage 0), shown before the member pays for anything.
  async count(input: Audience) {
    const queries = Array.from({ length: STAGES }, (_, stage) => peopleQuery(input, stage)); // validates before any call
    const totals = await Promise.all(queries.map(async query => {
      const n = z.number().int().nonnegative().safeParse((await this.request('find-people/count', { query })).total);
      if (!n.success) throw new IcypeasError('تغيّرت صيغة نتائج مزوّد البيانات. يلزم مراجعة الربط.');
      return n.data;
    }));
    return { total: totals.reduce((a, b) => a + b, 0), strict: totals[0] };
  }
  // One page of PAGE people (0.02 Icypeas credit each). token: continue where the previous page stopped.
  async people(input: Audience, token?: string | null, stage = 0): Promise<{ leads: Lead[]; returned: number; token: string | null }> {
    const raw = await this.request('find-people', { query: peopleQuery(input, stage), pagination: { size: PAGE, ...(token ? { token } : {}) } });
    const parsed = z.array(leadSchema).max(200).safeParse(raw.leads ?? []);
    if (!parsed.success) throw new IcypeasError('تغيّرت صيغة نتائج مزوّد البيانات. يلزم مراجعة الربط.');
    const next = z.object({ token: z.string().min(1) }).safeParse(raw.pagination);
    return { leads: parsed.data.filter(lead => leadName(lead) && domainOf(lead) && inCountries(lead, input.countries)), returned: parsed.data.length, token: next.success ? next.data.token : null };
  }
  async submit(leads: Lead[], name: string): Promise<string> {
    const raw = await this.request('bulk-search', {
      name, task: 'email-search', data: leads.map(l => [l.firstname || '', l.lastname || '', domainOf(l)]),
      custom: { externalIds: leads.map((_, i) => String(i)) },
    }, true);
    const file = z.object({ file: z.string().min(1) }).safeParse(raw);
    if (!file.success) throw new IcypeasError('لم يصل رقم الطلب من مزوّد البيانات. لن نعيد الإرسال تلقائيًا.', 502, true);
    return file.data.file;
  }
  // One read (a batch has at most BATCH rows). Read-only; safe to repeat. Candidates come from finished rows only and
  // include only emails Icypeas rates ultra_sure / very_sure (<1% expected bounce). Malformed rows are skipped, not fatal.
  async results(file: string, leads: Lead[]): Promise<{ done: boolean; candidates: Candidate[] }> {
    const raw = await this.request('bulk-single-searchs/read', { mode: 'bulk', file, limit: BATCH });
    const rows = Array.isArray(raw.items) ? raw.items : [];
    const items = rows.map(i => itemSchema.safeParse(i)).flatMap(r => r.success ? [r.data] : []);
    const finished = items.filter(item => !pending.includes(item.status)), malformed = rows.length - items.length;
    const candidates: Candidate[] = [];
    for (const item of finished) {
      const lead = leads[Number(item.userData?.externalId)];
      const email = item.results?.emails?.find(e => ['ultra_sure', 'very_sure'].includes(e.certainty || '') && z.email().safeParse(e.email).success && !freeMail.test(e.email.split('@')[1]));
      if (!lead || !email) continue;
      const place = placeOf(lead.address);
      candidates.push({
        name: leadName(lead), email: email.email, company: lead.lastCompanyName || '', title: lead.lastJobTitle || '',
        sector: lead.lastCompanyIndustry || '', country: place.code ? countryLabel(place.code) : '', city: place.city,
        website: safeWebsite(lead.lastCompanyWebsite), size: lead.lastCompanySize == null ? '' : String(lead.lastCompanySize),
        source: 'clowzy', email_status: 'VERIFIED',
      });
    }
    return { done: finished.length + malformed >= leads.length, candidates }; // a malformed row counts as finished without email
  }
}
