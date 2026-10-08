import type { SearchInput } from './schemas';
import { countryFromText } from './places';
import { niches, type NicheName } from './niches';

// What the member picks from: a main field, then one of its specialties or the whole field. The server maps each label to
// exact provider names (src/lib/audience.ts); anything typed under «أخرى» is mapped by the AI there.
export const legacyFields = {
  'الصحة والطب': ['الصحة والعيادات', 'عيادات الأسنان', 'المستشفيات', 'المختبرات الطبية', 'العيون والبصريات', 'الصحة النفسية', 'الصيدليات والأدوية',
    'الأجهزة الطبية', 'الطب البيطري', 'اللياقة والصحة العامة'],
  'التقنية والاتصالات': ['التقنية والبرمجيات', 'الاتصالات'],
  'العقارات والبناء': ['العقارات', 'البناء والمقاولات', 'الهندسة والعمارة', 'الأثاث والديكور'],
  'التجارة والمتاجر': ['التجارة الإلكترونية', 'التجزئة والمتاجر', 'الجملة والاستيراد والتصدير', 'الأزياء والموضة', 'التجميل والعناية الشخصية', 'السيارات'],
  'المطاعم والضيافة': ['المطاعم والمقاهي', 'الأغذية والمشروبات', 'السياحة والضيافة', 'الفعاليات والمعارض'],
  'التسويق والإعلام': ['التسويق والإعلان', 'الإعلام والإنتاج', 'التصميم والجرافيك'],
  'المال والخدمات المهنية': ['المحاسبة والخدمات المالية', 'البنوك والاستثمار', 'التأمين', 'الخدمات المهنية', 'المحاماة والخدمات القانونية', 'الموارد البشرية والتوظيف'],
  'التعليم والتدريب': ['المدارس', 'الجامعات والكليات', 'مراكز التدريب', 'معاهد اللغات', 'التعليم الإلكتروني'],
  'الصناعة والطاقة والنقل': ['الصناعة', 'النفط والغاز والطاقة', 'الزراعة', 'النقل والخدمات اللوجستية', 'الأمن والحماية'],
  'الحكومة والمنظمات': ['الجهات الحكومية', 'الجمعيات والمنظمات غير الربحية'],
} as const;
export type FieldName = keyof typeof legacyFields;
export type LegacySpecialty = (typeof legacyFields)[FieldName][number];
export type Specialty = LegacySpecialty | NicheName;
// Preserve stored fields/specialties while adding the precise business activities used by the new picker.
export const fields = Object.fromEntries(Object.entries(legacyFields).map(([field, specialties]) =>
  [field,[...new Set([...specialties,...niches.filter(n=>n.field===field).map(n=>n.label)])]])) as unknown as Record<FieldName,readonly Specialty[]>;
export const sectors = Object.values(fields).flat() as Specialty[];
// The field a stored sector belongs to (itself when the whole field was chosen), or '' for the member's own words.
export const fieldOf = (sector: string) => (Object.keys(fields) as FieldName[]).find(f => f === sector || (fields[f] as readonly string[]).includes(sector)) ?? '';
export const titles = ['المالك أو المؤسس', 'الرئيس التنفيذي أو المدير العام', 'مدير التسويق', 'مسؤول التسويق الرقمي', 'مدير المبيعات', 'مدير تطوير الأعمال',
  'مدير العمليات', 'المدير المالي', 'مدير الموارد البشرية', 'مدير تقنية المعلومات', 'مدير المشتريات', 'مدير المشاريع', 'مدير المنتج',
  'مدير خدمة العملاء', 'مدير الفرع أو المتجر', 'مدير العيادة أو المدير الطبي'] as const;
export const OTHER = 'أخرى';
export const gulf = ['SA', 'AE', 'QA', 'KW', 'BH', 'OM'] as const;
export const listedCountries = [...gulf, 'DZ', 'EG'] as const;
export type { Resolved, SearchInput } from './schemas'; // types only: the browser never loads the validation library
// Searches saved (and pages opened) before multi-country send `country` (an Arabic name) instead of `countries`.
export function withCountries(raw: unknown) {
  if (!raw || typeof raw !== 'object' || 'countries' in raw || !('country' in raw)) return raw;
  return { ...raw, countries: [countryFromText(String(raw.country))].filter(Boolean) };
}

