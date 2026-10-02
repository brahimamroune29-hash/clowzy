'use client';
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { useRouter,useSearchParams } from 'next/navigation';
import { ArrowDown, Check, CheckCircle, Coins, Copy, DownloadSimple, MagnifyingGlass, MapPin, Plus, SlidersHorizontal, Sparkle, UsersThree, ClockCounterClockwise, ArrowSquareOut, X } from '@phosphor-icons/react';
import { searchMethod, assistForm, type AssistMessage, type AssistReply, type Contact, emailTrust, expectedEmails, fieldOf, fields, type FieldName, gulf, OTHER, type Search, type SearchInput, titles, withCountries } from '@/lib/contracts';
import { cityNames, countrySuggestions } from '@/lib/places';
import { api,date,downloadContacts,number } from '@/lib/client';
import type { ViewProps } from './platform';
import { SearchProgress } from './search-progress';
import { Badge,Button,Empty,Field,Forward,Modal,Notice,Open,PageHeading } from './ui';
import { useLang,useNames,useT } from './lang';

// A search's state in words, the same on the dashboard and in the history.
function SearchBadge({s}:{s:Search}){
  const t=useT();
  return <Badge tone={['failed','unknown','cancelled'].includes(s.status)||(s.status==='partial'&&!s.delivered)?'amber':'green'}>{s.status==='failed'?t('تعذّر البحث','Failed'):s.status==='unknown'?t('غير مؤكد','Uncertain'):s.status==='cancelled'?t('ملغى','Cancelled'):['awaiting_provider','running','queued'].includes(s.status)?t('قيد التنفيذ','Running'):s.status==='partial'?(s.delivered?t('نتائج جزئية','Partial'):t('لا نتائج','No results')):t('مكتمل','Complete')}</Badge>;
}
// The stored title is Arabic; in English it is rebuilt from the search's filters.
function useSearchTitle(){
  const {lang}=useLang(),names=useNames();
  return (s:Search)=>{
    if(lang!=='en')return s.title;
    try{const f=withCountries(JSON.parse(s.filters)) as Partial<SearchInput>;return (f.mode==='companies'?'Companies · ':'')+names.label(f.sector||'')+' · '+(f.city||(f.countries??[]).map(names.country).join(', '));}catch{return s.title;}
  };
}
export function Dashboard({data}:ViewProps) {
  const t=useT(),title=useSearchTitle();
  return <>
    <PageHeading title={t('أهلًا ','Hello ')+data.user.name.split(' ')[0]}><Link href="/search" className="button primary"><Plus size={19}/><span>{t('بحث جديد','New search')}</span></Link></PageHeading>
    <div className="stats-strip">{[{label:t('رصيدك','Your credits'),value:data.user.balance,icon:Coins},{label:t('عملاء محفوظون','Saved contacts'),value:data.summary?.contacts??data.contacts.length,icon:UsersThree},{label:t('عمليات البحث','Searches'),value:data.summary?.searches??data.searches.length,icon:MagnifyingGlass}].map(({label,value,icon:Icon})=><div className="stat" key={label}><div className="stat-label"><span>{label}</span><Icon size={20} weight="light"/></div><div className="stat-value">{number(value)}</div></div>)}</div>
    <section className="panel"><div className="section-title"><h2>{t('آخر عمليات البحث','Recent searches')}</h2>{data.searches.length>0&&<Link className="text-link" href="/history">{t('عرض الكل','See all')} <Forward/></Link>}</div>
      {data.searches.length?<div className="recent-list">{data.searches.slice(0,5).map(s=><Link key={s.id} href={'/leads?search='+s.id} className="recent-row"><div><strong>{title(s)}</strong><small>{date(s.created_at)}</small></div><div className="recent-result"><strong>{s.delivered}<small> / {s.requested}</small></strong><SearchBadge s={s}/></div><Forward size={18}/></Link>)}</div>
      :<Empty title={t('ابدأ بأول بحث','Start with your first search')} description={t('اختر المجال والبلد، ونحفظ لك الإيميلات هنا.','Pick a field and a country; your emails are saved here.')}><Link href="/search" className="button primary">{t('بحث جديد','New search')}</Link></Empty>}
    </section>
  </>;
}

