'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, CaretDown, MagnifyingGlass, X } from '@phosphor-icons/react';
import { fields, type FieldName } from '@/lib/contracts';
import { findNiches, nicheOf, niches } from '@/lib/niches';
import { useLang, useNames, useT } from './lang';

export function NichePicker({value,onChange,onPendingChange,disabled=false}:{value:string;onChange:(value:string)=>void;onPendingChange:(pending:boolean)=>void;disabled?:boolean}) {
  const t=useT(),names=useNames(),{lang}=useLang(),id=useId(),input=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[group,setGroup]=useState(''),[active,setActive]=useState(0);
  const matches=findNiches(query,group),picked=nicheOf(value);
  const groups=[...new Set(niches.map(n=>n.field))];
  useEffect(()=>{onPendingChange(open&&!!query.trim());},[open,query,onPendingChange]);
  useEffect(()=>()=>onPendingChange(false),[onPendingChange]);
  function choose(label:string){onChange(label);setQuery('');setOpen(false);onPendingChange(false);requestAnimationFrame(()=>document.getElementById(id+'-trigger')?.focus());}
  function show(){setQuery('');setGroup('');setActive(0);setOpen(true);requestAnimationFrame(()=>input.current?.focus());}
  return <div className="field niche-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)){setOpen(false);setQuery('');}}}>
    <label htmlFor={id+'-trigger'}>{t('النشاط الذي تريد الوصول إليه','Business activity to reach')}</label>
    <button id={id+'-trigger'} type="button" className="niche-trigger" disabled={disabled} aria-expanded={open} aria-controls={id+'-options'} onClick={()=>open?setOpen(false):show()}>
      <span>{value?names.label(value):t('اختر نشاطًا أو ابحث باسمه','Choose an activity or search by name')}</span><CaretDown size={17}/>
    </button>
    {open&&<div className="niche-menu">
      <div className="niche-search"><MagnifyingGlass size={18}/><input ref={input} value={query} disabled={disabled} role="combobox" aria-expanded={open} aria-controls={id+'-options'} aria-autocomplete="list" aria-activedescendant={matches.length?id+'-option-'+Math.min(active,matches.length-1):undefined} aria-label={t('ابحث عن نشاط','Search business activities')} placeholder={t('مثلًا: أسنان، عقارات، طاقة شمسية','e.g. dental, real estate, solar')} maxLength={60} onChange={e=>{setQuery(e.target.value);setActive(0);}} onKeyDown={e=>{
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const next=matches.length?(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length:0;setActive(next);document.getElementById(id+'-option-'+next)?.scrollIntoView({block:'nearest'});}
        if(e.key==='Enter'){e.preventDefault();if(matches.length)choose(matches[Math.min(active,matches.length-1)].label);}
        if(e.key==='Escape'){e.preventDefault();setOpen(false);setQuery('');document.getElementById(id+'-trigger')?.focus();}
      }}/>{query&&<button type="button" className="icon-button" aria-label={t('مسح البحث','Clear search')} onClick={()=>{setQuery('');setActive(0);input.current?.focus();}}><X size={15}/></button>}</div>
      <select disabled={disabled} aria-label={t('تصفية الأنشطة حسب المجال','Filter activities by category')} value={group} onChange={e=>{setGroup(e.target.value);setActive(0);}}><option value="">{t('كل المجالات','All categories')}</option>{groups.map(g=><option key={g} value={g}>{names.label(g)}</option>)}</select>
      <div id={id+'-options'} role="listbox" aria-label={t('الأنشطة المقترحة','Suggested activities')} className="niche-options">
        {matches.map((n,i)=><button type="button" key={n.label} id={id+'-option-'+i} role="option" aria-selected={value===n.label} className={'niche-option'+(i===active?' active':'')} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(n.label)}><span><strong>{names.label(n.label)}</strong><small>{names.label(n.field)}</small></span>{value===n.label&&<Check size={18}/>}</button>)}
        {!matches.length&&<p className="niche-empty">{t('لم نجد نشاطًا بهذه الكلمات. جرّب اسمًا آخر أو استخدم نشاطًا مخصصًا.','No activity matches. Try another name or use a custom activity.')}</p>}
      </div>
      {query.trim().length>=2&&<button type="button" className="niche-custom" disabled={disabled} onClick={()=>choose(query.trim())}>{t('استخدم «'+query.trim()+'» كنشاط مخصص','Use “'+query.trim()+'” as a custom activity')}</button>}
    </div>}
    {picked&&<div className="niche-opportunity"><strong>{t('خدمات يمكنك تقديمها لهذا النشاط','Services you could offer this business')}</strong><p>{lang==='en'?picked.servicesEn:picked.services}</p><small>{t('أمثلة لعروضك التجارية، وليست تكاملات ينفّذها البحث.','Examples for your sales offer; these are not search integrations.')}</small></div>}
    <details className="niche-extra"><summary>{t('أنشطة وتصنيفات إضافية','Additional activities and categories')}</summary><select aria-label={t('اختر تصنيفًا إضافيًا','Choose an additional category')} value="" disabled={disabled} onChange={e=>choose(e.target.value)}><option value="" disabled>{t('اختر من التصنيفات الأخرى','Choose another category')}</option>{(Object.keys(fields) as FieldName[]).map(f=><optgroup key={f} label={names.label(f)}><option value={f}>{t('كل ','All ')+names.label(f)}</option>{fields[f].filter(s=>!nicheOf(s)).map(s=><option key={s} value={s}>{names.label(s)}</option>)}</optgroup>)}</select></details>
  </div>;
}
