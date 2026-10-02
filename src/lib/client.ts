export type Lang = 'ar' | 'en';
// The member's language, kept in this browser (lang.tsx). Every request carries it, so the server answers in it.
let chosen: Lang | null = null; // this tab's choice, when the browser keeps no storage (private windows)
export function savedLang(): Lang { if (chosen) return chosen; try { return localStorage.getItem('lang') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; } }
export function chooseLang(lang: Lang) { chosen = lang; try { localStorage.setItem('lang', lang); } catch {} }
const say = (ar: string, en: string) => savedLang() === 'en' ? en : ar;

export async function api<T>(path: string, data?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'x-lang': savedLang(), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
      cache:'no-store', signal: AbortSignal.timeout(65000),
    });
  } catch { throw new Error(say('تعذّر الاتصال بالخادم. تحقّق من الإنترنت وحاول مجددًا.', 'Could not reach the server. Check your connection and try again.')); }
  const result = await response.json().catch(() => null); // e.g. an HTML error page during a redeploy
  if (!response.ok || !result) throw Object.assign(new Error(result?.error || say('تعذّر إكمال الطلب.', 'The request could not be completed.')), { status: response.status }); // 401: signed out
  return result as T;
}
export function date(value: string) {
  return new Intl.DateTimeFormat(savedLang(), { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' }).format(new Date(value));
}
export const number = (n:number) => new Intl.NumberFormat('en').format(n);
export async function downloadContacts(options: {ids?:string[];searchId?:string;profile?:'generic'|'gohighlevel';columns?:string[]} = {}) {
  const response = await fetch('/api/export', {signal:AbortSignal.timeout(65000),method:'POST',headers:{'Content-Type':'application/json','x-lang':savedLang()},body:JSON.stringify(options)});
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || say('تعذّر تنزيل الملف. حاول مجددًا.', 'Could not download the file. Try again.'));
  const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'clowzy-contacts.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); // Safari aborts a download revoked at once
}
