'use client';
import { useEffect } from 'react';
import Link from 'next/link';
// Any page crash shows this (in Arabic, inside the app's layout and styles) instead of the framework's English page.
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="boot"><p>حدث خطأ غير متوقع في هذه الصفحة.</p><button className="button secondary" onClick={() => retry()}><span>إعادة المحاولة</span></button><Link href="/" className="text-link">العودة إلى الرئيسية</Link></div>;
}
