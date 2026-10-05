// API request gate. With APP_URL set (production) only that host and same-origin JSON writes pass;
// without it the API stays loopback-only for local development.
export const bodyLimit = 64000; // an export of 1,000 selected ids is ~40 KB
type Req = { method: string; host?: string | null; origin?: string | null; contentType?: string | null; contentLength?: string | null };

const parse = (value?: string | null) => { try { return new URL(value || ''); } catch { return null; } };
const originOf = (value?: string | null) => parse(value)?.origin || '';
export const isHttps = (appUrl?: string) => parse(appUrl)?.protocol === 'https:';

// The owner's lock, held outside the platform: PLATFORM_LOCKED=1 in the host's environment makes this API
// answer the message below and nothing else — browser requests and the search worker alike. The worker is
// included on purpose: its ticks submit paid batches to the provider, so a platform locked for non-payment
// would otherwise keep spending the owner's money on the client's searches. Clearing the variable restores
// everything; no data is touched either way, and the nightly backup never notices — it reaches the database
// directly (.github/workflows/backup.yml), not through this API.
export const lockMessage = () =>
  /^(1|true)$/i.test((process.env.PLATFORM_LOCKED ?? '').trim())
    ? 'المنصة متوقفة مؤقتًا لعدم إكمال الدفعة. يرجى التواصل مع مالك المنصة لإعادة التفعيل.'
    : null;

export function accessError(req: Req, appUrl?: string): { status: number; message: string } | null {
  const host = req.host || '', app = appUrl ? parse(appUrl) : null;
  if (appUrl && !app) return { status: 503, message: 'إعداد عنوان المنصة (APP_URL) غير صالح.' };
  if (app) {
    if (host !== app.host) return { status: 403, message: 'هذا العنوان غير مسموح.' };
  } else if (!['127.0.0.1', 'localhost'].includes(host.split(':')[0])) {
    return { status: 503, message: 'المعاينة المحلية فقط. إعداد الإنتاج غير مفعّل.' };
  }
  if (req.method === 'GET') return null;
  const expected = app ? app.origin : originOf('http://' + host);
  if (!req.origin || originOf(req.origin) !== expected) return { status: 403, message: 'مصدر الطلب غير مسموح.' };
  if (!req.contentType?.includes('application/json')) return { status: 415, message: 'صيغة الطلب غير صحيحة.' };
  if (Number(req.contentLength) > bodyLimit) return { status: 413, message: 'الطلب أكبر من الحد المسموح.' };
  return null;
}

// The app listens on 127.0.0.1 behind one reverse proxy, which appends the real client IP last.
export function clientIp(forwardedFor: string | null) {
  return forwardedFor?.split(',').map(s => s.trim()).filter(Boolean).at(-1) || 'unknown';
}
