import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullEnrichClient,FullEnrichError,searchBody,safeWebsite } from '../src/lib/fullenrich';
import { LiveSearch } from '../src/lib/live-search';
import { Store } from '../src/lib/store';
import { searchSchema,type SearchInput } from '../src/lib/contracts';
import { suggestFilters } from '../src/lib/demo-provider';
const input=(count=2):SearchInput=>({sector:'التقنية والبرمجيات',country:'السعودية',city:'',title:'',size:'all',count,confirmed:true,requestId:randomUUID()});
const enrichmentId='2db5ea61-1752-42cf-8ea1-ab1da060cd0a';
const person=(id:string)=>({id,full_name:'Person '+id,first_name:'Person',last_name:id,location:{country:'Saudi Arabia',city:'Riyadh'},social_profiles:{professional_network:{url:'https://www.linkedin.com/in/'+id}},employment:{current:{title:'CEO',company:{name:'Test Company',domain:'company.example',website:'https://company.example',headcount:4,industry:{main_industry:'Software Development'}}}}});
const result=(id:string,email:string,status='DELIVERABLE')=>({custom:{person_id:id},contact_info:{most_probable_work_email:{email,status}}});
function mockTransport(options:{people?:unknown[];data?:unknown[];status?:string;searchHttp?:number;enrichThrow?:boolean}={}){
  const calls:{url:string;body:Record<string,unknown>|undefined}[]=[];
  const transport:typeof fetch=async(url,init)=>{
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer unit-test-secret');
    const path=String(url);const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url:path,body});
    assert.equal(init?.redirect,'error');
    if(path.endsWith('people/search'))return Response.json({people:options.people??[person('p1'),person('p2')]},{status:options.searchHttp??200});
    if(path.endsWith('contact/enrich/bulk')){
      if(options.enrichThrow)throw new Error('timeout includes unit-test-secret');
      return Response.json({enrichment_id:enrichmentId});
    }
    if(path.includes('contact/enrich/bulk/'))return Response.json({id:enrichmentId,status:options.status??'FINISHED',data:options.data??[result('p2','INVALID','INVALID'),result('p1','one@company.example')]});
    if(path.endsWith('keys/verify'))return Response.json({workspace_id:'test-workspace'});
    throw Error('Unexpected path');
  };
  return {calls,client:new FullEnrichClient('unit-test-secret',transport)};
}
function setup(filename=':memory:'){
  const store=new Store(filename,false),user=store.addUser('Alice','alice@example.com','secure-password','member',10),bob=store.addUser('Bob','bob@example.com','secure-password','member',10);
  return {store,user,bob};
}
function eligible(store:Store){store.db.prepare('UPDATE fullenrich_runs SET updated_at=0').run();}

test('API mapping bounds spending to one batch, requests only work emails, associates results by person id',async()=>{
  const {client,calls}=mockTransport();const people=await client.search(input());
  await client.enrich(people,'trial');const response=await client.result(enrichmentId,people);
  assert.equal(calls[0].body?.limit,2);assert.equal(calls[0].body?.offset,0);
  const submitted=calls[1].body?.data as {enrich_fields:string[]}[];
  assert.deepEqual(submitted[0].enrich_fields,['contact.work_emails']);
  assert.equal(response.candidates.length,1);assert.equal(response.candidates[0].name,'Person p1');
  assert.equal(response.candidates[0].source,'FullEnrich');assert.equal(response.candidates[0].email_status,'DELIVERABLE');
  assert.equal(calls.length,3);
});
test('rejects invalid, uncertain, missing and unrelated emails; never fabricates contact fields',async()=>{
  const {client}=mockTransport({data:[result('p1','bad','DELIVERABLE'),result('p2','two@company.example','HIGH_PROBABILITY'),result('unknown','third@company.example')]});
  const response=await client.result(enrichmentId,await client.search(input()));assert.deepEqual(response.candidates,[]);
  assert.equal(safeWebsite('javascript:alert(1)'),'');assert.equal(safeWebsite(undefined),'');
  assert.throws(()=>searchBody({...input(),title:'مدير'}),FullEnrichError);
  const payload=searchBody({...input(),city:'دبي',country:'الإمارات',size:'11-50'});
  assert.equal(payload.person_locations[0].value,'Dubai, United Arab Emirates');
  assert.deepEqual(payload.current_company_headcounts,[{min:11,max:50,exclude:false}]);
});
test('start, refresh and repeat polling deliver only once; different user cannot observe or poll job',async()=>{
  const {store,user,bob}=setup(),{client,calls}=mockTransport(),live=new LiveSearch(store,client),request=input();
  try{
    const [first,repeated]=await Promise.all([live.start(user.id,request),live.start(user.id,request)]);
    assert.equal(first.id,repeated.id);assert.equal(first.status,'awaiting_provider');assert.equal(store.reserved(user.id),2);
    assert.equal(calls.filter(c=>c.url.endsWith('/bulk')).length,1);
    await assert.rejects(live.poll(bob.id,first.id));
    eligible(store);const done=await live.poll(user.id,first.id);
    assert.equal(done.status,'partial');assert.equal(done.delivered,1);assert.equal(store.user(user.id).balance,9);assert.equal(store.reserved(user.id),0);
    await live.start(user.id,request);await live.poll(user.id,first.id);
    assert.equal(calls.length,3);assert.equal(store.snapshot(user.id).contacts.length,1);
    assert.equal(store.contactsForExport(user.id,undefined,first.id)[0].source,'FullEnrich');assert.equal(store.user(user.id).balance,9);
  }finally{store.close();}
});
test('completed enrichment resumes after database reopen without replaying paid submissions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'clowzy-live-')),file=join(dir,'test.sqlite');
  const {store,user}=setup(file),{client,calls}=mockTransport();
  const first=await new LiveSearch(store,client).start(user.id,input());store.close();
  const reopened=new Store(file,false);
  try{eligible(reopened);const done=await new LiveSearch(reopened,client).poll(user.id,first.id);assert.equal(done.delivered,1);assert.equal(calls.length,3);}finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});
