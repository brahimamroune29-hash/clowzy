import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogMatches, rememberCandidates } from '../src/lib/catalog';
import { testStore, input, live } from './pg';
import type { Candidate } from '../src/lib/contracts';
import { IcypeasClient } from '../src/lib/icypeas';
import { LiveSearch } from '../src/lib/live-search';
import { audienceOf } from '../src/lib/audience';

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

test('catalog: a narrow activity reuses what the same activity found, after a short wait, charged like a new email', async t => {
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());
  const b=await store.addUser('B','b@example.test','secure-password','member',5);
  const ask=(sector:string)=>audienceOf(JSON.stringify({sector,countries:['LB'],city:'',title:'',size:'all',count:1,confirmed:true,requestId:crypto.randomUUID()}));
  const salon:Candidate={...contact,email:'hello@jolie.example',company:'Jolie et co',sector:'Personal Care Services',country:'لبنان',city:'Beirut',website:'https://jolie.example'};
  await rememberCandidates(store,[salon],'صالونات التجميل النسائية');
  assert.equal((await catalogMatches(store,b.id,ask('صالونات التجميل النسائية'),50)).length,1,'what a salons search found serves the next salons search');
  assert.equal((await catalogMatches(store,b.id,ask('عيادات التجميل'),50)).length,0,'never another narrow activity');
  await rememberCandidates(store,[{...salon,email:'info@other.example'}],'محلات بيع العطور الفرنسية للعرائس');
  assert.equal((await store.db.get<{niche:string|null}>("SELECT payload->>'niche' niche FROM lead_catalog WHERE email='info@other.example'"))!.niche,null,'a member\'s own words never reach the shared catalog');
  const never=new IcypeasClient('test',async()=>{throw new Error('provider must not be called');});
  const search=new LiveSearch(store,never,{read:0,bulk:0,catalog:60000},{read:0,bulk:0});
  let s=await search.start(b.id,ask('صالونات التجميل النسائية'));
  assert.equal(s.status,'awaiting_provider');assert.equal(s.delivered,0,'the page shows a search for a while (owner, 2026-10-07: about 15 s)');
  s=await search.poll(b.id,s.id);assert.equal(s.delivered,0);
  await store.db.run('UPDATE provider_runs SET submitted_at=0');
  s=await search.poll(b.id,s.id);
  assert.equal(s.status,'completed');assert.equal(s.delivered,1);assert.equal((await store.user(b.id)).balance,4,'one credit, like an email the provider found');
});

test('catalog: the same request gets what an earlier identical request delivered, widened places and company emails included', async t => {
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());
  const a=await store.addUser('A','a@example.test','secure-password','member',5), b=await store.addUser('B','b@example.test','secure-password','member',5);
  const request=audienceOf(JSON.stringify({sector:'التقنية والبرمجيات',countries:['LB'],city:'',title:'',size:'all',count:2,confirmed:true,requestId:crypto.randomUUID()}));
  const found:Candidate[]=[{...contact,email:'omar@damascus.example',company:'Damascus Soft',country:'سوريا',city:'Damascus',website:'https://damascus.example'},
    {...contact,kind:'company',name:'Beirut Web',email:'info@beirutweb.example',company:'Beirut Web',title:'',country:'لبنان',city:'Beirut',website:'https://beirutweb.example'}];
  const first=await store.enqueueSearch(a.id,request);await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",first.id);
  await store.deliverBatch(a.id,first.id,found);await rememberCandidates(store,found);
  assert.deepEqual((await catalogMatches(store,b.id,{...request,count:5,requestId:crypto.randomUUID()},50)).map(c=>c.email).sort(),['info@beirutweb.example','omar@damascus.example'],
    'owner, 2026-10-07: «اذا شخص طلب نفس الطلب نجيبلو المعلومات نفسها»');
  assert.equal((await catalogMatches(store,b.id,{...request,city:'Beirut',requestId:crypto.randomUUID()},50)).length,0,'another request only takes what matches its own place and kind');
});

test('catalog: a narrow activity keeps its tag when a broad search finds the email again; a dental search never takes a supplier', async t => {
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());
  const b=await store.addUser('B','b@example.test','secure-password','member',5);
  const ask=(sector:string,country='LB')=>audienceOf(JSON.stringify({sector,countries:[country],city:'',title:'',size:'all',count:1,confirmed:true,requestId:crypto.randomUUID()}));
  const salon:Candidate={...contact,email:'hello@jolie.example',company:'Jolie et co',sector:'Personal Care Services',country:'لبنان',city:'Beirut',website:'https://jolie.example'};
  await rememberCandidates(store,[salon],'صالونات التجميل النسائية');await rememberCandidates(store,[salon]);
  assert.equal((await catalogMatches(store,b.id,ask('صالونات التجميل النسائية'),50)).length,1);
  const dental=(company:string,email:string):Candidate=>({...contact,email,company,sector:'Dentists',country:'الأردن',city:'Amman',website:'https://'+email.split('@')[1]});
  await rememberCandidates(store,[dental('Matest Dental Supplies','sales@matest.example'),dental('Smile Dental Clinic','info@smile.example')]);
  assert.deepEqual((await catalogMatches(store,b.id,ask('عيادات الأسنان','JO'),50)).map(c=>c.company),['Smile Dental Clinic']);
});
