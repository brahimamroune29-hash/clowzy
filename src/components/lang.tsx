'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { chooseLang, savedLang, type Lang } from '@/lib/client';
import { labelsEn } from '@/lib/contracts';
import { countryFromText, countryLabel, englishName } from '@/lib/places';

// Arabic or English for the whole platform, kept in this browser. Text sits next to its translation: t('عربي', 'English').
const LangContext = createContext<{ lang: Lang; setLang: (lang: Lang) => void }>({ lang: 'ar', setLang: () => {} });
// The saved choice is the store (client.ts savedLang; this tab's choice when the browser keeps no storage).
const listeners = new Set<() => void>();
const read = savedLang;
function subscribe(listener: () => void) {
  listeners.add(listener); window.addEventListener('storage', listener);
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
}
export function LangProvider({ children }: { children: React.ReactNode }) {
  const lang = useSyncExternalStore(subscribe, read, () => 'ar' as Lang); // the server renders Arabic; the saved choice follows at once
  // The pre-paint script in layout.tsx set the direction first; the hydration render (still Arabic) must not undo it.
  useEffect(() => { if (lang === read()) { document.documentElement.lang = lang; document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl'; } }, [lang]);
  const setLang = useCallback((next: Lang) => { chooseLang(next); listeners.forEach(l => l()); }, []);
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}
export const useLang = () => useContext(LangContext);
export function useT() {
  const { lang } = useLang();
  return useCallback((ar: string, en: string) => lang === 'en' ? en : ar, [lang]);
}
export function LangToggle() {
  const { lang, setLang } = useLang();
  return <button type="button" className="lang-toggle" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} lang={lang === 'en' ? 'ar' : 'en'}>{lang === 'en' ? 'العربية' : 'English'}</button>;
}
// Names in the chosen language: picked labels (fields, specialties, titles), countries by code, and stored Arabic country names.
export function useNames() {
  const { lang } = useLang(), en = lang === 'en';
  return useMemo(() => ({
    label: (ar: string) => en ? labelsEn[ar] ?? ar : ar,
    country: (code: string) => en ? englishName(code) : countryLabel(code),
    place: (stored: string) => { const code = en ? countryFromText(stored) : ''; return code ? englishName(code) : stored; },
  }), [en]);
}
