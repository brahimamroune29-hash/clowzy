export async function api<T>(path: string, data?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? undefined : {'Content-Type':'application/json'},
      body: data === undefined ? undefined : JSON.stringify(data),
      cache:'no-store',
    });
  } catch { throw new Error('تعذّر الاتصال بالخادم. تحقّق من الإنترنت وحاول مجددًا.'); }
  const result = await response.json().catch(() => null); // e.g. an HTML error page during a redeploy
  if (!response.ok || !result) throw Object.assign(new Error(result?.error || 'تعذّر إكمال الطلب.'), { status: response.status }); // 401: signed out
  return result as T;
}
export function date(value: string) {
  return new Intl.DateTimeFormat('ar', { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' }).format(new Date(value));
}
export const number = (n:number) => new Intl.NumberFormat('en').format(n);
export async function downloadContacts(options: {ids?:string[];searchId?:string} = {}) {
  const response = await fetch('/api/export', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options)});
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'تعذّر تنزيل الملف. حاول مجددًا.');
  const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'clowzy-contacts.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); // Safari aborts a download revoked at once
}
