import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { companiesQuery, cursorKey, IcypeasClient, stageCount } from '../src/lib/icypeas';
import { contactsCsv } from '../src/lib/csv';
import {coverageReport} from '../src/lib/coverage';
import { item, live, testStore } from './pg';

const companies = (count = 2, extra = {}) => audienceOf(JSON.stringify({ mode: 'companies', sector: 'العقارات', countries: ['SA', 'AE'], city: '', title: '', size: '11-50', count, widen: false, confirmed: true, requestId: randomUUID(), ...extra })); // widening: tests/widen.test.ts
const company = (id: string, o: Record<string, unknown> = {}) => ({ name: 'Company ' + id, url: 'https://www.linkedin.com/company/' + id, address: 'Riyadh, Riyadh, Saudi Arabia', website: 'https://www.' + id + '.example/about', industry: 'Real Estate', numberOfEmployees: 20, ...o });

test('a rejected published address falls back to another address on that site, with one customer and one debit',async()=>{
  const flag=process.env.PUBLISHED_EMAIL_ENABLED;process.env.PUBLISHED_EMAIL_ENABLED='true';
  const store=await testStore(),user=await store.addUser('Alternate trial','alternate@example.com','secure-password','member',5),owner=await store.addUser('QA Owner','qa-owner@example.com','secure-password','admin');
  const sent:{task:string;data:string[][]}[]=[];let reads=0;
  const transport:typeof fetch=async(url,init)=>{const path=String(url).split('/').pop(),b=JSON.parse(String(init?.body));
    if(path==='find-companies')return Response.json({success:true,leads:b.query.location.exclude?[]:[company('a')]});
    if(path==='bulk-search'){sent.push(b);return Response.json({success:true,file:'f'+sent.length});}
    if(path==='read'){const submission=sent[Number(b.file.slice(1))-1];return Response.json({success:true,items:[item(0,submission.data[0][0]==='sales@a.example'?'sales@a.example':null)]});}
    throw Error('Unexpected '+path);};
  const client=new IcypeasClient('test',transport,async()=>{reads++;return 'info@a.example sales@a.example contact@a.example';});
  try{const request=companies(2);let result=await live(store,client).start(user.id,request);
    for(let n=0;n<8&&result.status==='awaiting_provider';n++){await store.db.run('UPDATE provider_runs SET updated_at=0');const polled=await Promise.all([live(store,client).poll(user.id,result.id),live(store,client).poll(user.id,result.id)]);result=polled.find(s=>s.status!=='awaiting_provider')||polled[0];}
    assert.equal(result.delivered,1);assert.equal(result.status,'partial');assert.equal((await store.user(user.id)).balance,4);assert.equal(await store.reserved(user.id),0);
    assert.deepEqual(sent.map(s=>s.data),[[['a.example']],[['info@a.example']],[['sales@a.example']]]);assert.equal(reads,1);
    const contacts=(await store.snapshot(user.id)).contacts;assert.equal(contacts.length,1);assert.equal(contacts[0].email,'sales@a.example');
    const report=await coverageReport(store,owner.id,result.id);assert.equal(report.phases.verification.attempted,3);assert.equal(report.phases.verification.accepted,1);assert.equal(report.phases.verification.notFound,2);assert.equal(report.phases.site.addresses,3);assert.equal(report.events,4,'overlapping polls cannot record or deliver the same batch twice');assert(!JSON.stringify(report).includes('sales@a.example'));
    await assert.rejects(coverageReport(store,user.id,result.id),/مالك المنصة/);
    await live(store,client).start(user.id,companies(2));assert.equal(sent.length,3,'a new request cannot verify the same mail or a third mail for an already delivered company');
    assert.equal((await store.user(user.id)).balance,4);
  }finally{await store.close();if(flag===undefined)delete process.env.PUBLISHED_EMAIL_ENABLED;else process.env.PUBLISHED_EMAIL_ENABLED=flag;}
});

