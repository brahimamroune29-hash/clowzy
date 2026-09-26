import { Suspense } from 'react';
import Platform from '@/components/platform';
export default function Page() {
  return <Suspense fallback={<div className="boot"><span className="brand-text" dir="ltr">clowzy</span><p>نجهّز مساحة عملك…</p></div>}><Platform /></Suspense>;
}
