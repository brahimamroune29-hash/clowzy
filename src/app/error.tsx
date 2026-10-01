'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useT } from '@/components/lang';
// Any page crash shows this (inside the app's layout and styles) instead of the framework's English-only page.
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useT();
  useEffect(() => { console.error(error); }, [error]);
  return <div className="boot"><p>{t('حدث خطأ غير متوقع في هذه الصفحة.', 'Something went wrong on this page.')}</p><button className="button secondary" onClick={() => retry()}><span>{t('إعادة المحاولة', 'Try again')}</span></button><Link href="/" className="text-link">{t('العودة إلى الرئيسية', 'Back home')}</Link></div>;
}