type Form={mode:'people'|'companies';sector:string;countries:string[];city:string;title:string;size:'all'|'1-10'|'11-50'|'51-200';count:number};
// The form as the member edits it, from a saved search ("repeat"), the assistant, or the defaults.
function formOf(raw?:Partial<SearchInput>):Form{
  return {mode:raw?.mode==='companies'?'companies':'people',sector:raw?.sector||'',countries:raw?.countries?.length?raw.countries:['SA'],city:raw?.city||'',title:raw?.title||'',size:raw?.size||'all',count:raw?.count||10};
}
const fromFilters=(filters?:string)=>{
  try { const raw=filters?withCountries(JSON.parse(filters)):undefined;
    if(!raw||typeof raw!=='object')return formOf();
    const s=raw as Record<string,unknown>;return formOf(assistForm({...s,other:s.sector},50));
  } catch { return formOf(); }
};
// Countries: type part of a name for suggestions; the chosen ones show as removable tags.
function CountryPicker({value,onChange}:{value:string[];onChange:(v:string[])=>void}){
  const t=useT(),names=useNames(),[text,setText]=useState(''),[error,setError]=useState('');
  const matches=countrySuggestions(text).filter(c=>!value.includes(c));
  const allGulf=gulf.every(c=>value.includes(c));
  function set(list:string[]){if(list.length>10){setError(t('يمكن اختيار 10 دول كحد أقصى.','Up to 10 countries.'));return;}setError('');onChange(list);}
  function add(code:string){set([...value,code]);setText('');}
  return <div className="field country-field"><span>{t('البلد','Country')}</span>
    <div className="chips">{value.map(c=><span key={c} className="chip on">{names.country(c)}{value.length>1&&<button type="button" aria-label={t('إزالة ','Remove ')+names.country(c)} onClick={()=>set(value.filter(x=>x!==c))}><X size={13}/></button>}</span>)}
      {!allGulf&&<button type="button" className="chip" onClick={()=>set([...new Set([...value,...gulf])])}><Plus size={13}/>{t('كل دول الخليج','All Gulf countries')}</button>}</div>
    <div className="suggest"><input value={text} onChange={e=>setText(e.target.value)} placeholder={t('اكتب اسم الدولة، مثلًا: السع','Type a country, e.g. Sau')} aria-label={t('أضف دولة','Add a country')} maxLength={40}
      onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(matches[0])add(matches[0]);}}}/>
      {matches.length>0&&<ul role="listbox" aria-label={t('دول مقترحة','Suggested countries')}>{matches.map(c=><li key={c}><button type="button" role="option" aria-selected={false} onClick={()=>add(c)}>{names.country(c)}</button></li>)}</ul>}</div>
    {error&&<small className="field-error" role="alert">{error}</small>}</div>;
}
export function SearchView({data,reload,notify}:ViewProps){
  const t=useT(),{lang}=useLang(),names=useNames(),router=useRouter(),query=useSearchParams();
  const method=searchMethod(query);
  const previous=data.searches.find(s=>s.id===query.get('from'));
  // Starting values: a search the assistant prepared (?ai=, from its chat window), else a repeated search, else the defaults.
  const available=data.wallet?.available??data.user.balance,maxCount=Math.max(0,Math.min(data.provider?.maxCount??50,available));
  const [filters,setFilters]=useState<Form>(()=>{
    let f=fromFilters(query.get('saved')||previous?.filters);
    try{const raw=query.get('ai');if(raw){const s=assistForm(JSON.parse(raw),50);f={...f,...Object.fromEntries(Object.entries(s).filter(([,v])=>v!==undefined))};}}catch{}
    return {...f,count:Math.max(1,Math.min(f.count,50))};
  });
  const [busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
  const [audienceName,setAudienceName]=useState('');
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [otherDraft,setOtherDraft]=useState(()=>fieldOf(filters.sector)?'':filters.sector),[other,setOther]=useState(()=>!!filters.sector&&!fieldOf(filters.sector));
  const [editing,setEditing]=useState(false);
  const listedTitle=(title:string)=>!title||(titles as readonly string[]).includes(title);
  const [titleOther,setTitleOther]=useState(()=>!listedTitle(filters.title)),[titleDraft,setTitleDraft]=useState(()=>listedTitle(filters.title)?'':filters.title);
  const [describe,setDescribe]=useState(''),[thinking,setThinking]=useState(false),[aiNote,setAiNote]=useState('');
  const [conversation,setConversation]=useState<AssistMessage[]>([]);
  const [aiState,setAiState]=useState<'idle'|'prepare'|'clarify'|'answer'|'error'>('idle'),[choices,setChoices]=useState<string[]>([]);
  const formVersion=useRef(0);
  const [match,setMatch]=useState<{total?:number;strict?:number;industryLabels?:string[];industries?:string[];error?:string;audience:string}|null>(null); // null: counting
  function change(patch:Partial<Form>){
    formVersion.current++;
    setAiState('idle');setChoices([]);setAiNote('');
    setFilters(f=>{const next={...f,...Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined))};if(next.countries.length!==1)next.city='';return next;});
    setConfirmed(false);setRequestId(crypto.randomUUID()); // match is keyed by audience; changing only the count keeps the free count valid
  }
  function apply(patch:Partial<Form>){
    change(patch);
    if(patch.sector!==undefined){const own=!fieldOf(patch.sector);setOther(own);setOtherDraft(own?patch.sector:'');}
    if(patch.title!==undefined){const own=!listedTitle(patch.title);setTitleOther(own);setTitleDraft(own?patch.title:'');}
  }
  async function prepare(content=describe){
    if(content.trim().length<2||thinking||busy)return;
    if(!Number.isInteger(filters.count)||filters.count<1||filters.count>50){setError(t('اختر عددًا من 1 إلى 50 قبل تجهيز الوصف.','Choose 1–50 emails before preparing your description.'));return;}
    const version=formVersion.current;
    const messages:AssistMessage[]=[...conversation,{role:'user' as const,content:content.trim()}].slice(-8);
    while(messages[0]?.role==='assistant')messages.shift();
    setThinking(true);setAiNote('');setChoices([]);setConfirmed(false);setError('');
    try{
      const r=await api<AssistReply>('assist',{messages,context:filters});
      if(version!==formVersion.current){setAiNote(t('تغيّرت إعداداتك أثناء التجهيز. أرسل الوصف مجددًا لتطبيقه على اختياراتك الحالية.','Your settings changed while preparing. Send the description again to use your current choices.'));return;}
      if(r.search) apply(assistForm(r.search,50));
      setAiNote(r.reply);setAiState(r.search?'prepare':r.action==='clarify'?'clarify':'answer');setChoices(r.choices||[]);
      setConversation([...messages,{role:'assistant',content:r.reply}]);setDescribe('');
    }catch(e){setAiNote((e as Error).message);setAiState('error');}finally{setThinking(false);}
  }
  const displayCity=lang==='ar'?(Object.entries(cityNames).find(([,en])=>en===filters.city)?.[0]||filters.city):filters.city;
  const companies=filters.mode==='companies',field=fieldOf(filters.sector) as FieldName|'';
  const audience=JSON.stringify({mode:filters.mode,sector:filters.sector,countries:filters.countries,city:filters.city,title:companies?'':filters.title,size:filters.size});
  // Free count of matching people or companies, so a too-narrow search is visible before any credit is spent.
  useEffect(()=>{
    if(!method||!data.provider?.configured||JSON.parse(audience).sector.length<2)return;
    let active=true;
    const timer=setTimeout(()=>api<{total:number;strict:number;industryLabels:string[];industries:string[]}>('search/count',JSON.parse(audience))
      .then(r=>{if(active)setMatch({...r,audience});}).catch(e=>{if(active)setMatch({error:(e as Error).message,audience});}),700);
    return()=>{active=false;clearTimeout(timer);};
  },[data.provider?.configured,audience,method]);
  const currentMatch=match?.audience===audience?match:null;
  const expected=currentMatch?.total!==undefined?expectedEmails(currentMatch.strict??0,currentMatch.total,filters.count||0,filters.mode):undefined;
  const few=expected!==undefined&&expected<filters.count;
  const pending=other&&filters.sector!==otherDraft.trim()||!companies&&titleOther&&filters.title!==titleDraft.trim();
  const who=companies?t('الشركات المطابقة','matching companies'):t('الأشخاص المطابقين','matching people');
  const ready=filters.sector.length>=2&&!pending;
  const validCount=Number.isInteger(filters.count)&&filters.count>=1&&filters.count<=maxCount;
  const unfinishedDescription=method==='ai'&&(!!describe.trim()||aiState==='clarify');
  const canStart=!!method&&ready&&validCount&&confirmed&&!thinking&&!unfinishedDescription&&!!currentMatch&&!currentMatch.error&&currentMatch.total!==0&&!!data.provider?.configured;
  async function submit(e:React.FormEvent){
    e.preventDefault();if(busy||!canStart)return;setBusy(true);setError('');
    try{
      const result=await api<Search>('search',{...filters,title:companies?'':filters.title,confirmed,requestId});
      await reload();
      if(['failed','unknown'].includes(result.status)){
        setRequestId(crypto.randomUUID()); // pressing the button again is a new attempt, not the same failed search
        setError((result.message||t('تعذّر إكمال الطلب.','The request could not be completed.'))+' '+t('لم يُخصم كريدت من رصيدك.','No credit was charged.'));
        return;
      }
      notify(result.status==='awaiting_provider'?t('بدأ البحث. نجهّز الإيميلات ونتحقق منها.','Search started. We are finding and verifying emails.'):result.delivered?t('تم حفظ '+result.delivered+' بريد جديد.','Saved '+result.delivered+' new emails.'):t('لم نجد إيميلات جديدة في هذه الدفعة.','No new emails in this batch.'));
      router.push('/leads?search='+result.id);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const status=pending||filters.sector.length<2?t('اكتب مجالك ثم اضغط «اعتماد».','Type your field, then press “Apply”.')
    :!currentMatch?t('نحسب عدد ','Counting ')+who+'…':currentMatch.error?currentMatch.error
    :(other&&currentMatch.industryLabels?.length?t('سنبحث في: ','We will search in: ')+(lang==='en'?currentMatch.industries??[]:currentMatch.industryLabels).join(lang==='en'?', ':'، ')+'. ':'')
      +(currentMatch.total===0?t('لا يوجد ما يطابق هذه المعايير. وسّع البحث: احذف المدينة أو حجم الشركة.','Nothing matches. Widen the search: remove the city or company size.')
      :few?(expected?t('المتوقع نحو '+expected+' بريد من '+filters.count,'Expect about '+expected+' of '+filters.count+' emails'):t('قد لا نجد بريدًا بهذه المعايير','We may find no email with these filters'))+' ('+number(currentMatch.total!)+' '+who+'). '+t('لا يُخصم إلا البريد الذي يصلك.','You pay only for emails you receive.')
      :t('عدد '+who,companies?'Matching companies':'Matching people')+': '+number(currentMatch.total!)+'. '+t('العدّ مجاني.','Counting is free.'));
  function chooseMethod(next:'manual'|'ai'|null){
    if(busy||thinking)return;
    const params=new URLSearchParams(query.toString());params.set('method',next||'choose');
    setConfirmed(false);setEditing(false);
    router.push('/search?'+params.toString(),{scroll:false});
  }
  function editDetails(){
    if(method!=='manual'){setEditing(!editing);return;}
    const details=document.getElementById('search-details');
    details?.scrollIntoView({block:'start'});
    details?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
  }
  const manualControls=(
    <div id="search-details" className="search-details">
      <div className="field"><span>{t('نوع البحث','Search for')}</span><div className="chips">
        <button type="button" className={'chip'+(!companies?' on':'')} aria-pressed={!companies} onClick={()=>change({mode:'people'})}>{t('أشخاص داخل الشركات','People in companies')}</button>
        <button type="button" className={'chip'+(companies?' on':'')} aria-pressed={companies} onClick={()=>change({mode:'companies'})}>{t('إيميلات الشركات','Company emails')}</button></div>
        <small>{companies?t('الإيميل العام للشركة المنشور على موقعها، بعد التحقق منه.','The company’s own email from its website, verified.'):t('إيميل العمل لشخص داخل الشركة. إن لم يكفِ، نكمّل بإيميلات الشركات نفسها.','A person’s work email. If not enough, we fill in with the companies’ own emails.')}</small></div>
      <div className="form-grid">
        <Field label={t('المجال','Field')}><select value={other?OTHER:field} onChange={e=>{if(e.target.value===OTHER){setOther(true);change({sector:otherDraft.trim()});}else{setOther(false);change({sector:e.target.value});}}}><option value="" disabled>{t('اختر المجال','Choose a field')}</option>{(Object.keys(fields) as FieldName[]).map(f=><option key={f} value={f}>{names.label(f)}</option>)}<option value={OTHER}>{t('أخرى (اكتب مجالك)','Other (type it)')}</option></select></Field>
        {other?<div className="field"><span>{t('اكتب مجالك','Your field')}</span><div className="other-row"><input value={otherDraft} onChange={e=>setOtherDraft(e.target.value)} maxLength={60} placeholder={t('مثلًا: محلات العطور','e.g. perfume shops')} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(otherDraft.trim().length>=2)change({sector:otherDraft.trim()});}}}/>
          <Button type="button" variant="secondary" disabled={otherDraft.trim().length<2||!pending} onClick={()=>change({sector:otherDraft.trim()})}>{pending?t('اعتماد','Apply'):t('معتمد','Applied')}</Button></div></div>
        :field?<Field label={t('التخصص','Specialty')}><select value={filters.sector} onChange={e=>change({sector:e.target.value})}><option value={field}>{t('كل التخصصات','All specialties')}</option>{field&&fields[field].map(s=><option key={s} value={s}>{names.label(s)}</option>)}</select></Field>:null}
      </div>
      <CountryPicker value={filters.countries} onChange={countries=>change({countries})}/>
      <div className="form-grid">
        <Field label={t('المدينة','City')} hint={filters.countries.length===1?t('اتركها فارغة للبلد كله.','Leave empty for the whole country.'):t('متاحة عند اختيار دولة واحدة.','Available with one country.')}><input value={filters.city} onChange={e=>change({city:e.target.value})} placeholder={filters.countries.length===1?t('مثلًا: الرياض','e.g. Riyadh'):'—'} disabled={filters.countries.length!==1} maxLength={60}/></Field>
        {!companies&&<div className="field"><span>{t('المسمى الوظيفي','Job title')}</span><select aria-label={t('المسمى الوظيفي','Job title')} value={titleOther?OTHER:filters.title} onChange={e=>{if(e.target.value===OTHER){setTitleOther(true);change({title:titleDraft.trim()});}else{setTitleOther(false);change({title:e.target.value});}}}><option value="">{t('جميع المسميات','All titles')}</option>{titles.map(x=><option key={x} value={x}>{names.label(x)}</option>)}<option value={OTHER}>{t('أخرى (اكتب المسمى)','Other (type it)')}</option></select>
          {titleOther&&<div className="other-row"><input aria-label={t('اكتب المسمى الوظيفي','Type the job title')} value={titleDraft} onChange={e=>setTitleDraft(e.target.value)} maxLength={60} placeholder={t('مثلًا: مدير مستودع','e.g. warehouse manager')} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(titleDraft.trim().length>=2)change({title:titleDraft.trim()});}}}/>
            <Button type="button" variant="secondary" disabled={titleDraft.trim().length<2||filters.title===titleDraft.trim()} onClick={()=>change({title:titleDraft.trim()})}>{filters.title===titleDraft.trim()?t('معتمد','Applied'):t('اعتماد','Apply')}</Button></div>}</div>}
        <Field label={t('حجم الشركة','Company size')}><select value={filters.size} onChange={e=>change({size:e.target.value as Form['size']})}><option value="all">{t('كل الأحجام','Any size')}</option><option value="1-10">{t('1–10 موظفين','1–10 employees')}</option><option value="11-50">{t('11–50 موظفًا','11–50 employees')}</option><option value="51-200">{t('51–200 موظف','51–200 employees')}</option></select></Field>
      </div>

        </div>
  );
  if(!method)return <>
    <PageHeading title={t('كيف تحب أن تبدأ البحث؟','How would you like to search?')} description={t('طريقتان للوصول إلى عملائك. اختر الأنسب لك.','Two ways to find your clients. Pick the one that suits you.')}/>
    <div className="search-paths">
      <button type="button" className="search-path" onClick={()=>chooseMethod('manual')}>
        <span className="search-path-icon"><SlidersHorizontal size={28} weight="light"/></span>
        <h2>{t('بحث يدوي','Manual search')}</h2>
        <p>{t('حدد المجال والبلد ونوع جهات الاتصال بنفسك. كل الخيارات أمامك، خطوة بخطوة.','Choose the niche, location and contact type yourself. Every option is right in front of you.')}</p>
        <span className="search-path-preview">{t('المجال · المكان · جهة الاتصال','Niche · Location · Contact type')}</span>
        <span className="search-path-action">{t('اختَر معايير البحث','Choose search criteria')}<Forward size={19}/></span>
      </button>
      <button type="button" className="search-path" onClick={()=>chooseMethod('ai')}>
        <span className="search-path-icon"><Sparkle size={28} weight="light"/></span>
        <h2>{t('بمساعدة AI','AI-assisted search')}</h2>
        <p>{t('صف العملاء بكلامك، ونجهّز لك معايير البحث. راجع الملخص وعدّله قبل أن تبدأ.','Describe your ideal clients. We prepare the search criteria for you to review and refine.')}</p>
        <span className="search-path-preview">{t('«أريد أصحاب عيادات أسنان في دبي»','“I want dental clinic owners in Dubai”')}</span>
        <span className="search-path-action">{t('صِف العملاء للمساعد','Describe your clients')}<Forward size={19}/></span>
      </button>
    </div>
    <p className="search-path-note">{filters.sector?t('اختياراتك الحالية محفوظة عند الانتقال بين الطريقتين. ','Your current criteria stay with you when switching. '):''}{t('في الطريقتين، تراجع العدد والرصيد قبل البدء.','With either method, you review the count and credits before starting.')}</p>
  </>;
  return <>
    <div className="search-method-bar"><button type="button" className="text-button" disabled={busy||thinking} onClick={()=>chooseMethod(null)}>{t('طرق البحث','Search methods')}</button><span aria-hidden="true">/</span><span>{method==='manual'?t('بحث يدوي','Manual search'):t('بمساعدة AI','AI-assisted search')}</span><button type="button" className="text-button search-switch" disabled={busy||thinking} onClick={()=>chooseMethod(method==='manual'?'ai':'manual')}>{method==='manual'?t('الانتقال إلى مساعد AI','Switch to AI assistant'):t('الانتقال إلى البحث اليدوي','Switch to manual search')}</button></div>
    <PageHeading title={method==='manual'?t('حدّد العملاء الذين تبحث عنهم','Choose the clients you want to reach'):t('صِف عملاءك للمساعد','Describe your clients to the assistant')} description={method==='manual'?t('اختر المعايير، راجع الملخص، ثم ابدأ البحث.','Choose your criteria, review the summary, then start searching.'):t('اكتب وصفًا بسيطًا، وسنحوّله إلى بحث قابل للتعديل.','Write a simple description. We turn it into an editable search.')}/>
    <div className={'search-workspace method-'+method}>
      {method==='manual'?<section className="panel search-manual" aria-labelledby="manual-title"><div className="search-step"><span>01</span>{t('اختر المعايير','Choose criteria')}</div><h2 id="manual-title">{t('أنت تحدد التفاصيل','You set the details')}</h2><p>{t('ابدأ بالمجال والبلد. المدينة والمسمى وحجم الشركة اختيارية.','Start with a niche and country. City, job title and company size are optional.')}</p>{manualControls}</section>:
      <section className="panel search-composer" aria-labelledby="describe-label">
        <div className="search-step"><span>01</span>{t('صف العملاء','Describe your clients')}</div>
        <h2 id="describe-label">{t('ابدأ بالمجال. التفاصيل نكملها معًا.','Start with a niche. Refine it as you go.')}</h2>
        <p>{t('مثل «عيادات الأسنان»، أو صف المكان والأشخاص الذين تريد التواصل معهم.','Try “dental clinics”, or describe the location and people you want to reach.')}</p>
        <form onSubmit={e=>{e.preventDefault();void prepare();}} className="search-compose-form">
          <label htmlFor="describe" className="visually-hidden">{t('وصف العملاء أو تعديل البحث','Describe clients or refine the search')}</label>
          <textarea id="describe" value={describe} onChange={e=>{setDescribe(e.target.value);setConfirmed(false);}} rows={4} maxLength={500} disabled={thinking||busy} placeholder={conversation.length?t('أضف تعديلًا، مثلًا: في دبي وأريد المالكين','Refine it, e.g. in Dubai, and I want owners'):t('أبحث عن عيادات أسنان في السعودية…','I’m looking for dental clinics in Saudi Arabia…')}/>
          <div className="compose-actions"><small>{t('تجهيز الوصف لا يخصم من رصيد النتائج.','Preparing a draft uses no result credits.')}</small><Button type="submit" variant="secondary" loading={thinking} disabled={thinking||busy||describe.trim().length<2}>{thinking?t('نجهّز البحث…','Preparing…'):conversation.length?t('تحديث البحث','Update draft'):t('تجهيز البحث','Prepare search')}</Button></div>
        </form>
        {!conversation.length&&<div className="search-examples" aria-label={t('أمثلة للبدء','Try an example')}><small>{t('جرّب مثالًا','Try an example')}</small>{[t('عيادات الأسنان','Dental clinics'),t('محلات العطور','Perfume shops'),t('شركات البرمجيات','Software companies')].map(x=><button type="button" key={x} disabled={thinking||busy} onClick={()=>void prepare(x)}>{x}<Forward size={14}/></button>)}</div>}
        <div className="search-reply" role="status" aria-live="polite" aria-atomic="true">
          {thinking?<p>{t('نفهم الوصف ونحدّث ملخص البحث…','Reading your description and updating the draft…')}</p>:aiNote?<><strong>{aiState==='prepare'?t('تم تجهيز البحث','Draft prepared'):aiState==='clarify'?t('توضيح واحد ونكمل','One detail to clarify'):aiState==='error'?t('تعذّر تجهيز الوصف','Could not prepare the draft'):t('عن البحث','About your search')}</strong><p>{aiNote}</p></>:<p>{t('البلد والعدد المختاران ظاهرَان في الملخص. لن يبدأ البحث حتى تراجعه وتضغط «ابدأ البحث».','Your country and count are shown in the summary. Searching starts only after you review and confirm it.')}</p>}
        </div>
        {!!choices.length&&<div className="chips">{choices.map(x=><button type="button" key={x} className="chip" disabled={thinking||busy} onClick={()=>void prepare(x)}>{x}</button>)}</div>}
        {conversation.length>0&&<div className="search-context"><small>{t('آخر وصف: ','Last description: ')}{conversation.filter(m=>m.role==='user').at(-1)?.content}</small><button type="button" className="text-button" disabled={thinking||busy} onClick={()=>{setConversation([]);setAiNote('');setAiState('idle');setChoices([]);setDescribe('');apply({sector:'',city:'',title:''});setEditing(false);}}>{t('وصف جديد','New description')}</button></div>}
        {aiState==='error'&&<button type="button" className="text-button" onClick={()=>chooseMethod('manual')}>{t('أكمل بتعديل التفاصيل يدويًا','Continue by editing the details')}</button>}
      </section>}
      <form onSubmit={submit} className="panel search-review" aria-labelledby="review-title">
        <div className="search-step"><span>02</span>{t('راجع وابدأ','Review and start')}</div>
        <div className="search-review-title"><h2 id="review-title">{t('ملخص البحث','Your search')}</h2>{ready&&<Badge tone="green">{t('مسودة','Draft')}</Badge>}</div>
        <h3 className="search-audience">{ready?names.label(filters.sector):method==='manual'?t('اختر المجال لبدء البحث','Choose a niche to begin'):t('بانتظار وصف عملائك','Describe your clients to begin')}</h3>
        <dl className="search-summary">
          <div><dt>{t('المكان','Location')}</dt><dd><button type="button" onClick={editDetails}>{[displayCity,filters.countries.map(names.country).join('، ')].filter(Boolean).join(' · ')}<span>{t('تعديل','Edit')}</span></button></dd></div>
          <div><dt>{t('جهة الاتصال','Contact type')}</dt><dd><button type="button" onClick={editDetails}>{companies?t('بريد الشركات','Company emails'):filters.title?names.label(filters.title):t('أشخاص داخل الشركات','People in companies')}<span>{t('تعديل','Edit')}</span></button></dd></div>
          {filters.size!=='all'&&<div><dt>{t('حجم الشركة','Company size')}</dt><dd>{filters.size} {t('موظفين','employees')}</dd></div>}
        </dl>
        <Field label={t('عدد الإيميلات المطلوبة','Emails to find')}><input type="number" min="1" max={Math.max(1,maxCount)} value={filters.count||''} onChange={e=>change({count:Number(e.target.value)})} required/></Field>
        {method==='ai'&&(<button type="button" className="text-button" aria-expanded={editing} aria-controls="search-details" onClick={()=>setEditing(!editing)}>{editing?t('إخفاء التفاصيل','Hide details'):t('تعديل المجال والتفاصيل','Edit niche and details')}<ArrowDown size={15}/></button>)}
        {method==='ai'&&editing&&manualControls}
        {!data.provider?.configured?<Notice error>{t('البحث غير متاح حاليًا. تواصل مع مالك المنصة.','Search is unavailable right now. Contact the platform owner.')}</Notice>
          :ready&&<div className={'match-count'+(currentMatch?.error||few||pending?' warn':'')} role="status"><UsersThree size={18}/><span>{status}</span></div>}
        {ready&&other&&currentMatch?.industryLabels?.length&&<p className="search-footnote">{t('تصنيف مزوّد البيانات قد يكون أوسع من وصفك. راجعه قبل البدء.','The data provider’s category may be broader than your description. Review it before starting.')}</p>}
        {error&&<Notice error>{error}</Notice>}
        {maxCount<1?<Notice error>{t('لا يوجد رصيد متاح. تواصل مع مالك المنصة لإضافة رصيد.','No credits available. Contact the platform owner to add credits.')}</Notice>:!validCount&&<Notice error>{t('العدد المتاح حاليًا من 1 إلى '+maxCount+' بريد.','You can request 1–'+maxCount+' emails right now.')} {filters.count>maxCount&&<button type="button" className="text-button" onClick={()=>change({count:maxCount})}>{t('استخدم '+maxCount,'Use '+maxCount)}</button>}</Notice>}
        {ready&&<><p className="search-footnote">{t('كريدت واحد لكل بريد جديد يصلك. لا خصم للتكرار أو النتائج غير المتاحة.','One credit per new email delivered. No charge for duplicates or unavailable results.')}</p>
          <label className="check-label"><input type="checkbox" checked={confirmed} disabled={thinking||busy||unfinishedDescription||!validCount} onChange={e=>setConfirmed(e.target.checked)}/><span>{t('راجعت البحث وأوافق على خصم حتى '+filters.count+' كريدت مقابل الإيميلات التي تصلني.','I reviewed the search and agree to use up to '+filters.count+' credits for emails delivered.')}</span></label></>}
        <div className="search-launch"><Button type="submit" loading={busy} disabled={!canStart}>{ready?t('ابدأ البحث عن '+filters.count+' بريد','Find '+filters.count+' emails'):t('ابدأ البحث','Start search')}</Button><small><Coins size={16}/>{t('الرصيد المتاح: ','Available credits: ')}<strong>{number(available)}</strong></small></div>
        {data.features?.crm&&ready&&<details className="save-audience"><summary>{t('احفظ هذا الجمهور لبحث قادم','Save this audience for later')}</summary><div className="crm-save"><Field label={t('اسم الجمهور المحفوظ','Saved audience name')}><input maxLength={80} value={audienceName} onChange={e=>setAudienceName(e.target.value)}/></Field><Button type="button" variant="secondary" disabled={busy||thinking||!audienceName.trim()||pending||!validCount} onClick={async()=>{setBusy(true);try{await api('crm/audience',{name:audienceName,filters});setAudienceName('');notify(t('حُفظ الجمهور في إدارة العملاء.','Audience saved in CRM.'));}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}}>{t('حفظ المعايير','Save criteria')}</Button></div></details>}
      </form>
    </div></>;
}