// Company pages and domain-discovery result files; no website network access is needed.
function mock(o: { pages?: unknown[][]; files?: unknown[][] } = {}) {
  const calls: { path: string; body: { query?: Record<string, unknown>; task?: string; data?: string[][]; pagination?: { token?: string }; file?: string } }[] = [];
  let submitted = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://app.icypeas.com/api/', ''), body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === 'find-people') return Response.json({ success: true, leads: [] }); // nobody: a people search falls back at once
    if (path === 'find-companies/count') return Response.json({ success: true, total: body.query?.location?.exclude ? 40 : 60 });
    if (path === 'find-companies') {
      const n = body.pagination?.token ? Number(body.pagination.token.slice(1)) : 0, pages = o.pages ?? [[company('a'), company('b')]];
      return Response.json({ success: true, leads: body.query?.location?.exclude ? [] : pages[n] ?? [], ...(pages[n + 1] && !body.query?.location?.exclude ? { pagination: { token: 't' + (n + 1) } } : {}) });
    }
    if (path === 'bulk-search') return Response.json({ success: true, file: 'file' + ++submitted });
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: (o.files ?? [])[Number(String(body.file).slice(4)) - 1] ?? [] });
    throw Error('Unexpected path ' + path);
  };
  return { calls, client: new IcypeasClient('unit-test-secret', transport), count: (p: string) => calls.filter(c => c.path === p).length };
}

test('companies are searched by headquarters, industry and headcount; the job title plays no part', () => {
  const q = companiesQuery({ ...companies(), titles: ['CEO'] });
  assert.deepEqual(q, { location: { include: ['AE', 'SA'] }, industry: { include: ['Real Estate', 'Real Estate Agents and Brokers', 'Commercial Real Estate', 'Leasing Residential Real Estate', 'Leasing Non-residential Real Estate'] }, headcount: { '>=': 11, '<=': 50 } });
  assert.deepEqual(companiesQuery(companies(), 1).location, { include: ['United Arab Emirates', 'الإمارات', 'Saudi Arabia', 'السعودية'], exclude: ['AE', 'SA'] });
  assert.notEqual(cursorKey(companies()), cursorKey({ ...companies(), mode: 'people' }), 'a companies search never continues a people cursor');
});

test('every eligible company domain is retained even when no email is published on its website', async () => {
  const m2 = mock({ pages: [[company('a'), company('b'), company('social', { website: 'https://instagram.com/x' }), company('far', { address: 'Cairo, Egypt' }), company('none', { website: '' }), company('directory',{website:'https://health.example/en/Pages/ServiceProviderDetails.aspx?id=37'})]] });
  const page2 = await m2.client.companies(companies(), null, 0);
  assert.equal(page2.returned, 6, 'every company returned is paid for (0.02 each)');
  assert.deepEqual(page2.leads.map(l => l.lastCompanyName), ['Company a', 'Company b'], 'unread sites survive the paid page');
  assert(page2.leads.every(l=>l.kind==='company'&&!l.email));
  assert.equal((await m2.client.count(companies())).total, 100, 'the free count asks the companies list');
  assert.equal(m2.count('find-companies/count'), 2);
});

test('dental coverage includes clinics classified as healthcare without widening city, size or including suppliers', () => {
  const input=companies(5,{sector:'عيادات الأسنان',countries:['SA'],city:'الرياض'});
  assert.equal(stageCount(input),4);assert.equal(stageCount({...input,mode:'people'}),2);
  const exact=companiesQuery(input),extra=companiesQuery(input,2),broad=companiesQuery(input,3);
  assert.deepEqual(extra.location,exact.location);assert.deepEqual(extra.headcount,exact.headcount);
  assert.deepEqual(extra.industry.exclude,['Dentists']);assert(extra.keyword?.include?.includes('dental'));
  assert(extra.name?.exclude.includes('lab'));assert(extra.name?.exclude.includes('course'));
  assert.deepEqual(broad.location,companiesQuery(input,1).location);
  assert.equal(JSON.parse(cursorKey(input)).queries.length,4);
  assert.equal(JSON.parse(cursorKey(input)).discovery,'domain-search');
});

test('dental company results exclude education, laboratories and suppliers even if provider filters return them',async()=>{
  const m=mock({pages:[[company('clinic',{name:'Smile Dental Clinic'}),company('lab',{name:'Dental Laboratories'}),company('course',{name:'International dentistry courses'}),company('supplier',{name:'Dental Suppliers'}),company('agent',{name:'Digital Medical',description:'The exclusive agent for dental implants.'})]]});
  const page=await m.client.companies(companies(5,{sector:'عيادات الأسنان'}));
  assert.equal(page.returned,5);assert.deepEqual(page.leads.map(l=>l.lastCompanyName),['Smile Dental Clinic']);
});

