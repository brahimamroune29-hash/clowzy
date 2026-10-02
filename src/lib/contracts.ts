import type { SearchInput } from './schemas';
import { countryFromText } from './places';

// What the member picks from: a main field, then one of its specialties or the whole field. The server maps each label to
// exact provider names (src/lib/audience.ts); anything typed under «أخرى» is mapped by the AI there.
export const fields = {
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
export type FieldName = keyof typeof fields;
export type Specialty = (typeof fields)[FieldName][number];
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
// Emails a search can expect, from pooled live very-sure rates (A/B 2026-09-28 + production searches 2026-09-30): people matched by
// country code 8 of 45 (18%), name-only matches 2 of 25 (8%). A search tries at most SUBMIT_MULTIPLE x the count, strict first.
export function expectedEmails(strict: number, total: number, count: number, mode = 'people') {
  // Companies: at most 25 tried per requested email (fetchCap); 8 of 25 Gulf real-estate companies showed an email on their own
  // site (2026-10-01), and the provider verifies most of those: about 3 in 10.
  if (mode === 'companies') return Math.floor(Math.min(total, count * 25) * 0.3 + 1e-9);
  const first = Math.min(strict, count * SUBMIT_MULTIPLE), rest = Math.min(total - strict, count * SUBMIT_MULTIPLE - first);
  return Math.floor(first * 0.18 + rest * 0.08 + 1e-9); // rounded down: under one expected email reads as "may find none"
}
export type Role = 'admin' | 'member';
export type User = { id: string; name: string; email: string; role: Role; active: number; balance: number; created_at: string; terms_accepted_at: string | null };
// When the terms last changed in a way members must accept again (ISO UTC, same format as terms_accepted_at). Raise it with
// the text in terms.tsx: every member who accepted before it sees the terms again before anything else (route.ts).
// Never later than the deploy: acceptances would count as old until then (a test checks it is in the past).
export const TERMS_VERSION = '2026-10-02T00:00:00.000Z';
export const termsCurrent = (user: Pick<User, 'terms_accepted_at'>) => !!user.terms_accepted_at && user.terms_accepted_at >= TERMS_VERSION;
// How sure the provider is that the email exists: VERIFIED <1% expected bounce, PROBABLE <5% (Icypeas certainties).
export const emailTrust = (status: string, en = false) => status === 'PROBABLE' ? (en ? 'Provider confidence 95%' : 'ثقة المزوّد ٩٥٪') : status === 'VERIFIED' ? (en ? 'Provider confidence 99%' : 'ثقة المزوّد ٩٩٪') : status;
export type Contact = { kind?: 'person' | 'company'; id: string; user_id: string; search_id: string; name: string; email: string; company: string; title: string; sector: string; country: string; city: string; website: string; size: string; source: string; email_status: string; created_at: string };
export type Search = { id: string; user_id: string; filters: string; title: string; requested: number; delivered: number; duplicates: number; status: string; created_at: string; message?: string; checked?: number };
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
