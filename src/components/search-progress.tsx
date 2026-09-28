'use client';
import { useEffect, useState } from 'react';
import type { Search } from '@/lib/contracts';
import { api } from '@/lib/client';
import { Button, Notice } from './ui';
export function SearchProgress({search,reload}:{search:Search;reload:()=>Promise<void>}) {
  const [message,setMessage]=useState(search.message || 'جارٍ جلب الإيميلات والتحقق منها…');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    const began=Date.now();
    async function poll(){
      try {
        const value=await api<Search>('search/poll',{searchId:search.id});
        if(!active)return;
        if(value.message)setMessage(value.message);
        if(value.status!=='awaiting_provider'){await reload();return;}
      }catch(e){if(active)setMessage((e as Error).message);}
      if(active && Date.now()-began<20*60*1000)timer=setTimeout(poll,6000);
      else if(active)setMessage('ما زال الطلب محفوظًا. اضغط متابعة لتحديث حالته، أو عد إليه لاحقًا من سجل البحث.');
    }
    void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[search.id,reload,retry]);
  return <Notice><span role="status">{message} </span><Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>متابعة الحالة</Button><small>لن نعيد إرسال طلب البحث. كريدت المنصة يُخصم عند حفظ بريد جديد فقط.</small></Notice>;
}
