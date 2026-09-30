import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError, Store } from '../src/lib/store';
import { contactsCsv,cell } from '../src/lib/csv';
import { Candidate,Resolved } from '../src/lib/contracts';
import { searchSchema } from '../src/lib/schemas';
import { audienceOf } from '../src/lib/audience';
import { testStore } from './pg';

// Three synthetic contacts (the CSV test's second row relies on the demo status and label).
const demoCatalog:Candidate[]=[0,1,2].map(i=>({name:'خالد '+i+' الحسن',email:'contact-'+i+'@example.com',company:'شركة '+i,title:'مدير التسويق',sector:'التقنية والبرمجيات',country:'السعودية',city:'الرياض',size:'1-10',website:'https://example.com',source:'كتالوج تجريبي محلي',email_status:'demo'}));
const input=(count=2):Resolved=>audienceOf(JSON.stringify({sector:'التقنية والبرمجيات',countries:['SA'],city:'',title:'',size:'all',count,confirmed:true,requestId:randomUUID()}));
async function setup(){
  const store=await testStore();
  const admin=await store.addUser('Owner','owner@example.com','secure-password-123','admin');
  const alice=await store.addUser('Alice','alice@example.com','secure-password-123','member',10);
  const bob=await store.addUser('Bob','bob@example.com','secure-password-123','member',10);
  return {store,admin,alice,bob};
}
// The live flow (live-search.ts) without the provider: reserve -> one delivered batch -> finish.
async function deliver(store:Store,userId:string,request:Resolved,candidates:Candidate[]){
  const search=await store.enqueueSearch(userId,request);
  if(search.status==='queued'){
    await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",search.id);
    await store.deliverBatch(userId,search.id,candidates);
    await store.finishSearch(search.id);
  }
  return store.getSearch(userId,search.id);
}
const balance=async(store:Store,id:string)=>(await store.user(id)).balance;

