import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

// A company's own contact email, read from its public website (free). The companies search then has the provider verify it.
export type Get = (url: string, signal?: AbortSignal, sameHost?: boolean) => Promise<string>;
const CONTACT_PAGES = ['contact-us', 'contact', 'contactus', 'en/contact-us'];
export const freeMail = /^((gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|aol|protonmail|proton|yandex|gmx)(\.[a-z]{2,3}){1,2}|(me|mac|mail|rocketmail)\.com|emirates\.net\.ae|eim\.ae|batelco\.com\.bh|omantel\.net\.om|qatar\.net\.qa|qualitynet\.net)$/i;
// Bounded parts (RFC lengths): an unbounded pattern backtracks quadratically, and a 1 MB page could block the server for minutes.
const emailPattern = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi;
const placeholder = /\.(png|jpe?g|gif|webp|svg|css|js)$|^(you|your|name|user|email|example)@|@(example|domain|company|email|yourdomain|sentry)\./i;
// Only the website's actual domain and its children prove ownership. A matching brand under another TLD does not.
// ponytail: regional sibling domains need explicit ownership evidence; conservatively skip them.
const ownHost = (host: string) => host.toLowerCase().replace(/^www\d*\./, '').replace(/\.$/, '');
// Cloudflare hides page emails as hex (data-cfemail / #cfemail-protection): the first byte is the XOR key.
const cloudflare = (hex: string) => {
  const key = parseInt(hex.slice(0, 2), 16);
  return (hex.slice(2).match(/../g) ?? []).map(b => String.fromCharCode(parseInt(b, 16) ^ key)).join('');
};

export function emailsIn(html: string, host: string, publishedContact = false): string[] {
  const text = html.replace(/(?:data-cfemail="|email-protection#)([0-9a-f]{6,})/gi, (_, hex: string) => ' ' + cloudflare(hex) + ' ').replace(/&#64;|&commat;/gi, '@');
  const own = ownHost(host);
  const linkedEmails = new Set(publishedContact ? [...text.matchAll(/href\s*=\s*["']mailto:([^"'?\s]+)/gi)].map(m => m[1].toLowerCase()) : []);
  return [...new Set((text.match(emailPattern) ?? []).map(e => e.toLowerCase()))].filter(e => {
    const domain = e.split('@')[1];
    // Webmail qualifies only when the business itself publishes it as a contact link, never as guessed personal data.
    const linked = freeMail.test(domain) && linkedEmails.has(e);
    return !placeholder.test(e) && !!own && (domain === own || domain.endsWith('.' + own) || linked);
  });
}
// A general contact address first; hiring, legal and no-reply addresses never reach a sales inbox.
const rank = (email: string) => /^(info|contact|hello|sales|enquir|inquir|office|admin|marketing|support|customer|cs)\b/.test(email) ? 0
  : /^(careers?|jobs?|hr|recruit|cv|privacy|legal|dpo|no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|bounces?|abuse|webmaster|postmaster)\b/.test(email) ? 2 : 1;
export const bestEmail = (emails: string[]) => emails.filter(e => rank(e) < 2).sort((a, b) => rank(a) - rank(b))[0] ?? '';

export async function companyEmail(website: string, get: Get = safeGet, signal?: AbortSignal, publishedContact = false): Promise<string> {
  return (await companyEmails(website,get,signal,publishedContact,1))[0]||'';
}
// Collect a bounded set so an invalid first contact mailbox does not discard the whole business.
export async function companyEmails(website:string,get:Get=safeGet,signal?:AbortSignal,publishedContact=false,limit=3):Promise<string[]> {
  const found=new Set<string>();
  limit=Math.min(3,Math.max(1,Math.floor(limit)||1));
  let origin: URL;
  try { origin = new URL(new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website).origin); } catch { return []; }
  // The discovered URL may already be the real localized contact page; read it before guessing common paths.
  const suppliedPath = new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website).pathname;
  let decodedPath = suppliedPath;
  try { decodedPath = decodeURIComponent(suppliedPath); } catch { /* malformed encodings do not prove a contact page */ }
  const paths = [...new Set([/contact|اتصل|تواصل/i.test(decodedPath) ? suppliedPath : '/', suppliedPath, ...CONTACT_PAGES])];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (signal?.aborted) break;
    const reading=get(new URL(path,origin).href,signal,publishedContact);
    const html=await (signal?abortable(reading,signal):reading).catch(()=>'');
    for(const email of emailsIn(html,origin.hostname,publishedContact))if(rank(email)<2)found.add(email);
    if(found.size>=limit)break;
    // Prefer the site's own contact links, including localized and nested paths, within the same bounded read.
    if (paths.length < 9) for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      try {
        const link = new URL(match[1], origin);
        if (link.origin === origin.origin && /contact|اتصل|تواصل/i.test(decodeURIComponent(link.pathname)) && !paths.includes(link.pathname) && paths.length < 9) paths.splice(index + 1, 0, link.pathname);
      } catch { /* malformed links are not contact evidence */ }
    }
  }
  return [...found].sort((a,b)=>rank(a)-rank(b)).slice(0,limit);
}

export function privateAddress(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  // Allow only global-unicast IPv6; expanded loopback and IPv4-mapped spellings must also be refused.
  return isIP(ip) !== 6 || !/^[23][0-9a-f]{3}:/i.test(ip);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 1_000_000;
// Stop waiting for DNS too. Native lookup cannot be cancelled, but its late result never starts a socket.
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}
// One 5 s budget covers DNS, every redirect and the body. The connection uses only the checked IPs;
// the original hostname remains in the request for Host, TLS SNI and certificate verification.
export const safeGet: Get = async (start, parent, sameHost = false) => {
  const timeout = AbortSignal.timeout(5000), signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  try {
    let url = new URL(start);
    for (let hop = 0; hop < 4; hop++) {
      signal.throwIfAborted();
      if (!['http:', 'https:'].includes(url.protocol) || (url.port && !['80', '443'].includes(url.port)) || url.username || url.password) return '';
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host, { all: true }), signal);
      if (!addresses.length || addresses.some(a => privateAddress(a.address))) return '';
      signal.throwIfAborted();
      const result = await new Promise<{ html: string; redirect?: string }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).request(url, {
          agent: false, signal, headers: { 'User-Agent': UA, Accept: 'text/html' },
          lookup: (_host, options, cb) => cb(null, options.all ? addresses : addresses[0].address, addresses[0].family),
        }, res => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) { resolve({ html: '', redirect: res.headers.location }); res.destroy(); return; }
          if (status < 200 || status >= 300 || !/html|text\/plain/i.test(res.headers['content-type'] ?? '')) { resolve({ html: '' }); res.destroy(); return; }
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) { resolve({ html: '' }); res.destroy(); return; }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('Website response interrupted')));
        });
        req.on('error', reject); req.end();
      });
      if (result.redirect) {
        const next = new URL(result.redirect, url);
        if (sameHost && ownHost(next.hostname) !== ownHost(new URL(start).hostname)) return ''; // another site cannot prove this company's contact mailbox
        url = next; continue;
      }
      return result.html;
    }
    return '';
  } catch { return ''; }
};
