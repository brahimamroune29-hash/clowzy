import { z } from 'zod';

export const sectors = ['التقنية والبرمجيات', 'العقارات', 'الصحة والعيادات', 'التجارة الإلكترونية', 'التعليم والتدريب', 'السياحة والضيافة', 'الخدمات المهنية', 'الصناعة'] as const;
export const countries = ['السعودية', 'الإمارات', 'قطر', 'الكويت', 'البحرين', 'عُمان', 'الجزائر', 'مصر'] as const;
export const searchSchema = z.object({
  sector: z.enum(sectors),
  country: z.enum(countries),
  city: z.string().trim().max(60).default(''),
  title: z.string().trim().max(60).default(''),
  size: z.enum(['all', '1-10', '11-50', '51-200']).default('all'),
  count: z.number().int().min(1).max(50),
  confirmed: z.literal(true),
  requestId: z.string().uuid(),
});
export type SearchInput = z.infer<typeof searchSchema>;
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
  provider?: { name: 'Icypeas'; configured: boolean; maxCount: number };
  user: User; contacts: Contact[]; searches: Search[]; ledger: Ledger[]; exports: ExportEvent[];
  summary?: OverviewStats;
  admin?: { users: AdminUser[]; invitations: Invitation[]; audit: AuditEvent[]; totals: { delivered: number; searches: number; exports: number; used: number; members?: number; activeMembers?: number } };
};
export type Candidate = Omit<Contact, 'id' | 'user_id' | 'search_id' | 'created_at'>;
