// Countries and cities: profile addresses from Icypeas (any language) -> ISO country code, and the Arabic city names we accept.
export const cityNames: Record<string, string> = {
  'الرياض': 'Riyadh', 'جدة': 'Jeddah', 'الدمام': 'Dammam', 'الخبر': 'Khobar', 'مكة': 'Mecca', 'المدينة المنورة': 'Medina',
  'دبي': 'Dubai', 'أبوظبي': 'Abu Dhabi', 'أبو ظبي': 'Abu Dhabi', 'الشارقة': 'Sharjah', 'عجمان': 'Ajman',
  'الدوحة': 'Doha', 'مدينة الكويت': 'Kuwait City', 'المنامة': 'Manama', 'مسقط': 'Muscat',
  'القاهرة': 'Cairo', 'الإسكندرية': 'Alexandria', 'الجيزة': 'Giza', 'الجزائر': 'Algiers', 'الجزائر العاصمة': 'Algiers', 'وهران': 'Oran', 'قسنطينة': 'Constantine',
};
// Arabic spelling variants and diacritics fold together (أ/إ/آ -> ا, ى -> ي, ة -> ه); Latin accents too.
export const norm = (s: string) => s.normalize('NFKD').replace(/[ً-ٰٟـ̀-ͯ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').toLowerCase().trim();

const pseudo = /^(Q[M-Z]|X[A-Z]|ZZ|AA|EU|EZ|UN)$/; // private-use and grouping codes, not countries
export const isCountry = (code: string) => /^[A-Z]{2}$/.test(code) && !pseudo.test(code) && !!new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(code);
// Country names in the languages profile addresses come in, plus the short forms people write.
let names: Map<string, string> | undefined;
function countryNames() {
  if (names) return names;
  names = new Map();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const lang of ['en', 'ar', 'fr', 'de', 'nl', 'es', 'it', 'pt', 'tr']) {
    const display = new Intl.DisplayNames([lang], { type: 'region', fallback: 'none' });
    for (const a of letters) for (const b of letters) {
      const code = a + b, name = pseudo.test(code) ? undefined : display.of(code);
      if (name && !names.has(norm(name))) names.set(norm(name), code); // first code wins: FR before FX ("France" too)
    }
  }
  for (const [alias, code] of [['السعودية', 'SA'], ['الإمارات', 'AE'], ['عمان', 'OM'], ['سلطنة عمان', 'OM'], ['uae', 'AE'], ['ksa', 'SA'], ['امريكا', 'US'],
    ['بريطانيا', 'GB'], ['انجلترا', 'GB'], ['فلسطين', 'PS']]) names.set(norm(alias), code);
  return names;
}
const knownCities = new Set(Object.keys(cityNames).map(norm));

// "City, Region, Country" (Latin) or "<province> <city> <country>" (Arabic, no commas) -> { code, city }. Unknown: empty code.
export function placeOf(address: string | null | undefined): { code: string; city: string } {
  const parts = (address || '').split(',').map(s => s.trim()).filter(Boolean), last = parts.at(-1) || '', map = countryNames();
  const whole = map.get(norm(last));
  if (whole) return { code: whole, city: parts.length > 1 ? parts[0] : '' };
  const words = last.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const code = map.get(norm(words.slice(i).join(' ')));
    if (!code) continue;
    if (parts.length > 1) return { code, city: parts[0] };
    const before = words.slice(0, i); // the city is the longest known name at the end, else the last word
    const j = before.findIndex((_, k) => knownCities.has(norm(before.slice(k).join(' '))));
    return { code, city: before.slice(j < 0 ? -1 : j).join(' ') };
  }
  return { code: '', city: '' };
}

const shortNames: Record<string, string> = { SA: 'السعودية', AE: 'الإمارات', OM: 'عُمان' };
// The name members read: the short form for the Gulf, the standard Arabic name otherwise.
export const countryLabel = (code: string) => shortNames[code] ?? new Intl.DisplayNames(['ar'], { type: 'region' }).of(code) ?? code;
// A country the member typed under «أخرى»: exact name after folding spelling variants, never a partial match
// (السودان vs جنوب السودان). Empty when unknown.
export const countryFromText = (text: string) => countryNames().get(norm(text)) || '';
export const englishName = (code: string) => new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
