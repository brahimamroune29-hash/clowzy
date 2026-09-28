import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store';
import { weekBoundaries,weekBoundariesSchema,overviewOnly } from '../src/lib/overview';
import { seedPerformanceFixture } from '../scripts/performance/fixture';

test('dashboard stays bounded with 1000 members and 100000 contacts, without losing totals',async t=>{
  const s=new Store(':memory:'),f=seedPerformanceFixture(s);
  const days=weekBoundaries(new Date(f.created));
  try {
    await t.test('member totals use the entire history while recent rows are limited',()=>{
      const full=s.snapshot(f.heavyId),overview=s.overview(f.heavyId,days);
      assert.equal(overview.summary?.contacts,10000);
      assert.equal(overview.summary?.searches,200);
      assert.equal(overview.summary?.exports,150); // The previous snapshot caps exports at 100.
      assert.equal(overview.user.balance,10000);
      assert.equal(overview.searches.length,4);
      assert.deepEqual(overview.contacts,[]);assert.deepEqual(overview.ledger,[]);assert.deepEqual(overview.exports,[]);
      assert.equal(overview.admin,undefined);
      assert.ok(overview.searches.every(r=>r.user_id===f.heavyId));
      for(const day of overview.summary!.weekly) {
        assert.equal(day.count,full.contacts.filter(c=>c.created_at>=day.start&&c.created_at<day.end).length);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(overview))<16384);
      // Legacy list pages must still have access to their complete current contract.
      assert.equal(full.contacts.length,10000);assert.equal(full.searches.length,200);
    });
    await t.test('owner totals include members outside the five displayed rows, including disabled accounts',()=>{
      const view=s.overview(f.ownerId,days);
      assert.equal(view.admin!.users.length,5);assert.equal(view.admin!.audit.length,4);
      assert.deepEqual(view.admin!.invitations,[]);
      assert.deepEqual(view.admin!.totals,{delivered:100000,searches:2198,exports:1149,used:100000,members:1000,activeMembers:801});
      assert.ok(Buffer.byteLength(JSON.stringify(view))<16384);
      for(const u of view.admin!.users) {
        const exact=s.db.prepare('SELECT count(*) n FROM contacts WHERE user_id=?').get(u.id) as {n:number};
        assert.equal(u.leads,exact.n);
      }
    });
    await t.test('member summary is isolated and balances remain fresh after an owner adjustment',()=>{
      assert.equal(s.overview(f.otherMemberId,days).summary!.contacts,91);
      s.adjustCredits(f.ownerId,f.heavyId,'add',7,'اختبار تحديث الملخص',randomUUID());
      assert.equal(s.overview(f.heavyId,days).user.balance,10007);
      s.setActive(f.ownerId,f.otherMemberId,false);
      assert.throws(()=>s.overview(f.otherMemberId,days));
      assert.throws(()=>s.overview(randomUUID(),days));
    });
  } finally {s.close();}
});

test('overview empty state and exact day boundaries',()=>{
  const s=new Store(':memory:'),u=s.addUser('Empty','empty@example.com','test-password-123');
  try {
    const days=weekBoundaries(new Date('2026-09-24T12:00:00Z')),view=s.overview(u.id,days);
    assert.equal(view.summary!.contacts,0);assert.equal(view.summary!.exports,0);
    assert.equal(view.summary!.weekly.length,7);assert.ok(view.summary!.weekly.every(d=>d.count===0));
    assert.equal(weekBoundariesSchema.safeParse([days[0]]).success,false);
    assert.equal(weekBoundariesSchema.safeParse([...days].reverse()).success,false);
    assert.equal(weekBoundariesSchema.safeParse(Array(8).fill(days[0])).success,false);
    assert.equal(weekBoundariesSchema.safeParse(days).success,true);
    for(const p of ['/','/dashboard','/admin','/settings']) assert.equal(overviewOnly(p),true);
    for(const p of ['/leads','/search','/history','/credits','/admin/members','/admin/activity']) assert.equal(overviewOnly(p),false);
  } finally {s.close();}
});
