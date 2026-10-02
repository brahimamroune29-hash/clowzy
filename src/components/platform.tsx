'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { usePathname,useRouter,useSearchParams } from 'next/navigation';
import { Coins, GearSix, List, SignOut, X, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { termsCurrent, type Snapshot } from '@/lib/contracts';
import { api,number } from '@/lib/client';
import { overviewOnly,weekBoundaries } from '@/lib/overview';
import { Brand, Button, Notice, ThemeToggle } from './ui';
import { LangToggle, useT } from './lang';
import Auth from './auth';
import { TermsGate, TermsPage } from './terms';
import { Dashboard, SearchView, LeadsView, HistoryView, CreditsView, SettingsView } from './member-views';
import { AdminDashboard, MembersView, ActivityView } from './admin-views';
import { Assistant } from './assistant';
import { CrmView, CrmOperations } from './crm-views';
export type ViewProps = {data:Snapshot;reload:()=>Promise<void>;notify:(message:string,error?:boolean)=>void};
export default function Platform(){
  const t=useT();
  const [data,setData]=useState<Snapshot|null>(null),[loading,setLoading]=useState(true),[menu,setMenu]=useState(false),[toast,setToast]=useState<{message:string;error:boolean}|null>(null);
  const pathname=usePathname(),query=useSearchParams(),router=useRouter();
  // Only a 401 signs the user out; any other failure (network, a paused database, a redeploy) keeps the page and says so.
  const [failure,setFailure]=useState('');
  const failed=useCallback((e:unknown)=>{const signedOut=(e as {status?:number}).status===401;if(signedOut)setData(null);setFailure(signedOut?'':(e as Error).message);},[]);
  const requestPath=overviewOnly(pathname)?'bootstrap?view=overview&days='+encodeURIComponent(JSON.stringify(weekBoundaries())):'bootstrap?view=full';
  const [loadedPath,setLoadedPath]=useState('');
  const requestVersion=useRef(0);
  const refresh=useCallback(async()=>{
    const version=++requestVersion.current;
    try {const value=await api<Snapshot>(requestPath);if(version===requestVersion.current){setData(value);setFailure('');setLoadedPath(requestPath);}}
    catch(e){if(version===requestVersion.current)failed(e);}
    finally {if(version===requestVersion.current)setLoading(false);}
  },[requestPath,failed]);
  useEffect(()=>{
    const version=++requestVersion.current;
    let active=true;
    api<Snapshot>(requestPath).then(value=>{if(active&&version===requestVersion.current){setData(value);setFailure('');setLoadedPath(requestPath);}})
      .catch(e=>{if(active&&version===requestVersion.current){failed(e);if((e as {status?:number}).status===401)setLoadedPath(requestPath);}})
      .finally(()=>{if(active&&version===requestVersion.current)setLoading(false);});
    return()=>{active=false;};
  },[requestPath,failed]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),5000);return()=>clearTimeout(timer);},[toast]);
  const notify=(message:string,error=false)=>setToast({message,error});
  async function onLogin(){await refresh();router.replace('/dashboard');}
  async function logout(){requestVersion.current++;await api('auth/logout',{});setData(null);setFailure('');router.replace('/');}
  async function logoutFromMenu(){try{await logout();}catch(e){notify((e as Error).message,true);}}
  const token=query.get('token')||undefined;
  if(pathname==='/terms')return <TermsPage/>;
  // A page whose data did not load (network, paused database, redeploy): say so and retry; never show another page's data.
  if(!loading&&failure&&loadedPath!==requestPath)return <div className="boot"><Brand/><p>{failure}</p><Button variant="secondary" onClick={()=>{setLoading(true);void refresh();}}>{t('إعادة المحاولة','Try again')}</Button></div>;
  if(loading||loadedPath!==requestPath)return <div className="boot"><Brand/><p>{t('نجهّز مساحة عملك…','Preparing your workspace…')}</p><span className="loading-line"/></div>;
  if((pathname==='/invite'||pathname==='/reset')&&token)return <Auth onLogin={onLogin} token={token} reset={pathname==='/reset'}/>;
  if(!data)return <Auth onLogin={onLogin}/>;
  if(data.user.role==='member'&&!termsCurrent(data.user))return <TermsGate again={!!data.user.terms_accepted_at} onAccepted={refresh} onLogout={logout}/>;
  const admin=data.user.role==='admin',viewProps={data,reload:refresh,notify};
  const nav=admin?[{href:'/admin',label:t('نظرة عامة','Overview')},{href:'/admin/members',label:t('المشتركون','Members')},{href:'/admin/activity',label:t('السجل','Activity')}]
    :[{href:'/dashboard',label:t('الرئيسية','Home')},{href:'/search',label:t('بحث جديد','New search')},{href:'/leads',label:t('عملائي','My contacts')},{href:'/history',label:t('سجل البحث','History')}];
  if(data.features?.crm) nav.push({href:admin?'/admin/crm':'/crm',label:admin?t('عمليات العملاء','Contact operations'):t('إدارة العملاء','CRM')});
  const home=admin?'/admin':'/dashboard';
  let page:React.ReactNode;
  if(data.features?.crm&&pathname==='/crm'&&!admin)page=<CrmView {...viewProps}/>;
  else if(data.features?.crm&&pathname==='/admin/crm'&&admin)page=<CrmOperations {...viewProps}/>;
  else if(pathname==='/settings')page=<SettingsView {...viewProps}/>;
  else if(admin)page=pathname==='/admin/members'?<MembersView {...viewProps}/>:pathname==='/admin/activity'?<ActivityView {...viewProps}/>:<AdminDashboard {...viewProps}/>;
  else if(pathname==='/search')page=<SearchView key={query.get('ai')||query.get('from')||query.get('saved')||''} {...viewProps}/>; // a new suggestion or repeat starts a fresh form
  else if(pathname==='/leads')page=<LeadsView {...viewProps}/>;
  else if(pathname==='/history')page=<HistoryView {...viewProps}/>;
  else if(pathname==='/credits')page=<CreditsView {...viewProps}/>;
  else page=<Dashboard {...viewProps}/>;
  return <div className="app-shell">
    <header className="topnav">
      <Link href={home} className="topnav-brand" aria-label={t('الرئيسية','Home')}><Brand/></Link>
      <nav className={'topnav-links'+(menu?' open':'')} aria-label={t('التنقل','Navigation')}>{nav.map(n=><Link key={n.href} href={n.href} onClick={()=>setMenu(false)} className={'topnav-link'+(pathname===n.href||n.href===home&&pathname==='/'?' active':'')}>{n.label}</Link>)}
        <Link href="/settings" onClick={()=>setMenu(false)} className={'topnav-link mobile-only'+(pathname==='/settings'?' active':'')}>{t('الإعدادات','Settings')}</Link>
        <div className="topnav-menu-tools mobile-only"><LangToggle/><ThemeToggle/><button className="text-button" onClick={logoutFromMenu}><SignOut size={18}/>{t('تسجيل الخروج','Sign out')}</button></div></nav>
      <div className="topnav-tools">
        {!admin&&<Link href="/credits" className="credit-pill" title={t('رصيدك','Your credits')}><Coins size={17}/><strong>{number(data.wallet?.available??data.user.balance)}</strong><span>{t('كريدت','credits')}</span></Link>}
        <span className="tools-group desktop-only"><LangToggle/><ThemeToggle/>
        <Link href="/settings" className="icon-button" title={t('الإعدادات','Settings')} aria-label={t('الإعدادات','Settings')}><GearSix size={20}/></Link>
        <button className="icon-button" title={t('تسجيل الخروج','Sign out')} aria-label={t('تسجيل الخروج','Sign out')} onClick={logoutFromMenu}><SignOut size={20}/></button></span>
        <button className="icon-button mobile-only" aria-expanded={menu} aria-label={menu?t('إغلاق القائمة','Close menu'):t('فتح القائمة','Open menu')} onClick={()=>setMenu(m=>!m)}>{menu?<X size={22}/>:<List size={22}/>}</button>
      </div>
    </header>
    <main className="page-content" key={pathname}>{failure&&<Notice error>{failure} {t('البيانات المعروضة من آخر تحديث ناجح.','Showing the data from the last successful update.')}</Notice>}{page}</main>
    <footer className="app-footer"><span dir="ltr">clowzy</span><Link href="/terms">{t('شروط الاستخدام','Terms of use')}</Link></footer>
    {!admin&&pathname!=='/search'&&<Assistant/>}
    {toast&&<div className={'toast '+(toast.error?'toast-error':'')} role={toast.error?'alert':'status'}>{toast.error?<WarningCircle size={22}/>:<CheckCircle size={22}/>}<span>{toast.message}</span><button className="icon-button" aria-label={t('إغلاق التنبيه','Dismiss')} onClick={()=>setToast(null)}><X size={17}/></button></div>}
  </div>;
}
