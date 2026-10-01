'use client';
import { useEffect, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { Search } from '@/lib/contracts';
import { api } from '@/lib/client';
import { Button } from './ui';
import { useT } from './lang';
// Radar while the provider works; the steps and numbers follow the real progress (people sent for checking, emails saved).
export function SearchProgress({search,reload}:{search:Search;reload:()=>Promise<void>}) {
  const t=useT();
  const [message,setMessage]=useState(search.message || t('جارٍ جلب الإيميلات والتحقق منها…','Finding and verifying emails…'));
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
      }catch(e){if((e as {status?:number}).status===403)await reload();if(active)setMessage((e as Error).message);} // 403 for newer terms: the reload shows them (and unmounts this)
      if(active && Date.now()-began<20*60*1000)timer=setTimeout(poll,6000);
      else if(active)setMessage(t('ما زال الطلب محفوظًا. اضغط «متابعة» لتحديثه، أو عد إليه من سجل البحث.','The request is still saved. Press “Refresh”, or come back from the history.'));
    }
    void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[search.id,search.delivered,reload,retry,t]);
  const {checked,delivered}=progress;
  const companies=(JSON.parse(search.filters) as {mode?:string}).mode==='companies';
  return <section className="searching">
    <div className="radar" aria-hidden="true"><span className="ring"/><span className="ring"/><span className="ring"/><span className="core"><MagnifyingGlass size={26} weight="light"/></span></div>
    <div className="searching-body">
      <h3>{t('نبحث عن عملائك الآن','Finding your clients now')}</h3>
      <ol className="search-steps">
        <li className={checked?'done':'active'}>{companies?t('نبحث عن شركات تطابق معاييرك ونقرأ مواقعها','Finding matching companies and reading their sites'):t('نبحث عن أشخاص يطابقون معاييرك','Finding matching people')}</li>
        <li className={checked?'active':''}>{t('نتحقق من البريد','Verifying the emails')}</li>
        <li className={delivered?'done':''}>{t('نحفظ البريد في حسابك','Saving them to your account')}</li>
      </ol>
      <div role="status">{checked>0&&<p className="search-live">{t('فحصنا '+checked+' · وصلك '+delivered+' من '+search.requested,'Checked '+checked+' · received '+delivered+' of '+search.requested)}</p>}<p className="search-message">{message}</p></div>
      <div className="searching-foot"><Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>{t('متابعة','Refresh')}</Button><small>{t('يُخصم الكريدت فقط عند حفظ بريد جديد.','Credits are charged only when a new email is saved.')}</small></div>
    </div>
  </section>;
}
