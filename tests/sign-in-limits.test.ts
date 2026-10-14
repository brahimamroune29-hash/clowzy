import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/[...path]/route';
import type { Store } from '../src/lib/store';
import { testStore } from './pg';

// Owner 2026-10-14: 30 to 50 trainees sign in together, often from one room's network. The limits still stop a flood.
const APP = 'https://clowzy.test';
process.env.APP_URL = APP;
process.env.DATABASE_URL = 'postgres://unused'; // getStore() returns the test store set on globalThis below
const holder = globalThis as unknown as { waslStore?: Store };
const NOW = Date.parse('2026-10-14T10:00:10Z');

async function setup(t: TestContext, trainees: number) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW }); // one minute and one hour throughout
  const store = holder.waslStore = await testStore();
  t.after(() => store.close());
  for (let i = 0; i < trainees; i++) await store.addUser('Trainee ' + i, 'trainee' + i + '@room.test', 'trainee-password', 'member');
  const login = async (i: number, ip: string) => (await POST(new NextRequest(APP + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'trainee' + i + '@room.test', password: 'trainee-password' }),
    headers: { host: 'clowzy.test', origin: APP, 'content-type': 'application/json', 'x-forwarded-for': ip } }), { params: Promise.resolve({ path: ['auth', 'login'] }) })).status;
  const counted = (key: string, count: number, windowMs = 60000) => store.db.run('INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,?) ON CONFLICT(key,window_start) DO UPDATE SET count=rate_hits.count+excluded.count', key, NOW - NOW % windowMs, count);
  return { login, counted };
}

test('fifty trainees on one room\'s network sign in within the same minute', async t => {
  const { login } = await setup(t, 50);
  const statuses = await Promise.all(Array.from({ length: 50 }, (_, i) => login(i, '10.9.9.9')));
  assert.deepEqual(statuses, Array(50).fill(200));
});

test('a flood is still stopped: 150 a minute from one network, 120 a minute and 2000 an hour for the platform', async t => {
  const { login, counted } = await setup(t, 1);
  await counted('auth:10.1.1.1', 150);
  assert.equal(await login(0, '10.1.1.1'), 429);
  assert.equal(await login(0, '10.1.1.2'), 200, 'another network is not held back');
  await counted('auth-all', 119); // with the sign-in above (the refused one never reached this count): 120 this minute
  assert.equal(await login(0, '10.1.1.3'), 429);
});

test('the hour\'s platform ceiling holds across minutes', async t => {
  const { login, counted } = await setup(t, 1);
  await counted('auth-all-hour', 2000, 3600000);
  assert.equal(await login(0, '10.2.2.2'), 429);
});
