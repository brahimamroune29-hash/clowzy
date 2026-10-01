'use client';
import { useEffect, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { Search } from '@/lib/contracts';
import { api } from '@/lib/client';
import { Button } from './ui';
// Radar while the provider works; the steps and numbers follow the real progress (people sent for checking, emails saved).
export function SearchProgress({search,reload}:{search:Search;reload:()=>Promise<void>}) {
  const [message,setMessage]=useState(search.message || 'جارٍ جلب الإيميلات والتحقق منها…');
  const [progress,setProgress]=useState({checked:search.checked??0,delivered:search.delivered});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    let began=Date.now(),seen=''; // the 20-minute stop counts from the last real progress, not from the page opening
    async function poll(){
      try {
        const value=await api<Search>('search/poll',{searchId:search.id});
        if(!active)return;
        if(value.message)setMessage(value.message);
        setProgress({checked:value.checked??0,delivered:value.delivered});
        if(value.status!=='awaiting_provider'){await reload();return;}
        const mark=(value.checked??0)+':'+value.delivered;
        if(mark!==seen){seen=mark;began=Date.now();}
        if(value.delivered>search.delivered)await reload(); // saved emails show in the table and balance at once; new props restart this loop
      }catch(e){if(active)setMessage((e as Error).message);}
      if(active && Date.now()-began<20*60*1000)timer=setTimeout(poll,6000);
      else if(active)setMessage('ما زال الطلب محفوظًا. اضغط متابعة لتحديث حالته، أو عد إليه لاحقًا من سجل البحث.');
    }
    void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[search.id,search.delivered,reload,retry]);
  const {checked,delivered}=progress;
  const companies=(JSON.parse(search.filters) as {mode?:string}).mode==='companies';
  return <section className="searching">
    <div className="radar" aria-hidden="true"><span className="ring"/><span className="ring"/><span className="ring"/><span className="core"><MagnifyingGlass size={26} weight="light"/></span></div>
    <div className="searching-body">
      <h3>نبحث عن عملائك الآن</h3>
      <ol className="search-steps">
        <li className={checked?'done':'active'}>{companies?'نبحث عن شركات تطابق معاييرك ونقرأ مواقعها':'نبحث عن أشخاص يطابقون معاييرك'}</li>
        <li className={checked?'active':''}>{companies?'نتحقق من بريد كل شركة':'نتحقق من بريد كل شخص'}</li>
        <li className={delivered?'done':''}>نحفظ البريد الموثّق في حسابك</li>
      </ol>
      <div role="status">{checked>0&&<p className="search-live">نتحقق من بريد {checked} من {companies?'الشركات المطابقة':'الأشخاص المطابقين'} · وجدنا {delivered} من {search.requested} حتى الآن</p>}<p className="search-message">{message}</p></div>
      <div className="searching-foot"><Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>متابعة الحالة</Button><small>لن نعيد إرسال طلب البحث. كريدت المنصة يُخصم عند حفظ بريد جديد فقط.</small></div>
    </div>
  </section>;
}
