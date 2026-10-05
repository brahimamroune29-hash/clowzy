/* eslint-disable @typescript-eslint/no-require-imports -- Standalone browser check uses the existing tsx CJS harness. */
// Real UI and API handlers with disposable Postgres and synthetic supplier responses. No real credentials loaded.
require('tsx/cjs');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { NextRequest } = require('next/server');
const { testStore, input, lead, item } = require('../tests/pg.ts');
const { GET, POST } = require('../src/app/api/[...path]/route.ts');
const APP = 'http://127.0.0.1:3100';
const PASSWORD = 'local-check-password';
Object.assign(process.env, { DATABASE_URL:'unused-test-db', APP_URL:APP, CRM_ENABLED:'true', CATALOG_REUSE_ENABLED:'false', ICYPEAS_API_KEY:'synthetic-key', OPENROUTER_API_KEY:'synthetic-key' });
let submitted = [], failures = [], checked = 0;
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body || '{}'), path = String(url).replace('https://app.icypeas.com/api/', '');
  if (String(url).startsWith('https://openrouter.ai/')) return Response.json({choices:[{message:{content:JSON.stringify({reply:'Your search is ready.',search:{mode:'people',field:'التقنية والاتصالات',specialty:'التقنية والبرمجيات',other:'',countries:['SA'],city:'',title:'',size:'all',count:1}})}}]});
  if (path === 'a/actions/subscription-information') return Response.json({credits:500});
  if (path === 'find-people/count' || path === 'find-companies/count') return Response.json({success:true,total:100});
  if (path === 'find-people') return Response.json({success:true,total:2,leads:[lead('browser1'),lead('browser2')]});
  if (path === 'find-companies') return Response.json({success:true,leads:[]});
  if (path === 'bulk-search') { submitted = body.data; return Response.json({success:true,file:'browser-file'}); }
  if (path === 'bulk-single-searchs/read') return Response.json({success:true,items:submitted.map((_,i)=>item(i,`browser${i}@example.org`))});
  throw new Error('Unexpected external request: '+path);
};
async function main() {
  const store = await testStore(); globalThis.waslStore = store;
  const browser = await chromium.launch({headless:true});
  const errors = [], requests = [];
  async function context() {
    const c = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
    await c.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname.slice(5);
      if (failures.includes(path)) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary test outage'})});
      const r = new NextRequest(req.url(),{method:req.method(),headers:{...req.headers(),host:'127.0.0.1:3100','x-forwarded-for':'127.0.0.1'},...(req.method()==='POST'?{body:req.postData()}: {})});
      const response = await (req.method()==='GET'?GET:POST)(r,{params:Promise.resolve({path:path.split('/')})});
      requests.push({path,status:response.status});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    return c;
  }
  async function page(c) { const p=await c.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))errors.push(m.text());});return p; }
  async function check(name, fn) { try{await fn();checked++;console.log('PASS '+name);}catch(e){for(const c of browser.contexts())for(const p of c.pages())console.log('PAGE STATE',p.url().split('?')[0],(await p.locator('body').innerText()).slice(-4500));throw e;} }
  async function heading(p, name) { await p.getByRole('heading',{name,exact:true}).waitFor(); }
  async function go(p,path,name) { await p.goto(APP+path);await heading(p,name); }
  async function login(p,email,password=PASSWORD) {await p.getByLabel('Email',{exact:true}).fill(email);await p.getByLabel('Password',{exact:true}).fill(password);await p.getByRole('button',{name:'Sign in',exact:true}).click();}
  async function close(p) {await p.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});}
  async function download(p,button) {const event=p.waitForEvent('download');await button.click();const d=await event;const csv=readFileSync(await d.path(),'utf8');assert(csv.length>10);return csv;}
  try {
    await store.addUser('Test Owner','owner@browser.invalid',PASSWORD,'admin');
    const ownerContext=await context(), owner=await page(ownerContext);
    await owner.goto(APP);await owner.getByRole('button',{name:'English',exact:true}).click();
    await check('login validation, forgot-password controls and terms links',async()=>{
      await login(owner,'owner@browser.invalid','wrong-password');await owner.getByRole('alert').filter({hasText:'Wrong email or password.'}).waitFor();
      await owner.getByRole('button',{name:'Forgot your password?',exact:true}).click();await owner.getByRole('button',{name:'Platform owner? Use your recovery code',exact:true}).click();await heading(owner,'Recover your password');await owner.getByRole('button',{name:'Back to sign in',exact:true}).click();
      await owner.getByRole('link',{name:'Terms of use',exact:true}).click();await heading(owner,'Terms of use');await owner.getByRole('link',{name:'Back to the platform',exact:true}).click();
    });
    await check('owner login and provider connection button',async()=>{await login(owner,'owner@browser.invalid');await heading(owner,'Admin');await owner.getByRole('button',{name:'Check the connection',exact:true}).click();await owner.getByText('The data provider connection works.',{exact:true}).waitFor();});
    await check('logout outage shows an error and keeps the account open',async()=>{failures=['auth/logout'];await owner.getByRole('button',{name:'Sign out',exact:true}).click();await owner.getByRole('alert').filter({hasText:'Temporary test outage'}).waitFor();await heading(owner,'Admin');failures=[];await owner.getByRole('button',{name:'Dismiss',exact:true}).click();});
    let invitation;
    await check('invite member, copy link, cancel dialog and filters',async()=>{
      await owner.getByRole('link',{name:'Invite a member',exact:true}).click();await heading(owner,'Invite a new member');await close(owner);
      await owner.getByRole('button',{name:'Invite a member',exact:true}).click();await owner.getByLabel('Member name',{exact:true}).fill('Browser Member');await owner.getByLabel('Starting credits',{exact:true}).fill('60');await owner.getByRole('button',{name:'Create invitation link',exact:true}).click();
      invitation=await owner.getByLabel('Invitation link',{exact:true}).inputValue();await owner.getByRole('button',{name:'Copy link',exact:true}).click();await owner.getByText('Link copied.',{exact:true}).waitFor();await close(owner);
    });
    const memberContext=await context(), member=await page(memberContext);
    await check('invitation acceptance: the invited member picks the sign-in email and agrees to the terms',async()=>{
      await member.goto(invitation);await member.getByRole('button',{name:'English',exact:true}).click();await heading(member,'Welcome');await member.getByLabel('Email',{exact:true}).fill('member@browser.invalid');await member.getByLabel('New password').fill(PASSWORD);assert(await member.getByRole('button',{name:'Create account and sign in',exact:true}).isDisabled());await member.getByRole('checkbox').check();await member.getByRole('button',{name:'Create account and sign in',exact:true}).click();await heading(member,'Hello Browser');
    });
    await check('activity picker: narrow niches and every provider category, which counts as a listed choice',async()=>{
      await member.goto(APP+'/search?method=manual');await member.getByLabel('Business activity to reach').click();
      await member.getByLabel('Search business activities').fill('salon');await member.getByRole('option',{name:/Beauty salons/}).waitFor();
      await member.getByLabel('Search business activities').fill('personal care services');await member.getByRole('option',{name:/Personal Care Services.*Data provider category/}).click();
      assert.match(await member.getByLabel('Business activity to reach').innerText(),/Personal Care Services/);assert.equal(await member.getByLabel('Type a custom activity').count(),0);
      assert(await member.getByLabel('Choose an additional category').locator('optgroup[label="All data provider categories"] option').count()>400);
    });
    const user=await store.db.get('select id from users where email=?','member@browser.invalid');
    // Existing results exercise pagination and exports without paying a supplier.
    const seeded=await store.enqueueSearch(user.id,input(30));await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",seeded.id);
    await store.deliverBatch(user.id,seeded.id,Array.from({length:30},(_,i)=>({name:`Contact ${String(i).padStart(2,'0')}`,email:`contact${i}@example.org`,company:'Browser Company',title:'CEO',sector:'Software Development',country:'Saudi Arabia',city:'Riyadh',website:'https://example.com',size:'12',source:'Synthetic browser fixture',email_status:'demo',kind:i===0?'company':'person'})));await store.finishSearch(seeded.id);
    await check('member search filters, country controls, company mode and AI preparation',async()=>{
      await go(member,'/search','Who do you want to reach?');await member.getByRole('button',{name:'All Gulf countries',exact:true}).click();await member.getByRole('button',{name:'More options: city, job title, company size',exact:true}).click();assert(await member.getByLabel('City').isDisabled());
      for(const country of ['United Arab Emirates','Qatar','Kuwait','Bahrain','Oman'])await member.getByRole('button',{name:'Remove '+country,exact:true}).click();await member.getByLabel('City').fill('Riyadh');await member.getByLabel('Company size').selectOption('11-50');
      await member.getByRole('button',{name:'Company emails',exact:true}).click();assert.equal(await member.getByLabel('Job title',{exact:true}).count(),0);await member.getByRole('button',{name:'People in companies',exact:true}).click();
      await member.getByLabel('Describe your clients and the assistant fills the search').fill('Software companies in Saudi Arabia');await member.getByRole('button',{name:'Fill it in',exact:true}).click();await member.getByText('The search is ready. Review it, then start.',{exact:true}).waitFor();
      await member.getByLabel('Saved audience name',{exact:true}).fill('Browser audience');await member.getByRole('button',{name:'Save criteria',exact:true}).click();await member.getByText('Audience saved in CRM.',{exact:true}).waitFor();
    });
    await check('start search, supplier polling, delivery and debit',async()=>{
      await member.getByLabel('How many emails',{exact:true}).fill('1');await member.getByRole('checkbox').check();await member.getByRole('button',{name:'Start search',exact:true}).click();await member.waitForURL('**/leads?search=*');await member.getByText('browser0@example.org',{exact:true}).waitFor({timeout:30000});assert.equal((await store.user(user.id)).balance,29);
    });
    await check('contacts filtering, pagination, selection, detail, copy and CSV',async()=>{
      await go(member,'/leads','My contacts');await member.getByRole('button',{name:'Next',exact:true}).click();assert.equal(await member.locator('.page-number').textContent(),'2');await member.getByRole('button',{name:'Previous',exact:true}).click();
      await member.getByLabel('Search contacts',{exact:true}).fill('contact0@example.org');await member.getByRole('button',{name:'Details of Contact 00',exact:true}).click();await member.getByRole('button',{name:'Copy email',exact:true}).click();await member.getByText('Email copied.',{exact:true}).waitFor();await close(member);await member.getByRole('checkbox',{name:'Select page',exact:true}).check();const csv=await download(member,member.getByRole('button',{name:'Download selected (1)',exact:true}));assert.match(csv,/contact0@example.org/);assert(!csv.includes('contact1@example.org'));
      await member.getByLabel('Search contacts',{exact:true}).fill('no-such-contact');await heading(member,'No results');
    });
    await check('history results, repeat link and credit history',async()=>{await go(member,'/history','Search history');await member.getByRole('link',{name:'Results',exact:true}).first().click();await member.waitForURL('**/leads?search=*');await go(member,'/history','Search history');await member.getByTitle('Search again with these filters').first().click();await member.waitForURL('**/search?from=*');await go(member,'/credits','Your credits');await heading(member,'Credit history');});
    await check('assistant open, send, search suggestion and close',async()=>{await member.getByRole('button',{name:'Assistant',exact:true}).click();await member.getByLabel('Your message',{exact:true}).fill('Find software companies');await member.getByRole('button',{name:'Send',exact:true}).click();await member.getByRole('button',{name:'Open this search',exact:true}).click();await member.waitForURL('**/search?ai=*');await member.getByRole('button',{name:'Assistant',exact:true}).click();await member.locator('.assistant').getByRole('button',{name:'Close',exact:true}).click();});
    await check('CRM list, contact stages/tags/notes, filters, pagination, export profiles',async()=>{
      await go(member,'/crm','CRM');await member.getByRole('button',{name:'Next',exact:true}).click();await member.getByRole('button',{name:'Previous',exact:true}).click();await member.getByLabel('List name',{exact:true}).fill('Prospects');await member.getByRole('button',{name:'Add list',exact:true}).click();await member.getByRole('option',{name:'Prospects',exact:true}).waitFor({state:'attached'});
      await member.getByLabel('Search',{exact:true}).fill('contact0@example.org');await member.getByRole('button',{name:'Contact 00',exact:true}).click();await member.getByLabel('Contact stage',{exact:true}).selectOption('interested');await member.getByLabel('Comma separated tags',{exact:true}).fill('VIP, Saudi');await member.getByLabel('Private notes',{exact:true}).fill('Private test note');await member.getByRole('checkbox',{name:'Prospects',exact:true}).check();await member.getByRole('button',{name:'Save',exact:true}).click();await member.getByRole('dialog').waitFor({state:'hidden'});
      await member.getByRole('button',{name:'Contact 00',exact:true}).click();assert.equal(await member.getByLabel('Private notes',{exact:true}).inputValue(),'Private test note');await member.getByLabel('Private notes',{exact:true}).fill('Updated private note');await member.getByRole('button',{name:'Save',exact:true}).click();await member.getByRole('dialog').waitFor({state:'hidden'});
      await member.getByLabel('Stage',{exact:true}).selectOption('interested');await member.getByLabel('List',{exact:true}).selectOption({label:'Prospects'});await member.getByLabel('Tag',{exact:true}).fill('VIP');assert.equal(await member.locator('tbody tr').count(),1);
      await member.getByRole('button',{name:'Custom export',exact:true}).click();await member.getByLabel('Export profile',{exact:true}).selectOption('gohighlevel');assert(await member.getByRole('checkbox',{name:'Email',exact:true}).isDisabled());await member.getByRole('button',{name:'Preview first five rows',exact:true}).click();await member.locator('.crm-preview').waitFor();assert.match(await member.locator('.crm-preview').textContent(),/Business Name/);const csv=await download(member,member.getByRole('button',{name:'Download CSV',exact:true}));assert.match(csv,/contact0@example.org/);
    });
    await check('CRM exclusions, notification, saved audience removal and deletion request',async()=>{
      await member.getByLabel('Email or domain',{exact:true}).fill('excluded.example');await member.getByRole('button',{name:'Exclude',exact:true}).click();await member.getByText('excluded.example',{exact:true}).waitFor();await member.locator('.crm-item').filter({hasText:'excluded.example'}).getByRole('button',{name:'Remove',exact:true}).click();
      await member.getByRole('button',{name:'Mark read',exact:true}).first().click();await member.getByRole('link',{name:'Browser audience',exact:true}).click();await member.waitForURL('**/search?saved=*');await go(member,'/crm','CRM');await member.locator('.crm-item').filter({hasText:'Browser audience'}).getByRole('button',{name:'Remove',exact:true}).click();
      await member.getByLabel('Search',{exact:true}).fill('contact0@example.org');await member.getByRole('button',{name:'Contact 00',exact:true}).click();await member.getByRole('button',{name:'Request deletion from the platform',exact:true}).click();await member.getByText('Saved.',{exact:true}).waitFor();await close(member);await member.getByRole('button',{name:'Remove list',exact:true}).click();await member.getByText('Awaiting owner review',{exact:false}).waitFor();
    });
    await check('owner reviews deletion and member contact disappears',async()=>{await go(owner,'/admin/crm','Contact operations');await owner.getByRole('button',{name:'Review',exact:true}).click();await owner.getByRole('button',{name:'Approve and delete',exact:true}).click();await owner.getByText('Deleted and audited.',{exact:true}).waitFor();assert.equal(await store.db.get('select id from contacts where email=?','contact0@example.org'),undefined);});
    await check('member profile and password change, logout and new-password login',async()=>{
      await go(member,'/settings','Settings');await member.getByLabel('Name',{exact:true}).fill('Updated Member');await member.getByRole('button',{name:'Save',exact:true}).click();await member.getByText('Saved.',{exact:true}).waitFor();await member.getByLabel('Current password',{exact:true}).fill(PASSWORD);await member.getByLabel('New password').fill(PASSWORD+'-new');await member.getByRole('button',{name:'Change password',exact:true}).click();await member.getByText('Password changed; other sessions were signed out.',{exact:true}).waitFor();await member.getByRole('button',{name:'Sign out',exact:true}).click();await member.waitForURL(APP+'/');await heading(member,'Sign in');await login(member,'member@browser.invalid',PASSWORD+'-new');await heading(member,'Hello Updated');
    });
    await check('owner member search/filter, add/set balance and detail reset link',async()=>{
      await go(owner,'/admin/members','Members and invitations');await owner.getByLabel('Search members',{exact:true}).fill('Updated Member');await owner.getByRole('button',{name:'Credits',exact:true}).click();await owner.getByLabel('Credits to add',{exact:true}).fill('5');await owner.getByLabel('Reason',{exact:true}).fill('Browser check grant');await owner.getByRole('button',{name:'Confirm',exact:true}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});assert.equal((await store.user(user.id)).balance,34);
      await owner.getByRole('button',{name:'Credits',exact:true}).click();await owner.getByLabel(/^Change/).selectOption('set');await owner.getByLabel('New balance',{exact:true}).fill('10');await owner.getByLabel('Reason',{exact:true}).fill('Browser check correction');await owner.getByRole('button',{name:'Confirm',exact:true}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});assert.equal((await store.user(user.id)).balance,10);
      await owner.getByRole('button',{name:'Details of Updated Member',exact:true}).click();await owner.getByRole('button',{name:'Access recovery link',exact:true}).click();const reset=await owner.getByLabel('Valid for one hour — no email sent',{exact:true}).inputValue();await close(owner);await member.goto(reset);await heading(member,'A new password');await member.getByLabel('New password').fill(PASSWORD);await member.getByRole('button',{name:'Activate account',exact:true}).click();await heading(member,'Hello Updated');
    });
    await check('disable revokes member session, enable restores access',async()=>{
      await owner.getByRole('button',{name:'Disable Updated Member',exact:true}).click();await owner.getByRole('dialog').getByRole('button',{name:'Disable account',exact:true}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});await member.reload();await heading(member,'Sign in');await owner.getByLabel('Status',{exact:true}).selectOption('disabled');await owner.getByRole('button',{name:'Enable Updated Member',exact:true}).click();await owner.getByRole('dialog').getByRole('button',{name:'Enable account',exact:true}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});await login(member,'member@browser.invalid');await heading(member,'Hello Updated');
    });
    await check('owner recovery-code generation and password recovery',async()=>{
      await go(owner,'/settings','Settings');await owner.locator('section').filter({has:owner.getByRole('heading',{name:'Recovery code',exact:true})}).getByLabel('Current password',{exact:true}).fill(PASSWORD);await owner.getByRole('button',{name:'Create the code',exact:true}).click();const code=await owner.getByLabel('Your code',{exact:true}).inputValue();await owner.getByRole('button',{name:'Sign out',exact:true}).click();await owner.waitForURL(APP+'/');await heading(owner,'Sign in');await owner.getByRole('button',{name:'Forgot your password?',exact:true}).click();await owner.getByRole('button',{name:'Platform owner? Use your recovery code',exact:true}).click();await owner.getByLabel('Email',{exact:true}).fill('owner@browser.invalid');await owner.getByLabel('Recovery code',{exact:true}).fill(code);await owner.getByLabel('New password').fill(PASSWORD+'-reset');await owner.getByRole('button',{name:'Change password',exact:true}).click();await owner.getByRole('button',{name:'Saved it, continue',exact:true}).click();await heading(owner,'Admin');
    });
    await check('unavailable assistant and failed export show recoverable errors',async()=>{
      await go(member,'/leads','My contacts');failures=['export'];await member.getByRole('button',{name:'Download file',exact:true}).click();await member.getByRole('alert').filter({hasText:'Temporary test outage'}).waitFor();failures=[];await member.getByRole('button',{name:'Dismiss',exact:true}).click();
      await member.getByRole('button',{name:'Assistant',exact:true}).click();failures=['assist'];await member.getByLabel('Your message',{exact:true}).fill('Find companies');await member.getByRole('button',{name:'Send',exact:true}).click();await member.locator('.assistant').getByText('Temporary test outage',{exact:true}).waitFor();failures=[];await member.locator('.assistant').getByRole('button',{name:'Close',exact:true}).click();
    });
    await check('used invitation and invalid reset cannot be submitted again',async()=>{
      const c=await context(),p=await page(c);await p.goto(invitation);await p.getByRole('button',{name:'English',exact:true}).click();await p.getByRole('link',{name:'Sign in',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Activate account',exact:true}).count(),0);
      await p.goto(APP+'/reset?token='+'0'.repeat(48));await p.getByLabel('New password',{exact:true}).fill(PASSWORD);await p.getByRole('button',{name:'Activate account',exact:true}).click();await p.getByRole('link',{name:'Sign in',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Activate account',exact:true}).count(),0);await c.close();
    });
    await check('bootstrap outage retry preserves login',async()=>{failures=['bootstrap'];await member.goto(APP+'/credits');await member.getByRole('button',{name:'Try again',exact:true}).waitFor();failures=[];await member.getByRole('button',{name:'Try again',exact:true}).click();await heading(member,'Your credits');});
    await check('all navigation pages at mobile width, languages and theme',async()=>{
      mkdirSync('.data/browser-check',{recursive:true});
      for(const [p,paths] of [[member,['/dashboard','/search','/leads','/history','/credits','/crm','/settings']],[owner,['/admin','/admin/members','/admin/activity','/admin/crm','/settings']]]){
        await p.setViewportSize({width:390,height:844});
        for(const path of paths){await p.goto(APP+path);await p.locator('.page-heading h1').waitFor();assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Overflow: '+path);}
        await p.getByRole('button',{name:'Open menu',exact:true}).click();await p.getByRole('button',{name:'العربية',exact:true}).click();assert.equal(await p.locator('html').getAttribute('dir'),'rtl');await p.getByTitle('الوضع الفاتح أو الداكن').filter({visible:true}).click();await p.getByRole('button',{name:'إغلاق القائمة',exact:true}).click();await p.screenshot({path:'.data/browser-check/'+(p===member?'member':'owner')+'-mobile.png',fullPage:true});
        await p.getByRole('button',{name:'فتح القائمة',exact:true}).click();await p.getByRole('link',{name:'الإعدادات',exact:true}).click();await heading(p,'الإعدادات');assert.equal(await p.getByRole('button',{name:'إغلاق القائمة',exact:true}).count(),0);
      }
    });
    assert.deepEqual(errors,[],'Browser runtime errors');assert(!requests.some(r=>r.status>=500),'Unexpected backend failure');
    console.log(JSON.stringify({passed:checked,apiRequests:requests.length,runtimeErrors:errors.length,realProviderCalls:0}));
  } finally {await browser.close();await store.close();delete globalThis.waslStore;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