test('native domain discovery delivers one verified email per company and charges only delivered emails', async () => {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  try {
    // b: a NOT_FOUND row that still carries the email, and a stray row for an email never sent: neither is delivered.
    const m = mock({ files: [[item(0, 'info@a.example', 'ultra_sure', 'FOUND'), item(1, 'sales@b.example', 'probable', 'NOT_FOUND'), { ...item(0, 'other@a.example'), _id: 'stray' }]] });
    const first = await live(store, m.client).start(user.id, companies(2));
    assert.equal(first.status, 'awaiting_provider');
    const sent = m.calls.find(c => c.path === 'bulk-search')!.body;
    assert.equal(sent.task, 'domain-search');
    assert.deepEqual(sent.data, [['a.example'], ['b.example']]);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const done = await live(store, m.client).poll(user.id, first.id);
    assert.equal(done.delivered, 1); assert.equal(done.status, 'partial');
    const [contact] = (await store.snapshot(user.id)).contacts;
    assert.deepEqual([contact.kind, contact.name, contact.company, contact.title, contact.email, contact.email_status], ['company', 'Company a', 'Company a', '', 'info@a.example', 'VERIFIED']);
    assert.equal((await store.user(user.id)).balance, 9, 'one credit for the verified email; the unverified one is free');
    assert.match(done.message ?? '', /الشركات/, 'the closing message speaks of companies');
    assert.ok(contactsCsv([contact]).split('\r\n')[1].startsWith('"","","info@a.example","Company a"'), 'a company row has no person name in the file');
    assert.match((await store.getSearch(user.id, first.id)).title, /^شركات · /);
    const again = await live(store, m.client).start(user.id, companies(2));
    assert.equal(m.count('bulk-search'), 1, 'a company already tried for this member is not verified (paid) again');
    assert.equal(again.delivered, 0);
  } finally { await store.close(); }
});

test('domain results require verified ownership, exclude hiring mailboxes and retain legacy verification checks', async()=>{
  const first={...item(0,null),status:'DEBITED',results:{emails:[{email:'info@unrelated.example',certainty:'ultra_sure'},{email:'jobs@a.example',certainty:'ultra_sure'},{email:'support@a.example',certainty:'probable'},{email:'info@a.example',certainty:'ultra_sure'}]}};
  const m=mock({files:[[first,item(1,'info@b.example','not_found')]]}),page=await m.client.companies(companies());
  const result=await m.client.results('file1',page.leads);assert.deepEqual(result.candidates.map(c=>c.email),['info@a.example']);
  const legacy=await m.client.results('file1',[{...page.leads[0],kind:undefined,email:'hello@a.example'}]);assert.equal(legacy.candidates.length,0);
});

test('a first domain batch with one result continues from the saved page and fills five unique emails', async () => {
  const store=await testStore(),user=await store.addUser('Alice','alice@example.com','secure-password','member',10);
  const m=mock({pages:[Array.from({length:25},(_,i)=>company('c'+i))],files:[
    Array.from({length:17},(_,i)=>item(i,i===0?'info@c0.example':null)),
    Array.from({length:8},(_,i)=>item(i,i<4?'info@c'+(i+17)+'.example':null)),
  ]});
  try{
    let search=await live(store,m.client).start(user.id,companies(5));
    assert.equal(search.status,'awaiting_provider');
    assert.equal(JSON.parse((await store.cursor(user.id,cursorKey(companies()))).leftovers).length,8);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    search=await live(store,m.client).poll(user.id,search.id);
    assert.equal(search.delivered,1);assert.equal(search.status,'awaiting_provider');
    assert.equal(m.calls.filter(c=>c.path==='find-companies'&&!JSON.stringify(c.body.query).includes('exclude')).length,1,'does not refetch the paid page');
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    search=await live(store,m.client).poll(user.id,search.id);
    assert.equal(search.status,'completed');assert.equal(search.delivered,5);assert.equal((await store.user(user.id)).balance,5);
    assert.equal(await store.reserved(user.id),0);
  }finally{await store.close();}
});

