export async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : {'Content-Type':'application/json'},
    body: data === undefined ? undefined : JSON.stringify(data),
    cache:'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذّر إكمال الطلب.');
  return result as T;
}
export function date(value: string) {
  return new Intl.DateTimeFormat('ar', { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' }).format(new Date(value));
}
export const number = (n:number) => new Intl.NumberFormat('en').format(n);
export async function downloadContacts(options: {ids?:string[];searchId?:string} = {}) {
  const response = await fetch('/api/export', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options)});
  if (!response.ok) throw new Error((await response.json()).error);
  const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'clowzy-contacts.csv'; a.click(); URL.revokeObjectURL(url);
}
