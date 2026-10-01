import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, getStore } from '@/lib/store';
import { withCountries } from '@/lib/contracts';
import { searchSchema, weekBoundariesSchema } from '@/lib/schemas';
import { IcypeasClient, IcypeasError, providerInfo } from '@/lib/icypeas';
import { LiveSearch } from '@/lib/live-search';
import { resolveAudience } from '@/lib/audience';
import { contactsCsv } from '@/lib/csv';
import { accessError, bodyLimit, clientIp, isHttps } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A search call can wait on the provider (20 s per request) and then submit a paid batch: never cut it off at a short platform default.
export const maxDuration = 60;
const password = z.string().min(10).max(128);
const tokenField = z.string().regex(/^[a-f0-9]{48}$/);
const attempts = new Map<string, { count: number; until: number }>();
function rateLimit(key: string, max: number) {
  const t = Date.now();
  for (const [k,v] of attempts) if (v.until < t) attempts.delete(k);
  const current = attempts.get(key) ?? { count: 0, until: t + 60000 };
  current.count++;
  attempts.set(key, current);
  if (current.count > max) throw new AppError('طلبات كثيرة. انتظر دقيقة وحاول مجددًا.', 429);
}
function guard(req: NextRequest) {
  const h = req.headers, denied = accessError({ method: req.method, host: h.get('host'), origin: h.get('origin'), contentType: h.get('content-type'), contentLength: h.get('content-length') }, process.env.APP_URL);
  if (denied) throw new AppError(denied.message, denied.status);
}
// Reads with a hard cap: a chunked body without Content-Length must not be buffered unbounded.
async function body(req: NextRequest) {
  const reader = req.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > bodyLimit) { await reader.cancel(); throw new AppError('الطلب أكبر من الحد المسموح.', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('تعذّر قراءة الطلب.'); }
}
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function authenticated(token: string) {
  const response = json({ ok: true });
  response.cookies.set('wasl_session', token, { httpOnly: true, sameSite: 'strict', secure: isHttps(process.env.APP_URL), path: '/', maxAge: 7 * 86400 });
  return response;
}
async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    guard(req);
    const path = (await params).path.join('/');
    const store = getStore();
    const session = req.cookies.get('wasl_session')?.value;
    if (req.method === 'GET' && path === 'invitation') {
      const token = tokenField.safeParse(req.nextUrl.searchParams.get('token'));
      if (!token.success) throw new AppError('الدعوة غير صالحة أو انتهت مدتها.', 410); // a truncated link reads like an expired one
      return json(await store.invitation(token.data));
    }
    if (req.method === 'POST' && path.startsWith('auth/')) {
      const ip = clientIp(req.headers.get('x-forwarded-for'));
      if (ip === 'unknown' && process.env.APP_URL) console.warn('No X-Forwarded-For: every client shares one login limit. Check the reverse proxy.');
      // Counted in the database: Vercel runs several instances, each with its own memory. Per IP only: a per-email
      // limit would let anyone lock the owner out.
      await store.hit('auth:' + ip, 30);
      const b = await body(req);
      if (path === 'auth/login') {
        const data = z.object({email:z.email(),password:z.string().min(1).max(128)}).parse(b);
        return authenticated(await store.login(data.email, data.password));
      }
      if (path === 'auth/accept') {
        const data = z.object({token:tokenField,password}).parse(b);
        return authenticated(await store.acceptInvite(data.token, data.password));
      }
      if (path === 'auth/reset') {
        const data = z.object({token:tokenField,password}).parse(b);
        return authenticated(await store.resetPassword(data.token, data.password));
      }
      if (path === 'auth/logout') {
        if (session) await store.logout(session);
        const response = json({ ok: true });
        response.cookies.set('wasl_session', '', {httpOnly:true,sameSite:'strict',path:'/',maxAge:0});
        return response;
      }
    }
    const user = await store.session(session);
    rateLimit(user.id, 120);
    // Members see no data and spend no credits before accepting the terms (the UI gate alone is not enough).
    if (user.role === 'member' && !user.terms_accepted_at && path !== 'bootstrap' && path !== 'terms') throw new AppError('وافق على شروط الاستخدام أولًا.', 403);
    if (req.method === 'GET' && path === 'bootstrap') {
      const view=z.enum(['overview','full']).parse(req.nextUrl.searchParams.get('view')||'overview');
      if(view==='full') return json({...await store.snapshot(user.id),provider:providerInfo()});
      const raw=req.nextUrl.searchParams.get('days');
      let days: string[] | undefined;
      if(raw!==null) {
        if(raw.length>512) throw new AppError('الفترة الزمنية غير صالحة.');
        let parsed: unknown;
        try {parsed=JSON.parse(raw);} catch {throw new AppError('الفترة الزمنية غير صالحة.');}
        days=weekBoundariesSchema.parse(parsed);
      }
      return json({...await store.overview(user.id,days),provider:providerInfo()});
    }
    if (req.method !== 'POST') throw new AppError('الصفحة المطلوبة غير موجودة.', 404);
    const b = await body(req);
    if (path === 'search') {
      const input = searchSchema.parse(withCountries(b)); // a page opened before multi-country still searches
      rateLimit('search:' + user.id, 20);
      if (!providerInfo().configured) throw new AppError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.',503);
      return json(await new LiveSearch(store).start(user.id,await resolveAudience(store,input)));
    }
    if (path === 'search/count') {
      const input = searchSchema.pick({ mode:true, sector:true, countries:true, city:true, title:true, size:true }).parse(withCountries(b));
      rateLimit('count:' + user.id, 60); // ponytail: in-memory, like the other limits; each call is 2 free provider requests, plus one paid AI call per new «أخرى» text (then cached)
      if (!providerInfo().configured) throw new AppError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.',503);
      if (user.balance < 1) throw new AppError('رصيدك صفر. تواصل مع مالك المنصة لإضافة رصيد قبل البحث.'); // no paid AI mapping for a search that cannot run
      const audience = await resolveAudience(store,input); // «أخرى» is mapped here, so the member sees what will be searched
      return json({...await new IcypeasClient().count(audience),industryLabels:audience.industryLabels});
    }
    if (path === 'search/poll') {
      const {searchId}=z.object({searchId:z.string().uuid()}).parse(b);
      return json(await new LiveSearch(store).poll(user.id,searchId));
    }
    if (path === 'provider/verify') {
      await store.admin(user.id);
      return json(await new IcypeasClient().verify());
    }
    if (path === 'export') {
      const options = z.object({ ids:z.array(z.string().uuid()).min(1).max(1000).optional(), searchId:z.string().uuid().optional() }).parse(b);
      const contacts = await store.contactsForExport(user.id, options.ids, options.searchId);
      return new NextResponse(contactsCsv(contacts), {headers:{ 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="clowzy-contacts.csv"', 'Cache-Control':'no-store' }});
    }
    if (path === 'terms') {
      await store.acceptTerms(user.id);
      return json({ok:true});
    }
    if (path === 'profile') {
      const data = z.object({name:z.string().trim().min(2).max(60)}).parse(b);
      await store.updateProfile(user.id, data.name);
      return json({ok:true});
    }
    if (path === 'password') {
      const data = z.object({current:z.string().min(1).max(128),password}).parse(b);
      return authenticated(await store.changePassword(user.id, data.current, data.password));
    }
    if (path.startsWith('admin/')) await store.admin(user.id);
    if (path === 'admin/invite') {
      const data = z.object({name:z.string().trim().min(2).max(60),email:z.email(),credits:z.number().int().min(0).max(100000)}).parse(b);
      return json(await store.invite(user.id, data.name, data.email, data.credits));
    }
    if (path === 'admin/credits') {
      const data = z.object({userId:z.string().uuid(),mode:z.enum(['add','set']),amount:z.number().int().min(0).max(100000),reason:z.string().trim().min(3).max(200),requestId:z.string().uuid()}).parse(b);
      await store.adjustCredits(user.id, data.userId, data.mode, data.amount, data.reason, data.requestId);
      return json({ok:true});
    }
    if (path === 'admin/status') {
      const data = z.object({userId:z.string().uuid(),active:z.boolean()}).parse(b);
      await store.setActive(user.id, data.userId, data.active);
      return json({ok:true});
    }
    if (path === 'admin/reset') {
      const data = z.object({userId:z.string().uuid()}).parse(b);
      return json({token:await store.createReset(user.id,data.userId)});
    }
    throw new AppError('العملية المطلوبة غير موجودة.', 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({error:['/api/search','/api/search/count'].includes(req.nextUrl.pathname)?'راجع البيانات المدخلة، وتأكد من تأكيد معايير البحث.':'راجع البيانات المدخلة.'},400);
    if (error instanceof IcypeasError) return json({error:error.message},error.status);
    if (error instanceof AppError) {
      // Denials must be visible in the server log: a wrong APP_URL would otherwise reject every user silently.
      if ([403,413,415,429,503].includes(error.status)) console.warn('API denied', error.status, req.method, req.nextUrl.pathname, error.message);
      return json({error:error.message},error.status);
    }
    console.error('Local API failure:', error instanceof Error ? error.message : 'unknown');
    return json({error:'حدث خطأ غير متوقع. حاول مجددًا.'},500);
  }
}
export { handle as GET, handle as POST };
