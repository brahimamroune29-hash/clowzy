import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogMatches, rememberCandidates } from '../src/lib/catalog';
import { testStore, input, live } from './pg';
import type { Candidate } from '../src/lib/contracts';
import { IcypeasClient } from '../src/lib/icypeas';

const contact: Candidate = { kind:'person',name:'Ali',email:'ali@acme.test',company:'Acme',title:'CEO',sector:'Software Development',
  country:'السعودية',city:'Riyadh',website:'https://acme.test',size:'12',source:'clowzy',email_status:'VERIFIED' };

test('catalog: fresh factual matches are reused atomically across members, never twice for one member', async t => {
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());
  const a=await store.addUser('A','a@example.test','secure-password','member',5), b=await store.addUser('B','b@example.test','secure-password','member',5);
  await rememberCandidates(store,[contact]);
  const request={...input(1),city:'الرياض',titles:['CEO'],size:'11-50' as const};
  const never=new IcypeasClient('test',async()=>{throw new Error('provider must not be called');});
  const first=await live(store,never).start(a.id,request);
  assert.equal(first.status,'completed');assert.equal(first.delivered,1);assert.equal((await store.user(a.id)).balance,4);
  await live(store,never).start(a.id,request);assert.equal((await store.user(a.id)).balance,4,'same request is idempotent');
  assert.equal((await catalogMatches(store,a.id,request,50)).length,0,'already owned');
  assert.equal((await catalogMatches(store,b.id,{...request,countries:['AE']},50)).length,0,'different country');
  assert.equal((await catalogMatches(store,b.id,{...request,titles:['CFO']},50)).length,0,'different title');
  const second=await live(store,never).start(b.id,{...request,requestId:crypto.randomUUID()});
  assert.equal(second.delivered,1);assert.equal((await store.user(b.id)).balance,4);
  await assert.rejects(store.contactsForExport(b.id,[(await store.snapshot(a.id)).contacts[0].id]),'private ownership survives reuse');
});

test('catalog: expired, suppressed, excluded and demo contacts cannot be reused; sharing is opt-in',async t=>{
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());const u=await store.addUser('A','a@example.test','secure-password','member',2);
  await rememberCandidates(store,[contact,{...contact,email:'demo@acme.test',email_status:'demo'}]);
  assert.equal((await store.db.get<{n:number}>('SELECT count(*) n FROM lead_catalog'))!.n,1);
  delete process.env.CATALOG_REUSE_ENABLED;assert.equal((await catalogMatches(store,u.id,input(),50)).length,0);
  process.env.CATALOG_REUSE_ENABLED='true';
  await store.db.run('INSERT INTO crm_exclusions VALUES(?,?,?)',u.id,'acme.test',new Date().toISOString());
  assert.equal((await catalogMatches(store,u.id,input(),50)).length,0);
  await store.db.run('DELETE FROM crm_exclusions');await store.db.run("UPDATE lead_catalog SET verified_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await catalogMatches(store,u.id,input(),50)).length,0);
  await store.db.run('INSERT INTO catalog_suppressions VALUES(?,?)',contact.email,new Date().toISOString());
  await rememberCandidates(store,[contact]);assert.equal((await catalogMatches(store,u.id,input(),50)).length,0);
});