test('a fresh production store has no demo accounts; the owner is created once and sets a password via a one-time link',async()=>{
  const s=await testStore();
  try {
    assert.equal((await s.db.get<{n:number}>('SELECT count(*) n FROM users'))?.n,0);
    assert.equal((await s.db.get<{n:number}>('SELECT count(*) n FROM contacts'))?.n,0);
    const token=await s.createOwner('Client Owner','Owner@Company.com');
    await assert.rejects(s.login('owner@company.com',''));
    const owner=await s.session(await s.resetPassword(token,'owner-strong-password-1'));
    assert.equal(owner.role,'admin');assert.equal(owner.email,'owner@company.com');
    await assert.rejects(s.resetPassword(token,'another-password-123'));
    await assert.rejects(s.createOwner('Twice','owner@company.com'));
    assert.equal((await s.session(await s.login('owner@company.com','owner-strong-password-1'))).id,owner.id);
  } finally {await s.close();}
});
test('concurrent searches dedupe per member and charge once per normalized email',async()=>{
  const {store,alice,bob}=await setup();
  const noisy=[demoCatalog[0],{...demoCatalog[0],email:'  '+demoCatalog[0].email.toUpperCase()+' '},demoCatalog[1],{...demoCatalog[2],email:''}];
  try {
    const results=await Promise.all([deliver(store,alice.id,input(),noisy),deliver(store,alice.id,input(),noisy)]);
    assert.equal(results.reduce((n,r)=>n+r.delivered,0),2);
    assert.equal(await balance(store,alice.id),8);
    assert.equal((await store.snapshot(alice.id)).contacts.length,2);
    await deliver(store,bob.id,input(),noisy);
    assert.equal(await balance(store,bob.id),8);
    assert.equal((await store.snapshot(bob.id)).contacts.length,2);
  } finally {await store.close();}
});
test('same request is idempotent, different payload with reused id rejected',async()=>{
  const {store,alice}=await setup(),request=input();
  try {
    const first=await deliver(store,alice.id,request,demoCatalog.slice(0,2)),second=await deliver(store,alice.id,request,demoCatalog.slice(0,2));
    assert.equal(first.id,second.id);assert.equal(await balance(store,alice.id),8);
    await assert.rejects(store.enqueueSearch(alice.id,{...request,count:3}),/مستخدم لبحث مختلف/);
  } finally {await store.close();}
});
test('delivery transaction rolls back contacts and debit if any row is malformed',async()=>{
  const {store,alice}=await setup();
  const malformed={...demoCatalog[1],company:undefined} as unknown as Candidate;
  try {
    await assert.rejects(deliver(store,alice.id,input(),[demoCatalog[0],malformed]));
    assert.equal(await balance(store,alice.id),10);assert.equal((await store.snapshot(alice.id)).contacts.length,0);
  } finally {await store.close();}
});
test('zero balance rejects the search before anything is reserved',async()=>{
  const {store,admin,alice}=await setup();
  try {
    await store.adjustCredits(admin.id,alice.id,'set',0,'test reset',randomUUID());
    await assert.rejects(store.enqueueSearch(alice.id,input(1)),/لا يكفي/);
    assert.equal(await balance(store,alice.id),0);assert.equal(await store.reserved(alice.id),0);
  } finally {await store.close();}
});
test('a reservation that would exceed the balance is refused',async()=>{
  const {store,alice}=await setup();
  try {
    // 10 credits, two 6-credit reservations: exactly one is accepted. PGlite runs one transaction at a time, so this
    // checks the rule, not the row lock; scripts/check-concurrency.ts checks true overlap on a real Postgres.
    const outcomes=await Promise.allSettled([store.enqueueSearch(alice.id,input(6)),store.enqueueSearch(alice.id,input(6))]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal(await store.reserved(alice.id),6);
  } finally {await store.close();}
});
test('export ownership enforced and repeated export never debits',async()=>{
  const {store,alice,bob}=await setup();
  try {
    await deliver(store,alice.id,input(),demoCatalog.slice(0,2));
    const contacts=(await store.snapshot(alice.id)).contacts;
    assert.equal((await store.snapshot(bob.id)).contacts.length,0);
    await assert.rejects(store.contactsForExport(bob.id,[contacts[0].id]));
    await store.contactsForExport(alice.id);await store.contactsForExport(alice.id);
    assert.equal(await balance(store,alice.id),8);assert.equal((await store.snapshot(alice.id)).exports.length,2);
    const csv=contactsCsv([{...contacts[0],company:'=HYPERLINK("bad")',name:'Ali "Test", User'}]);
    assert.ok(csv.startsWith('﻿'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('""Test""'));
    assert.equal(cell('+cmd'),'"\' +cmd"'.replace("' ","'"));
  } finally {await store.close();}
});
test('CSV keeps each contact stored email status; only demo rows carry the demo label',()=>{
  const row={id:'c',user_id:'u',search_id:'s',created_at:''};
  const [,real,demo]=contactsCsv([{...demoCatalog[0],...row,source:'FullEnrich',email_status:'DELIVERABLE'},{...demoCatalog[1],...row}]).split('\r\n');
  assert.ok(real.endsWith(',"DELIVERABLE"'),real);
  assert.ok(real.includes(',"clowzy",')&&!real.includes('FullEnrich'),'the provider name never reaches the member\'s file: '+real);
  assert.ok(demo.endsWith(',"DEMO — not real contact data"'),demo);
});
test('invitations accepted once, preserve assigned credits, reject expired token',async()=>{
  const {store,admin}=await setup();
  try {
    const invite=await store.invite(admin.id,'New member','new@example.com',35);
    const token=await store.acceptInvite(invite.token,'a-strong-password-123'),user=await store.session(token);
    assert.equal(user.balance,35);await assert.rejects(store.acceptInvite(invite.token,'another-password'));
    const expired=await store.invite(admin.id,'Expired','expired@example.com',10);
    await store.db.run("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?",expired.id);
    await assert.rejects(store.acceptInvite(expired.token,'a-strong-password-123'));
  } finally {await store.close();}
});
test('suspension revokes sessions and enforces admin-only mutations',async()=>{
  const {store,admin,alice,bob}=await setup();
  try {
    const session=await store.createSession(alice.id);
    await assert.rejects(store.setActive(bob.id,alice.id,false));
    await assert.rejects(store.invite(bob.id,'Illegal','illegal@example.com',10));
    await store.setActive(admin.id,alice.id,false);await assert.rejects(store.session(session));
    await store.setActive(admin.id,alice.id,true);await assert.rejects(store.session(session));
    assert.equal((await store.session(await store.login(alice.email,'secure-password-123'))).id,alice.id);
  } finally {await store.close();}
});
test('credit reset remains ledger-backed and retry-safe',async()=>{
  const {store,admin,alice}=await setup(),request=randomUUID();
  try {
    await store.adjustCredits(admin.id,alice.id,'add',20,'manual grant',request);
    await store.adjustCredits(admin.id,alice.id,'add',20,'manual grant',request);
    assert.equal(await balance(store,alice.id),30);
    await store.adjustCredits(admin.id,alice.id,'set',3,'correction',randomUUID());
    assert.equal(await balance(store,alice.id),3);
    assert.equal((await store.snapshot(alice.id)).ledger.reduce((n,l)=>n+l.amount,0),3);
  } finally {await store.close();}
});
test('reset token is single-use and revokes all former sessions',async()=>{
  const {store,admin,alice}=await setup();
  try {
    const old=await store.createSession(alice.id);
    const reset=await store.createReset(admin.id,alice.id),fresh=await store.resetPassword(reset,'new-password-12345');
    await assert.rejects(store.session(old));await assert.rejects(store.resetPassword(reset,'another-password'));
    await assert.rejects(store.login(alice.email,'secure-password-123'));
    assert.equal((await store.session(fresh)).id,alice.id);
  } finally {await store.close();}
});
test('search contract requires confirmation and bounded integer count',()=>{
  assert.equal(searchSchema.safeParse({...input(),confirmed:false}).success,false);
  assert.equal(searchSchema.safeParse({...input(),count:51}).success,false);
  assert.equal(searchSchema.safeParse({...input(),count:1.5}).success,false);
  assert.equal(searchSchema.safeParse(input()).success,true);
});
test('terms: a new account has not accepted; acceptance is recorded once',async()=>{
  const s=await testStore();
  try {
    const u=await s.addUser('Member','terms@example.com','secure-password-123');
    assert.equal((await s.user(u.id)).terms_accepted_at,null);
    await s.acceptTerms(u.id);const first=(await s.user(u.id)).terms_accepted_at;
    assert.ok(first);await s.acceptTerms(u.id);assert.equal((await s.user(u.id)).terms_accepted_at,first,'first acceptance time is kept');
  } finally {await s.close();}
});
test('owner snapshot, password change, profile and logout run on Postgres types',async()=>{
  const {store,admin,alice}=await setup();
  try {
    const snap=await store.snapshot(admin.id);
    assert.equal(typeof snap.admin!.totals.used,'number');assert.equal(typeof snap.admin!.users[0].leads,'number');
    await assert.rejects(store.changePassword(alice.id,'wrong-password','another-secure-password'));
    const token=await store.changePassword(alice.id,'secure-password-123','another-secure-password');
    await store.updateProfile(alice.id,'Alice B');assert.equal((await store.session(token)).name,'Alice B');
    await store.logout(token);await assert.rejects(store.session(token));
    assert.equal((await store.session(await store.login(alice.email,'another-secure-password'))).id,alice.id);
  } finally {await store.close();}
});

test('a newer reset link, a used one or a password change cancels every older reset link',async()=>{
  const {store,admin,alice}=await setup();
  try {
    const a=await store.createReset(admin.id,alice.id),b=await store.createReset(admin.id,alice.id);
    await assert.rejects(store.resetPassword(a,'leaked-link-password'),'a newer link cancels the older one');
    await store.resetPassword(b,'new-password-12345');
    const c=await store.createReset(admin.id,alice.id);
    await store.changePassword(alice.id,'new-password-12345','newer-password-123');
    await assert.rejects(store.resetPassword(c,'x-password-12345'),'a password change cancels outstanding links');
  } finally {await store.close();}
});
test('login attempts are counted per IP in the database, so every server instance shares the limit',async()=>{
  const {store}=await setup();
  try {
    for(let i=0;i<20;i++) await store.hit('auth:1.2.3.4',20);
    await assert.rejects(store.hit('auth:1.2.3.4',20),(e:AppError)=>e.status===429);
    await store.hit('auth:5.6.7.8',20);
  } finally {await store.close();}
});
