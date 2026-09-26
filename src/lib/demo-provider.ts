import { Candidate, countries, LeadProvider, SearchInput, sectors } from './contracts';

const cities: Record<string, string[]> = {
  السعودية: ['الرياض', 'جدة', 'الدمام'], الإمارات: ['دبي', 'أبوظبي', 'الشارقة'],
  الجزائر: ['الجزائر', 'وهران', 'قسنطينة'], مصر: ['القاهرة', 'الإسكندرية', 'الجيزة'],
};
const brands = ['أفق', 'مدار', 'مسار', 'روافد', 'نواة', 'منار', 'ركن', 'امتداد', 'رؤية', 'سند', 'مدى', 'إثراء'];
const endings = ['للحلول الرقمية', 'للعقارات', 'للرعاية الصحية', 'للتجارة', 'للتدريب', 'للضيافة', 'للاستشارات', 'للصناعات'];
const first = ['خالد', 'ريم', 'عمر', 'نورة', 'يوسف', 'لينا', 'سامي', 'سارة', 'زياد', 'مريم', 'أمين', 'هند'];
const last = ['الحسن', 'منصور', 'صالح', 'علي', 'كريم', 'ناصر'];
const titles = ['المدير التنفيذي', 'مدير التسويق', 'مؤسس الشركة'];
export const demoCatalog: Candidate[] = sectors.flatMap((sector, si) => countries.flatMap((country, ci) => brands.map((brand, n) => ({
  name: first[n] + ' ' + last[(n + ci) % last.length],
  email: 'contact-' + si + '-' + ci + '-' + n + '@example.com',
  company: brand + ' ' + endings[si],
  title: titles[n % titles.length],
  sector, country, city: cities[country][n % 3],
  size: ['1-10', '11-50', '51-200'][n % 3],
  website: 'https://example.com',
  source: 'كتالوج تجريبي محلي', email_status: 'demo',
}))));

export const demoProvider = {
  name: 'كتالوج تجريبي محلي',
  search(f: SearchInput) {
    return demoCatalog.filter(c => c.sector === f.sector && c.country === f.country
      && (!f.city || c.city.includes(f.city))
      && (!f.title || c.title.includes(f.title))
      && (f.size === 'all' || c.size === f.size));
  },
} satisfies LeadProvider;

export function suggestFilters(description: string) {
  const text = description.toLowerCase();
  const groups = [
    ['تقني', 'برمج', 'saas', 'software'], ['عقار', 'real estate'], ['عياد', 'أسنان', 'اسنان', 'صح', 'clinic'],
    ['تجار', 'متجر', 'ecommerce'], ['تعليم', 'تدريب', 'مدرس', 'training'], ['فندق', 'سياح', 'ضياف', 'hotel'],
    ['محام', 'استشار', 'محاسب', 'consult'], ['صناع', 'مصنع', 'factory'],
  ];
  const sectorIndex = groups.findIndex(words => words.some(word => text.includes(word)));
  const country = countries.find(c => text.includes(c)) || (text.includes('دبي') ? 'الإمارات' : text.includes('الرياض') || text.includes('جدة') ? 'السعودية' : text.includes('وهران') ? 'الجزائر' : text.includes('القاهرة') ? 'مصر' : 'السعودية');
  const city = cities[country].find(c => text.includes(c)) || '';
  return { sector: sectors[Math.max(0, sectorIndex)], country, city, title: text.includes('تسويق') ? 'Marketing Director' : '', size: 'all', count: 10, mode: 'demo' };
}
