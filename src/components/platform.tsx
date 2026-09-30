'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { usePathname,useRouter,useSearchParams } from 'next/navigation';
import { ChartPieSlice, ClockCounterClockwise, Coins, GearSix, House, List, MagnifyingGlass, SignOut, SquaresFour, UsersThree, X, CheckCircle, WarningCircle, ArrowLeft } from '@phosphor-icons/react';
import type { Snapshot } from '@/lib/contracts';
import { api,number } from '@/lib/client';
import { overviewOnly,weekBoundaries } from '@/lib/overview';
import { Brand, Button, Notice, ThemeToggle } from './ui';
import Auth from './auth';
import { TermsGate, TermsPage } from './terms';
import { Dashboard, SearchView, LeadsView, HistoryView, CreditsView, SettingsView } from './member-views';
import { AdminDashboard, MembersView, ActivityView } from './admin-views';
export type ViewProps = {data:Snapshot;reload:()=>Promise<void>;notify:(message:string,error?:boolean)=>void};
const memberNav=[{href:'/dashboard',label:'نظرة عامة',icon:House},{href:'/search',label:'بحث جديد',icon:MagnifyingGlass},{href:'/leads',label:'قائمة العملاء',icon:UsersThree},{href:'/history',label:'سجل البحث',icon:ClockCounterClockwise},{href:'/credits',label:'رصيد الكريدت',icon:Coins}];
const adminNav=[{href:'/admin',label:'نظرة عامة',icon:ChartPieSlice},{href:'/admin/members',label:'المشتركون والدعوات',icon:UsersThree},{href:'/admin/activity',label:'سجل الإدارة',icon:ClockCounterClockwise}];
export default function Platform(){
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
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(null),5000);return()=>clearTimeout(t);},[toast]);
  const notify=(message:string,error=false)=>setToast({message,error});
  async function onLogin(){await refresh();router.replace('/dashboard');}
  async function logout(){requestVersion.current++;await api('auth/logout',{});setData(null);setFailure('');router.replace('/');}
  const token=query.get('token')||undefined;
  if(pathname==='/terms')return <TermsPage/>;
  // A page whose data did not load (network, paused database, redeploy): say so and retry; never show another page's data.
  if(!loading&&failure&&loadedPath!==requestPath)return <div className="boot"><Brand/><p>{failure}</p><Button variant="secondary" onClick={()=>{setLoading(true);void refresh();}}>إعادة المحاولة</Button></div>;
  if(loading||loadedPath!==requestPath)return <div className="boot"><Brand/><p>نجهّز مساحة عملك…</p><span className="loading-line"/></div>;
  if((pathname==='/invite'||pathname==='/reset')&&token)return <Auth onLogin={onLogin} token={token} reset={pathname==='/reset'}/>;
  if(!data)return <Auth onLogin={onLogin}/>;
  if(data.user.role==='member'&&!data.user.terms_accepted_at)return <TermsGate onAccepted={refresh} onLogout={logout}/>;
  const admin=data.user.role==='admin',nav=admin?adminNav:memberNav,viewProps={data,reload:refresh,notify};
  let page:React.ReactNode;
  if(pathname==='/settings')page=<SettingsView {...viewProps}/>;
  else if(admin)page=pathname==='/admin/members'?<MembersView {...viewProps}/>:pathname==='/admin/activity'?<ActivityView {...viewProps}/>:<AdminDashboard {...viewProps}/>;
  else if(pathname==='/search')page=<SearchView {...viewProps}/>;
  else if(pathname==='/leads')page=<LeadsView {...viewProps}/>;
  else if(pathname==='/history')page=<HistoryView {...viewProps}/>;
  else if(pathname==='/credits')page=<CreditsView {...viewProps}/>;
  else page=<Dashboard {...viewProps}/>;
  const label=pathname==='/settings'?'إعدادات الحساب':nav.find(n=>n.href===pathname)?.label||'نظرة عامة';
  return <div className="app-shell">
    {menu&&<button className="mobile-scrim" aria-label="إغلاق القائمة" onClick={()=>setMenu(false)}/>}
    <aside className={'sidebar '+(menu?'open':'')}>
      <div className="sidebar-brand"><Brand compact/><button className="icon-button mobile-only" aria-label="إغلاق القائمة" onClick={()=>setMenu(false)}><X size={22}/></button></div>
      <div className="workspace-label"><span className="workspace-icon"><SquaresFour size={18}/></span><div><strong>{admin?'إدارة المنصة':'مساحة عملي'}</strong><small>{admin?'صلاحيات المالك':'حساب المشترك'}</small></div><span className="tiny-dot"/></div>
      <div className="nav-caption">مساحة العمل</div><nav>{nav.map(({href,label,icon:Icon})=><Link key={href} href={href} onClick={()=>setMenu(false)} className={'nav-item '+((pathname===href||href===(admin?'/admin':'/dashboard')&&pathname==='/')?'active':'')}><Icon size={21} weight="light"/><span>{label}</span>{href==='/leads'&&<span className="nav-count">{(data.summary?.contacts??data.contacts.length)}</span>}</Link>)}</nav>
      <div className="sidebar-bottom">{!admin&&<div className="credit-card"><div><span>رصيدك المتاح</span><Coins size={19}/></div><strong>{number(data.user.balance)} <small>كريدت</small></strong><div className="credit-track"><span style={{width:Math.max(0,Math.min(100,data.user.balance/Math.max(data.user.balance+(data.summary?.contacts??data.contacts.length),1)*100))+'%'}}/></div><p>كريدت واحد لكل بريد جديد.</p><Link href="/credits">عرض سجل الرصيد <ArrowLeft size={15}/></Link></div>}
      <Link href="/settings" className={'nav-item '+(pathname==='/settings'?'active':'')} onClick={()=>setMenu(false)}><GearSix size={21} weight="light"/><span>إعدادات الحساب</span></Link>
      <div className="profile"><span className="avatar">{data.user.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><div><strong>{data.user.name}</strong><small>{admin?'مالك المنصة':'مشترك'}</small></div><button className="icon-button" aria-label="تسجيل الخروج" onClick={logout}><SignOut size={20}/></button></div></div>
    </aside>
    <div className="main-area"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" aria-label="فتح القائمة" onClick={()=>setMenu(true)}><List size={24}/></button><span>{admin?'إدارة المنصة':'مساحة العمل'}</span><span className="slash">/</span><strong>{label}</strong></div><div className="topbar-tools"><ThemeToggle/><span className="topbar-avatar">{data.user.name[0]}</span></div></header>
    <main className="page-content" key={pathname}>{failure&&<Notice error>{failure} البيانات المعروضة من آخر تحديث ناجح.</Notice>}{page}</main><footer className="app-footer"><span>clowzy — مساحة الفرص</span><Link href="/terms">شروط الاستخدام</Link></footer></div>
    {toast&&<div className={'toast '+(toast.error?'toast-error':'')} role={toast.error?'alert':'status'}>{toast.error?<WarningCircle size={22}/>:<CheckCircle size={22}/>}<span>{toast.message}</span><button className="icon-button" aria-label="إغلاق التنبيه" onClick={()=>setToast(null)}><X size={17}/></button></div>}
  </div>;
}
