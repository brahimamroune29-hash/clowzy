import type { Metadata } from 'next';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './globals.css';
import { LangProvider } from '@/components/lang';
export const metadata: Metadata = { title:'clowzy — مساحة الفرص', description:'منصة خاصة لاكتشاف العملاء المحتملين وتنظيم علاقاتك القادمة.', robots:{index:false,follow:false} };
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="ar" dir="rtl" suppressHydrationWarning><head>
    <script dangerouslySetInnerHTML={{__html:`(function(){var t,l;try{t=localStorage.getItem('theme');l=localStorage.getItem('lang')}catch(e){}if(t!=='light'&&t!=='dark')t='light';var d=document.documentElement;d.dataset.theme=t;if(l==='en'){d.lang='en';d.dir='ltr'}})()`}}/>
  </head><body><LangProvider>{children}</LangProvider></body></html>;
}
