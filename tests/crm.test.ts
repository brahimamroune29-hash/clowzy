import test from 'node:test';
import assert from 'node:assert/strict';
import { testStore,input,live } from './pg';
import { crmState,crmAction,approveDeletion,crmOperations } from '../src/lib/crm';
import { searchTick, workerAuthorized } from '../src/lib/search-worker';
import { crmCsv } from '../src/lib/csv';
import { IcypeasClient } from '../src/lib/icypeas';
import type { Candidate } from '../src/lib/contracts';
const candidate:Candidate={name:'Ali User',email:'ali@acme.test',company:'Acme',title:'CEO',sector:'Software Development',country:'Saudi Arabia',city:'Riyadh',website:'https://acme.test',size:'12',source:'clowzy',email_status:'VERIFIED',kind:'person'};
test('CRM: tenant notes/lists/audiences, exclusions, previews, deletion and financial history',async t=>{
  const old=process.env.CRM_ENABLED;process.env.CRM_ENABLED='true';t.after(()=>{if(old===undefined)delete process.env.CRM_ENABLED;else process.env.CRM_ENABLED=old;});
  const store=await testStore();t.after(()=>store.close());
  const a=await store.addUser('A user','a@test.com','long-password', 'member',10),b=await store.addUser('B user','b@test.com','long-password','member',10),owner=await store.addUser('Owner','owner@test.com','long-password','admin');
  const search=await store.enqueueSearch(a.id,input(2));await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",search.id);
  await crmAction(store,a.id,'exclude',{value:'blocked.test'});
  assert.equal(await store.deliverBatch(a.id,search.id,[candidate,{...candidate,email:'x@blocked.test'}]),1);
  assert.deepEqual((await crmState(store,a.id)).wallet,{total:9,reserved:1,available:8});
  await store.finishSearch(search.id);await store.finishSearch(search.id);
  const cid=(await store.snapshot(a.id)).contacts[0].id;
  await crmAction(store,a.id,'list',{name:'Prospects'});const list=(await crmState(store,a.id)).lists[0];
  await crmAction(store,a.id,'contact',{contactId:cid,stage:'interested',tags:['VIP','VIP'],notes:'Private secret',lists:[list.id]});
  await assert.rejects(crmAction(store,b.id,'contact',{contactId:cid,stage:'new',tags:[],notes:'Stolen',lists:[]}),/حسابك/);
  const sb=await store.enqueueSearch(b.id,input(1));await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",sb.id);await store.deliverBatch(b.id,sb.id,[candidate]);const bcid=(await store.snapshot(b.id)).contacts[0].id;
  await assert.rejects(crmAction(store,b.id,'contact',{contactId:bcid,stage:'new',tags:[],notes:'',lists:[list.id]}),/حسابك/);
  await crmAction(store,a.id,'audience',{name:'Tech',filters:input(2)});
  const mine=await crmState(store,a.id),other=await crmState(store,b.id);
  assert.equal(mine.meta[0].notes,'Private secret');assert.deepEqual(mine.meta[0].tags,['VIP']);assert.equal(other.meta.length,0);assert.equal(other.lists.length,0);assert.equal(other.audiences.length,0);assert.equal(other.notifications.length,0);assert.equal(mine.notifications.length,1);
  const exportsBefore=(await store.snapshot(a.id)).exports.length;await store.contactsForExport(a.id,[cid],undefined,false);assert.equal((await store.snapshot(a.id)).exports.length,exportsBefore);
  assert.match(crmCsv([{...(await store.snapshot(a.id)).contacts[0],notes:'=BAD\nvalue'}],['email','notes'],'generic'),/'=BAD/);
  assert.match(crmCsv([{...(await store.snapshot(a.id)).contacts[0]}],['name','email','company'],'gohighlevel'),/First Name.*Last Name.*Email.*Business Name/);
  await crmAction(store,a.id,'delete-request',{contactId:cid});const deletion=(await crmState(store,a.id)).deletions[0];
  await assert.rejects(approveDeletion(store,b.id,{id:deletion.id}),/مالك/);
  await approveDeletion(store,owner.id,{id:deletion.id});assert.equal((await store.snapshot(a.id)).contacts.length,0);assert.equal((await store.snapshot(b.id)).contacts.length,0);assert.equal((await crmState(store,a.id)).meta.length,0);assert.equal((await store.user(a.id)).balance,9);
  assert.equal((await crmOperations(store,owner.id)).estimatedCost,null);
  assert.equal(await store.deliverBatch(b.id,sb.id,[candidate]),1);assert.equal((await store.user(b.id)).balance,9);assert.equal((await store.snapshot(b.id)).contacts.length,0);
});
test('Worker: durable lease, closed-tab completion, idempotent notifications',async t=>{
  process.env.CRM_ENABLED='true';t.after(()=>delete process.env.CRM_ENABLED);
  const store=await testStore();t.after(()=>store.close());const user=await store.addUser('User','worker@test.com','long-password','member',3),search=await store.enqueueSearch(user.id,input(1));await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",search.id);
  await store.db.run('INSERT INTO crm_worker_leases(search_id,token,expires_at) VALUES(?,?,?)',search.id,'busy',Date.now()+60000);
  assert.equal(await searchTick(store,async()=>{throw new Error('Lease failed');}),0);
  await store.db.run('DELETE FROM crm_worker_leases');
  assert.equal(await searchTick(store,async(uid,sid)=>{await store.deliverBatch(uid,sid,[candidate]);await store.finishSearch(sid);return store.getSearch(uid,sid);}),1);
  assert.equal(await searchTick(store),0);assert.equal((await crmState(store,user.id)).notifications.length,1);assert.equal((await store.user(user.id)).balance,2);
  const failed=await live(store,new IcypeasClient('test',async()=>{throw new Error('offline');})).start(user.id,input(1));
  assert.equal(failed.status,'failed');assert.equal((await crmState(store,user.id)).notifications.length,2);assert.equal((await store.user(user.id)).balance,2);
});
test('Worker: leased jobs cannot hide the queue; parallel attempts and failures are bounded',async t=>{
  process.env.CRM_ENABLED='true';t.after(()=>delete process.env.CRM_ENABLED);
  const store=await testStore();t.after(()=>store.close());
  for(let i=0;i<12;i++){
    const user=await store.addUser('Queue '+i,`queue-${i}@test.com`,'long-password','member',1),search=await store.enqueueSearch(user.id,input(1));
    await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",search.id);
    if(i<11)await store.db.run('INSERT INTO crm_worker_leases(search_id,token,expires_at) VALUES(?,?,?)',search.id,'busy',Date.now()+60000);
  }
  const finish=async(uid:string,sid:string)=>{await store.finishSearch(sid);return store.getSearch(uid,sid);};
  assert.equal(await searchTick(store,finish,3),1,'unleased work beyond the first ten must progress');
  await store.db.run('DELETE FROM crm_worker_leases');
  let active=0,peak=0;
  assert.equal(await searchTick(store,async(uid,sid)=>{
    peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,30));active--;
    return finish(uid,sid);
  },3),3);
  assert.equal(peak,3,'a slow search must not serialize other members');
  let attempts=0;
  assert.equal(await searchTick(store,async()=>{attempts++;throw new Error('Expected test failure');},2),0);
  assert.equal(attempts,2,'failed attempts also consume the per-tick limit');
  assert.equal((await store.db.get<{n:number}>('SELECT count(*)::int n FROM crm_worker_leases'))?.n,2,'failed jobs back off so other jobs can progress');
  assert.equal(await searchTick(store,finish,3),3);
});
test('Private schema: API roles denied; trusted backend role works under RLS and cannot directly delete contacts',async t=>{
  const {testDb}=await import('./pg');const db=await testDb(true,true);t.after(()=>db.end());
  await db.run('GRANT USAGE ON SCHEMA clowzy TO clowzy_app,anon,authenticated');
  for(const role of ['anon','authenticated']){
    await db.run('SET ROLE '+role);await assert.rejects(db.get('SELECT * FROM lead_catalog'),/permission denied/);await assert.rejects(db.run("INSERT INTO crm_lists(id,user_id,name) VALUES('bad','bad','bad')"),/permission denied/);await assert.rejects(db.get("SELECT clowzy.suppress_contact('bad','a@test.com')"),/permission denied/);await db.run('RESET ROLE');
  }
  await db.run("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('owner','owner','owner@test.com','x','admin','2026-10-02')");
  await db.run('GRANT SELECT ON users TO clowzy_app');
  await db.run('SET ROLE clowzy_app');
  await db.run("INSERT INTO crm_lists(id,user_id,name) VALUES('list','owner','Private')");assert.equal((await db.get<{name:string}>('SELECT name FROM crm_lists'))?.name,'Private');
  await assert.rejects(db.run("DELETE FROM contacts WHERE email='a@test.com'"),/permission denied/);
  await db.get("SELECT clowzy.suppress_contact('owner','a@test.com')");assert.equal((await db.get<{email:string}>('SELECT email FROM catalog_suppressions'))?.email,'a@test.com');await db.run('RESET ROLE');
  await db.run('SET ROLE clowzy_backup');
  assert.equal((await db.get<{n:number}>('SELECT count(*)::int n FROM crm_lists'))?.n,1,'backup policy includes rows under RLS');
  await assert.rejects(db.run("INSERT INTO crm_lists(id,user_id,name) VALUES('write','owner','bad')"),/permission denied/);
  await db.run('RESET ROLE');
});

