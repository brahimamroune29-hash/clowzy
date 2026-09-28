'use client';
import { useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { api } from '@/lib/client';
import Link from 'next/link';
import { Brand, Button, Notice } from './ui';

// ponytail: plain-language terms for launch; a lawyer in the target GCC markets should review them before scaling.
const TERMS_VERSION = '2026-09-28';
const sections: [string, string][] = [
  ['الخدمة', 'منصة لاكتشاف جهات اتصال مهنية وبريد عمل من مزوّدي بيانات تجاريين، لأغراض التواصل التجاري بين الشركات.'],
  ['مسؤوليتك عن الإرسال', 'أنت وحدك مسؤول عن أي رسالة ترسلها لجهات الاتصال، وعن الالتزام بقوانين حماية البيانات ومكافحة الرسائل غير المرغوبة في بلد المستلم. في دول الخليج تشترط قوانين كثيرة موافقة مسبقة على الرسائل التسويقية. في كل رسالة: عرّف بنفسك، وضع طريقة سهلة لإلغاء الاشتراك، وتوقف فورًا عن مراسلة من يطلب ذلك.'],
  ['الاستخدام المسموح', 'البيانات لتواصل نشاطك المهني فقط. يُمنع بيعها أو نشرها أو مشاركتها مع أي طرف آخر، ويُمنع استخدامها لرسائل مضللة أو احتيالية أو مزعجة بالجملة.'],
  ['الرصيد', 'يُخصم كريدت واحد لكل بريد عمل جديد موثّق يُحفظ في حسابك. لا يُخصم على النتائج المكررة أو غير المؤكدة. الكريدت المستخدم لا يُسترد.'],
  ['دقة البيانات', 'البيانات من مزوّدين خارجيين وتُقدَّم كما هي. نسلّم فقط الإيميلات ذات درجة التحقق العالية، ولا نضمن أن يبقى كل بريد صالحًا.'],
  ['الإيقاف وطلبات الحذف', 'يحق لمالك المنصة تعطيل أي حساب يخالف هذه الشروط أو تصل عنه شكاوى إزعاج. إذا طلب شخص حذف بياناته، أبلغ مالك المنصة لحذفها.'],
];
export function TermsText() {
  return <div className="terms">{sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}<small>آخر تحديث: {TERMS_VERSION}</small></div>;
}
export function TermsPage() {
  return <main className="terms-page"><Brand/><h1>شروط الاستخدام</h1><TermsText/><Link href="/" className="text-link">العودة إلى المنصة</Link></main>;
}
export function TermsGate({ onAccepted, onLogout }: { onAccepted: () => Promise<void>; onLogout: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function accept() { setBusy(true); setError(''); try { await api('terms', {}); await onAccepted(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <main className="terms-page"><Brand/><h1>قبل أن تبدأ</h1><p>اقرأ شروط الاستخدام ووافق عليها للمتابعة.</p><TermsText/>
    {error && <Notice error>{error}</Notice>}
    <label className="check-label"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}/><span>قرأت الشروط وأوافق عليها، وأتحمّل مسؤولية الالتزام بقوانين المراسلة في البلدان التي أتواصل معها.</span></label>
    <Button loading={busy} disabled={!agreed} onClick={accept}>أوافق وأتابع <Check size={18}/></Button><Button variant="ghost" onClick={onLogout}>تسجيل الخروج</Button></main>;
}