// Submit at most 20x the requested emails for email discovery (owner, 2026-10-01; was 10): a person without an email costs
// nothing, and Dubai dentists found 1 in 40. A people search still short then falls back to the companies' own emails.
export const SUBMIT_MULTIPLE = 20;
export type Role = 'admin' | 'member';
export type User = { id: string; name: string; email: string; role: Role; active: number; balance: number; created_at: string; terms_accepted_at: string | null };
// When the terms last changed in a way members must accept again (ISO UTC, same format as terms_accepted_at). Raise it with
// the text in terms.tsx: every member who accepted before it sees the terms again before anything else (route.ts).
// Never later than the deploy: acceptances would count as old until then (a test checks it is in the past).
export const TERMS_VERSION = '2026-10-02T00:00:00.000Z';
export const termsCurrent = (user: Pick<User, 'terms_accepted_at'>) => !!user.terms_accepted_at && user.terms_accepted_at >= TERMS_VERSION;
// How sure the provider is that the email exists: VERIFIED <1% expected bounce, PROBABLE <5% (Icypeas certainties), which
// the member reads as «likely» rather than as a bare percentage.
export const emailTrust = (status: string, en = false) => status === 'PROBABLE' ? (en ? 'Likely · provider confidence 95%' : 'محتمل · ثقة المزوّد ٩٥٪') : status === 'VERIFIED' ? (en ? 'Provider confidence 99%' : 'ثقة المزوّد ٩٩٪') : status;
// The provider finds the email of about 1 in 20 people at a company with a page (restaurants in Saudi Arabia: 10 in 185, 2026-10-05):
// fewer of them than 20 per email asked for, and the search will likely end short. Said before it starts.
// How often a running search is moved on: by the results page, and by the background worker (owner 2026-10-08: was 6 s).
export const POLL_MS = 3000;
export const MIN_FIND_RATE = 0.05; // also the batch-size floor in live-search.ts; the warning's «one in twenty» follows it
export const fewReachable = (reachable: number | undefined, count: number) => reachable !== undefined && reachable * MIN_FIND_RATE < count;
// A niche+country whose past searches delivered far less than asked for (store.marketRate). This is measured from
// real results, so it warns harder than the estimated fewReachable: salons in Lebanon read 0; a healthy market stays
// well above. Only set once there is enough history to judge, so a new market is never branded dead.
export const DEAD_MARKET_RATE = 0.15;
export const deadMarket = (rate: number | undefined) => rate !== undefined && rate < DEAD_MARKET_RATE;
// Webmail and internet-provider domains (Gmail, Hotmail, IDM in Lebanon...): an address there belongs to a person, never to a
// company's own domain, and two salons with an IDM address are not one company (review 2026-10-05).
export const freeMail = /^((gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|aol|protonmail|proton|yandex|gmx)(\.[a-z]{2,3}){1,2}|(me|mac|mail|rocketmail)\.com|emirates\.net\.ae|eim\.ae|batelco\.com\.bh|omantel\.net\.om|qatar\.net\.qa|qualitynet\.net|(idm|cyberia|terra|sodetel)\.net\.lb|(awalnet|nesma)\.net\.sa|tedata\.net\.eg|link\.net|zoho\.com|mail\.ru|(orange|wanadoo|free|sfr)\.fr|laposte\.net|web\.de|libero\.it)$/i;
export type Contact = { kind?: 'person' | 'company'; id: string; user_id: string; search_id: string; name: string; email: string; company: string; title: string; sector: string; country: string; city: string; website: string; size: string; source: string; email_status: string; created_at: string };
export type Search = { id: string; user_id: string; filters: string; title: string; requested: number; delivered: number; duplicates: number; status: string; created_at: string; message?: string; checked?: number; companiesChecked?: number; widenedTo?: string[] }; // companiesChecked: of checked, the companies looked up after a people search fell back to company emails; widenedTo: the countries a search short of its count widened to
export type Ledger = { id: string; amount: number; kind: string; reason: string; created_at: string; balance_after: number };
export type ExportEvent = { id: string; row_count: number; created_at: string };
export type Invitation = { id: string; name: string; email: string; credits: number; expires_at: string; used_at: string | null; created_at: string };
export type AuditEvent = { id: string; action: string; detail: string; created_at: string };
export type AdminUser = User & { leads: number; searches: number; exports: number };
export type OverviewStats = {
  contacts: number; searches: number; exports: number;
  weekly: { start: string; end: string; count: number }[];
};
export type Snapshot = {
  features?:{crm:boolean}; wallet?:{total:number;reserved:number;available:number};
  provider?: { configured: boolean; maxCount: number }; // no provider name: members never see it
  user: User; contacts: Contact[]; searches: Search[]; ledger: Ledger[]; exports: ExportEvent[];
  summary?: OverviewStats;
  admin?: { users: AdminUser[]; invitations: Invitation[]; audit: AuditEvent[]; recovery?: boolean; totals: { delivered: number; searches: number; exports: number; used: number; members?: number; activeMembers?: number } };
};
export type Candidate = Omit<Contact, 'id' | 'user_id' | 'search_id' | 'created_at'>;

