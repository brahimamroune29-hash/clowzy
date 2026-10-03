import { type FieldName, fields, type LegacySpecialty, type Resolved, type SearchInput, sectors, type Specialty, titles, withCountries } from './contracts';
import { nicheOf } from './niches';
import { resolvedSchema } from './schemas';
import { INDUSTRIES } from './industries';
import { norm } from './places';
import { AppError, type Store } from './store';
import { type AiMapper, openRouter } from './ai';

// Listed sectors -> exact Icypeas industry names (checked against INDUSTRIES by tests/audience.test.ts).
const LEGACY_INDUSTRIES: Record<LegacySpecialty, string[]> = {
  'الصحة والعيادات': ['Hospitals and Health Care', 'Medical Practices', 'Hospitals', 'Outpatient Care Centers', 'Physicians'],
  'عيادات الأسنان': ['Dentists'],
  'المستشفيات': ['Hospitals', 'Hospitals and Health Care'],
  'المختبرات الطبية': ['Medical and Diagnostic Laboratories'],
  'العيون والبصريات': ['Optometrists'],
  'الصحة النفسية': ['Mental Health Care'],
  'الصيدليات والأدوية': ['Retail Pharmacies', 'Pharmaceutical Manufacturing', 'Wholesale Drugs and Sundries'],
  'الأجهزة الطبية': ['Medical Device', 'Medical Equipment Manufacturing'],
  'الطب البيطري': ['Veterinary', 'Veterinary Services'],
  'اللياقة والصحة العامة': ['Health, Wellness & Fitness', 'Wellness and Fitness Services'],
  'التقنية والبرمجيات': ['Software Development', 'IT Services and IT Consulting', 'Information Technology & Services', 'Technology, Information and Internet', 'IT System Custom Software Development'],
  'الاتصالات': ['Telecommunications', 'Telecommunications Carriers', 'Wireless Services'],
  'العقارات': ['Real Estate', 'Real Estate Agents and Brokers', 'Commercial Real Estate', 'Leasing Residential Real Estate', 'Leasing Non-residential Real Estate'],
  'البناء والمقاولات': ['Construction', 'Building Construction', 'Civil Engineering', 'Specialty Trade Contractors', 'Residential Building Construction', 'Nonresidential Building Construction'],
  'الهندسة والعمارة': ['Engineering Services', 'Architecture and Planning', 'Mechanical Or Industrial Engineering'],
  'الأثاث والديكور': ['Furniture', 'Interior Design', 'Furniture and Home Furnishings Manufacturing', 'Retail Furniture and Home Furnishings'],
  'التجارة الإلكترونية': ['Online and Mail Order Retail', 'Internet Marketplace Platforms'],
  'التجزئة والمتاجر': ['Retail', 'Retail Groceries', 'Retail Luxury Goods and Jewelry', 'Retail Office Supplies and Gifts', 'Retail Appliances, Electrical, and Electronic Equipment'],
  'الجملة والاستيراد والتصدير': ['Wholesale', 'Import & Export', 'Wholesale Import and Export', 'International Trade and Development'],
  'الأزياء والموضة': ['Apparel & Fashion', 'Retail Apparel and Fashion', 'Apparel Manufacturing', 'Fashion Accessories Manufacturing'],
  'التجميل والعناية الشخصية': ['Cosmetics', 'Personal Care Services', 'Personal Care Product Manufacturing', 'Retail Health and Personal Care Products'],
  'السيارات': ['Automotive', 'Retail Motor Vehicles', 'Vehicle Repair and Maintenance', 'Motor Vehicle Parts Manufacturing'],
  'المطاعم والمقاهي': ['Restaurants', 'Food and Beverage Services', 'Caterers'],
  'الأغذية والمشروبات': ['Food and Beverage Manufacturing', 'Food & Beverages', 'Food Production', 'Wholesale Food and Beverage', 'Food and Beverage Retail'],
  'السياحة والضيافة': ['Hospitality', 'Travel Arrangements', 'Leisure, Travel & Tourism', 'Hotels and Motels'],
  'الفعاليات والمعارض': ['Events Services'],
  'التسويق والإعلان': ['Marketing Services', 'Advertising Services', 'Public Relations and Communications Services'],
  'الإعلام والإنتاج': ['Media Production', 'Broadcast Media Production and Distribution', 'Online Audio and Video Media', 'Movies, Videos, and Sound'],
  'التصميم والجرافيك': ['Design Services', 'Graphic Design', 'Design'],
  'المحاسبة والخدمات المالية': ['Accounting', 'Financial Services'],
  'البنوك والاستثمار': ['Banking', 'Investment Management', 'Investment Banking', 'Venture Capital and Private Equity Principals', 'Capital Markets'],
  'التأمين': ['Insurance', 'Insurance Agencies and Brokerages', 'Insurance Carriers'],
  'الخدمات المهنية': ['Professional Services', 'Business Consulting and Services'],
  'المحاماة والخدمات القانونية': ['Law Practice', 'Legal Services'],
  'الموارد البشرية والتوظيف': ['Human Resources Services', 'Staffing and Recruiting', 'Executive Search Services'],
  'المدارس': ['Primary and Secondary Education'],
  'الجامعات والكليات': ['Higher Education'],
  'مراكز التدريب': ['Professional Training and Coaching', 'Technical and Vocational Training'],
  'معاهد اللغات': ['Language Schools'],
  'التعليم الإلكتروني': ['E-Learning Providers', 'E-learning'],
  'الصناعة': ['Manufacturing', 'Industrial Machinery Manufacturing'],
  'النفط والغاز والطاقة': ['Oil and Gas', 'Oil, Gas, and Mining', 'Oil Extraction', 'Renewable Energy Power Generation', 'Utilities', 'Electric Power Generation'],
  'الزراعة': ['Agriculture', 'Farming'],
  'النقل والخدمات اللوجستية': ['Transportation, Logistics, Supply Chain and Storage', 'Truck Transportation', 'Freight and Package Transportation', 'Warehousing and Storage'],
  'الأمن والحماية': ['Security and Investigations', 'Security Guards and Patrol Services', 'Security Systems Services'],
  'الجهات الحكومية': ['Government Administration'],
  'الجمعيات والمنظمات غير الربحية': ['Non-profit Organizations', 'Non-profit Organization Management', 'Civic and Social Organizations'],
};
export const SECTOR_INDUSTRIES = Object.fromEntries(sectors.map(s => [s,
  nicheOf(s) ? [...nicheOf(s)!.industries] : LEGACY_INDUSTRIES[s as LegacySpecialty],
])) as Record<Specialty,string[]>;
// A whole field searches all its specialties' provider names; «التعليم والتدريب» adds the general education ones (it was a
// single sector before the fields, and old searches still name it).
const extra: Partial<Record<FieldName, string[]>> = { 'التعليم والتدريب': ['Education', 'Education Management'] };
export const fieldIndustries = (field: FieldName) => [...new Set([...(fields[field] as readonly Specialty[]).flatMap(s => SECTOR_INDUSTRIES[s]), ...(extra[field] ?? [])])];
const listed = (sector: string) => Object.hasOwn(SECTOR_INDUSTRIES, sector) ? SECTOR_INDUSTRIES[sector as Specialty] : Object.hasOwn(fields, sector) ? fieldIndustries(sector as FieldName) : undefined;
// Listed titles -> what profiles say, Arabic and English together (Arabic alone finds a fraction: 896 vs 3,311 in Saudi Arabia).
export const TITLE_VARIANTS: Record<(typeof titles)[number], string[]> = {
  'المالك أو المؤسس': ['Owner', 'Founder', 'Co-Founder', 'مالك', 'مؤسس'],
  'الرئيس التنفيذي أو المدير العام': ['CEO', 'Chief Executive Officer', 'General Manager', 'Managing Director', 'الرئيس التنفيذي', 'المدير العام'],
  'مدير التسويق': ['Marketing Manager', 'Marketing Director', 'Head of Marketing', 'CMO', 'مدير التسويق', 'مدير تسويق'],
  'مسؤول التسويق الرقمي': ['Digital Marketing Manager', 'Digital Marketing Specialist', 'Social Media Manager', 'التسويق الرقمي'],
  'مدير المبيعات': ['Sales Manager', 'Sales Director', 'Head of Sales', 'مدير المبيعات', 'مدير مبيعات'],
  'مدير تطوير الأعمال': ['Business Development Manager', 'Business Development Director', 'Head of Business Development', 'مدير تطوير الأعمال'],
  'مدير العمليات': ['Operations Manager', 'Head of Operations', 'COO', 'Chief Operating Officer', 'مدير العمليات'],
  'المدير المالي': ['CFO', 'Chief Financial Officer', 'Finance Manager', 'Finance Director', 'المدير المالي'],
  'مدير الموارد البشرية': ['HR Manager', 'Human Resources Manager', 'HR Director', 'Head of HR', 'مدير الموارد البشرية'],
  'مدير تقنية المعلومات': ['IT Manager', 'IT Director', 'Head of IT', 'CTO', 'Chief Technology Officer', 'مدير تقنية المعلومات'],
  'مدير المشتريات': ['Procurement Manager', 'Purchasing Manager', 'Head of Procurement', 'مدير المشتريات'],
  'مدير المشاريع': ['Project Manager', 'Projects Director', 'مدير المشاريع', 'مدير مشاريع'],
  'مدير المنتج': ['Product Manager', 'Head of Product', 'مدير المنتج'],
  'مدير خدمة العملاء': ['Customer Service Manager', 'Customer Experience Manager', 'Head of Customer Service', 'مدير خدمة العملاء'],
  'مدير الفرع أو المتجر': ['Branch Manager', 'Store Manager', 'مدير الفرع', 'مدير فرع'],
  'مدير العيادة أو المدير الطبي': ['Clinic Manager', 'Medical Director', 'مدير العيادة', 'المدير الطبي'],
};

