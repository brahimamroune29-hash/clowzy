'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { EnvelopeSimple } from '@phosphor-icons/react';
import { api } from '@/lib/client';
import { TERMS_VERSION } from '@/lib/contracts';
import { Brand, Button, Field, Notice, ThemeToggle } from './ui';
import { LangToggle, useT } from './lang';
// owner: the handover link (scripts/owner-handover.ts), where the new owner sets the sign-in email and password.
export default function Auth({onLogin,token,reset=false,owner=false}:{onLogin:()=>Promise<void>;token?:string;reset?:boolean;owner?:boolean}) {
  const t=useT(),link=reset||owner; // a one-time password link, not an invitation
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[help,setHelp]=useState(false);
  // The owner's recovery code (settings): email + code + a new password, then the replacement code, shown once.
  const [recovering,setRecovering]=useState(false),[code,setCode]=useState(''),[newCode,setNewCode]=useState('');
  const fresh=!!token||recovering; // choosing a new password
  const [invitation,setInvitation]=useState<{name:string;email:string}|null>(null);
  const [agreed,setAgreed]=useState(false);
  const [gone,setGone]=useState(false); // the server said this link is no longer valid (410)
  const dead=gone||(!!token&&!link&&!invitation&&!!error); // expired, used, replaced or broken link: nothing to submit
  useEffect(()=>{if(token&&!link)api<{name:string;email:string}>('invitation?token='+encodeURIComponent(token)).then(setInvitation).catch(e=>setError(e.message));},[token,link]);
  async function submit(e:React.FormEvent) {
    e.preventDefault(); if(token&&!link&&!agreed)return; setBusy(true); setError('');
    try {
      if(recovering){setNewCode((await api<{code:string}>('auth/recover',{email,code,password})).code);return;}
      if(owner){await api('auth/owner',{token,email,password});await onLogin();return;}
      await api(token?(reset?'auth/reset':'auth/accept'):'auth/login', token?{token,password,...(!reset?{email:invitation?.email||email,termsVersion:TERMS_VERSION}:{})}:{email,password}); await onLogin();
    }
    catch(e){setError((e as Error).message);if(token&&(e as {status?:number}).status===410)setGone(true);} finally {setBusy(false);}
  }
  const title=owner?t('حساب مالك المنصة','Platform owner account'):recovering?t('استرجاع كلمة المرور','Recover your password'):token?(reset?t('كلمة مرور جديدة','A new password'):t('أهلًا بك','Welcome')):t('تسجيل الدخول','Sign in');
  const lead=owner&&!dead?t('اختر البريد وكلمة المرور اللي تدخل فيها لوحة المالك.','Choose the email and password you will use to sign in to the owner dashboard.'):recovering?(newCode?t('تغيّرت كلمة المرور، ودخلت إلى حسابك.','Your password is changed and you are signed in.'):t('اكتب بريدك ورمز الاسترجاع، واختر كلمة مرور جديدة.','Enter your email and recovery code, and choose a new password.')):token?(dead?t('هذا الرابط لم يعد صالحًا.','This link is no longer valid.'):reset?t('اختر كلمة مرور جديدة.','Choose a new password.'):invitation?(invitation.email?t('أهلًا '+invitation.name+'، اختر كلمة مرورك وابدأ.','Hi '+invitation.name+', choose your password to start.'):t('أهلًا '+invitation.name+'، أدخل بريدك واختر كلمة مرورك.','Hi '+invitation.name+', enter your email and choose your password.')):t('نتحقق من دعوتك…','Checking your invitation…')):t('ادخل إلى مساحتك وابدأ البحث عن عملائك.','Sign in and start finding your clients.');
  return <main className="auth">
    <div className="auth-tools"><LangToggle/><ThemeToggle/></div>
    <section className="auth-card"><Brand/><h1>{title}</h1><p>{lead}</p>
      {newCode?<div className="form-stack"><Notice>{t('هذا رمز الاسترجاع الجديد، والقديم توقف. احفظه الآن في مكان آمن: لن يظهر مرة أخرى.','This is your new recovery code; the old one no longer works. Save it somewhere safe now: it will not be shown again.')}</Notice><Field label={t('رمز الاسترجاع الجديد','New recovery code')}><input readOnly dir="ltr" value={newCode} onFocus={e=>e.target.select()}/></Field><Button onClick={onLogin}>{t('حفظته، تابع','Saved it, continue')}</Button></div>:
      dead?<div className="form-stack"><Notice error>{error}</Notice><p>{link?t('اطلب رابطًا جديدًا من مالك المنصة.','Ask the platform owner for a new link.'):t('اطلب دعوة جديدة من مالك المنصة. إن كان لديك حساب، سجّل الدخول.','Ask the platform owner for a new invitation. If you have an account, sign in.')}</p><Link href="/" className="button secondary">{t('تسجيل الدخول','Sign in')}</Link></div>:
      <form onSubmit={submit} className="form-stack">
        {error&&<Notice error>{error}</Notice>}
        {(!token||owner||(invitation&&!invitation.email))&&<Field label={t('البريد الإلكتروني','Email')}><input autoComplete="email" type="email" dir="ltr" maxLength={254} placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)} required/></Field>}
        {invitation?.email&&<div className="invited-email"><EnvelopeSimple size={20}/><span dir="ltr">{invitation.email}</span></div>}
        {recovering&&<Field label={t('رمز الاسترجاع','Recovery code')}><input dir="ltr" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" maxLength={64} value={code} onChange={e=>setCode(e.target.value)} required/></Field>}
        <Field label={fresh?t('كلمة مرور جديدة','New password'):t('كلمة المرور','Password')} hint={fresh?t('10 أحرف على الأقل.','At least 10 characters.'):''}><input autoComplete={fresh?'new-password':'current-password'} type="password" minLength={fresh?10:undefined} maxLength={128} placeholder="••••••••••" value={password} onChange={e=>setPassword(e.target.value)} required/></Field>
        {invitation&&!reset&&<label className="check-label"><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} required/><span>{t('أوافق على','I agree to the')} <Link href="/terms" target="_blank" rel="noopener noreferrer">{t('شروط الاستخدام','terms of use')}</Link></span></label>}
        {!token&&!recovering&&<button type="button" className="text-button" onClick={()=>setHelp(!help)}>{t('نسيت كلمة المرور؟','Forgot your password?')}</button>}
        {help&&!recovering&&<Notice>{t('اطلب من مالك المنصة رابط استعادة من صفحة المشتركين.','Ask the platform owner for a reset link from the members page.')} <button type="button" className="text-button" onClick={()=>{setRecovering(true);setError('');setPassword('');}}>{t('مالك المنصة؟ استخدم رمز الاسترجاع','Platform owner? Use your recovery code')}</button></Notice>}
        <Button loading={busy} type="submit" disabled={!!token&&!link&&(!invitation||!agreed)}>{owner?t('حفظ والدخول','Save and sign in'):recovering?t('تغيير كلمة المرور','Change password'):token?(reset?t('تغيير كلمة المرور','Change password'):t('إنشاء الحساب والدخول','Create account and sign in')):t('دخول','Sign in')}</Button>
        {recovering&&<button type="button" className="text-button" onClick={()=>{setRecovering(false);setError('');}}>{t('رجوع لتسجيل الدخول','Back to sign in')}</button>}
      </form>}
      <small className="auth-foot">{t('الدخول بالدعوة فقط.','By invitation only.')} <Link href="/terms">{t('شروط الاستخدام','Terms of use')}</Link></small>
    </section>
  </main>;
}
