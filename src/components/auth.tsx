'use client';
import { useEffect,useState } from 'react';
import { ArrowLeft, Check, LockKey, Sparkle, UsersThree, EnvelopeSimple } from '@phosphor-icons/react';
import { api } from '@/lib/client';
import { Brand, Button, Field, Notice } from './ui';
export default function Auth({onLogin,token,reset=false}:{onLogin:()=>Promise<void>;token?:string;reset?:boolean}) {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[help,setHelp]=useState(false);
  const [invitation,setInvitation]=useState<{name:string;email:string}|null>(null);
  useEffect(()=>{if(token&&!reset)api<{name:string;email:string}>('invitation?token='+encodeURIComponent(token)).then(setInvitation).catch(e=>setError(e.message));},[token,reset]);
  async function submit(e:React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(token?(reset?'auth/reset':'auth/accept'):'auth/login', token?{token,password}:{email,password}); await onLogin(); }
    catch(e){setError((e as Error).message);} finally {setBusy(false);}
  }
  async function demo(role:string) {
    setBusy(true);setError('');
    try{await api('auth/demo',{role});await onLogin();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <main className="auth-layout">
    <section className="auth-form-side"><Brand/><div className="auth-content">
      <span className="eyebrow"><span className="tiny-dot"/> منصتك الخاصة لاكتشاف الفرص</span>
      <h1>{token?(reset?'بداية جديدة لحسابك.':'أهلًا بك في clowzy.'):'علاقات جديدة،\nفرص أكبر.'}</h1>
      <p className="auth-description">{token?(reset?'اختر كلمة مرور جديدة لاستعادة الوصول.':invitation?'أهلًا '+invitation.name+'، عيّن كلمة مرورك وابدأ رحلتك.':'جارٍ التحقق من دعوتك…'):'ادخل إلى مساحة عملك، وحدد جمهورك، وابدأ بناء قائمة عملائك القادمين.'}</p>
      <form onSubmit={submit} className="form-stack">
        {error&&<Notice error>{error}</Notice>}
        {!token&&<Field label="البريد الإلكتروني"><input autoComplete="email" type="email" dir="ltr" placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)} required/></Field>}
        {invitation&&<div className="invited-email"><EnvelopeSimple size={20}/><span dir="ltr">{invitation.email}</span></div>}
        <Field label={token?'كلمة مرور جديدة':'كلمة المرور'} hint={token?'10 أحرف على الأقل.':''}><input autoComplete={token?'new-password':'current-password'} type="password" minLength={token?10:undefined} maxLength={128} placeholder="••••••••••" value={password} onChange={e=>setPassword(e.target.value)} required/></Field>
        {!token&&<button type="button" className="text-button forget" onClick={()=>setHelp(!help)}>نسيت كلمة المرور؟</button>}
        {help&&<Notice>اطلب من مالك المنصة رابط استعادة الوصول من صفحة المشتركين. إرسال البريد الآلي غير متصل في هذه المعاينة.</Notice>}
        <Button loading={busy} type="submit" arrow disabled={!!token&&!reset&&!invitation}>{token?'تفعيل الوصول':'تسجيل الدخول'}</Button>
      </form>
      {!token&&<div className="demo-access"><div className="divider-label"><span/>جرّب النسخة المحلية<span/></div><div className="demo-buttons"><Button variant="secondary" loading={busy} onClick={()=>demo('member')}>دخول كمشترك <ArrowLeft size={16}/></Button><Button variant="ghost" loading={busy} onClick={()=>demo('admin')}>لوحة الأونر <ArrowLeft size={16}/></Button></div><small>حسابات محلية للتجربة. البحث الحقيقي يتاح عند إضافة مفتاح FullEnrich، وقد يستهلك رصيد المزود.</small></div>}
    </div><div className="auth-footer"><LockKey size={16}/><span>مساحة خاصة. الدخول متاح بالدعوة.</span><span className="version">clowzy / 01</span></div></section>
    <section className="auth-art"><div className="art-top"><span>ابدأ بالعميل المناسب</span><span>clowzy / WORKSPACE</span></div>
      <div className="connection-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="art-core"><CirclesLogo/></div>
        <div className="floating-card float-one"><span className="small-icon"><UsersThree size={23}/></span><div><strong>جمهور يناسب خدمتك</strong><small>استهداف واضح، من البداية</small></div><span className="card-check"><Check size={14}/></span></div>
        <div className="floating-card float-two"><span className="small-icon"><Sparkle size={23}/></span><div><strong>من الفكرة إلى أول قائمة</strong><small>مسار واحد، خطوات بسيطة</small></div></div>
        <span className="orbit-dot dot-one"/><span className="orbit-dot dot-two"/>
      </div><div className="art-bottom"><span className="eyebrow">كل علاقة تبدأ بفرصة</span><h2>اعثر على من يحتاج<br/>ما تقدّمه.</h2><p>بحث أذكى، قوائم مرتبة، ومساحة واحدة<br/>تجمع فرصك القادمة.</p></div><div className="art-foot"><span>مصمم ليبقى تركيزك على عملائك.</span><span>01 — 03</span></div>
    </section>
  </main>;
}
function CirclesLogo(){return <span className="art-logo" aria-hidden="true">c</span>;}
