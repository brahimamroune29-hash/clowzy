import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// A company's own contact email, read from its public website (free). The companies search then has the provider verify it.
export type Get = (url: string) => Promise<string>;
const CONTACT_PAGES = ['contact-us', 'contact', 'contactus', 'en/contact-us'];
// Bounded parts (RFC lengths): an unbounded pattern backtracks quadratically, and a 1 MB page could block the server for minutes.
const emailPattern = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi;
const placeholder = /\.(png|jpe?g|gif|webp|svg|css|js)$|^(you|your|name|user|email|example)@|@(example|domain|company|email|yourdomain|sentry)\./i;
// The company's own name in a host: acme.com.sa, www.acme.ae and mail.acme.com all give "acme".
const ownName = (host: string) => {
  const parts = host.toLowerCase().split('.');
  return parts.at(parts.length > 2 && /^(com|net|org|gov|edu|co|ac|sch|med)$/.test(parts.at(-2)!) ? -3 : -2) ?? '';
};
// Cloudflare hides page emails as hex (data-cfemail / #cfemail-protection): the first byte is the XOR key.
const cloudflare = (hex: string) => {
  const key = parseInt(hex.slice(0, 2), 16);
  return (hex.slice(2).match(/../g) ?? []).map(b => String.fromCharCode(parseInt(b, 16) ^ key)).join('');
};

export function emailsIn(html: string, host: string): string[] {
  const text = html.replace(/(?:data-cfemail="|email-protection#)([0-9a-f]{6,})/gi, (_, hex: string) => ' ' + cloudflare(hex) + ' ').replace(/&#64;|&commat;/gi, '@');
  const own = ownName(host);
  return [...new Set((text.match(emailPattern) ?? []).map(e => e.toLowerCase()))].filter(e => !placeholder.test(e) && ownName(e.split('@')[1]) === own);
}
// A general contact address first; hiring, legal and no-reply addresses never reach a sales inbox.
const rank = (email: string) => /^(info|contact|hello|sales|enquir|inquir|office|admin|marketing|support|customer|cs)\b/.test(email) ? 0
  : /^(careers?|jobs?|hr|recruit|cv|privacy|legal|dpo|no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|bounces?|abuse|webmaster|postmaster)\b/.test(email) ? 2 : 1;
export const bestEmail = (emails: string[]) => emails.filter(e => rank(e) < 2).sort((a, b) => rank(a) - rank(b))[0] ?? '';

export async function companyEmail(website: string, get: Get = safeGet): Promise<string> {
  let origin: URL;
  try { origin = new URL(new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website).origin); } catch { return ''; }
  const read = (path: string) => get(new URL(path, origin).href).then(html => emailsIn(html, origin.hostname), () => []);
  return bestEmail(await read('/')) || bestEmail((await Promise.all(CONTACT_PAGES.map(read))).flat());
}

export function privateAddress(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^(::1?|f[cd]|fe[89ab]|ff)/i.test(ip);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 1_000_000;
// Public web pages only: http(s) on default ports, every hop's address checked (redirects followed by hand), 5 s and 1 MB per page.
// ponytail: addresses are checked at lookup, not at connect (DNS rebinding could swap them); pin the IP in a custom agent if that matters.
export const safeGet: Get = async start => {
  try {
    let url = new URL(start);
    for (let hop = 0; hop < 4; hop++) {
      if (!['http:', 'https:'].includes(url.protocol) || (url.port && !['80', '443'].includes(url.port)) || url.username || url.password) return '';
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
      if (!addresses.length || addresses.some(privateAddress)) return '';
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { await res.body?.cancel(); url = new URL(res.headers.get('location')!, url); continue; }
      if (!res.ok || !res.body || !/html|text\/plain/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel(); return ''; }
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let text = '', bytes = 0;
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        bytes += part.value.length; text += decoder.decode(part.value, { stream: true });
        if (bytes > MAX_BYTES) { await reader.cancel(); break; }
      }
      return text;
    }
    return '';
  } catch { return ''; }
};