// English names of what the member picks from (Arabic is the stored value; English is for display only).
export const labelsEn: Record<string, string> = {
  ...Object.fromEntries(niches.map(n=>[n.label,n.en])),
  'الصحة والطب': 'Health & medicine', 'التقنية والاتصالات': 'Technology & telecom', 'العقارات والبناء': 'Real estate & construction',
  'التجارة والمتاجر': 'Retail & trade', 'المطاعم والضيافة': 'Food & hospitality', 'التسويق والإعلام': 'Marketing & media',
  'المال والخدمات المهنية': 'Finance & professional services', 'التعليم والتدريب': 'Education & training',
  'الصناعة والطاقة والنقل': 'Industry, energy & transport', 'الحكومة والمنظمات': 'Government & non-profits',
  'الصحة والعيادات': 'Clinics & health care', 'عيادات الأسنان': 'Dental clinics', 'المستشفيات': 'Hospitals', 'المختبرات الطبية': 'Medical laboratories',
  'العيون والبصريات': 'Eye care & optics', 'الصحة النفسية': 'Mental health', 'الصيدليات والأدوية': 'Pharmacies & pharma', 'الأجهزة الطبية': 'Medical devices',
  'الطب البيطري': 'Veterinary', 'اللياقة والصحة العامة': 'Fitness & wellness', 'التقنية والبرمجيات': 'Software & IT', 'الاتصالات': 'Telecommunications',
  'العقارات': 'Real estate', 'البناء والمقاولات': 'Construction & contracting', 'الهندسة والعمارة': 'Engineering & architecture', 'الأثاث والديكور': 'Furniture & interiors',
  'التجارة الإلكترونية': 'E-commerce', 'التجزئة والمتاجر': 'Retail stores', 'الجملة والاستيراد والتصدير': 'Wholesale & import/export', 'الأزياء والموضة': 'Fashion & apparel',
  'التجميل والعناية الشخصية': 'Beauty & personal care', 'السيارات': 'Automotive', 'المطاعم والمقاهي': 'Restaurants & cafés', 'الأغذية والمشروبات': 'Food & beverages',
  'السياحة والضيافة': 'Travel & hospitality', 'الفعاليات والمعارض': 'Events & exhibitions', 'التسويق والإعلان': 'Marketing & advertising', 'الإعلام والإنتاج': 'Media & production',
  'التصميم والجرافيك': 'Design & graphics', 'المحاسبة والخدمات المالية': 'Accounting & finance', 'البنوك والاستثمار': 'Banking & investment', 'التأمين': 'Insurance',
  'الخدمات المهنية': 'Professional services', 'المحاماة والخدمات القانونية': 'Law & legal services', 'الموارد البشرية والتوظيف': 'HR & recruitment',
  'المدارس': 'Schools', 'الجامعات والكليات': 'Universities & colleges', 'مراكز التدريب': 'Training centers', 'معاهد اللغات': 'Language institutes', 'التعليم الإلكتروني': 'E-learning',
  'الصناعة': 'Manufacturing', 'النفط والغاز والطاقة': 'Oil, gas & energy', 'الزراعة': 'Agriculture', 'النقل والخدمات اللوجستية': 'Transport & logistics', 'الأمن والحماية': 'Security',
  'الجهات الحكومية': 'Government', 'الجمعيات والمنظمات غير الربحية': 'Non-profits',
  'المالك أو المؤسس': 'Owner or founder', 'الرئيس التنفيذي أو المدير العام': 'CEO or general manager', 'مدير التسويق': 'Marketing manager',
  'مسؤول التسويق الرقمي': 'Digital marketing lead', 'مدير المبيعات': 'Sales manager', 'مدير تطوير الأعمال': 'Business development manager', 'مدير العمليات': 'Operations manager',
  'المدير المالي': 'Finance manager', 'مدير الموارد البشرية': 'HR manager', 'مدير تقنية المعلومات': 'IT manager', 'مدير المشتريات': 'Procurement manager',
  'مدير المشاريع': 'Project manager', 'مدير المنتج': 'Product manager', 'مدير خدمة العملاء': 'Customer service manager', 'مدير الفرع أو المتجر': 'Branch or store manager',
  'مدير العيادة أو المدير الطبي': 'Clinic manager or medical director',
};