export type { AiMapper };
const known = new Set(INDUSTRIES);
const arabic = /[؀-ۿ]/;
// One AI answer per normalized text, kept in the database (empty answers too): the same words never pay twice, and the
// query (so the member's cursor) stays the same across count, search and repeat searches.
async function cached<T>(store: Store, kind: 'sector' | 'title', text: string, ask: () => Promise<T>, userId?: string): Promise<T> {
  const key = norm(text), hit = await store.aiCached(kind, key);
  if (hit) return JSON.parse(hit) as T;
  if (userId) await store.aiBudget(userId);
  const value = await ask();
  await store.saveAiCache(kind, key, JSON.stringify(value));
  return value;
}
const aiDown = (kind: string, e: unknown) => {
  if (e instanceof AppError && e.status === 429) return e;
  console.warn('AI mapping failed:', kind, e instanceof Error ? e.message : 'unknown');
  return new AppError(process.env.OPENROUTER_API_KEY?.trim() ? 'تعذّر فهم ما كتبته في «أخرى» الآن. اختر من القائمة أو حاول بعد قليل.'
    : 'خيار «أخرى» غير مفعّل حاليًا. اختر من القائمة.', 503);
};

// Form -> the audience a search runs with. Listed options map from the tables; typed ones go through the AI, checked.
type AudienceForm = Pick<SearchInput, 'sector' | 'countries' | 'city' | 'title' | 'size'> & Partial<Pick<SearchInput, 'mode'>>;
export async function resolveAudience<T extends AudienceForm>(store: Store, input: T, ai: AiMapper = openRouter, userId?: string): Promise<T & Pick<Resolved, 'industries' | 'industryLabels' | 'titles'>> {
  let industries: string[], industryLabels: string[];
  const table = listed(input.sector);
  if (table) {
    industries = table; industryLabels = [input.sector];
  } else {
    const pick = (list: { name: string; ar: string }[]) => list.filter((x, i) => known.has(x.name) && list.findIndex(y => y.name === x.name) === i).slice(0, 5);
    const picked = pick(await cached(store, 'sector', input.sector, () => ai.sector(input.sector), userId).catch(e => { throw aiDown('sector', e); }));
    if (!picked.length) throw new AppError(`لم نجد مجالًا مهنيًا يطابق «${input.sector}». جرّب كلمات أوضح أو اختر من القائمة.`, 400);
    industries = picked.map(x => x.name); industryLabels = picked.map(x => arabic.test(x.ar) ? x.ar.trim().slice(0, 80) : input.sector); // members read Arabic only
  }
  const title = input.mode === 'companies' ? '' : input.title.trim(); // a company has no job title: never sent to the AI
  let titles: string[] = [];
  if (Object.hasOwn(TITLE_VARIANTS, title)) titles = TITLE_VARIANTS[title as keyof typeof TITLE_VARIANTS];
  else if (arabic.test(title)) { // the Arabic words always search; the AI adds the English forms when it answers
    const english = await cached(store, 'title', title, () => ai.title(title), userId).catch(e => { if (e instanceof AppError && e.status === 429) throw e; aiDown('title', e); return []; });
    titles = [title, ...english.filter(t => /^[\x20-\x7E]{2,60}$/.test(t)).slice(0, 4)];
  } else if (title) titles = [title];
  return { ...input, industries, industryLabels, titles };
}

// Filters stored with a search -> the audience to continue it with. Searches saved before multi-country
// (country: Arabic name, no resolved lists) are upgraded from the tables, so they still run and repeat.
export function audienceOf(filters: string): Resolved {
  const raw = withCountries(JSON.parse(filters)) as Partial<Resolved>;
  const sector = raw.sector || '', title = (raw.title || '').trim();
  return resolvedSchema.parse({
    ...raw,
    industries: raw.industries ?? listed(sector) ?? [],
    industryLabels: raw.industryLabels ?? [sector],
    titles: raw.titles ?? (Object.hasOwn(TITLE_VARIANTS, title) ? TITLE_VARIANTS[title as keyof typeof TITLE_VARIANTS] : title ? [title] : []),
  });
}
