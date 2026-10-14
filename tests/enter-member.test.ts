import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/[...path]/route';
import type { Store } from '../src/lib/store';
import { testStore } from './pg';

// Client 2026-10-14 (owner's answers Q6-Q9): from a member's window the owner enters that member's account and does
// anything the member can, with no time limit and no log, then goes back to the owner's own session.
const APP = 'https://clowzy.test';
process.env.APP_URL = APP;
process.env.DATABASE_URL = 'postgres://unused'; // getStore() returns the test store set on globalThis below
const holder = globalThis as unknown as { waslStore?: Store };

// A browser keeping every cookie the server sets: inside a member's account it holds two. jar: to plant a cookie.
function browser() {
  const jar = new Map<string, string>();
  return Object.assign(async function call(path: string, body?: unknown) {
    const method = body === undefined ? 'GET' : 'POST', cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    const req = new NextRequest(APP + '/api/' + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { host: 'clowzy.test', origin: APP, 'content-type': 'application/json', 'x-forwarded-for': '10.7.0.1', ...(cookie ? { cookie } : {}) } });
    const res = await (method === 'GET' ? GET : POST)(req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
    for (const set of res.headers.getSetCookie()) {
      const [name, value] = set.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  }, { jar });
}

async function setup(t: TestContext) {
  const store = holder.waslStore = await testStore();
  t.after(() => store.close());
  await store.addUser('Owner', 'owner@clowzy.test', 'owner-password-1', 'admin');
  const sara = await store.addUser('Sara', 'sara@clinic.test', 'sara-password-1', 'member', 7);
  const omar = await store.addUser('Omar', 'omar@shop.test', 'omar-password-1', 'member', 3);
  const owner = browser(), member = browser();
  assert.equal((await owner('auth/login', { email: 'owner@clowzy.test', password: 'owner-password-1' })).status, 200);
  assert.equal((await member('auth/login', { email: 'sara@clinic.test', password: 'sara-password-1' })).status, 200);
  return { store, owner, member, sara, omar };
}

test('the owner enters a member\'s account, acts as that member, and returns to the owner\'s own session', async t => {
  const { owner, member, sara } = await setup(t);
  assert.equal((await owner('admin/enter', { userId: sara.id })).status, 200);
  const inside = await owner('bootstrap');
  assert.equal(inside.data.user.id, sara.id);
  assert.equal(inside.data.ownerInside, true); // the page shows the way back
  // No limit (Q7): the terms she has not accepted yet do not stop the owner, who can accept them for her.
  assert.equal((await owner('terms', {})).status, 200);
  const full = await owner('bootstrap?view=full');
  assert.equal(full.status, 200);
  assert.equal(full.data.user.balance, 7);
  assert.equal(full.data.ownerInside, true);
  // Sara's own session is untouched while the owner is inside, and after.
  assert.equal((await member('bootstrap')).data.user.id, sara.id);
  assert.equal((await owner('owner/return', {})).status, 200);
  const back = await owner('bootstrap');
  assert.equal(back.data.user.role, 'admin');
  assert.equal(back.data.ownerInside, undefined);
  assert.equal((await member('bootstrap')).data.user.id, sara.id);
  assert.equal((await owner('owner/return', {})).status, 200, 'a second way back changes nothing');
  assert.equal((await owner('bootstrap')).data.user.role, 'admin');
});

test('a visit lives on the owner\'s own session: it ends with it, and nobody else can use it', async t => {
  const { store, owner, member, sara, omar } = await setup(t);
  assert.equal((await member('terms', {})).status, 200);
  // A member who plants the cookie stays herself.
  member.jar.set('wasl_member', omar.id);
  assert.equal((await member('bootstrap')).data.user.id, sara.id);
  assert.equal((await member('bootstrap')).data.ownerInside, undefined);
  // A member disabled while the owner is inside: the owner is back to the owner's own view.
  assert.equal((await owner('admin/enter', { userId: omar.id })).status, 200);
  assert.equal((await owner('bootstrap')).data.user.id, omar.id);
  await store.db.run('UPDATE users SET active=0 WHERE id=?', omar.id);
  assert.equal((await owner('bootstrap')).data.user.role, 'admin');
  // The owner's session ended elsewhere (a password change signs out every device): the visit ends with it.
  assert.equal((await owner('admin/enter', { userId: sara.id })).status, 200);
  await store.db.run("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE role='admin')");
  assert.equal((await owner('bootstrap')).status, 401);
  assert.equal((await member('bootstrap')).data.user.id, sara.id, 'her own session untouched');
});

test('only the owner enters, only a member\'s account, and a sign-out inside ends the way back', async t => {
  const { store, owner, member, sara, omar } = await setup(t);
  assert.equal((await member('terms', {})).status, 200); // past the terms, so the refusal below is the owner check's
  assert.equal((await member('admin/enter', { userId: omar.id })).status, 403);
  assert.equal((await member('owner/return', {})).status, 200);
  assert.equal((await member('bootstrap')).data.user.id, sara.id);
  const ownerId = (await owner('bootstrap')).data.user.id;
  assert.equal((await owner('admin/enter', { userId: ownerId })).status, 404);
  await store.setActive(ownerId, omar.id, false);
  assert.equal((await owner('admin/enter', { userId: omar.id })).status, 404);
  // Signing out inside a member's account signs out of both: a later sign-in on that browser cannot reach the owner.
  assert.equal((await owner('admin/enter', { userId: sara.id })).status, 200);
  assert.equal((await owner('auth/logout', {})).status, 200);
  assert.equal((await owner('auth/login', { email: 'sara@clinic.test', password: 'sara-password-1' })).status, 200);
  assert.equal((await owner('owner/return', {})).status, 200);
  assert.equal((await owner('bootstrap')).data.user.id, sara.id);
  assert.equal((await owner('bootstrap')).data.ownerInside, undefined);
});