export function LeadsView({data,reload,notify}:ViewProps){
  const t=useT(),{lang}=useLang(),names=useNames(),title=useSearchTitle(),query=useSearchParams(),searchId=query.get('search'),search=data.searches.find(s=>s.id===searchId);
  const [text,setText]=useState(''),[selected,setSelected]=useState<string[]>([]),[page,setPage]=useState(1),[detail,setDetail]=useState<Contact|null>(null),[busy,setBusy]=useState(false);
  const base=searchId?data.contacts.filter(c=>c.search_id===searchId):data.contacts;
  const rows=base.filter(c=>[c.name,c.email,c.company,c.city].join(' ').toLowerCase().includes(text.toLowerCase()));
  const pages=Math.max(1,Math.ceil(rows.length/10)),activePage=Math.min(page,pages),visible=rows.slice((activePage-1)*10,activePage*10);
  const trust=(c:Contact)=>c.email_status==='demo'?t('عينة','Sample'):emailTrust(c.email_status,lang==='en');
  const role=(c:Contact)=>c.kind==='company'?t('إيميل الشركة','Company email'):c.title;
  function toggle(id:string){setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);}
  async function exportRows(){setBusy(true);try{await downloadContacts(selected.length?{ids:selected}:searchId?{searchId}:{});await reload();notify(t('تم تنزيل الملف دون خصم إضافي.','Downloaded, with no extra charge.'));}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
  return <><PageHeading title={search?title(search):t('عملائي','My contacts')}><Button variant="secondary" loading={busy} disabled={!base.length} onClick={exportRows}><DownloadSimple size={18}/>{selected.length?t('تنزيل المحدد ('+selected.length+')','Download selected ('+selected.length+')'):t('تنزيل الملف','Download file')}</Button></PageHeading>
  {search?.status==='awaiting_provider'&&<SearchProgress search={search} reload={reload}/>}
  {search&&['failed','unknown'].includes(search.status)&&<Notice error>{(search.message||(search.status==='unknown'?t('حالة الطلب غير مؤكدة. يمكنك البدء ببحث جديد.','The request status is uncertain. You can start a new search.'):t('تعذّر إكمال الطلب.','The request could not be completed.')))+' '+t('لم يُخصم كريدت لنتائج لم تصلك.','No credit was charged for results you did not receive.')}</Notice>}
  {search?.status==='partial'&&<Notice>{search.message||t('لم نجد بريدًا كافيًا بهذه المعايير.','Not enough emails for these filters.')} {t('لم يُخصم إلا ما وصلك.','You paid only for what you received.')} <Link href={'/search?from='+search.id} className="text-link">{t('عدّل المعايير وابحث مجددًا','Edit and search again')}</Link></Notice>}
  {search&&<div className="result-summary"><span><CheckCircle size={20}/><strong>{search.delivered}</strong> {t('بريد جديد','new emails')}</span><span><Coins size={18}/>{search.delivered} {t('كريدت','credits')}</span>{search.duplicates>0&&<span>{search.duplicates} {t('مكرر لم يُخصم','duplicates, not charged')}</span>}<Link href="/leads" className="text-link">{t('كل عملائي','All my contacts')} <Forward/></Link></div>}
  {!(search?.status==='awaiting_provider'&&!base.length)&&<section className="panel table-panel"><div className="table-toolbar"><div className="search-input"><MagnifyingGlass size={19}/><input aria-label={t('ابحث في العملاء','Search contacts')} placeholder={t('ابحث بالاسم أو الشركة أو البريد…','Search by name, company or email…')} value={text} onChange={e=>{setText(e.target.value);setPage(1);}}/></div><span className="result-count">{rows.length} {t('نتيجة','results')}</span></div>
  {rows.length?<><div className="table-scroll"><table className="leads-table"><thead><tr><th className="check-cell"><input aria-label={t('تحديد الصفحة','Select page')} type="checkbox" checked={visible.length>0&&visible.every(c=>selected.includes(c.id))} onChange={e=>setSelected(e.target.checked?[...new Set([...selected,...visible.map(c=>c.id)])]:selected.filter(id=>!visible.some(c=>c.id===id)))}/></th><th>{t('الاسم','Name')}</th><th>{t('الشركة','Company')}</th><th>{t('البريد','Email')}</th><th>{t('الموقع','Location')}</th><th/></tr></thead><tbody>{visible.map((c,i)=><tr key={c.id}><td><input aria-label={t('تحديد ','Select ')+c.name} type="checkbox" checked={selected.includes(c.id)} onChange={()=>toggle(c.id)}/></td><td><button className="contact-name" onClick={()=>setDetail(c)}><span className={'avatar avatar-'+i%4}>{c.name.split(' ').map(s=>s[0]).join('').slice(0,2)}</span><span><strong>{c.name}</strong><small>{role(c)}</small></span></button></td><td><strong className="company-name">{c.company}</strong><small>{names.label(c.sector)}</small></td><td><span className="email-text" dir="ltr">{c.email}</span><Badge tone={c.email_status==='PROBABLE'?'neutral':'green'}>{trust(c)}</Badge></td><td><span className="location-cell"><MapPin size={14}/>{c.city||'—'}</span><small>{names.place(c.country)}</small></td><td><button className="icon-button" title={t('التفاصيل','Details')} aria-label={t('تفاصيل ','Details of ')+c.name} onClick={()=>setDetail(c)}><Open/></button></td></tr>)}</tbody></table></div>
    <div className="pagination"><span>{(activePage-1)*10+1}–{Math.min(activePage*10,rows.length)} / {rows.length}</span><div><Button variant="ghost" disabled={activePage===1} onClick={()=>setPage(activePage-1)}>{t('السابق','Previous')}</Button><span className="page-number">{activePage}</span><Button variant="ghost" disabled={activePage===pages} onClick={()=>setPage(activePage+1)}>{t('التالي','Next')}</Button></div></div></>
  :<Empty title={search?.status==='awaiting_provider'?t('بانتظار الإيميلات','Waiting for emails'):search?t('لا توجد نتائج جديدة لهذا البحث','No new results for this search'):t('لا توجد نتائج','No results')} description={search?.status==='awaiting_provider'?t('أبقِ الصفحة مفتوحة أو عد إليها من سجل البحث.','Keep this page open, or come back from the history.'):search?t('ربما حُفظت النتائج سابقًا، أو المعايير ضيقة. لم يُخصم شيء.','The results may be saved already, or the filters are narrow. Nothing was charged.'):t('ابدأ بحثًا جديدًا.','Start a new search.')}><Link href="/search" className="button secondary">{t('بحث جديد','New search')} <MagnifyingGlass size={16}/></Link></Empty>}
  </section>}
  {base.length>0&&<p className="export-tip">{t('نزّل الملف وارفعه في نظام إدارة العملاء عندك. بجانب كل بريد درجة تأكده (٩٩٪ أو ٩٥٪).','Download the file and import it into your CRM. Each email shows how sure it is (99% or 95%).')}</p>}
  {detail&&<Modal title={detail.name} onClose={()=>setDetail(null)}><div className="contact-detail"><p>{role(detail)} · {detail.company}</p><Badge tone="green">{trust(detail)}</Badge><dl><dt>{t('البريد','Email')}</dt><dd dir="ltr">{detail.email}<button className="icon-button" aria-label={t('نسخ البريد','Copy email')} onClick={async()=>{try{await navigator.clipboard.writeText(detail.email);notify(t('تم نسخ البريد.','Email copied.'));}catch{notify(t('تعذّر النسخ. حدّد النص وانسخه.','Copy failed. Select the text and copy it.'),true);}}}><Copy size={17}/></button></dd><dt>{t('الموقع','Location')}</dt><dd>{[detail.city,names.place(detail.country)].filter(Boolean).join(lang==='en'?', ':'، ')}</dd><dt>{t('المجال','Field')}</dt><dd>{names.label(detail.sector)}</dd>{detail.size&&<><dt>{t('حجم الشركة','Company size')}</dt><dd>{detail.size} {t('موظفين','employees')}</dd></>}<dt>{t('موقع الشركة','Website')}</dt><dd>{detail.website?<a href={detail.website} target="_blank" rel="noreferrer" className="text-link" dir="ltr">{detail.website} <ArrowSquareOut size={16}/></a>:t('غير متاح','Not available')}</dd><dt>{t('تاريخ الحفظ','Saved on')}</dt><dd>{date(detail.created_at)}</dd></dl></div></Modal>}</>;
}