// The assistant (src/lib/ai.ts): a short answer, and a search form when the member described who they want to reach.
export type AssistContext = Pick<SearchInput, 'mode' | 'sector' | 'countries' | 'city' | 'title' | 'size' | 'count'>;
export type AssistMessage = { role: 'user' | 'assistant'; content: string };
export function searchMethod(query: Pick<URLSearchParams,'get'>): 'manual'|'ai'|null {
  const method=query.get('method');
  if(method==='manual'||method==='ai')return method;
  if(method!==null)return null;
  return query.get('ai')?'ai':query.get('from')||query.get('saved')?'manual':null;
}
export type AssistReply = { reply: string; action?: 'prepare' | 'clarify' | 'answer'; choices?: string[]; search?: { mode: 'people' | 'companies'; field: string; specialty: string; other: string; countries: string[];
  city: string; title: string; size: 'all' | '1-10' | '11-50' | '51-200'; count: number } };
// The assistant's suggestion -> search form values (a specialty, a whole field, or the member's own words). Checked in the
// browser too: it may arrive in a link (?ai=), so nothing is trusted; the server checks the search itself.
const sizes = ['all', '1-10', '11-50', '51-200'] as const;
export function assistForm(raw: unknown, max: number) {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 60) : '';
  const countries = Array.isArray(s.countries) ? s.countries.filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).slice(0, 10) : [];
  const count = typeof s.count === 'number' && Number.isFinite(s.count) ? Math.round(s.count) : 0;
  return {
    mode: s.mode === 'companies' ? 'companies' as const : 'people' as const, sector: text(s.specialty) || text(s.field) || text(s.other) || undefined,
    countries: countries.length ? countries : undefined, city: countries.length === 1 ? text(s.city) : '', title: s.mode === 'companies' ? '' : text(s.title),
    size: sizes.find(x => x === s.size) ?? 'all', count: count > 0 ? Math.max(1, Math.min(count, max)) : undefined,
  };
}

// A member explicitly chooses a broader draft. It requests only the deficit and never starts or confirms a paid search.
export function completionDraft(search: Search | undefined, scope: string | null) {
  if (!search || search.status !== 'partial' || search.delivered >= search.requested || !['country', 'gulf'].includes(scope || '')) return;
  try {
    const raw = withCountries(JSON.parse(search.filters)) as Record<string, unknown>, draft = assistForm({ ...raw, other: raw.sector }, 50);
    if (!draft.sector || !draft.countries || (scope === 'country' && !draft.city)) return;
    if (scope === 'gulf' && (!draft.countries.every(c => (gulf as readonly string[]).includes(c)) || gulf.every(c => draft.countries!.includes(c)))) return;
    return { ...draft, countries: scope === 'gulf' ? [...gulf] : draft.countries, city: '', count: Math.min(50, search.requested - search.delivered) };
  } catch { return; }
}