test('uncertain submission is not retried and does not debit platform balance or disclose the secret',async()=>{
  const {store,user}=setup(),{client,calls}=mockTransport({enrichThrow:true}),live=new LiveSearch(store,client),request=input();
  try{
    const first=await live.start(user.id,request);assert.equal(first.status,'unknown');assert.ok(!first.message?.includes('unit-test-secret'));
    await live.start(user.id,request);await live.poll(user.id,first.id);
    assert.equal(calls.length,2);assert.equal(store.user(user.id).balance,10);assert.equal(store.reserved(user.id),0);
  }finally{store.close();}
});
test('no results or rejected search never starts enrichment; unauthorized response has helpful error',async()=>{
  for(const options of [{people:[]},{searchHttp:403}]){
    const {store,user}=setup(),{client,calls}=mockTransport(options);
    try{const response=await new LiveSearch(store,client).start(user.id,input());assert.equal(response.delivered,0);assert.equal(calls.length,1);assert.equal(store.reserved(user.id),0);assert.equal(store.user(user.id).balance,10);if(options.searchHttp)assert.match(response.message||'',/Search API/);}finally{store.close();}
  }
});
test('pending polls preserve reservations and both count and balance are checked before paid requests',async()=>{
  const {store,user}=setup(),{client,calls}=mockTransport({status:'IN_PROGRESS'}),live=new LiveSearch(store,client);
  try{
    await assert.rejects(live.start(user.id,input(11)));assert.equal(calls.length,0);
    const first=await live.start(user.id,input(6));await assert.rejects(live.start(user.id,input(6)));
    eligible(store);assert.equal((await live.poll(user.id,first.id)).status,'awaiting_provider');assert.equal(store.reserved(user.id),6);assert.equal(store.user(user.id).balance,10);
    assert.equal(store.claimJob(),null,'demo worker must not claim FullEnrich work');
  }finally{store.close();}
});
test('missing API key does not invoke transport',async()=>{
  let called=false;const client=new FullEnrichClient('',async()=>{called=true;return Response.json({});});
  await assert.rejects(client.search(input()),/FULLENRICH_API_KEY/);assert.equal(called,false);
});
test('finished result with no deliverable emails never charges; repeated email is deduplicated across searches',async()=>{
  const {store,user}=setup(),{client}=mockTransport({data:[result('p1','one@company.example'),result('p2','one@company.example')]}),live=new LiveSearch(store,client);
  try{
    for(let i=0;i<2;i++){const pending=await live.start(user.id,input());eligible(store);const done=await live.poll(user.id,pending.id);assert.equal(done.delivered,i===0?1:0);}
    assert.equal(store.user(user.id).balance,9);assert.equal(store.snapshot(user.id).contacts.length,1);
  }finally{store.close();}
});
test('fuzzy search results outside the selected country or city are excluded before enrichment',async()=>{
  const wrongCountry={...person('other'),location:{country:'United States',city:'Riyadh'}};
  const {client}=mockTransport({people:[wrongCountry,person('valid')]});
  const people=await client.search({...input(),city:'الرياض'});assert.deepEqual(people.map(p=>p.id),['valid']);
});
test('interrupted submission remains uncertain after restart and cannot be blindly resubmitted',async()=>{
  const {store,user}=setup(),{client,calls}=mockTransport(),live=new LiveSearch(store,client),request=input();
  try{
    const first=await live.start(user.id,request);
    store.db.prepare("UPDATE fullenrich_runs SET phase='submitting',enrichment_id=NULL,updated_at=0 WHERE search_id=?").run(first.id);
    const current=await new LiveSearch(store,client).start(user.id,request);
    assert.equal(current.status,'unknown');assert.equal(calls.length,2);assert.equal(store.reserved(user.id),0);assert.equal(store.user(user.id).balance,10);
  }finally{store.close();}
});
test('assistant suggestion from its own placeholder example passes the live search mapping',()=>{
  const suggested=suggestFilters('أقدم خدمات تسويق وأبحث عن شركات عقارية في دبي');
  assert.equal(suggested.title,'Marketing Director');
  assert.doesNotThrow(()=>searchBody(searchSchema.parse({...suggested,confirmed:true,requestId:randomUUID()})));
});
