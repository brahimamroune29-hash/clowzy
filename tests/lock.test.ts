import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { lockMessage } from '../src/lib/access';
import { GET } from '../src/app/api/[...path]/route';

// The owner's lock: what it refuses, what it must keep refusing, and that clearing it restores service.
const APP = 'https://clowzy.test';
process.env.APP_URL = APP;

const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const get = (path: string) => new NextRequest(APP + '/api/' + path, { method: 'GET', headers: { host: 'clowzy.test' } });

test('only 1/true lock; blank, 0 and false keep serving', () => {
  for (const on of ['1', 'true', 'TRUE', ' 1 ']) { process.env.PLATFORM_LOCKED = on; assert.ok(lockMessage(), `"${on}" must lock`); }
  for (const off of ['', '0', 'false', 'no']) { process.env.PLATFORM_LOCKED = off; assert.equal(lockMessage(), null, `"${off}" must not lock`); }
  delete process.env.PLATFORM_LOCKED;
  assert.equal(lockMessage(), null, 'an unset variable must not lock');
});

test('locked: the browser is refused with the message', async () => {
  process.env.PLATFORM_LOCKED = '1';
  const refused = await GET(get('bootstrap'), context('bootstrap'));
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /الدفعة/);
});

test('locked: the paid search worker is stopped too, so the lock costs the owner nothing', async () => {
  process.env.PLATFORM_LOCKED = '1';
  // searchTick submits paid batches to the provider. The cron path is authenticated and handled before
  // every browser concern, so the lock has to sit above it: otherwise a platform locked for non-payment
  // keeps spending the owner's money on the client's running searches. This is the whole point.
  const worker = await GET(get('cron/search'), context('cron', 'search'));
  assert.equal(worker.status, 503, 'the lock must stop the paid search worker');
  const health = await GET(get('cron/health'), context('cron', 'health'));
  assert.equal(health.status, 503, 'nothing answers while locked');
});

test('unlocked: the request passes the lock and continues into the normal flow', async () => {
  delete process.env.PLATFORM_LOCKED;
  const response = await GET(get('bootstrap'), context('bootstrap'));
  const body = await response.json().catch(() => ({})) as { error?: string };
  // Not a status assertion: with no database configured this environment fails further down for its
  // own reason (503 «قاعدة البيانات غير مهيأة»). What must be true is that the lock stopped answering.
  assert.doesNotMatch(body.error ?? '', /الدفعة/, 'clearing the lock must restore service');
});
