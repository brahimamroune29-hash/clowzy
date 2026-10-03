import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, getStore } from '@/lib/store';
import { TERMS_VERSION, termsCurrent, withCountries } from '@/lib/contracts';
import { assistRequestSchema, registrationEmail, searchSchema, weekBoundariesSchema } from '@/lib/schemas';
import { IcypeasClient, IcypeasError, providerInfo } from '@/lib/icypeas';
import { LiveSearch } from '@/lib/live-search';
import { searchTick, workerAuthorized } from '@/lib/search-worker';
import { audienceOf, resolveAudience } from '@/lib/audience';
import { contactsCsv, crmCsv, exportColumns } from '@/lib/csv';
import { accessError, bodyLimit, clientIp, isHttps } from '@/lib/access';
import { assist } from '@/lib/ai';
import { englishBody } from '@/lib/en';
import { crmEnabled } from '@/lib/catalog';
import { crmState, crmAction, crmOperations, approveDeletion, requireCrm } from '@/lib/crm';
import {coverageReport} from '@/lib/coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A search call can wait on the provider (20 s per request) and then submit a paid batch: never cut it off at a short platform default.
export const maxDuration = 60;
const password = z.string().min(10).max(128);
const tokenField = z.string().regex(/^[a-f0-9]{48}$/);
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
function authenticated(token: string, data: object = { ok: true }) {
  const response = json(data);
  response.cookies.set('wasl_session', token, { httpOnly: true, sameSite: 'strict', secure: isHttps(process.env.APP_URL), path: '/', maxAge: 7 * 86400 });
  return response;
}
async function answer(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await params).path.join('/');
    // Vercel may invoke the deployment hostname. The cron authenticates with its server secret, not a browser origin/cookie.
    if (path === 'cron/search' || path === 'cron/health') {
      if (req.method !== 'GET' || !workerAuthorized(req.headers.get('authorization'))) return json({ error: 'Unauthorized' }, 401);
      if (path === 'cron/health') {
        // An answering homepage does not prove abandoned searches are still progressing. Counts only: no member data.
        const state = await getStore().db.get<{pending:number;stale:number}>(`SELECT count(*)::int pending,
          count(*) FILTER (WHERE COALESCE(r.updated_at,extract(epoch FROM s.created_at::timestamptz)*1000) < ?)::int stale
          FROM searches s JOIN users u ON u.id=s.user_id LEFT JOIN provider_runs r ON r.search_id=s.id
          WHERE s.status IN ('queued','awaiting_provider') AND u.active=1`, Date.now()-30*60000);
        const ok = crmEnabled() && !!state && state.stale === 0;
        return json({ok,...state},ok?200:503);
      }
      return json({ handled: await searchTick(getStore()) });
    }
    guard(req);
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
        const data = z.object({token:tokenField,password,email:registrationEmail.optional(),termsVersion:z.literal(TERMS_VERSION).optional()}).parse(b);
        return authenticated(await store.acceptInvite(data.token, data.password, data.email, data.termsVersion===TERMS_VERSION));
      }
      if (path === 'auth/reset') {
        const data = z.object({token:tokenField,password}).parse(b);
        return authenticated(await store.resetPassword(data.token, data.password));
      }
      if (path === 'auth/recover') {
        const data = z.object({email:z.email(),code:z.string().min(1).max(64),password}).parse(b);
        const { token, code } = await store.recover(data.email, data.code, data.password);
        return authenticated(token, { ok: true, code });
      }
      if (path === 'auth/logout') {
        if (session) await store.logout(session);
        const response = json({ ok: true });
        response.cookies.set('wasl_session', '', {httpOnly:true,sameSite:'strict',path:'/',maxAge:0});
        return response;
      }
    }
    const user = await store.session(session);
    await store.hit('api:' + user.id, 120);
    // Members see no data and spend no credits before accepting the current terms (the UI gate alone is not enough):
    // the page gets the account alone, to show the terms.
    if (user.role === 'member' && !termsCurrent(user)) {
      if (req.method === 'GET' && path === 'bootstrap') return json({ user, contacts: [], searches: [], ledger: [], exports: [] });
      if (path !== 'terms') throw new AppError('وافق على شروط الاستخدام أولًا.', 403);
    }
    if (req.method === 'GET' && path === 'crm') return json(await crmState(store,user.id));
    if (req.method === 'GET' && path === 'admin/crm') return json(await crmOperations(store,user.id));
    if(req.method==='GET'&&path==='admin/coverage')return json(await coverageReport(store,user.id,z.string().uuid().parse(req.nextUrl.searchParams.get('searchId'))));
    if (req.method === 'GET' && path === 'bootstrap') {
      const reserved=await store.reserved(user.id);
      const features={crm:crmEnabled()},wallet=(balance:number)=>({total:balance,reserved,available:Math.max(0,balance-reserved)});
      const view=z.enum(['overview','full']).parse(req.nextUrl.searchParams.get('view')||'overview');
      if(view==='full') { const snapshot=await store.snapshot(user.id);return json({...snapshot,provider:providerInfo(),features,wallet:wallet(snapshot.user.balance)}); }
      const raw=req.nextUrl.searchParams.get('days');
      let days: string[] | undefined;
      if(raw!==null) {
        if(raw.length>512) throw new AppError('الفترة الزمنية غير صالحة.');
        let parsed: unknown;
        try {parsed=JSON.parse(raw);} catch {throw new AppError('الفترة الزمنية غير صالحة.');}
        days=weekBoundariesSchema.parse(parsed);
      }
      const snapshot=await store.overview(user.id,days);
      return json({...snapshot,provider:providerInfo(),features,wallet:wallet(snapshot.user.balance)});
    }
    if (req.method !== 'POST') throw new AppError('الصفحة المطلوبة غير موجودة.', 404);
    const b = await body(req);
    if(path.startsWith('crm/')) return json(await crmAction(store,user.id,path.slice(4),b));
    if(path==='admin/crm/delete') return json(await approveDeletion(store,user.id,b));
    if (path === 'search') {
      const input = searchSchema.parse(withCountries(b)); // a page opened before multi-country still searches
      await store.hit('search:' + user.id, 20);
      if (!providerInfo().configured) throw new AppError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.',503);
      const old = await store.db.get<{ filters: string }>('SELECT filters FROM searches WHERE user_id=? AND request_id=?', user.id, input.requestId);
      if (old) {
        if (JSON.stringify(searchSchema.parse(JSON.parse(old.filters))) !== JSON.stringify(input)) throw new AppError('معرّف الطلب مستخدم لبحث مختلف.', 409);
        return json(await new LiveSearch(store).start(user.id, audienceOf(old.filters)));
      }
      const live = new LiveSearch(store);
      await live.recoverStale(user.id);
      await store.checkSearchCapacity(user.id, input.count); // before any paid AI; enqueue rechecks under the wallet lock
      return json(await live.start(user.id,await resolveAudience(store,input,undefined,user.id)));
    }
    if (path === 'search/count') {
      const input = searchSchema.pick({ mode:true, sector:true, countries:true, city:true, title:true, size:true }).parse(withCountries(b));
      await store.hit('count:' + user.id, 60); // Shared across server instances, before any provider or AI call.
      if (!providerInfo().configured) throw new AppError('مزوّد البيانات غير مهيأ على الخادم. تواصل مع مالك المنصة.',503);
      await store.checkSearchCapacity(user.id, 1);
      const audience = await resolveAudience(store,input,undefined,user.id); // «أخرى» is mapped here, so the member sees what will be searched
      return json({...await new IcypeasClient().count(audience),industryLabels:audience.industryLabels,industries:audience.industries});
    }
    if (path === 'assist') {
      const {messages,context}=assistRequestSchema.parse(b);
      // About $0.002 a message, at most ~$0.012: 12 a minute and 150 a day per member bound one account to ~$2 a day.
      await store.aiBudget(user.id);
      return json(await assist(messages, req.headers.get('x-lang') === 'en' ? 'en' : 'ar', context).catch(e => {
        console.warn('Assistant failed:', e instanceof Error ? e.message : 'unknown');
        throw new AppError('المساعد غير متاح الآن. حاول بعد قليل.', 503);
      }));
    }
    if (path === 'search/poll') {
      const {searchId}=z.object({searchId:z.string().uuid()}).parse(b);
      return json(await new LiveSearch(store).poll(user.id,searchId));
    }
    if (path === 'provider/verify') {
      await store.admin(user.id);
      return json(await new IcypeasClient().verify());
    }
    if (path === 'export' || path === 'export/preview') {
      const options = z.object({ ids:z.array(z.string().uuid()).min(1).max(1000).optional(), searchId:z.string().uuid().optional(),profile:z.enum(['generic','gohighlevel']).optional(),columns:z.array(z.enum(exportColumns)).min(1).max(exportColumns.length).refine(c=>new Set(c).size===c.length).optional() }).parse(b);
      if(options.profile||options.columns||path==='export/preview') requireCrm();
      if(options.profile==='gohighlevel'&&options.columns&&!options.columns.includes('email')) throw new AppError('تصدير GoHighLevel يتطلب عمود البريد.');
      const contacts = await store.contactsForExport(user.id, options.ids, options.searchId,false);
      if((options.profile||options.columns)&&contacts.length>1000) throw new AppError('التصدير المخصص محدود بألف عميل. حدد العملاء أولًا.');
      const meta=options.profile||options.columns?await store.db.all<{contact_id:string;stage:string;tags:string[];notes:string}>('SELECT contact_id,stage,tags,notes FROM crm_meta WHERE user_id=?',user.id):[];
      const byId=new Map(meta.map(m=>[m.contact_id,m]));
      const rows=(path==='export/preview'?contacts.slice(0,5):contacts).map(c=>({...c,...byId.get(c.id)}));
      const csv=options.profile||options.columns?crmCsv(rows,options.columns||['name','email','company','title','city','country'],options.profile||'generic'):contactsCsv(rows);
      if(path==='export/preview') return json({rowCount:contacts.length,preview:csv});
      await store.contactsForExport(user.id,contacts.map(c=>c.id));
      return new NextResponse(csv, {headers:{ 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="clowzy-contacts.csv"', 'Cache-Control':'no-store' }});
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
      const data = z.object({name:z.string().trim().min(2).max(60),email:registrationEmail.optional(),credits:z.number().int().min(0).max(100000)}).parse(b);
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
    if (path === 'admin/recovery-code') {
      const data = z.object({password:z.string().min(1).max(128)}).parse(b);
      return json({code:await store.createRecoveryCode(user.id,data.password)});
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
// The page's language (x-lang, src/lib/client.ts): an English page gets the errors and search messages in English.
async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const res = await answer(req, context);
  if (req.headers.get('x-lang') !== 'en' || !res.headers.get('content-type')?.includes('json')) return res;
  const headers = new Headers(res.headers); headers.delete('content-length');
  return new NextResponse(JSON.stringify(englishBody(await res.json())), { status: res.status, headers });
}
export { handle as GET, handle as POST };