test('a 50-email request survives collection pauses and a sparse first batch, topping up without repeated charges', async () => {
  const store = await testStore(), user = await store.addUser('Fifty test', 'fifty@example.com', 'secure-password', 'member', 60);
  const m = mock({ pages: Array.from({ length: 6 }, (_, page) => Array.from({ length: 25 }, (_, i) => company('f' + (page * 25 + i)))), files: [
    Array.from({ length: 100 }, (_, i) => item(i, i < 10 ? 'info@f' + i + '.example' : null)),
    Array.from({ length: 50 }, (_, i) => item(i, i < 40 ? 'info@f' + (100 + i) + '.example' : null)),
  ] });
  try {
    let search = await live(store, m.client).start(user.id, companies(50));
    for (let i = 0; i < 10 && search.status === 'awaiting_provider'; i++) {
      await store.db.run('UPDATE provider_runs SET updated_at=0');
      search = await live(store, m.client).poll(user.id, search.id);
    }
    assert.equal(search.status, 'completed'); assert.equal(search.delivered, 50);
    assert.equal(m.count('bulk-search'), 2); assert.equal((await store.user(user.id)).balance, 10); assert.equal(await store.reserved(user.id), 0);
    const contacts = (await store.snapshot(user.id)).contacts; assert.equal(new Set(contacts.map(c => c.email)).size, 50);
    await live(store, m.client).poll(user.id, search.id);
    assert.equal(m.count('bulk-search'), 2); assert.equal((await store.user(user.id)).balance, 10);
  } finally { await store.close(); }
});

test('a people search short of its count is completed with the companies\' own verified emails, once, labelled as such', async () => {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10);
  try {
    const m = mock({ files: [[item(0, 'info@a.example', 'very_sure', 'FOUND'), item(1, null, 'ultra_sure', 'NOT_FOUND')]] });
    const people = audienceOf(JSON.stringify({ ...JSON.parse(JSON.stringify(companies(2))), mode: 'people', title: 'مدير التسويق' }));
    const first = await live(store, m.client).start(user.id, people);
    assert.equal(m.count('find-people'), 2, 'the people first (both stages, nobody)');
    assert.equal(m.calls.find(c => c.path === 'bulk-search')?.body.task, 'domain-search', 'then the companies of the same filters');
    assert.deepEqual([first.checked, first.companiesChecked], [2, 2], 'the progress line names the companies looked up after the people');
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    const done = await live(store, m.client).poll(user.id, first.id);
    assert.equal(done.delivered, 1); assert.equal(done.status, 'partial');
    assert.equal((await store.snapshot(user.id)).contacts[0].kind, 'company');
    assert.equal(done.message, 'بحثنا عن بريد 0 من الأشخاص المطابقين، ثم أجرينا 2 عملية بحث عن بريد الشركات نفسها، فوصلك 1 من 2. لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المسمى الوظيفي أو أضف دولًا.', 'only the filters this search set');
    assert.equal(m.count('find-people'), 2, 'never back to the people after the fallback');
    assert.equal((await store.user(user.id)).balance, 9);
  } finally { await store.close(); }
});

