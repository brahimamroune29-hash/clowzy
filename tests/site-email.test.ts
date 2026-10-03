import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { bestEmail, companyEmail, emailsIn, privateAddress, safeGet } from '../src/lib/site-email';

test('a company email is read from its own site: exact domain only, Cloudflare-hidden ones too, placeholders and images never', () => {
  const cf = (email: string, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map(ch => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const html = `<a href="mailto:Info@Acme.com.sa">mail</a> sales@acme.ae you@company.com logo@2x.png careers@acme.com.sa
    partner@other.com <span class="__cf_email__" data-cfemail="${cf('hello@acme.com.sa')}">[email&#160;protected]</span> office&#64;acme.com.sa`;
  assert.deepEqual(emailsIn(html, 'www.acme.com.sa').sort(), ['careers@acme.com.sa', 'hello@acme.com.sa', 'info@acme.com.sa', 'office@acme.com.sa']);
  assert.deepEqual(emailsIn('x@mail.peko.one x@peko.net', 'peko.one'), ['x@mail.peko.one'], 'children count, another TLD does not');
  assert.deepEqual(emailsIn('x@mail.peko.one', 'uae.peko.one'), [], 'sibling ownership cannot be assumed');
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
  assert.equal(await companyEmail('https://acme.ae/%broken', get), 'info@acme.ae');
});

test('published business webmail needs a real mailto link on the business site, and localized contact paths are followed', async () => {
  const html = 'a visitor: visitor@gmail.com <a href="mailto:Clinic@gmail.com">البريد الإلكتروني</a> <a href="mailto:jobs@gmail.com">Jobs</a>';
  assert.deepEqual(emailsIn(html, 'clinic.example'), []);
  assert.deepEqual(emailsIn(html, 'clinic.example', true), ['clinic@gmail.com', 'jobs@gmail.com']);
  assert.equal(bestEmail(emailsIn(html, 'clinic.example', true)), 'clinic@gmail.com');
  const asked: string[] = [];
  const get = async (url: string) => { asked.push(url); return url.endsWith('/ar/pages/contact-us') ? html : '<a href="/ar/pages/contact-us">تواصل معنا</a><a href="https://another.example/contact">partner</a>'; };
  assert.equal(await companyEmail('https://clinic.example', get, undefined, true), 'clinic@gmail.com');
  assert(asked.includes('https://clinic.example/ar/pages/contact-us')); assert(asked.every(u => new URL(u).hostname === 'clinic.example'));
});

test('the site reader never reaches private or internal addresses', async t => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:a00:1', '192.0.0.1', '198.18.0.1', '198.19.255.254'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  // Redirects are followed by hand and every hop is checked again (IP hosts: no DNS needed).
  const hops: string[] = [];
  t.mock.method(http, 'request', ((url: URL, _options: http.RequestOptions, callback: (r: http.IncomingMessage) => void) => {
    hops.push(url.href);
    const res = new PassThrough() as unknown as http.IncomingMessage;
    res.statusCode = url.hostname === '93.184.216.34' ? 302 : 200;
    res.headers = res.statusCode === 302 ? { location: url.pathname === '/in' ? 'http://127.0.0.1/admin' : 'http://93.184.216.35/ok' } : { 'content-type': 'text/html' };
    const req = new EventEmitter() as http.ClientRequest;
    req.end = (() => { queueMicrotask(() => { callback(res); (res as unknown as PassThrough).end('info@acme.ae'); }); return req; }) as typeof req.end;
    return req;
  }) as typeof http.request);
  assert.equal(await safeGet('http://93.184.216.34/in'), '', 'a redirect into the private network is refused');
  assert.deepEqual(hops, ['http://93.184.216.34/in'], 'the private address is never requested');
  assert.equal(await safeGet('http://93.184.216.34/out'), 'info@acme.ae', 'a public redirect is followed');
  assert.equal(await safeGet('http://93.184.216.34/out', undefined, true), '', 'published business webmail cannot come from a different redirected host');
  t.mock.restoreAll();
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'http://acme.ae:8080/', 'http://user:pw@acme.ae/'])
    assert.equal(await safeGet(url), '', url);
});

// The OS resolver is checked once; the socket gets those same IPs even if DNS changes before it connects.
test('DNS is pinned to validated public IPs and an aborted request opens no socket', async t => {
  let lookups = 0, sockets = 0;
  t.mock.method(dns, 'lookup', async () => { lookups++; return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]; });
  t.mock.method(http, 'request', ((url: URL, options: http.RequestOptions, callback: (r: http.IncomingMessage) => void) => {
    sockets++;
    assert.equal(url.hostname, 'acme.test', 'Host and TLS name stay original');
    options.lookup!('acme.test', { all: true }, (error, address) => { assert.ifError(error); assert.deepEqual(address, [{ address: '93.184.216.34', family: 4 }]); });
    const res = new PassThrough() as unknown as http.IncomingMessage;
    res.statusCode = 200; res.headers = { 'content-type': 'text/html' };
    const req = new EventEmitter() as http.ClientRequest;
    req.end = (() => { queueMicrotask(() => { callback(res); (res as unknown as PassThrough).end('safe'); }); return req; }) as typeof req.end;
    return req;
  }) as typeof http.request);
  assert.equal(await safeGet('http://acme.test'), 'safe');
  assert.equal(lookups, 1);
  assert.equal(await safeGet('http://acme.test', AbortSignal.abort()), '');
  assert.equal(sockets, 1);
});