test('Worker endpoint: only the exact configured bearer secret is accepted', () => {
  const secret = 'worker-secret-'.repeat(4);
  assert.equal(workerAuthorized(null,secret),false);
  assert.equal(workerAuthorized('Bearer '+secret,''),false);
  assert.equal(workerAuthorized('Bearer wrong',secret),false);
  assert.equal(workerAuthorized('Bearer '+secret,secret),true);
});

test('Deletion redacts all known pending copies without shifting provider result indices; terminal batches are cleared',async t=>{
  process.env.CRM_ENABLED='true';t.after(()=>delete process.env.CRM_ENABLED);
  const store=await testStore();t.after(()=>store.close());
  const owner=await store.addUser('Owner','deletion-owner@test.com','long-password','admin');
  const a=await store.addUser('A','deletion-a@test.com','long-password','member',10);
  const b=await store.addUser('B','deletion-b@test.com','long-password','member',10);
  const sa=await store.enqueueSearch(a.id,input(2)),sb=await store.enqueueSearch(b.id,input(2));
  const raw=[{firstname:'Ali',lastname:'User',lastCompanyName:'Acme',profileUrl:'https://linkedin.com/in/ali'}, {firstname:'Other',lastname:'Person',lastCompanyName:'Other'}];
  for(const s of [sa,sb]){
    await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",s.id);
    await store.db.run("INSERT INTO provider_runs(search_id,phase,people,updated_at) VALUES(?,'waiting',?,?)",s.id,JSON.stringify(raw),Date.now());
    await store.saveCursor(s.user_id,'audience',0,null,JSON.stringify(raw));
  }
  await store.deliverBatch(a.id,sa.id,[candidate]);
  await store.db.get('SELECT clowzy.suppress_contact(?,?)',owner.id,candidate.email);
  for(const s of [sa,sb]){
    const run=await store.db.get<{people:string}>('SELECT people FROM provider_runs WHERE search_id=?',s.id);
    assert.deepEqual(JSON.parse(run!.people),[{suppressed:true},raw[1]],'indices stay stable in another account too');
    assert.deepEqual(JSON.parse((await store.cursor(s.user_id,'audience')).leftovers),[{suppressed:true},raw[1]]);
  }
  const client=new IcypeasClient('test',async()=>Response.json({success:true,items:[
    {_id:'deleted',status:'DEBITED',userData:{externalId:'0'},results:{emails:[{email:candidate.email,certainty:'very_sure'}]}},
    {_id:'kept',status:'DEBITED',userData:{externalId:'1'},results:{emails:[{email:'other@business.test',certainty:'very_sure'}]}}
  ]}));
  const result=await client.results('file',[{suppressed:true},raw[1]]);
  assert.equal(result.done,true);assert.deepEqual(result.candidates.map(c=>c.email),['other@business.test']);
  await store.finishSearch(sa.id);
  assert.equal((await store.db.get<{people:string}>('SELECT people FROM provider_runs WHERE search_id=?',sa.id))!.people,'[]');
});
