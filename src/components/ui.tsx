'use client';
import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { ArrowLeft, ArrowUpLeft, CircleNotch, X, MagnifyingGlass, CheckCircle, WarningCircle, Moon, Sun } from '@phosphor-icons/react';
import { useT } from './lang';
export function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">c</span><span className="brand-text" dir="ltr">clowzy</span></div>;
}
// "Go on" arrows point left in Arabic; the stylesheet mirrors them in English.
export const Forward = ({ size = 16 }: { size?: number }) => <ArrowLeft className="fwd" size={size}/>;
export const Open = ({ size = 18 }: { size?: number }) => <ArrowUpLeft className="fwd" size={size}/>;
export function Button({children,loading=false,variant='primary',...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{loading?:boolean;variant?:'primary'|'secondary'|'ghost'|'danger'}) {
  return <button {...props} disabled={props.disabled || loading} className={'button '+variant+' '+(props.className||'')}>{loading && <CircleNotch className="spin" size={18}/>}<span>{children}</span></button>;
}
export function Badge({children,tone='neutral'}:{children:React.ReactNode;tone?:'green'|'amber'|'neutral'}) { return <span className={'badge '+tone}>{children}</span>; }
export function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null),titleId=useId(),t=useT();
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={onClose} onClick={e=>{if(e.target===ref.current)onClose();}}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label={t('إغلاق','Close')} onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
export function Empty({title,description,children}:{title:string;description:string;children?:React.ReactNode}) {
  return <div className="empty"><span><MagnifyingGlass size={30} weight="light"/></span><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function Notice({children,error=false}:{children:React.ReactNode;error?:boolean}) {
  return <div className={'notice '+(error?'error':'')} role={error?'alert':undefined}>{error?<WarningCircle size={20}/>:<CheckCircle size={20}/>}<span>{children}</span></div>;
}
export function PageHeading({title,description,children}:{title:string;description?:string;children?:React.ReactNode}) {
  return <div className="page-heading"><div><h1>{title}</h1>{description&&<p>{description}</p>}</div>{children&&<div className="heading-action">{children}</div>}</div>;
}
export function Field({label,children,hint}:{label:string;children:React.ReactNode;hint?:string}) {
  const id=useId();
  return <label className="field"><span id={id}>{label}</span>{isValidElement<{'aria-labelledby'?:string;'aria-describedby'?:string}>(children)?cloneElement(children,{'aria-labelledby':id,'aria-describedby':hint?id+'-hint':undefined}):children}{hint&&<small id={id+'-hint'}>{hint}</small>}</label>;
}
// Same rule as the pre-paint script in layout.tsx: saved choice, else light.
function savedTheme(){let t:string|null=null;try{t=localStorage.getItem('theme');}catch{}return t==='light'||t==='dark'?t:'light';}
export function ThemeToggle() {
  const t=useT();
  // React Strict Mode (development only) clears data-theme on its remount; re-apply before paint. No-op in production.
  useLayoutEffect(()=>{document.documentElement.dataset.theme||=savedTheme();},[]);
  function toggle(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('theme',next);}catch{}}
  // The label names the target theme; CSS shows only the pair that matches the current theme.
  return <button type="button" className="icon-button" onClick={toggle} title={t('الوضع الفاتح أو الداكن','Light or dark mode')}><Moon className="when-light" size={20} aria-hidden/><span className="when-light visually-hidden">{t('التحويل إلى الوضع الداكن','Switch to dark mode')}</span><Sun className="when-dark" size={20} aria-hidden/><span className="when-dark visually-hidden">{t('التحويل إلى الوضع الفاتح','Switch to light mode')}</span></button>;
}
