import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IcypeasClient } from '../src/lib/icypeas';
import { ownerCsv } from '../src/lib/csv';
import { input, item, lead, live, testStore } from './pg';

// Client request 2026-10-11: the owner sees what each member extracted, search by search, and downloads it.
const provider: typeof fetch = async (url, init) => {
  const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
  if (path === 'find-people') return Response.json({ success: true, leads: body.query?.profileLocation?.exclude ? [] : [lead('a'), lead('b')] });
  if (path === 'find-companies') return Response.json({ success: true, leads: [] });
  if (path === 'bulk-search') return Response.json({ success: true, file: 'f1' });
  if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: [item(0, 'person@company-a.example'), item(1, 'person@company-b.example')] });
  throw new Error('Unexpected ' + path);
};

async function platform() {
  const store = await testStore(), s = live(store, new IcypeasClient('unit-test-secret', provider));
  const owner = await store.addUser('Owner', 'owner@example.com', 'secure-password', 'admin', 0);
  const alice = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 5);
  const bob = await store.addUser('Bob', 'bob@example.com', 'secure-password', 'member', 5);
  const search = async (userId: string) => {
    const first = await s.start(userId, input(2));
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    return s.poll(userId, first.id);
  };
  return { store, owner, alice, bob, a: await search(alice.id), b: await search(bob.id) };
}

test('the owner lists a member\'s searches and opens one: its contacts, and nothing from another member', async () => {
  const { store, owner, alice, a } = await platform();
  try {
    assert.equal(a.delivered, 2);
    const searches = await store.memberSearches(owner.id, alice.id);
    assert.deepEqual(searches.map(s => [s.id, s.delivered, s.status]), [[a.id, 2, 'completed']]);
    const contacts = await store.ownerContacts(owner.id, { searchId: a.id });
    assert.deepEqual(contacts.map(c => c.email).sort(), ['person@company-a.example', 'person@company-b.example']);
    assert.ok(contacts.every(c => c.user_id === alice.id && c.member === 'Alice'));
  } finally { await store.close(); }
});

test('a member cannot read another member\'s results through the owner\'s views', async () => {
  const { store, alice, bob, b } = await platform();
  try {
    const forbidden = (e: { status?: number }) => e.status === 403;
    await assert.rejects(store.memberSearches(alice.id, bob.id), forbidden);
    await assert.rejects(store.ownerContacts(alice.id, { searchId: b.id }), forbidden);
    await assert.rejects(store.ownerContacts(alice.id, {}, true), forbidden);
  } finally { await store.close(); }
});

test('the owner\'s file covers one member, one search or the whole platform, and each row names its member and search', async () => {
  const { store, owner, bob, a } = await platform();
  try {
    assert.equal((await store.ownerContacts(owner.id, {})).length, 4);
    assert.equal((await store.ownerContacts(owner.id, { userId: bob.id })).length, 2);
    const rows = await store.ownerContacts(owner.id, { searchId: a.id }, true);
    const lines = ownerCsv(rows).replace('﻿', '').split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith('"Member","Search","Date","First Name","Last Name","Email"'), lines[0]);
    assert.ok(lines.slice(1).every(l => l.startsWith(`"Alice","${a.title}","${a.created_at.slice(0, 10)}"`)), lines[1]);
    assert.equal((await store.db.get<{ n: number }>('SELECT count(*)::int n FROM exports WHERE user_id=?', owner.id))!.n, 1, 'the download is counted');
    await assert.rejects(store.ownerContacts(owner.id, { userId: owner.id }, true), /لا توجد نتائج/);
  } finally { await store.close(); }
});
