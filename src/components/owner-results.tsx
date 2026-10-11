'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import type { Contact, Search } from '@/lib/contracts';
import { api, date, downloadContacts } from '@/lib/client';
import { Button, Empty } from './ui';
import { SearchBadge } from './member-views';
import { useT } from './lang';

// The owner's view of one member's results (client 2026-10-11): each search, its contacts, its file, and a stop while it runs.
export function MemberResults({userId,notify}:{userId:string;notify:(message:string,error?:boolean)=>void}){
  const t=useT(),[searches,setSearches]=useState<Search[]|null>(null),[open,setOpen]=useState(''),[contacts,setContacts]=useState<Contact[]>([]),[busy,setBusy]=useState('');
  const load=useCallback(()=>api<Search[]>('admin/searches?userId='+userId).then(setSearches,(e:Error)=>notify(e.message,true)),[userId,notify]);
  useEffect(()=>{void load();},[load]);
  async function show(id:string){
    if(open===id){setOpen('');return;}
    setBusy('view:'+id);
    try{setContacts(await api<Contact[]>('admin/contacts?searchId='+id));setOpen(id);}catch(e){notify((e as Error).message,true);}finally{setBusy('');}
  }
  const download=(options:{userId?:string;searchId?:string})=>downloadContacts(options,'admin/export').catch((e:Error)=>notify(e.message,true));
  async function stop(id:string){
    if(!window.confirm(t('إيقاف هذا البحث؟ نسلّم للمشترك ما وصل من الإيميلات ثم نغلقه.','Stop this search? The member gets the emails that arrived, then it closes.')))return;
    setBusy('stop:'+id);
    try{await api('search/stop',{searchId:id});await load();}catch(e){notify((e as Error).message,true);}finally{setBusy('');}
  }
  if(!searches)return <p>{t('جارٍ تحميل بحوثه…','Loading searches…')}</p>;
  if(!searches.length)return <Empty title={t('لا بحوث بعد','No searches yet')} description={t('لم يُجرِ هذا المشترك أي بحث.','This member has not run a search.')}/>;
  return <section className="owner-results">
    <div className="section-title"><h3>{t('بحوثه ونتائجه','Searches and results')}</h3><Button variant="ghost" onClick={()=>download({userId})}><DownloadSimple size={18}/>{t('تنزيل كل نتائجه','Download all')}</Button></div>
    <div className="table-scroll"><table><thead><tr><th>{t('البحث','Search')}</th><th>{t('الحالة','Status')}</th><th>{t('وصل','Received')}</th><th>{t('التاريخ','Date')}</th><th/></tr></thead><tbody>
      {searches.map(s=><Fragment key={s.id}>
        <tr><td>{s.title}</td><td><SearchBadge s={s}/></td><td>{s.delivered+' / '+s.requested}</td><td>{date(s.created_at)}</td><td><div className="row-actions">
          {s.delivered>0&&<Button variant="ghost" loading={busy==='view:'+s.id} onClick={()=>show(s.id)}>{open===s.id?t('إخفاء','Hide'):t('عرض','View')}</Button>}
          {s.delivered>0&&<Button variant="ghost" onClick={()=>download({searchId:s.id})}>{t('تنزيل','Download')}</Button>}
          {s.status==='awaiting_provider'&&<Button variant="danger" loading={busy==='stop:'+s.id} onClick={()=>stop(s.id)}>{t('إيقاف','Stop')}</Button>}
        </div></td></tr>
        {open===s.id&&<tr><td colSpan={5} className="owner-contacts"><table><thead><tr><th>{t('الاسم','Name')}</th><th>{t('البريد','Email')}</th><th>{t('الشركة','Company')}</th><th>{t('المسمى','Title')}</th><th>{t('الموقع','Location')}</th></tr></thead><tbody>
          {contacts.map(c=><tr key={c.id}><td>{c.name||c.company}</td><td dir="ltr">{c.email}</td><td>{c.company}</td><td>{c.title}</td><td>{[c.city,c.country].filter(Boolean).join('، ')}</td></tr>)}
        </tbody></table></td></tr>}
      </Fragment>)}
    </tbody></table></div>
  </section>;
}