test('missing domain results resume from a durable published-contact queue, verify the exact business Gmail, and debit once', async () => {
  const before = process.env.PUBLISHED_EMAIL_ENABLED; process.env.PUBLISHED_EMAIL_ENABLED = 'true';
  const store = await testStore(), user = await store.addUser('Publication trial', 'publication@example.com', 'secure-password', 'member', 5);
  const calls: {task:string;data:string[][]}[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split('/').pop(), body = JSON.parse(String(init?.body));
    if (path === 'find-companies') return Response.json({ success:true,leads:body.query.location.exclude ? [] : [company('alpha'),company('bravo')] }); // the site's domain carries the name
    if (path === 'bulk-search') { calls.push(body); return Response.json({ success:true,file:'f'+calls.length }); }
    if (path === 'read') return Response.json({ success:true,items:body.file === 'f1' ? [item(0,null),item(1,null)] : [item(0,'clinic-a@gmail.com'),item(1,'different@gmail.com')] });
    throw Error('Unexpected '+path);
  };
  const client = new IcypeasClient('test', transport, async url => '<a href="mailto:clinic-'+new URL(url).hostname.replace(/^www\./,'')[0]+'@gmail.com">Contact</a>');
  const request = companies(2);
  try {
    let result = await live(store,client).start(user.id,request);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    result = await live(store,client).poll(user.id,result.id);
    assert.equal(calls[1].task,'email-verification'); assert.deepEqual(calls[1].data,[['clinic-a@gmail.com'],['clinic-b@gmail.com']]);
    await store.db.run('UPDATE provider_runs SET updated_at=0');
    result = await live(store,client).poll(user.id,result.id);
    assert.equal(result.delivered,1); assert.equal(result.status,'partial'); assert.equal((await store.user(user.id)).balance,4); assert.equal(await store.reserved(user.id),0);
    assert.match(result.message??'',/4 محاولة/, 'two companies with two checks each must not be reported as four different companies');
    assert.equal((await store.snapshot(user.id)).contacts[0].email,'clinic-a@gmail.com');
    assert.equal(await store.claimPerson(user.id,'different-key','اسم آخر للعيادة','اسم آخر للعيادة','alpha.example'),false,'a changed brand spelling must not create a second customer from the same domain');
    await live(store,client).poll(user.id,result.id); await live(store,client).start(user.id,request);
    assert.equal(calls.length,2); assert.equal((await store.user(user.id)).balance,4);
    const native = await client.results('f2',[{kind:'company',lastCompanyName:'A',lastCompanyWebsite:'https://a.example',email:''}]);
    assert.equal(native.candidates.length,0,'a provider Gmail without publication evidence is still rejected');
  } finally { await store.close(); if(before===undefined)delete process.env.PUBLISHED_EMAIL_ENABLED;else process.env.PUBLISHED_EMAIL_ENABLED=before; }
});

test('fifty missing company emails can fill from bounded published-contact batches without replay or extra debit', async () => {
  const before=process.env.PUBLISHED_EMAIL_ENABLED;process.env.PUBLISHED_EMAIL_ENABLED='true';
  const store=await testStore(),user=await store.addUser('Fifty publications','fifty-publications@example.com','secure-password','member',50);
  const submissions:{task:string;data:string[][]}[]=[];
  const transport:typeof fetch=async(url,init)=>{
    const path=String(url).split('/').pop(),body=JSON.parse(String(init?.body));
    if(path==='find-companies')return Response.json({success:true,leads:body.query.location.exclude?[]:Array.from({length:50},(_,i)=>company('clinic'+i))});
    if(path==='bulk-search'){submissions.push(body);return Response.json({success:true,file:'f'+submissions.length});}
    if(path==='read'){const batch=submissions[Number(body.file.slice(1))-1];return Response.json({success:true,items:batch.data.map((row,i)=>item(i,batch.task==='domain-search'?null:row[0]))});}
    throw Error('Unexpected '+path);
  };
  const client=new IcypeasClient('test',transport,async url=>'<a href="mailto:'+new URL(url).hostname.replace(/^www\./,'').split('.')[0]+'@gmail.com">Contact</a>');
  try{
    const request=companies(50,{countries:['SA'],city:'الرياض'});let result=await live(store,client).start(user.id,request);
    for(let n=0;n<25&&result.status==='awaiting_provider';n++){
      await store.db.run('UPDATE provider_runs SET updated_at=0');
      result=await live(store,client).poll(user.id,result.id);
    }
    assert.equal(result.status,'completed');assert.equal(result.delivered,50);assert.equal((await store.user(user.id)).balance,0);assert.equal(await store.reserved(user.id),0);
    assert.equal(new Set((await store.snapshot(user.id)).contacts.map(c=>c.website)).size,50);
    assert(submissions.filter(s=>s.task==='email-verification').every(s=>s.data.length<=6)); // six websites read per round
    const paid=submissions.length;await live(store,client).start(user.id,request);assert.equal(submissions.length,paid);
  }finally{await store.close();if(before===undefined)delete process.env.PUBLISHED_EMAIL_ENABLED;else process.env.PUBLISHED_EMAIL_ENABLED=before;}
});
