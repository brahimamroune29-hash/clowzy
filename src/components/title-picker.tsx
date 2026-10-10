'use client';
import { useId, useRef, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { findTitles, labelsEn, MAX_TITLES, TITLE_VARIANTS } from '@/lib/contracts';
import { useLang, useNames, useT } from './lang';

// Job titles as the activity field works (client 2026-10-09): type, pick from what matches, up to three as removable tags;
// words that match no listed title can be used as they are. The typed words (query) belong to the search form: they hold the
// search until picked, used as typed or cleared, even while this field is hidden (assistant details closed), so they never drop.
export function TitlePicker({value,onChange,query,onQuery,disabled=false}:{value:string[];onChange:(value:string[])=>void;query:string;onQuery:(query:string)=>void;disabled?:boolean}) {
  const t=useT(),names=useNames(),{lang}=useLang(),id=useId(),input=useRef<HTMLInputElement>(null),tags=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[active,setActive]=useState(0),setQuery=onQuery;
  const typed=query.trim(),full=value.length>=MAX_TITLES,same=(x:string)=>x.toLowerCase()===typed.toLowerCase();
  // The listed title the words name exactly (its Arabic or English name, or a provider form: «CEO»), chosen already or not.
  const exact=typed?findTitles(typed).find(x=>same(x)||same(names.label(x))||TITLE_VARIANTS[x].some(same)):undefined;
  const matches=findTitles(query).filter(x=>!value.includes(x)),chosen=value.some(x=>same(x)||same(names.label(x)))||!!exact&&value.includes(exact);
  // The box leaves when three are chosen and comes back when one is removed: focus follows to what is still there.
  const focusLater=(el:()=>HTMLElement|null|undefined)=>requestAnimationFrame(()=>el()?.focus());
  function add(title:string){
    if(full||value.includes(title))return;
    onChange([...value,title]);setQuery('');setActive(0);
    if(value.length+1>=MAX_TITLES){setOpen(false);focusLater(()=>[...tags.current?.querySelectorAll<HTMLButtonElement>('button')??[]].at(-1));}else focusLater(()=>input.current);
  }
  function remove(title:string){onChange(value.filter(y=>y!==title));focusLater(()=>input.current);}
  return <div className="field niche-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
    <label htmlFor={full?undefined:id+'-input'}>{t('المسمى الوظيفي','Job title')}</label>
    {value.length>0&&<div className="chips" ref={tags}>{value.map(x=><span key={x} className="chip on">{names.label(x)}<button type="button" disabled={disabled} aria-label={t('إزالة ','Remove ')+names.label(x)} onClick={()=>remove(x)}><X size={13}/></button></span>)}</div>}
    {full?<small role="status">{t('حتى ثلاثة مسميات. احذف واحدًا لإضافة غيره.','Up to three titles. Remove one to add another.')}</small>
    :<div className="title-search">
      <div className="niche-search"><MagnifyingGlass size={18}/><input id={id+'-input'} ref={input} value={query} disabled={disabled} role="combobox" aria-expanded={open} aria-controls={id+'-options'} aria-autocomplete="list"
        aria-activedescendant={open&&matches.length?id+'-option-'+Math.min(active,matches.length-1):undefined} placeholder={t('اكتب مسمى، مثلًا: مدير التسويق','Type a title, e.g. marketing manager')} maxLength={60}
        onFocus={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setActive(0);setOpen(true);}} onKeyDown={e=>{
          if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);const next=matches.length?(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length:0;setActive(next);document.getElementById(id+'-option-'+next)?.scrollIntoView({block:'nearest'});}
          if(e.key==='Enter'){e.preventDefault();if(matches.length)add(matches[Math.min(active,matches.length-1)]);else if(typed.length>=2&&!chosen&&!exact)add(typed);}
          if(e.key==='Escape'){e.preventDefault();setOpen(false);}
        }}/>{query&&<button type="button" className="icon-button" aria-label={t('مسح البحث','Clear search')} onClick={()=>{setQuery('');setActive(0);input.current?.focus();}}><X size={15}/></button>}</div>
      {!value.length&&!open&&<small>{t('اتركها فارغة لكل المسميات، أو اختر حتى ثلاثة.','Leave empty for all titles, or choose up to three.')}</small>}
      {open&&<div className="niche-menu">
        <div id={id+'-options'} role="listbox" aria-label={t('المسميات المقترحة','Suggested titles')} className="niche-options">
          {matches.map((x,i)=><button type="button" key={x} id={id+'-option-'+i} role="option" aria-selected={i===Math.min(active,matches.length-1)} className={'niche-option'+(i===active?' active':'')} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>add(x)}>
            <span><strong>{names.label(x)}</strong>{lang==='ar'&&<small dir="ltr">{labelsEn[x]}</small>}</span></button>)}
          {!matches.length&&<p className="niche-empty">{chosen?t('هذا المسمى مختار.','This title is already chosen.'):typed.length<2?t('لا يوجد مسمى بهذه الكلمات في القائمة.','No listed title matches.'):t('لا يوجد مسمى بهذه الكلمات في القائمة. يمكنك استخدامه كما كتبته.','No listed title matches. You can use it as typed.')}</p>}
        </div>
        {typed.length>=2&&!exact&&!chosen&&<button type="button" className="niche-custom" disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>add(typed)}>{t('استخدم «'+typed+'» كمسمى','Use “'+typed+'” as a title')}</button>}
      </div>}
    </div>}
  </div>;
}
