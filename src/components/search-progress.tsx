'use client';
import { useEffect, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { Search } from '@/lib/contracts';
import { api } from '@/lib/client';
import { countryLabel, englishName } from '@/lib/places';
import { Button } from './ui';
import { useT } from './lang';
// Radar while the provider works; the steps and numbers follow the real progress (people sent for checking, emails saved).
export function SearchProgress({search,reload}:{search:Search;reload:()=>Promise<void>}) {
  const t=useT();
  const [message,setMessage]=useState(search.message || t('جارٍ جلب الإيميلات والتحقق منها…','Finding and verifying emails…'));
  const [progress,setProgress]=useState({checked:search.checked??0,firms:search.companiesChecked,wide:search.widenedTo,delivered:search.delivered});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    let began=Date.now(),seen=''; // the 20-minute stop counts from the last real progress, not from the page opening
    async function poll(){
      try {
        const value=await api<Search>('search/poll',{searchId:search.id});
        if(!active)return;
        if(value.message)setMessage(value.message);
        setProgress({checked:value.checked??0,firms:value.companiesChecked,wide:value.widenedTo,delivered:value.delivered});
        if(value.status!=='awaiting_provider'){await reload();return;}
        const mark=(value.checked??0)+':'+value.delivered;
        if(mark!==seen){seen=mark;began=Date.now();}
        if(value.delivered>search.delivered)await reload(); // saved emails show in the table and balance at once; new props restart this loop
      }catch(e){
        const {status,offline}=e as {status?:number;offline?:boolean};
        if(status===403)await reload(); // newer terms: the reload shows them (and unmounts this)
        // No answer at all (a dropped connection, a sleeping tab): the search goes on on the server, and the next poll retries.
        if(active)setMessage(offline?t('انقطع الاتصال بالإنترنت. نعيد المحاولة تلقائيًا، وبحثك مستمر على الخادم.','Connection lost. Retrying automatically; your search continues on the server.'):(e as Error).message);
      }
      if(active && Date.now()-began<20*60*1000)timer=setTimeout(poll,6000);
      else if(active)setMessage(t('ما زال الطلب محفوظًا. اضغط «متابعة» لتحديثه، أو عد إليه من سجل البحث.','The request is still saved. Press “Refresh”, or come back from the history.'));
    }
    void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[search.id,search.delivered,reload,retry,t]);
  const {checked,firms,wide,delivered}=progress;
  const asked=JSON.parse(search.filters) as {mode?:string;countries?:string[];city?:string};
  const companies=asked.mode==='companies', fallback=firms!==undefined;
  // Where a search short of its count has looked: after a city, its whole country first, then the region's other countries, then other regions.
  const places=(names:(c:string)=>string,all:string)=>(wide??[]).map((c,i)=>(i===0&&asked.city?all:'')+names(c));
  // What was looked up, by name: the client read the old «N محاولة فحص» as failed checks (2026-10-05).
  const looked=companies?t('أجرينا '+checked+' عملية بحث عن بريد الشركات المطابقة','Ran '+checked+' searches for matching companies’ emails') // a company can be searched twice
    :fallback?t('بحثنا عن بريد '+(checked-firms)+' من الأشخاص، ثم أجرينا '+firms+' عملية بحث عن بريد الشركات','Looked up '+(checked-firms)+' people, then ran '+firms+' searches for the companies’ emails')
    :t('بحثنا عن بريد '+checked+' من الأشخاص المطابقين','Looked up '+checked+' matching people');
  return <section className="searching">
    <div className="radar" aria-hidden="true"><span className="ring"/><span className="ring"/><span className="ring"/><span className="core"><MagnifyingGlass size={26} weight="light"/></span></div>
    <div className="searching-body">
      <h3>{t('نبحث عن عملائك الآن','Finding your clients now')}</h3>
      <ol className="search-steps">
        <li className={checked?'done':'active'}>{companies||fallback?t('نبحث عن بريد عمل للشركات المطابقة لمعاييرك','Finding business emails for matching companies'):t('نبحث عن أشخاص يطابقون معاييرك','Finding matching people')}</li>
        <li className={checked?'active':''}>{t('نتحقق من البريد','Verifying the emails')}</li>
        <li className={delivered?'done':''}>{t('نحفظ البريد في حسابك','Saving them to your account')}</li>
      </ol>
      <div role="status">{wide&&<p className="search-live">{t('ما اكتمل العدد، فوسّعنا البحث إلى: '+places(countryLabel,'كل ').join('، ')+'.','Not enough yet, so we widened the search to: '+places(englishName,'all of ').join(', ')+'.')}</p>}
        {fallback&&<p className="search-live">{t('لم نجد بريدًا كافيًا للأشخاص، فنبحث الآن عن بريد الشركات نفسها.','Not enough personal emails found, so we are now looking for the companies’ own emails.')}</p>}
        {checked>0&&<p className="search-live">{looked+t(' · وصلك '+delivered+' من '+search.requested,' · received '+delivered+' of '+search.requested)}</p>}<p className="search-message">{message}</p></div>
      <div className="searching-foot"><Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>{t('متابعة','Refresh')}</Button><small>{t('يُخصم الكريدت فقط عند حفظ بريد جديد.','Credits are charged only when a new email is saved.')}</small></div>
    </div>
  </section>;
}
