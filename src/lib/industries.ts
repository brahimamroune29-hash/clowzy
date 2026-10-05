import { INDUSTRY_AR } from './industries-ar';

// Icypeas' exact industry names (find-people currentCompany.industry), from https://api-doc.icypeas.com/assets/files/industries-054af2e58c8a6e7bb3cbe357085f09c8.txt
// fetched 2026-09-30, minus alcohol, nightlife and gambling (never searched for Gulf members; see ANY_INDUSTRY_EXCLUDED). The AI
// mapping for a typed sector is checked against this list.
export const INDUSTRIES: readonly string[] = Object.keys(INDUSTRY_AR);
