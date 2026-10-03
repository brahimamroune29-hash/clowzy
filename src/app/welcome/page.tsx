'use client';

import Link from 'next/link';
import { ArrowLeft, SlidersHorizontal, Sparkle, CheckCircle } from '@phosphor-icons/react';
import { Brand, ThemeToggle } from '@/components/ui';
import { LangToggle, useT } from '@/components/lang';
import styles from './welcome.module.css';

export default function WelcomePage() {
  const t = useT();
  return <div className={styles.page}>
    <a className={styles.skip} href="#content">{t('انتقل إلى المحتوى', 'Skip to content')}</a>
    <header className={styles.nav}>
      <Link href="/welcome" aria-label="clowzy"><Brand /></Link>
      <nav aria-label={t('روابط الصفحة', 'Page navigation')}>
        <a href="#how">{t('كيف تعمل', 'How it works')}</a>
        <a href="#questions">{t('الأسئلة الشائعة', 'FAQ')}</a>
      </nav>
      <div className={styles.tools}><LangToggle /><ThemeToggle /><Link className="button secondary" href="/">{t('تسجيل الدخول', 'Log in')}</Link></div>
    </header>
    <main id="content">
      <section className={styles.hero} aria-labelledby="welcome-title">
        <div className={styles.intro}>
          <p className={styles.eyebrow}>{t('مساحة عملك للبحث عن العملاء', 'Your prospecting workspace')}</p>
          <h1 id="welcome-title">{t('ابدأ بالعميل الذي تبحث عنه.', 'Start with the customer you want to reach.')}</h1>
          <p>{t('حدد مجالك وسوقك، واجمع بيانات التواصل المتاحة، ثم نظم نتائجك وتابعها من مكان واحد.', 'Choose your sector and market, find available contact details, and organize your results in one place.')}</p>
          <Link className="button primary" href="/">{t('تسجيل الدخول', 'Log in')}<ArrowLeft className="fwd" size={18} /></Link>
        </div>
        <div className={styles.methods}>
          <h2>{t('ابحث بالطريقة التي تناسبك', 'Search your way')}</h2>
          <Link href="/search?method=manual" className={styles.method}>
            <SlidersHorizontal size={28} aria-hidden="true" />
            <div><h3>{t('اختر المعايير بنفسك', 'Set your own filters')}</h3><p>{t('المجال، الدولة، المدينة ونوع البريد. كل اختيار أمامك.', 'Choose the sector, country, city and email type.')}</p></div>
            <ArrowLeft className="fwd" size={20} aria-hidden="true" />
          </Link>
          <Link href="/search?method=ai" className={styles.method}>
            <Sparkle size={28} aria-hidden="true" />
            <div><h3>{t('اشرح طلبك للمساعد', 'Describe it to the assistant')}</h3><p>{t('اكتب بلغتك، ثم راجع معايير البحث قبل البدء.', 'Write naturally, then review your search before starting.')}</p></div>
            <ArrowLeft className="fwd" size={20} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section id="how" className={styles.workflow} aria-labelledby="how-title">
        <h2 id="how-title">{t('من البحث إلى المتابعة', 'From search to follow-up')}</h2>
        <ol>
          <li><h3>{t('راجع طلبك', 'Review your search')}</h3><p>{t('حدد النطاق والعدد المطلوب. عدد الشركات المرشحة يساعدك في الاختيار، ولا يمثل إيميلات جاهزة.', 'Choose your scope and target count. Matching company counts guide your search; they are not verified emails.')}</p></li>
          <li><h3>{t('استلم النتائج المتاحة', 'Receive available results')}</h3><p>{t('يبحث النظام على دفعات ويحتسب الإيميلات الجديدة التي وصلت فقط. إذا نقص العدد، يمكنك مراجعة نطاق أوسع لاستكماله.', 'Search runs in batches. Only new emails delivered use credits. If the count is short, you can review a broader scope to continue.')}</p></li>
          <li><h3>{t('نظم عملاءك', 'Organize your contacts')}</h3><p>{t('احفظ القوائم والملاحظات داخل المنصة، ونزّل ملف CSV لاستيراده في نظام إدارة العملاء الذي تستخدمه.', 'Keep lists and notes in Clowzy, and download a CSV to import into your CRM.')}</p></li>
        </ol>
      </section>

      <section id="questions" className={styles.questions} aria-labelledby="questions-title">
        <h2 id="questions-title">{t('قبل أن تبدأ', 'Before you start')}</h2>
        <details><summary>{t('كيف أحصل على حساب؟', 'How do I get an account?')}</summary><p>{t('الدخول بالدعوة. اطلب رابط التفعيل من مسؤول اشتراكك، وافتحه لإنشاء كلمة المرور. إذا فعّلت حسابك مسبقًا، استخدم زر تسجيل الدخول.', 'Access is by invitation. Ask your subscription manager for an activation link to set your password. If you already activated your account, log in.')}</p></details>
        <details><summary>{t('هل أحصل دائمًا على العدد المطلوب؟', 'Will I always receive the requested count?')}</summary><p>{t('يعتمد العدد على البيانات المتاحة للمجال والموقع ومعاييرك. عند نقصه تظهر النتيجة الفعلية والعدد المتبقي. توسيع النطاق يحتاج مراجعتك وتأكيدك، ولا تُضاف عناوين غير متحققة لإكمال العدد.', 'The count depends on available data for your sector, location and filters. A shortfall shows the delivered and remaining counts. Broadening the scope requires your review and confirmation; unverified addresses are not added to fill the target.')}</p></details>
        <details><summary>{t('هل النتائج إيميلات أشخاص أم شركات؟', 'Are these people or company emails?')}</summary><p>{t('يمكنك اختيار بريد الشركات أو الأشخاص داخل الشركات. بحث الأشخاص قد يستكمل العدد ببريد الشركات نفسها، وتظهر طبيعة كل نتيجة بوضوح.', 'Choose company emails or people within companies. People searches may supplement results with company emails; each result identifies its type.')}</p></details>
        <details><summary>{t('هل يوجد ربط مباشر مع Kelshi أو CRM آخر؟', 'Is there a direct Kelshi or CRM integration?')}</summary><p>{t('المتاح حاليًا هو إدارة العملاء داخل Clowzy وتصدير CSV. يمكنك استيراد الملف في نظامك إذا كان يدعم ذلك. الربط التلقائي المباشر غير متاح حاليًا.', 'Clowzy currently offers built-in contact management and CSV export. Import the file into your system if it supports CSV. A direct automatic integration is not currently available.')}</p></details>
      </section>

      <aside className={styles.closing}><CheckCircle size={26} aria-hidden="true" /><p>{t('وصلك رابط الدعوة؟ افتحه لتفعيل حسابك. حسابك مفعّل؟ ادخل وابدأ أول بحث.', 'Got an invitation? Open its link to activate your account. Already activated? Log in and start your first search.')}</p><Link className="button primary" href="/">{t('تسجيل الدخول', 'Log in')}</Link></aside>
    </main>
    <footer className={styles.footer}><Brand /><Link href="/terms">{t('شروط الاستخدام', 'Terms of use')}</Link></footer>
  </div>;
}
