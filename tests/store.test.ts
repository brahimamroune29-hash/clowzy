import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/lib/store';
import { demoCatalog } from '../src/lib/demo-provider';
import { contactsCsv,cell } from '../src/lib/csv';
import { Candidate,LeadProvider,SearchInput,searchSchema } from '../src/lib/contracts';
const input=(count=2):SearchInput=>({sector:'التقنية والبرمجيات',country:'السعودية',city:'',title:'',size:'all',count,confirmed:true,requestId:randomUUID()});
function setup(){
  const store=new Store(':memory:',false);
  const admin=store.addUser('Owner','owner@example.com','secure-password-123','admin');
  const alice=store.addUser('Alice','alice@example.com','secure-password-123','member',10);
  const bob=store.addUser('Bob','bob@example.com','secure-password-123','member',10);
  return {store,admin,alice,bob};
}
const provider:LeadProvider={name:'test',search:()=>demoCatalog.slice(0,2)};

test('seeded demo has internally consistent balance and delivery counts',()=>{
  const s=new Store(':memory:');
  const member=s.session(s.demoSession('member'));
  const data=s.snapshot(member.id);
  assert.equal(data.contacts.length,8);assert.equal(member.balance,492);
  assert.equal(data.ledger.reduce((n,l)=>n+l.amount,0),492);
  assert.ok(data.contacts.every(c=>c.email.endsWith('@example.com')));
  s.close();
});
test('concurrent searches dedupe per member and charge once per normalized email',async()=>{
  const {store,alice,bob}=setup();
  const noisy:LeadProvider={name:'test',search:async()=>[demoCatalog[0],{...demoCatalog[0],email:'  '+demoCatalog[0].email.toUpperCase()+' '},demoCatalog[1],{...demoCatalog[2],email:''}]};
  const results=await Promise.all([store.search(alice.id,input(),noisy),store.search(alice.id,input(),noisy)]);
  assert.equal(results.reduce((n,r)=>n+r.delivered,0),2);
  assert.equal(store.user(alice.id).balance,8);
  assert.equal(store.snapshot(alice.id).contacts.length,2);
  await store.search(bob.id,input(),noisy);
  assert.equal(store.user(bob.id).balance,8);
  assert.equal(store.snapshot(bob.id).contacts.length,2);
  store.close();
});
test('same request is idempotent, different payload with reused id rejected',async()=>{
  const {store,alice}=setup(),request=input();
  const first=await store.search(alice.id,request,provider),second=await store.search(alice.id,request,provider);
  assert.equal(first.id,second.id);assert.equal(store.user(alice.id).balance,8);
  await assert.rejects(store.search(alice.id,{...request,count:3},provider));
  store.close();
});
test('provider failure never debits, failed search recorded',async()=>{
  const {store,alice}=setup();
  await assert.rejects(store.search(alice.id,input(),{name:'fails',search(){throw Error('offline');}}));
  assert.equal(store.user(alice.id).balance,10);
  assert.equal(store.snapshot(alice.id).searches[0].status,'failed');
  assert.equal(store.snapshot(alice.id).contacts.length,0);store.close();
});
test('delivery transaction rolls back contacts and debit if any row is malformed',async()=>{
  const {store,alice}=setup();
  const malformed={...demoCatalog[1],company:undefined} as unknown as Candidate;
  await assert.rejects(store.search(alice.id,input(),{name:'bad',search:()=>[demoCatalog[0],malformed]}));
  assert.equal(store.user(alice.id).balance,10);assert.equal(store.snapshot(alice.id).contacts.length,0);store.close();
});
test('zero balance rejects before provider invocation',async()=>{
  const {store,admin,alice}=setup();store.adjustCredits(admin.id,alice.id,'set',0,'test reset',randomUUID());
  let called=false;
  await assert.rejects(store.search(alice.id,input(1),{name:'test',search(){called=true;return demoCatalog;}}));
  assert.equal(called,false);assert.equal(store.user(alice.id).balance,0);store.close();
});
test('export ownership enforced and repeated export never debits',async()=>{
  const {store,alice,bob}=setup();await store.search(alice.id,input(),provider);
  const contacts=store.snapshot(alice.id).contacts;
  assert.equal(store.snapshot(bob.id).contacts.length,0);
  assert.throws(()=>store.contactsForExport(bob.id,[contacts[0].id]));
  store.contactsForExport(alice.id);store.contactsForExport(alice.id);
  assert.equal(store.user(alice.id).balance,8);assert.equal(store.snapshot(alice.id).exports.length,2);
  const csv=contactsCsv([{...contacts[0],company:'=HYPERLINK("bad")',name:'Ali "Test", User'}]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('""Test""'));
  assert.equal(cell('+cmd'),'"\' +cmd"'.replace("' ","'"));store.close();
});
test('invitations accepted once, preserve assigned credits, reject expired token',()=>{
  const {store,admin}=setup();const invite=store.invite(admin.id,'New member','new@example.com',35);
  const token=store.acceptInvite(invite.token,'a-strong-password-123'),user=store.session(token);
  assert.equal(user.balance,35);assert.throws(()=>store.acceptInvite(invite.token,'another-password'));
  const expired=store.invite(admin.id,'Expired','expired@example.com',10);
  store.db.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").run(expired.id);
  assert.throws(()=>store.acceptInvite(expired.token,'a-strong-password-123'));store.close();
});
test('suspension revokes sessions and enforces admin-only mutations',()=>{
  const {store,admin,alice,bob}=setup();const session=store.createSession(alice.id);
  assert.throws(()=>store.setActive(bob.id,alice.id,false));
  assert.throws(()=>store.invite(bob.id,'Illegal','illegal@example.com',10));
  store.setActive(admin.id,alice.id,false);assert.throws(()=>store.session(session));
  store.setActive(admin.id,alice.id,true);assert.throws(()=>store.session(session));
  assert.equal(store.session(store.login(alice.email,'secure-password-123')).id,alice.id);store.close();
});
test('credit reset remains ledger-backed and retry-safe',()=>{
  const {store,admin,alice}=setup(),request=randomUUID();
  store.adjustCredits(admin.id,alice.id,'add',20,'manual grant',request);
  store.adjustCredits(admin.id,alice.id,'add',20,'manual grant',request);
  assert.equal(store.user(alice.id).balance,30);
  store.adjustCredits(admin.id,alice.id,'set',3,'correction',randomUUID());
  assert.equal(store.user(alice.id).balance,3);
  assert.equal(store.snapshot(alice.id).ledger.reduce((n,l)=>n+l.amount,0),3);store.close();
});
test('reset token is single-use and revokes all former sessions',()=>{
  const {store,admin,alice}=setup(),old=store.createSession(alice.id);
  const reset=store.createReset(admin.id,alice.id),fresh=store.resetPassword(reset,'new-password-12345');
  assert.throws(()=>store.session(old));assert.throws(()=>store.resetPassword(reset,'another-password'));
  assert.throws(()=>store.login(alice.email,'secure-password-123'));
  assert.equal(store.session(fresh).id,alice.id);store.close();
});
test('search contract requires confirmation and bounded integer count',()=>{
  assert.equal(searchSchema.safeParse({...input(),confirmed:false}).success,false);
  assert.equal(searchSchema.safeParse({...input(),count:51}).success,false);
  assert.equal(searchSchema.safeParse({...input(),count:1.5}).success,false);
  assert.equal(searchSchema.safeParse(input()).success,true);
});
test('contacts and balance survive reopening local database',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wasl-test-')),file=join(dir,'app.sqlite');
  const s=new Store(file,false),u=s.addUser('Persistent','persist@example.com','secure-password-123','member',5);
  await s.search(u.id,input(),provider);s.close();
  const reopened=new Store(file,false);
  assert.equal(reopened.user(u.id).balance,3);assert.equal(reopened.snapshot(u.id).contacts.length,2);
  reopened.close();rmSync(dir,{recursive:true,force:true});
});
