import { countryFromText, cityNames, norm } from './places';
import type { Candidate, Resolved } from './contracts';
import type { Store } from './store';

export const crmEnabled = () => process.env.CRM_ENABLED === 'true';
export const reuseEnabled = () => crmEnabled() && process.env.CATALOG_REUSE_ENABLED === 'true';
// Verification ages out; keep this knob since provider freshness and the owner's policy can differ.
export function catalogDays() {
  const days = Number(process.env.CATALOG_FRESH_DAYS || 30);
  return Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30;
}
export const cityKey = (s: string) => norm(cityNames[s] || s);

// Only supplier result fields belong in the shared catalog, never a member's notes, lists or search wording.
export async function rememberCandidates(store: Store, candidates: Candidate[]) {
  if (!crmEnabled()) return;
  return store.transaction(async () => {
  await store.db.run('LOCK TABLE catalog_suppressions IN SHARE MODE');
  for (const c of candidates.slice(0, 100)) {
    const email = c.email.trim().toLowerCase(), country = countryFromText(c.country);
    if (email.length > 254 || !country || !['VERIFIED', 'PROBABLE'].includes(c.email_status) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const payload: Candidate = { kind: c.kind || 'person', name: c.name, email, company: c.company, title: c.title, sector: c.sector,
      country: c.country, city: c.city, website: c.website, size: c.size, source: 'clowzy', email_status: c.email_status };
    await store.db.run(`INSERT INTO lead_catalog(email,kind,industry,country_code,city_key,title_key,headcount,payload,verified_at)
      SELECT ?,?,?,?,?,?,?,?::jsonb,? WHERE NOT EXISTS(SELECT 1 FROM catalog_suppressions WHERE email=?)
      ON CONFLICT(email) DO UPDATE SET kind=excluded.kind,industry=excluded.industry,country_code=excluded.country_code,
        city_key=excluded.city_key,title_key=excluded.title_key,headcount=excluded.headcount,payload=excluded.payload,verified_at=excluded.verified_at`,
      email, payload.kind, norm(c.sector), country, cityKey(c.city), norm(c.title), /^\d+$/.test(c.size) && Number(c.size)<=2147483647 ? Number(c.size) : null,
      JSON.stringify(payload), new Date().toISOString(), email);
  }
  });
}

export async function catalogMatches(store: Store, userId: string, input: Resolved, limit: number) {
  if (!reuseEnabled()) return [];
  const [min, max] = input.size === 'all' ? [0, 2147483647] : input.size.split('-').map(Number);
  // SQL does the filtering and ownership exclusion; missing attributes never satisfy a narrower filter.
  return (await store.db.all<{ payload: Candidate }>(`SELECT l.payload FROM lead_catalog l
    WHERE l.kind=? AND l.verified_at>=? AND l.country_code IN (SELECT jsonb_array_elements_text(?::jsonb))
      AND l.industry IN (SELECT jsonb_array_elements_text(?::jsonb))
      AND (?='' OR l.city_key=?) AND (?=0 OR l.headcount BETWEEN ? AND ?)
      AND (?=0 OR l.title_key IN (SELECT jsonb_array_elements_text(?::jsonb)))
      AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.user_id=? AND c.email=l.email)
      AND NOT EXISTS(SELECT 1 FROM catalog_suppressions s WHERE s.email=l.email)
      AND NOT EXISTS(SELECT 1 FROM crm_exclusions e WHERE e.user_id=? AND (e.value=l.email OR e.value=split_part(l.email,'@',2)))
    ORDER BY l.verified_at DESC,l.email LIMIT ?`, input.mode === 'companies' ? 'company' : 'person',
    new Date(Date.now() - catalogDays() * 86400000).toISOString(), JSON.stringify(input.countries), JSON.stringify(input.industries.map(norm)),
    cityKey(input.city), cityKey(input.city), input.size === 'all' ? 0 : 1, min, max,
    input.mode === 'companies' || !input.titles.length ? 0 : 1, JSON.stringify(input.titles.map(norm)), userId, userId, Math.min(50, limit)))
    .map(row => row.payload);
}
