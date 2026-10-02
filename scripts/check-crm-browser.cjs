/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CJS check registers tsx before loading real API handlers. */
// Local UI + real API handler against disposable PGlite. All /api traffic is intercepted; no provider or production DB.
require('tsx/cjs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {NextRequest}=require('next/server');
const {testStore,input}=require('../tests/pg.ts');
const {GET,POST}=require('../src/app/api/[...path]/route.ts');
async function main(){
  process.env.DATABASE_URL='disposable-test-only';process.env.APP_URL='http://127.0.0.1:3100';process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='false';delete process.env.ICYPEAS_API_KEY;delete process.env.OPENROUTER_API_KEY;
  const store=await testStore();globalThis.waslStore=store;
  const browser=await chromium.launch({headless:true});
  try{
    const member=await store.addUser('عضو اختبار محلي','member@crm.invalid','local-only-password','member',10),owner=await store.addUser('مالك اختبار','owner@crm.invalid','local-only-password','admin');
    await store.acceptTerms(member.id);
    const search=await store.enqueueSearch(member.id,input(1));await store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=?",search.id);
    await store.deliverBatch(member.id,search.id,[{name:'عميل تجريبي محلي',email:'demo@crm.invalid',company:'شركة الاختبار',title:'CEO',sector:'Software Development',country:'Saudi Arabia',city:'Riyadh',website:'https://example.com',size:'12',source:'Local UI fixture',email_status:'demo',kind:'person'}]);await store.finishSearch(search.id);
    for(const [role,user] of [['member',member],['owner',owner]]){
      const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
      await context.addCookies([{name:'wasl_session',value:await store.createSession(user.id),url:'http://127.0.0.1:3100'}]);
      await context.route('**/api/**',async route=>{
        const req=route.request(),headers={...req.headers(),host:'127.0.0.1:3100'};
        const request=new NextRequest(req.url(),{method:req.method(),headers,...(req.method()==='POST'?{body:req.postData()}: {})});
        const path=new URL(req.url()).pathname.slice(5).split('/');
        const response=await (req.method()==='GET'?GET:POST)(request,{params:Promise.resolve({path})});
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      });
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:3100/'+(role==='member'?'crm':'admin/crm'));
      await page.getByRole('heading',{name:role==='member'?'إدارة العملاء':'عمليات العملاء',exact:true}).waitFor();
      if(role==='member'){
        await page.getByLabel('اسم القائمة',{exact:true}).fill('قائمة الاختبار');await page.getByRole('button',{name:'إضافة قائمة',exact:true}).click();await page.getByRole('option',{name:'قائمة الاختبار'}).waitFor({state:'attached'});
        await page.getByRole('button',{name:'عميل تجريبي محلي',exact:true}).click();await page.getByRole('dialog').getByRole('combobox').selectOption('interested');await page.getByLabel('ملاحظات خاصة',{exact:true}).fill('ملاحظة خاصة للاختبار');await page.getByLabel('وسوم مفصولة بفاصلة',{exact:true}).fill('VIP');await page.getByRole('checkbox',{name:'قائمة الاختبار',exact:true}).check();await page.getByRole('button',{name:'حفظ',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
        await page.getByRole('button',{name:'تصدير مخصص',exact:true}).click();await page.getByLabel('قالب التصدير',{exact:true}).selectOption('gohighlevel');await page.getByRole('button',{name:'معاينة أول خمسة صفوف',exact:true}).click();await page.locator('.crm-preview').waitFor();assert.match(await page.locator('.crm-preview').textContent(),/demo@crm.invalid/);assert.match(await page.locator('.crm-preview').textContent(),/Business Name/);
        const download=page.waitForEvent('download');await page.getByRole('button',{name:'تنزيل CSV',exact:true}).click();assert.equal((await download).suggestedFilename(),'clowzy-contacts.csv');
        await page.screenshot({path:'/tmp/clowzy-crm-desktop.png',fullPage:true});
        await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/clowzy-crm-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile page must not overflow horizontally');
        await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:3100/search');await page.getByLabel('اسم الجمهور المحفوظ',{exact:true}).fill('جمهور التقنية');await page.getByRole('button',{name:'حفظ المعايير',exact:true}).click();await page.getByText('حُفظ الجمهور في إدارة العملاء.',{exact:true}).waitFor();
        await page.goto('http://127.0.0.1:3100/crm');await page.getByRole('link',{name:'جمهور التقنية',exact:true}).click();await page.waitForURL('**/search?saved=*');assert.ok(new URL(page.url()).searchParams.has('saved'));await page.getByLabel('اسم الجمهور المحفوظ',{exact:true}).waitFor();
        await page.goto('http://127.0.0.1:3100/search?saved=%7Bbad');await page.getByLabel('اسم الجمهور المحفوظ',{exact:true}).waitFor();
        await page.goto('http://127.0.0.1:3100/crm');await page.getByRole('heading',{name:'إدارة العملاء',exact:true}).waitFor();await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('heading',{name:'CRM',exact:true}).waitFor();
      }else await page.getByText('إعادة الاستخدام بين الحسابات معطلة.',{exact:true}).waitFor();
      assert.deepEqual(errors,[]);console.log('PASS '+role+': CRM UI, no runtime errors'+(role==='member'?', private edit/list, export preview/download, saved audience, mobile width':''));await context.close();
    }
  }finally{await browser.close();await store.close();delete globalThis.waslStore;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
