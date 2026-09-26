import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, getStore } from '@/lib/store';
import { searchSchema } from '@/lib/contracts';
import { suggestFilters } from '@/lib/demo-provider';
import { FullEnrichClient, FullEnrichError, providerInfo } from '@/lib/fullenrich';
import { LiveSearch } from '@/lib/live-search';
import { contactsCsv } from '@/lib/csv';
import { weekBoundariesSchema } from '@/lib/overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
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
function guard(request: NextRequest) {
  const host = request.headers.get('host')?.split(':')[0];
  if (process.env.APP_MODE !== 'demo' || !['127.0.0.1', 'localhost'].includes(host || '')) {
    throw new AppError('المعاينة المحلية فقط. إعداد الإنتاج غير مفعّل.', 503);
  }
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== request.headers.get('host')) throw new AppError('مصدر الطلب غير مسموح.', 403);
    if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError('صيغة الطلب غير صحيحة.', 415);
  }
}
async function body(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 16000) throw new AppError('الطلب أكبر من الحد المسموح.', 413);
  try { return JSON.parse(raw); } catch { throw new AppError('تعذّر قراءة الطلب.'); }
}
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function authenticated(token: string) {
  const response = json({ ok: true });
  response.cookies.set('wasl_session', token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/', maxAge: 7 * 86400 });
  return response;
}
async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    guard(req);
    const path = (await params).path.join('/');
    const store = getStore();
    const session = req.cookies.get('wasl_session')?.value;
    if (req.method === 'GET' && path === 'invitation') return json(store.invitation(tokenField.parse(req.nextUrl.searchParams.get('token'))));
    if (req.method === 'POST' && path.startsWith('auth/')) {
      rateLimit('auth:' + (req.headers.get('host') || ''), 30);
      const b = await body(req);
      if (path === 'auth/demo') {
        const { role } = z.object({ role: z.enum(['member','admin']) }).parse(b);
        return authenticated(store.demoSession(role));
      }
      if (path === 'auth/login') {
        const data = z.object({email:z.email(),password:z.string().min(1).max(128)}).parse(b);
        return authenticated(store.login(data.email, data.password));
      }
      if (path === 'auth/accept') {
        const data = z.object({token:tokenField,password}).parse(b);
        return authenticated(store.acceptInvite(data.token, data.password));
      }
      if (path === 'auth/reset') {
        const data = z.object({token:tokenField,password}).parse(b);
        return authenticated(store.resetPassword(data.token, data.password));
      }
      if (path === 'auth/logout') {
        if (session) store.logout(session);
        const response = json({ ok: true });
        response.cookies.set('wasl_session', '', {httpOnly:true,sameSite:'strict',path:'/',maxAge:0});
        return response;
      }
    }
    const user = store.session(session);
    rateLimit(user.id, 120);
    if (req.method === 'GET' && path === 'bootstrap') {
      const view=z.enum(['overview','full']).parse(req.nextUrl.searchParams.get('view')||'overview');
      if(view==='full') return json({...store.snapshot(user.id),provider:providerInfo()});
      const raw=req.nextUrl.searchParams.get('days');
      let days: string[] | undefined;
      if(raw!==null) {
        if(raw.length>512) throw new AppError('الفترة الزمنية غير صالحة.');
        let parsed: unknown;
        try {parsed=JSON.parse(raw);} catch {throw new AppError('الفترة الزمنية غير صالحة.');}
        days=weekBoundariesSchema.parse(parsed);
      }
      return json({...store.overview(user.id,days),provider:providerInfo()});
    }
    if (req.method !== 'POST') throw new AppError('الصفحة المطلوبة غير موجودة.', 404);
    const b = await body(req);
    if (path === 'search') {
      const input = searchSchema.parse(b);
      rateLimit('search:' + user.id, 20);
      if (!providerInfo().configured) throw new AppError('أضف مفتاح FullEnrich إلى .env.local ثم أعد تشغيل المنصة.',503);
      return json(await new LiveSearch(store).start(user.id,input));
    }
    if (path === 'search/poll') {
      const {searchId}=z.object({searchId:z.string().uuid()}).parse(b);
      return json(await new LiveSearch(store).poll(user.id,searchId));
    }
    if (path === 'provider/verify') {
      store.admin(user.id);
      return json(await new FullEnrichClient().verify());
    }
    if (path === 'assistant') {
      rateLimit('assistant:' + user.id, 15);
      const { description } = z.object({ description:z.string().trim().min(8).max(2000) }).parse(b);
      return json(suggestFilters(description));
    }
    if (path === 'export') {
      const options = z.object({ ids:z.array(z.string().uuid()).min(1).max(1000).optional(), searchId:z.string().uuid().optional() }).parse(b);
      const contacts = store.contactsForExport(user.id, options.ids, options.searchId);
      return new NextResponse(contactsCsv(contacts), {headers:{ 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="clowzy-contacts.csv"', 'Cache-Control':'no-store' }});
    }
    if (path === 'profile') {
      const data = z.object({name:z.string().trim().min(2).max(60)}).parse(b);
      store.updateProfile(user.id, data.name);
      return json({ok:true});
    }
    if (path === 'password') {
      const data = z.object({current:z.string().min(1).max(128),password}).parse(b);
      return authenticated(store.changePassword(user.id, data.current, data.password));
    }
    if (path.startsWith('admin/')) store.admin(user.id);
    if (path === 'admin/invite') {
      const data = z.object({name:z.string().trim().min(2).max(60),email:z.email(),credits:z.number().int().min(0).max(100000)}).parse(b);
      return json(store.invite(user.id, data.name, data.email, data.credits));
    }
    if (path === 'admin/credits') {
      const data = z.object({userId:z.string().uuid(),mode:z.enum(['add','set']),amount:z.number().int().min(0).max(100000),reason:z.string().trim().min(3).max(200),requestId:z.string().uuid()}).parse(b);
      store.adjustCredits(user.id, data.userId, data.mode, data.amount, data.reason, data.requestId);
      return json({ok:true});
    }
    if (path === 'admin/status') {
      const data = z.object({userId:z.string().uuid(),active:z.boolean()}).parse(b);
      store.setActive(user.id, data.userId, data.active);
      return json({ok:true});
    }
    if (path === 'admin/reset') {
      const data = z.object({userId:z.string().uuid()}).parse(b);
      return json({token:store.createReset(user.id,data.userId)});
    }
    throw new AppError('العملية المطلوبة غير موجودة.', 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({error:'راجع البيانات المدخلة، وتأكد من تأكيد معايير البحث.'},400);
    if (error instanceof FullEnrichError) return json({error:error.message},502);
    if (error instanceof AppError) return json({error:error.message},error.status);
    console.error('Local API failure:', error instanceof Error ? error.message : 'unknown');
    return json({error:'حدث خطأ غير متوقع. حاول مجددًا.'},500);
  }
}
export { handle as GET, handle as POST };
