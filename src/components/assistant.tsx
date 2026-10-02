'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatCircleDots, PaperPlaneTilt, X } from '@phosphor-icons/react';
import { assistForm, type AssistReply, type AssistMessage } from '@/lib/contracts';
import { api } from '@/lib/client';
import { Button } from './ui';
import { useT } from './lang';

// The member's helper: answers questions about the platform, and turns "who I want to reach" into a ready search.
export function Assistant() {
  const t = useT(), router = useRouter();
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<(AssistMessage & { search?: AssistReply['search'] })[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages, open]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next); setText(''); setBusy(true);
    try {
      const recent = next.slice(-8);
      while (recent[0]?.role === 'assistant') recent.shift(); // a conversation starts with the member
      const previous = [...messages].reverse().find(m => m.search)?.search;
      const r = await api<AssistReply>('assist', { context: previous ? assistForm(previous, 50) : undefined, messages: recent.map(({ role, content }) => ({ role, content: content.slice(0, 1200) })) });
      setMessages([...next, { role: 'assistant', content: r.reply, search: r.search }]);
    } catch (e) { setMessages([...next, { role: 'assistant', content: (e as Error).message }]); }
    finally { setBusy(false); }
  }
  function openSearch(search: NonNullable<AssistReply['search']>) {
    setOpen(false);
    router.push('/search?ai=' + encodeURIComponent(JSON.stringify(search)));
  }
  if (!open) return <button className="assistant-fab" onClick={() => setOpen(true)} aria-label={t('المساعد', 'Assistant')}><ChatCircleDots size={24}/><span>{t('المساعد', 'Assistant')}</span></button>;
  return <section className="assistant" aria-label={t('المساعد', 'Assistant')}>
    <div className="assistant-head"><strong>{t('المساعد', 'Assistant')}</strong><button className="icon-button" aria-label={t('إغلاق', 'Close')} onClick={() => setOpen(false)}><X size={18}/></button></div>
    <div className="assistant-body" role="log" aria-live="polite">
      <p className="assistant-msg">{t('أهلًا! اسألني عن المنصة، أو صف لي عملاءك (مثلًا: عيادات أسنان في دبي) وأجهّز لك البحث.', 'Hi! Ask me about the platform, or describe your clients (e.g. dental clinics in Dubai) and I will set up the search.')}</p>
      {messages.map((m, i) => <div key={i} className={'assistant-msg' + (m.role === 'user' ? ' mine' : '')}><p>{m.content}</p>{m.search && <Button variant="secondary" onClick={() => openSearch(m.search!)}>{t('افتح هذا البحث', 'Open this search')}</Button>}</div>)}
      {busy && <p className="assistant-msg muted">{t('يكتب…', 'Typing…')}</p>}
      <div ref={end}/>
    </div>
    <form className="assistant-form" onSubmit={send}><input value={text} onChange={e => setText(e.target.value)} maxLength={500} placeholder={t('اكتب سؤالك أو صف عملاءك…', 'Ask, or describe your clients…')} aria-label={t('رسالتك', 'Your message')}/><button className="icon-button" type="submit" disabled={busy || !text.trim()} aria-label={t('إرسال', 'Send')}><PaperPlaneTilt className="fwd-send" size={20}/></button></form>
  </section>;
}
