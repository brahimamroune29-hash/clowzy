import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestEmail, companyEmail, emailsIn, privateAddress, safeGet } from '../src/lib/site-email';

test('a company email is read from its own site: same name under any ending, Cloudflare-hidden ones too, placeholders and images never', () => {
  const cf = (email: string, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map(ch => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const html = `<a href="mailto:Info@Acme.com.sa">mail</a> sales@acme.ae you@company.com logo@2x.png careers@acme.com.sa
    partner@other.com <span class="__cf_email__" data-cfemail="${cf('hello@acme.com.sa')}">[email&#160;protected]</span> office&#64;acme.com.sa`;
  assert.deepEqual(emailsIn(html, 'www.acme.com.sa').sort(), ['careers@acme.com.sa', 'hello@acme.com.sa', 'info@acme.com.sa', 'office@acme.com.sa', 'sales@acme.ae']);
  assert.deepEqual(emailsIn('x@mail.peko.one', 'uae.peko.one'), ['x@mail.peko.one'], 'subdomains of the same company count');
  assert.equal(bestEmail(['ahmed@acme.ae', 'careers@acme.ae', 'info@acme.ae']), 'info@acme.ae', 'a general contact address first');
  assert.equal(bestEmail(['careers@acme.ae', 'noreply@acme.ae', 'do-not-reply@acme.ae', 'no_reply@acme.ae', 'mailer-daemon@acme.ae', 'bounce@acme.ae']), '', 'hiring and no-reply addresses never reach a sales inbox');
  const started = Date.now();
  assert.deepEqual(emailsIn('a'.repeat(60_000) + ' info@acme.ae ' + '%2Fa.b-c'.repeat(8_000), 'acme.ae'), ['info@acme.ae']);
  // An unbounded pattern takes ~6 s here (and minutes on a 1 MB page, blocking the server): this must stay instant.
  assert.ok(Date.now() - started < 1000, 'long runs of email-like text are scanned in linear time: ' + (Date.now() - started) + ' ms');
});

test('the contact pages are read when the home page has no email; nothing found is an empty answer, never an error', async () => {
  const pages: Record<string, string> = { 'https://acme.ae/': '<p>Call us</p>', 'https://acme.ae/contact-us': 'Write to info@acme.ae' };
  const asked: string[] = [];
  const get = async (url: string) => { asked.push(url); if (url.endsWith('/contact')) throw new Error('timeout'); return pages[url] ?? ''; };
  assert.equal(await companyEmail('https://acme.ae/en/about', get), 'info@acme.ae');
  assert.equal(asked[0], 'https://acme.ae/', 'the home page first');
  assert.equal(await companyEmail('https://silent.ae', async () => ''), '');
  assert.equal(await companyEmail('not a url', get), '');
});

test('the site reader never reaches private or internal addresses', async t => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  // Redirects are followed by hand and every hop is checked again (IP hosts: no DNS needed).
  const hops: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => { hops.push(url.href); return url.hostname === '93.184.216.34' ? new Response(null, { status: 302, headers: { location: url.pathname === '/in' ? 'http://127.0.0.1/admin' : 'http://93.184.216.35/ok' } }) : new Response('info@acme.ae', { headers: { 'content-type': 'text/html' } }); });
  assert.equal(await safeGet('http://93.184.216.34/in'), '', 'a redirect into the private network is refused');
  assert.deepEqual(hops, ['http://93.184.216.34/in'], 'the private address is never requested');
  assert.equal(await safeGet('http://93.184.216.34/out'), 'info@acme.ae', 'a public redirect is followed');
  t.mock.restoreAll();
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'http://acme.ae:8080/', 'http://user:pw@acme.ae/'])
    assert.equal(await safeGet(url), '', url);
});
