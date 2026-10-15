import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/[...path]/route';
import type { Store } from '../src/lib/store';
import { testStore } from './pg';

// Owner 2026-10-14: 30 to 50 trainees sign in together, often from one room's network. Security review 2026-10-15: failed attempts
// alone count toward the platform's caps, and one network's 20 failures a minute stop only that network.
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
  const login = async (i: number, ip: string, password = 'trainee-password') => (await POST(new NextRequest(APP + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'trainee' + i + '@room.test', password }),
    headers: { host: 'clowzy.test', origin: APP, 'content-type': 'application/json', 'x-forwarded-for': ip } }), { params: Promise.resolve({ path: ['auth', 'login'] }) })).status;
  const counted = (key: string, count: number, windowMs = 60000) => store.db.run('INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,?) ON CONFLICT(key,window_start) DO UPDATE SET count=rate_hits.count+excluded.count', key, NOW - NOW % windowMs, count);
  return { store, login, counted };
}

test('fifty trainees on one room\'s network sign in within the same minute, ten at a time, and spend none of the failure caps', async t => {
  const { store, login } = await setup(t, 50);
  for (let batch = 0; batch < 5; batch++)
    assert.deepEqual(await Promise.all(Array.from({ length: 10 }, (_, i) => login(batch * 10 + i, '10.9.9.9'))), Array(10).fill(200));
  assert.equal((await store.db.get<{ n: number }>("SELECT coalesce(sum(count),0)::int n FROM rate_hits WHERE key LIKE 'auth-fail%'"))!.n, 0);
});

test('one network guessing passwords stops itself after 30 failures a minute, never the platform; signing out still works', async t => {
  const { login } = await setup(t, 1);
  for (let i = 0; i < 30; i++) assert.equal(await login(0, '10.1.1.1', 'wrong-password'), 401);
  assert.equal(await login(0, '10.1.1.1'), 429, 'not even the right password from there, this minute');
  const out = await POST(new NextRequest(APP + '/api/auth/logout', { method: 'POST', body: '{}', headers: { host: 'clowzy.test', origin: APP, 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' } }), { params: Promise.resolve({ path: ['auth', 'logout'] }) });
  assert.equal(out.status, 200);
  assert.equal(await login(0, '10.1.1.2'), 200, 'everyone else still signs in');
});

test('a burst of wrong passwords sent at the same instant from one network gets 30 guesses at most and never locks the platform', async t => {
  const { store, login } = await setup(t, 1);
  const burst = await Promise.all(Array.from({ length: 140 }, () => login(0, '10.5.5.5', 'wrong-password')));
  assert.equal(burst.filter(s => s === 401).length, 30);
  assert.equal(burst.filter(s => s === 429).length, 110);
  assert.equal((await store.db.get<{ count: number }>("SELECT count FROM rate_hits WHERE key='auth-fail-all'"))!.count, 30);
  assert.equal(await login(0, '10.5.5.6'), 200);
});

test('failures from many networks still meet a platform cap: 300 a minute, 6000 an hour; and 150 attempts a minute from one network', async t => {
  const { login, counted } = await setup(t, 1);
  await counted('auth-fail-all', 300);
  assert.equal(await login(0, '10.2.2.1'), 429);
  await counted('auth-fail-all', -300);
  assert.equal(await login(0, '10.2.2.2'), 200);
  await counted('auth-fail-all-hour', 6000, 3600000);
  assert.equal(await login(0, '10.2.2.3'), 429);
  await counted('auth-fail-all-hour', -6000, 3600000);
  await counted('auth:10.2.2.4', 150);
  assert.equal(await login(0, '10.2.2.4'), 429);
});

test('one IPv6 home connection counts as one network: its /64 shares the failure cap', async t => {
  const { login } = await setup(t, 1);
  for (let i = 0; i < 30; i++) assert.equal(await login(0, '2001:db8:aa:bb::' + (i + 1).toString(16), 'wrong-password'), 401);
  assert.equal(await login(0, '2001:db8:aa:bb:ffff::9'), 429);
  assert.equal(await login(0, '2001:db8:aa:bc::1'), 200, 'the next /64 is another network');
});

test('an account keeps its 20 newest sessions: signing in again and again piles up nothing', async t => {
  const { store } = await setup(t, 1);
  const user = await store.db.get<{ id: string }>("SELECT id FROM users WHERE email='trainee0@room.test'");
  const tokens: string[] = [];
  for (let i = 0; i < 25; i++) { tokens.push(await store.createSession(user!.id)); t.mock.timers.tick(1); }
  assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM sessions WHERE user_id=?', user!.id))!.n, 20);
  assert.equal((await store.session(tokens[24])).id, user!.id, 'the newest still works');
  await assert.rejects(store.session(tokens[0]), (e: { status?: number }) => e.status === 401, 'the oldest is gone');
});
