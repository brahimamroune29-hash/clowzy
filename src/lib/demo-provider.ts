import { Candidate, countries, LeadProvider, SearchInput, sectors } from './contracts';

const cities: Record<string, string[]> = {
  السعودية: ['الرياض', 'جدة', 'الدمام'], الإمارات: ['دبي', 'أبوظبي', 'الشارقة'],
  قطر: ['الدوحة', 'الريان', 'الوكرة'], الكويت: ['مدينة الكويت', 'حولي', 'الفروانية'], البحرين: ['المنامة', 'المحرق', 'الرفاع'], عُمان: ['مسقط', 'صلالة', 'صحار'],
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