export function HistoryView({data}:ViewProps){
  const t=useT(),title=useSearchTitle();
  return <><PageHeading title={t('سجل البحث','Search history')}/><section className="panel table-panel">{data.searches.length?<div className="table-scroll"><table><thead><tr><th>{t('البحث','Search')}</th><th>{t('التاريخ','Date')}</th><th>{t('وصل / المطلوب','Received / requested')}</th><th>{t('الحالة','Status')}</th><th/></tr></thead><tbody>{data.searches.map(s=><tr key={s.id}><td><strong>{title(s)}</strong></td><td>{date(s.created_at)}</td><td>{s.delivered} / {s.requested}</td><td><SearchBadge s={s}/></td><td><div className="row-actions"><Link href={'/leads?search='+s.id} className="text-link">{s.status==='awaiting_provider'?t('متابعة','Follow'):t('النتائج','Results')} <Open size={15}/></Link><Link href={'/search?from='+s.id} className="icon-button" title={t('ابحث مجددًا بهذه المعايير','Search again with these filters')}><ClockCounterClockwise size={18}/></Link></div></td></tr>)}</tbody></table></div>:<Empty title={t('لا توجد عمليات بحث بعد','No searches yet')} description={t('يظهر هنا كل بحث تجريه.','Every search you run shows here.')}/>}</section></>;
}
export function CreditsView({data}:ViewProps){
  const t=useT();
  return <><PageHeading title={t('رصيدك','Your credits')} description={t('كريدت واحد لكل بريد يصلك. البحث الذي لا يجد شيئًا لا يكلّفك.','One credit per email you receive. A search that finds nothing costs nothing.')}/><div className="credit-overview"><div><span>{t('الرصيد المتاح','Available')}</span><strong>{number(data.wallet?.available??data.user.balance)}</strong></div>{data.wallet&&<><div><span>{t('الرصيد الكلي','Total balance')}</span><strong>{number(data.wallet.total)}</strong></div><div><span>{t('المحجوز لبحث جارٍ','Reserved for running searches')}</span><strong>{number(data.wallet.reserved)}</strong></div></>}<div><span>{t('البريد المستلم','Emails received')}</span><strong>{data.contacts.length}</strong></div></div><section className="panel table-panel"><div className="section-title"><h2>{t('حركة الرصيد','Credit history')}</h2></div><div className="table-scroll"><table><thead><tr><th>{t('العملية','Entry')}</th><th>{t('التفاصيل','Details')}</th><th>{t('التاريخ','Date')}</th><th>{t('التغيير','Change')}</th><th>{t('الرصيد بعدها','Balance after')}</th></tr></thead><tbody>{data.ledger.map(l=><tr key={l.id}><td><span className={'ledger-icon '+(l.amount<0?'debit':'')}><ArrowDown size={16}/></span>{l.kind==='debit'?t('تسليم بريد','Email delivered'):l.kind==='grant'?t('إضافة رصيد','Credits added'):t('تصحيح الرصيد','Balance correction')}</td><td>{l.reason}</td><td>{date(l.created_at)}</td><td><span className={l.amount>=0?'positive':''} dir="ltr">{l.amount>0?'+':''}{l.amount}</span></td><td>{number(l.balance_after)}</td></tr>)}</tbody></table></div></section></>;
}
export function SettingsView({data,reload,notify}:ViewProps){
  const t=useT(),[name,setName]=useState(data.user.name),[current,setCurrent]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false);
  const [codePassword,setCodePassword]=useState(''),[code,setCode]=useState(''); // the owner's recovery code, shown once
  async function createCode(e:React.FormEvent){e.preventDefault();setBusy(true);try{setCode((await api<{code:string}>('admin/recovery-code',{password:codePassword})).code);setCodePassword('');await reload();}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
  async function save(e:React.FormEvent){e.preventDefault();setBusy(true);try{await api('profile',{name});await reload();notify(t('تم حفظ بياناتك.','Saved.'));}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
  async function change(e:React.FormEvent){e.preventDefault();setBusy(true);try{await api('password',{current,password});setCurrent('');setPassword('');notify(t('تم تغيير كلمة المرور وإنهاء الجلسات السابقة.','Password changed; other sessions were signed out.'));}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
  return <><PageHeading title={t('الإعدادات','Settings')}/><div className="settings-grid"><section className="panel"><h2>{t('حسابك','Your account')}</h2><form className="form-stack" onSubmit={save}><Field label={t('الاسم','Name')}><input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={60} required/></Field><Field label={t('البريد الإلكتروني','Email')}><input dir="ltr" value={data.user.email} disabled/></Field><Button loading={busy} type="submit">{t('حفظ','Save')} <Check size={18}/></Button></form></section><section className="panel"><h2>{t('كلمة المرور','Password')}</h2><form className="form-stack" onSubmit={change}><Field label={t('كلمة المرور الحالية','Current password')}><input type="password" autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)} required/></Field><Field label={t('كلمة المرور الجديدة','New password')} hint={t('10 أحرف على الأقل.','At least 10 characters.')}><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} required/></Field><Button variant="secondary" loading={busy} type="submit">{t('تغيير كلمة المرور','Change password')}</Button></form></section>
    {data.admin&&<section className="panel"><h2>{t('رمز الاسترجاع','Recovery code')}</h2><p>{t('إذا نسيت كلمة المرور، ادخل بهذا الرمز من «نسيت كلمة المرور؟» في صفحة الدخول. يظهر مرة واحدة، والرمز الجديد يلغي القديم.','If you forget your password, use this code from “Forgot your password?” on the sign-in page. It is shown once, and a new code cancels the old one.')}</p>
      {code?<div className="form-stack"><Notice>{t('احفظه الآن في مكان آمن، مثل مدير كلمات المرور: لن يظهر مرة أخرى.','Save it somewhere safe now, such as a password manager: it will not be shown again.')}</Notice><Field label={t('رمزك','Your code')}><input readOnly dir="ltr" value={code} onFocus={e=>e.target.select()}/></Field><Button variant="secondary" onClick={()=>setCode('')}>{t('حفظته','Saved it')}</Button></div>:
      <form className="form-stack" onSubmit={createCode}><Badge tone={data.admin.recovery?'green':'amber'}>{data.admin.recovery?t('لديك رمز فعّال','You have an active code'):t('لا يوجد رمز بعد','No code yet')}</Badge><Field label={t('كلمة المرور الحالية','Current password')}><input type="password" autoComplete="current-password" value={codePassword} onChange={e=>setCodePassword(e.target.value)} required/></Field><Button variant="secondary" loading={busy} type="submit">{data.admin.recovery?t('إنشاء رمز جديد','Create a new code'):t('إنشاء الرمز','Create the code')}</Button></form>}</section>}
  </div></>;
}
