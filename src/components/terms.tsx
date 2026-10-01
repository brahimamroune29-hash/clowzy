'use client';
import { useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { api } from '@/lib/client';
import { TERMS_VERSION } from '@/lib/contracts';
import Link from 'next/link';
import { Brand, Button, Notice } from './ui';
import { LangToggle, useLang, useT } from './lang';

// ponytail: plain-language terms for launch; a lawyer in the target GCC markets should review them before scaling.
// A change members must accept again: edit the text, raise TERMS_VERSION (contracts.ts) and say what changed here.
const changed = { ar: 'الجديد: إذا لم تكفِ إيميلات الأشخاص، نكمّل بإيميل الشركة نفسها بعد فحصه، بنفس السعر.',
  en: 'What’s new: when people’s emails are not enough, we fill in with the company’s own verified email, at the same price.' };
const sections: { ar: [string, string]; en: [string, string] }[] = [
  { ar: ['الخدمة', 'منصة لاكتشاف جهات اتصال مهنية وبريد عمل من مزوّدي بيانات تجاريين ومن مواقع الشركات نفسها، لأغراض التواصل التجاري بين الشركات.'],
    en: ['The service', 'A platform to find business contacts and work emails, from commercial data providers and the companies’ own websites, for business-to-business outreach.'] },
  { ar: ['مسؤوليتك عن الإرسال', 'أنت وحدك مسؤول عن أي رسالة ترسلها لجهات الاتصال، وعن الالتزام بقوانين حماية البيانات ومكافحة الرسائل غير المرغوبة في بلد المستلم. في دول الخليج تشترط قوانين كثيرة موافقة مسبقة على الرسائل التسويقية. في كل رسالة: عرّف بنفسك، وضع طريقة سهلة لإلغاء الاشتراك، وتوقف فورًا عن مراسلة من يطلب ذلك.'],
    en: ['Your responsibility for sending', 'You alone are responsible for any message you send to these contacts, and for following the data-protection and anti-spam laws of the recipient’s country. Many Gulf laws require prior consent for marketing messages. In every message: say who you are, offer an easy way to unsubscribe, and stop at once when asked.'] },
  { ar: ['الاستخدام المسموح', 'البيانات لتواصل نشاطك المهني فقط. يُمنع بيعها أو نشرها أو مشاركتها مع أي طرف آخر، ويُمنع استخدامها لرسائل مضللة أو احتيالية أو مزعجة بالجملة.'],
    en: ['Allowed use', 'The data is for your own business outreach only. Selling, publishing or sharing it is forbidden, as is using it for misleading, fraudulent or bulk unsolicited messages.'] },
  { ar: ['الرصيد', 'يُخصم كريدت واحد لكل بريد عمل جديد يُحفظ في حسابك، ودرجة تأكده ٩٥٪ أو أكثر. لا يُخصم على النتائج المكررة أو التي لم نجد لها بريدًا. إذا لم تكفِ إيميلات الأشخاص، نكمّل بإيميل الشركة نفسها بعد فحصه، بنفس السعر. الكريدت المستخدم لا يُسترد.'],
    en: ['Credits', 'One credit is charged for each new work email saved to your account, verified at 95% or more. Duplicates and people without an email are free. When people’s emails are not enough, we fill in with the company’s own verified email, at the same price. Used credits are not refunded.'] },
  { ar: ['دقة البيانات', 'البيانات من مزوّدين خارجيين وتُقدَّم كما هي. نسلّم فقط الإيميلات ذات درجة التحقق العالية، ولا نضمن أن يبقى كل بريد صالحًا.'],
    en: ['Data accuracy', 'The data comes from third parties and is provided as is. We deliver only highly verified emails, but cannot guarantee every email stays valid.'] },
  { ar: ['الإيقاف وطلبات الحذف', 'يحق لمالك المنصة تعطيل أي حساب يخالف هذه الشروط أو تصل عنه شكاوى إزعاج. إذا طلب شخص حذف بياناته، أبلغ مالك المنصة لحذفها.'],
    en: ['Suspension and deletion requests', 'The platform owner may disable any account that breaks these terms or draws spam complaints. If a person asks for their data to be deleted, tell the platform owner.'] },
];
export function TermsText() {
  const { lang } = useLang(), t = useT();
  return <div className="terms">{sections.map(s => { const [title, body] = s[lang]; return <section key={title}><h2>{title}</h2><p>{body}</p></section>; })}<small>{t('آخر تحديث: ', 'Last updated: ')}{TERMS_VERSION.slice(0, 10)}</small></div>;
}
export function TermsPage() {
  const t = useT();
  return <main className="terms-page"><div className="auth-tools"><LangToggle/></div><Brand/><h1>{t('شروط الاستخدام', 'Terms of use')}</h1><TermsText/><Link href="/" className="text-link">{t('العودة إلى المنصة', 'Back to the platform')}</Link></main>;
}
// again: the member accepted older terms; they see what changed, then the whole text.
export function TermsGate({ again, onAccepted, onLogout }: { again: boolean; onAccepted: () => Promise<void>; onLogout: () => Promise<void> }) {
  const t = useT(), { lang } = useLang(), [agreed, setAgreed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function accept() { setBusy(true); setError(''); try { await api('terms', {}); await onAccepted(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <main className="terms-page"><div className="auth-tools"><LangToggle/></div><Brand/><h1>{again ? t('تحدّثت شروط الاستخدام', 'The terms have changed') : t('قبل أن تبدأ', 'Before you start')}</h1><p>{t('اقرأ شروط الاستخدام ووافق عليها للمتابعة.', 'Read and accept the terms to continue.')}</p>{again && <Notice>{changed[lang]}</Notice>}<TermsText/>
    {error && <Notice error>{error}</Notice>}
    <label className="check-label"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}/><span>{t('قرأت الشروط وأوافق عليها، وأتحمّل مسؤولية الالتزام بقوانين المراسلة في البلدان التي أتواصل معها.', 'I have read and accept the terms, and I am responsible for following the messaging laws of the countries I contact.')}</span></label>
    <Button loading={busy} disabled={!agreed} onClick={accept}>{t('أوافق وأتابع', 'Accept and continue')} <Check size={18}/></Button><Button variant="ghost" onClick={onLogout}>{t('تسجيل الخروج', 'Sign out')}</Button></main>;
}
