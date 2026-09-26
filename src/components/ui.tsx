'use client';
import { useEffect, useRef, useId } from 'react';
import { ArrowUpLeft, CircleNotch, X, MagnifyingGlass, CheckCircle, WarningCircle } from '@phosphor-icons/react';
export function Brand({compact=false}:{compact?:boolean}) {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">c</span><span className="brand-text" dir="ltr">clowzy</span>{!compact && <span className="brand-caption">مساحة الفرص</span>}</div>;
}
export function Button({children,loading=false,variant='primary',arrow=false,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{loading?:boolean;variant?:'primary'|'secondary'|'ghost'|'danger';arrow?:boolean}) {
  return <button {...props} disabled={props.disabled || loading} className={'button '+variant+' '+(props.className||'')}>{loading && <CircleNotch className="spin" size={18}/>}<span>{children}</span>{arrow && <span className="button-icon"><ArrowUpLeft size={18}/></span>}</button>;
}
export function Badge({children,tone='neutral'}:{children:React.ReactNode;tone?:'green'|'amber'|'neutral'}) { return <span className={'badge '+tone}>{children}</span>; }
export function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={onClose} onClick={e=>{if(e.target===ref.current)onClose();}}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
export function Empty({title,description,children}:{title:string;description:string;children?:React.ReactNode}) {
  return <div className="empty"><span><MagnifyingGlass size={30} weight="light"/></span><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function Notice({children,error=false}:{children:React.ReactNode;error?:boolean}) {
  return <div className={'notice '+(error?'error':'')} role={error?'alert':undefined}>{error?<WarningCircle size={20}/>:<CheckCircle size={20}/>}<span>{children}</span></div>;
}
export function PageHeading({eyebrow,title,description,children}:{eyebrow:string;title:string;description:string;children?:React.ReactNode}) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><div className="heading-action">{children}</div></div>;
}
export function Field({label,children,hint}:{label:string;children:React.ReactNode;hint?:string}) {return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
