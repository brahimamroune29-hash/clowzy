import { countryFromText } from './places';

// What the member picks from. The server maps each label to exact provider names (src/lib/audience.ts);
// anything else typed under «أخرى» is mapped by the AI there.
export const sectors = ['التقنية والبرمجيات', 'العقارات', 'الصحة والعيادات', 'عيادات الأسنان', 'التجارة الإلكترونية', 'التجزئة والمتاجر', 'المطاعم والمقاهي',
  'الأغذية والمشروبات', 'البناء والمقاولات', 'الهندسة والعمارة', 'التسويق والإعلان', 'الإعلام والإنتاج', 'التصميم والجرافيك', 'التعليم والتدريب',
  'السياحة والضيافة', 'الفعاليات والمعارض', 'الخدمات المهنية', 'المحاماة والخدمات القانونية', 'المحاسبة والخدمات المالية', 'البنوك والاستثمار', 'التأمين',
  'السيارات', 'النقل والخدمات اللوجستية', 'الأزياء والموضة', 'التجميل والعناية الشخصية', 'اللياقة والصحة العامة', 'الصيدليات والأدوية',
  'النفط والغاز والطاقة', 'الاتصالات', 'الموارد البشرية والتوظيف', 'الأمن والحماية', 'الأثاث والديكور', 'الزراعة', 'الجملة والاستيراد والتصدير',
  'الصناعة', 'الجمعيات والمنظمات غير الربحية', 'الجهات الحكومية'] as const;
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
// How sure the provider is that the email exists: VERIFIED <1% expected bounce, PROBABLE <5% (Icypeas certainties).
export const emailTrust = (status: string) => status === 'PROBABLE' ? 'مؤكد ٩٥٪' : status === 'VERIFIED' ? 'مؤكد ٩٩٪' : status;
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
  provider?: { configured: boolean; maxCount: number }; // no provider name: members never see it
  user: User; contacts: Contact[]; searches: Search[]; ledger: Ledger[]; exports: ExportEvent[];
  summary?: OverviewStats;
  admin?: { users: AdminUser[]; invitations: Invitation[]; audit: AuditEvent[]; totals: { delivered: number; searches: number; exports: number; used: number; members?: number; activeMembers?: number } };
};
export type Candidate = Omit<Contact, 'id' | 'user_id' | 'search_id' | 'created_at'>;
