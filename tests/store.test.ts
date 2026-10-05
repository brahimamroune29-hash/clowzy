import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError, Store } from '../src/lib/store';
import { contactsCsv,cell } from '../src/lib/csv';
import { Candidate,Resolved,TERMS_VERSION,termsCurrent } from '../src/lib/contracts';
import { searchSchema } from '../src/lib/schemas';
import { audienceOf } from '../src/lib/audience';
import { testStore, hookDb } from './pg';

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
test('concurrent searches are serialized per member; retries dedupe and charge once per email',async()=>{
  const {store,alice,bob}=await setup();
  const noisy=[demoCatalog[0],{...demoCatalog[0],email:'  '+demoCatalog[0].email.toUpperCase()+' '},demoCatalog[1],{...demoCatalog[2],email:''}];
  try {
    const results=await Promise.allSettled([deliver(store,alice.id,input(),noisy),deliver(store,alice.id,input(),noisy)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await deliver(store,alice.id,input(),noisy)).delivered,0, 'retry does not charge duplicates');
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
    await assert.rejects(store.enqueueSearch(alice.id,input(1)),/لا يكفي|رصيدك صفر/);
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
  assert.equal(cell('\n=1+1'), '"\'\n=1+1"', 'a leading newline is escaped as spreadsheet data too');
  const row={id:'c',user_id:'u',search_id:'s',created_at:''};
  const [,real,demo]=contactsCsv([{...demoCatalog[0],...row,source:'FullEnrich',email_status:'DELIVERABLE'},{...demoCatalog[1],...row}]).split('\r\n');
  assert.ok(real.endsWith(',"DELIVERABLE"'),real);
  assert.ok(real.includes(',"clowzy",')&&!real.includes('FullEnrich'),'the provider name never reaches the member\'s file: '+real);
  assert.ok(demo.endsWith(',"DEMO — not real contact data"'),demo);
  const [,probable]=contactsCsv([{...demoCatalog[0],...row,email_status:'PROBABLE'}]).split('\r\n');
  assert.ok(probable.endsWith(',"ثقة المزوّد ٩٥٪"'),'the member reads how sure each email is: '+probable);
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
test('name-only invitation lets the member choose an email once, preserves name and credits, and records the joined email',async()=>{
  const {store,admin}=await setup();
  try{
    const invite=await store.invite(admin.id,'Member chosen by owner',undefined,35);
    assert.equal((await store.invitation(invite.token)).email,'');
    const session=await store.acceptInvite(invite.token,'a-strong-password-123',' NEW@Example.com ',true),user=await store.session(session);
    assert.equal(user.email,'new@example.com');assert.equal(user.name,'Member chosen by owner');assert.equal(user.role,'member');assert.equal(user.balance,35);
    assert(termsCurrent(user));
    assert.equal((await store.db.get<{email:string}>('SELECT email FROM invitations WHERE id=?',invite.id))?.email,user.email);
    await assert.rejects(store.acceptInvite(invite.token,'other-password-123','other@example.com'),/الدعوة غير صالحة/);
    assert.equal((await store.db.get<{n:number}>('SELECT count(*)::int n FROM ledger WHERE user_id=?',user.id))?.n,1);
    assert.equal((await store.session(await store.login(user.email,'a-strong-password-123'))).id,user.id);
  }finally{await store.close();}
});
test('missing, invalid or existing email does not consume a name-only invitation; legacy email-bound invites cannot be redirected',async()=>{
  const {store,admin,alice}=await setup();
  try{
    const invite=await store.invite(admin.id,'Waiting member',undefined,15);
    for(const email of [undefined,'not-an-email',alice.email.toUpperCase()])await assert.rejects(store.acceptInvite(invite.token,'a-strong-password-123',email),AppError);
    const row=await store.db.get<{used_at:string|null;email:string}>('SELECT used_at,email FROM invitations WHERE id=?',invite.id);
    assert.equal(row?.used_at,null);assert.equal(row?.email,'');
    const fresh=await store.session(await store.acceptInvite(invite.token,'a-strong-password-123','fresh@example.com'));
    assert.equal(fresh.balance,15);assert.equal(fresh.terms_accepted_at,null,'old clients still require explicit consent on the terms screen');
    const bound=await store.invite(admin.id,'Legacy member','legacy@example.com',10);
    await assert.rejects(store.acceptInvite(bound.token,'a-strong-password-123','replacement@example.com'),/مخصصة للبريد/);
    assert.equal((await store.invitation(bound.token)).email,'legacy@example.com');
    assert.equal((await store.session(await store.acceptInvite(bound.token,'a-strong-password-123'))).email,'legacy@example.com');
    const expired=await store.invite(admin.id,'Expired member',undefined,10);
    await store.db.run("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?",expired.id);
    await assert.rejects(store.acceptInvite(expired.token,'a-strong-password-123','expired-new@example.com'),/الدعوة غير صالحة/);
    assert.equal(await store.db.get('SELECT id FROM users WHERE email=?','expired-new@example.com'),undefined);
  }finally{await store.close();}
});
test('failed session creation rolls back signup, invitation use, starting credits and consent',async()=>{
  const {store,admin}=await setup();
  try{
    const invite=await store.invite(admin.id,'Atomic signup',undefined,35);
    const before=await store.db.get<{n:number}>('SELECT count(*)::int n FROM ledger');
    let fail=true;hookDb(store,sql=>{if(fail&&sql.startsWith('INSERT INTO sessions'))throw Error('injected session failure');});
    await assert.rejects(store.acceptInvite(invite.token,'a-strong-password-123','atomic@example.com',true),/injected session failure/);
    assert.equal((await store.invitation(invite.token)).email,'');
    assert.equal(await store.db.get('SELECT id FROM users WHERE email=?','atomic@example.com'),undefined);
    assert.deepEqual(await store.db.get('SELECT count(*)::int n FROM ledger'),before);
    fail=false;assert.equal((await store.session(await store.acceptInvite(invite.token,'a-strong-password-123','atomic@example.com',true))).balance,35);
  }finally{await store.close();}
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
test('terms: a new account has not accepted; acceptance is recorded once per version, and newer terms ask again',async()=>{
  const s=await testStore();
  try {
    const u=await s.addUser('Member','terms@example.com','secure-password-123');
    assert.ok(TERMS_VERSION<=new Date().toISOString(),'a TERMS_VERSION in the future would refuse every acceptance until then');
    assert.equal(termsCurrent(await s.user(u.id)),false);
    await s.acceptTerms(u.id);const first=(await s.user(u.id)).terms_accepted_at;
    assert.ok(termsCurrent(await s.user(u.id)));await s.acceptTerms(u.id);assert.equal((await s.user(u.id)).terms_accepted_at,first,'first acceptance time is kept');
    await s.db.run('UPDATE users SET terms_accepted_at=? WHERE id=?','2026-09-28T10:00:00.000Z',u.id); // accepted the terms before TERMS_VERSION
    assert.equal(termsCurrent(await s.user(u.id)),false,'the terms changed since');
    await s.acceptTerms(u.id);assert.ok(termsCurrent(await s.user(u.id)));
  } finally {await s.close();}
});
test('owner recovery code: needs the current password, works once, and is replaced by a new one',async()=>{
  const {store,admin,alice}=await setup();
  try {
    await assert.rejects(store.createRecoveryCode(admin.id,'wrong-password'));
    await assert.rejects(store.createRecoveryCode(alice.id,'secure-password-123'),(e:AppError)=>e.status===403,'owner only');
    const old=await store.createRecoveryCode(admin.id,'secure-password-123'),code=await store.createRecoveryCode(admin.id,'secure-password-123');
    assert.match(code,/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    assert.equal((await store.overview(admin.id)).admin!.recovery,true);
    await assert.rejects(store.recover('owner@example.com',old,'forgotten-password-1'),'a new code replaces the old one');
    await assert.rejects(store.recover('alice@example.com',code,'forgotten-password-1'),'another account');
    const before=await store.login('owner@example.com','secure-password-123');
    const {token,code:next}=await store.recover(' Owner@Example.com ',code.toLowerCase().replaceAll('-',' '),'forgotten-password-1'); // typed loosely
    assert.equal((await store.session(token)).id,admin.id);
    await assert.rejects(store.session(before),'other sessions end');
    await assert.rejects(store.login('owner@example.com','secure-password-123'));
    await assert.rejects(store.recover('owner@example.com',code,'again-password-12'),'a used code is spent');
    assert.notEqual(next,code);await store.recover('owner@example.com',next,'again-password-12');
    await store.login('owner@example.com','again-password-12');
  } finally {await store.close();}
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
    for(let i=0;i<2;i++) await store.hit('assist-day:u',2,86400000,'حد اليوم');
    await assert.rejects(store.hit('assist-day:u',2,86400000,'حد اليوم'),(e:AppError)=>e.status===429&&e.message==='حد اليوم','a day-long window counts across minutes');
  } finally {await store.close();}
});

// PGlite serializes transactions; this checks rollback and lock ordering, not real multi-connection contention.
test('reset creation rolls back revocation on failure and locks the account before touching tokens',async()=>{
  const {store,admin,alice}=await setup();
  try {
    const old=await store.createReset(admin.id,alice.id);
    let fail=true;const queries:string[]=[];
    hookDb(store,sql=>{queries.push(sql);if(fail&&sql.startsWith('INSERT INTO reset_tokens'))throw new Error('injected reset failure');});
    await assert.rejects(store.createReset(admin.id,alice.id),/injected reset failure/);
    fail=false;
    assert.ok(queries.findIndex(q=>q.includes('FOR UPDATE')) < queries.findIndex(q=>q.startsWith('UPDATE reset_tokens')));
    await store.resetPassword(old,'still-valid-password-123');
    const outcomes=await Promise.allSettled([
      store.changePassword(alice.id,'still-valid-password-123','winner-password-123'),
      store.changePassword(alice.id,'still-valid-password-123','loser-password-123'),
    ]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,'the old password authorizes only the first change');
  } finally {await store.close();}
});

test('reset links are for members only, and per-search coverage rows stay out of the owner activity log',async()=>{
  const {store,admin,alice}=await setup();
  try {
    await assert.rejects(store.createReset(admin.id,admin.id),(e:AppError)=>e.status===404,'no reset link for the owner account');
    await store.createReset(admin.id,alice.id);
    await store.db.run("INSERT INTO audit(id,actor_id,action,detail,created_at) VALUES(?,?,'search-coverage','{}',?)",randomUUID(),alice.id,new Date(Date.now()+1000).toISOString());
    assert.ok(!(await store.snapshot(admin.id)).admin!.audit.some(a=>a.action==='search-coverage'));
    assert.ok(!(await store.overview(admin.id)).admin!.audit.some(a=>a.action==='search-coverage'));
  } finally {await store.close();}
});

test('owner handover: a one-time link lets the new owner set the sign-in email and password; everything of the old owner ends',async()=>{
  const {store,admin,alice}=await setup();
  try {
    const before=await store.login('owner@example.com','secure-password-123');
    await store.createRecoveryCode(admin.id,'secure-password-123');
    const memberLink=await store.createReset(admin.id,alice.id);
    await assert.rejects(store.claimOwner(memberLink,'taken@client.com','client-password-1'),'a member reset link cannot claim the owner account');
    const link=await store.ownerHandover();
    await assert.rejects(store.claimOwner(link,'alice@example.com','client-password-1'),'an email in use is refused');
    const session=await store.claimOwner(link,' Boss@Client.com ','client-password-1'); // the refusal left the link usable
    const owner=await store.session(session);
    assert.deepEqual([owner.id,owner.email,owner.role],[admin.id,'boss@client.com','admin']);
    await assert.rejects(store.session(before),'the old owner is signed out');
    await assert.rejects(store.login('owner@example.com','secure-password-123'));
    assert.equal((await store.overview(admin.id)).admin!.recovery,false,'the old recovery code is gone');
    await assert.rejects(store.claimOwner(link,'other@client.com','client-password-2'),'one use only');
  } finally {await store.close();}
});
