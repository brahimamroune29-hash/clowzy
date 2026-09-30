import { z } from 'zod';
import { countryFromText, isCountry } from './places';

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
const text = (max: number) => z.string().trim().max(max);
export const searchSchema = z.object({
  sector: text(60).min(2), // a listed sector, or the member's own words
  countries: z.array(z.string().refine(isCountry)).min(1).max(10),
  city: text(60).default(''),
  title: text(60).default(''), // a listed title, English as typed, or Arabic words for the AI
  size: z.enum(['all', '1-10', '11-50', '51-200']).default('all'),
  count: z.number().int().min(1).max(50),
  confirmed: z.literal(true),
  requestId: z.string().uuid(),
});
export type SearchInput = z.infer<typeof searchSchema>;
// Searches saved (and pages opened) before multi-country send `country` (an Arabic name) instead of `countries`.
export function withCountries(raw: unknown) {
  if (!raw || typeof raw !== 'object' || 'countries' in raw || !('country' in raw)) return raw;
  return { ...raw, countries: [countryFromText(String(raw.country))].filter(Boolean) };
}
// A search as stored and run: the form plus the provider names it resolved to (server-side only, never from the client).
export const resolvedSchema = searchSchema.extend({
  industries: z.array(text(120)).min(1).max(40), industryLabels: z.array(text(80)).max(40), titles: z.array(text(80)).max(40),
});
export type Resolved = z.infer<typeof resolvedSchema>;
export const SUBMIT_MULTIPLE = 10; // approved 2026-09-30 (was 5): submit at most 10x the requested emails for email discovery
// Emails a search can expect, from pooled live very-sure rates (A/B 2026-09-28 + production searches 2026-09-30): people matched by
// country code 8 of 45 (18%), name-only matches 2 of 25 (8%). A search tries at most SUBMIT_MULTIPLE x the count, strict first.
export function expectedEmails(strict: number, total: number, count: number) {
  const first = Math.min(strict, count * SUBMIT_MULTIPLE), rest = Math.min(total - strict, count * SUBMIT_MULTIPLE - first);
  return Math.floor(first * 0.18 + rest * 0.08 + 1e-9); // rounded down: under one expected email reads as "may find none"
}
export type Role = 'admin' | 'member';
export type User = { id: string; name: string; email: string; role: Role; active: number; balance: number; created_at: string; terms_accepted_at: string | null };
export type Contact = { id: string; user_id: string; search_id: string; name: string; email: string; company: string; title: string; sector: string; country: string; city: string; website: string; size: string; source: string; email_status: string; created_at: string };
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
