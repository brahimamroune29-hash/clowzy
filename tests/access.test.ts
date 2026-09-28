import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessError, clientIp, isHttps } from '../src/lib/access';

const app = 'https://clowzy.example';
const post = { method: 'POST', host: 'clowzy.example', origin: app, contentType: 'application/json', contentLength: '120' };

test('production accepts only the configured host, same-origin JSON writes, and bounded bodies', () => {
  assert.equal(accessError({ method: 'GET', host: 'clowzy.example' }, app), null);
  assert.equal(accessError(post, app), null);
  assert.equal(accessError({ method: 'GET', host: 'evil.example' }, app)?.status, 403);
  assert.equal(accessError({ method: 'GET', host: '127.0.0.1:3100' }, app)?.status, 403);
  assert.equal(accessError({ ...post, origin: null }, app)?.status, 403);
  assert.equal(accessError({ ...post, origin: 'null' }, app)?.status, 403);
  assert.equal(accessError({ ...post, origin: 'https://evil.example' }, app)?.status, 403);
  assert.equal(accessError({ ...post, origin: 'http://clowzy.example' }, app)?.status, 403);
  assert.equal(accessError({ ...post, contentType: 'text/plain' }, app)?.status, 415);
  assert.equal(accessError({ ...post, contentLength: '999999' }, app)?.status, 413);
  assert.equal(accessError({ method: 'GET', host: 'clowzy.example' }, 'not a url')?.status, 503, 'a malformed APP_URL is a visible denial, not a crash');
  assert.equal(isHttps('HTTPS://Clowzy.example'), true); assert.equal(isHttps('http://clowzy.example'), false); assert.equal(isHttps(undefined), false);
});

test('without APP_URL the API stays loopback-only for local development', () => {
  assert.equal(accessError({ method: 'GET', host: '127.0.0.1:3100' }), null);
  assert.equal(accessError({ ...post, host: 'localhost:3100', origin: 'http://localhost:3100' }), null);
  assert.equal(accessError({ method: 'GET', host: 'clowzy.example' })?.status, 503);
  assert.equal(accessError({ ...post, host: '127.0.0.1:3100', origin: 'null' })?.status, 403);
});

test('client IP is the entry appended by our reverse proxy, never a client-supplied one', () => {
  assert.equal(clientIp('203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp('6.6.6.6, 203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp(null), 'unknown');
  assert.equal(clientIp(' , '), 'unknown');
});
