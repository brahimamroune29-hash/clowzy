import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assist, cleanSearch } from '../src/lib/ai';
import { audienceOf, resolveAudience } from '../src/lib/audience';
import { fieldOf, labelsEn, type AssistContext } from '../src/lib/contracts';
import { companiesQuery, cursorKey, peopleQuery } from '../src/lib/icypeas';
import { findNiches, knownNiche, niches } from '../src/lib/niches';
import { groundedCompanies } from '../src/lib/web-companies';
import { testStore } from './pg';
import { catalogMatches, rememberCandidates } from '../src/lib/catalog';

const context:AssistContext={mode:'companies',sector:'عيادات الأسنان',countries:['SA'],city:'Riyadh',title:'',size:'all',count:50};
const noAi={sector:async()=>{throw new Error('A listed activity must not use the model');},title:async()=>{throw new Error('No title translation needed');}};
const form=(sector:string)=>({...context,sector,confirmed:true as const,requestId:randomUUID()});

test('every client activity and video example prepares the exact niche without a model or changing location/count',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Listed activities must work when the AI is unavailable');});
  const store=await testStore();
  try{
    assert.equal(niches.length,42);assert.equal(new Set(niches.map(n=>n.label)).size,42);
    for(const n of niches){
      assert.equal(fieldOf(n.label),n.field);assert.ok(labelsEn[n.label]);
      const ar=await assist([{role:'user',content:n.label}],'ar',context);
      const en=await assist([{role:'user',content:n.en}],'en',context);
      assert.equal(ar.search?.specialty,n.label);assert.equal(en.search?.specialty,n.label);
      assert.equal(ar.search?.city,'Riyadh');assert.equal(ar.search?.count,50);assert.equal(ar.search?.mode,'companies');
      assert.doesNotMatch(en.reply,/[\u0600-\u06ff]/);
      const scope=await resolveAudience(store,form(n.label),noAi);
      assert.deepEqual(scope.industries,[...n.industries]);
    }
    for(const label of ['العيادات الخاصة','مورّدو المعدات الطبية','مكاتب العقارات','المحاسبة والخدمات المالية','الصحة والطب'])assert.ok(audienceOf(JSON.stringify(form(label))).industries.length);
  }finally{await store.close();}
});

test('activity suggestions search Arabic spelling variants, English aliases and selected categories; unknown words stay custom',()=>{
  assert.equal(findNiches('اسنان')[0]?.label,'عيادات الأسنان');
  assert.equal(findNiches('طاقة شمسية')[0]?.label,'شركات الطاقة الشمسية');
  assert.equal(findNiches('cyber security')[0]?.label,'شركات الأمن السيبراني');
  assert.ok(findNiches('معدات طبية').some(n=>n.label==='مورّدو المعدات الطبية'));
  assert.ok(findNiches('', 'التعليم والتدريب').every(n=>n.field==='التعليم والتدريب'));
  assert.deepEqual(findNiches('شيء غير موجود'),[]);assert.equal(knownNiche('أخصائيي التغذية')?.label,'أخصائيو التغذية');
  assert.equal(cleanSearch({other:'محلات العطور',countries:['SA']})?.other,'محلات العطور');
});

test('narrow activities filter both people and companies by documented company keywords, without widening the city',()=>{
  const scopes=['عيادات التجميل','أخصائيو التغذية','شركات الطاقة الشمسية','تأجير السيارات','مورّدو المعدات الطبية'].map(s=>audienceOf(JSON.stringify(form(s))));
  for(const scope of scopes){
    const companies=companiesQuery(scope),people=peopleQuery({...scope,mode:'people'});
    assert.ok(companies.keyword?.include.length);assert.deepEqual(people['currentCompany.keyword']?.include,companies.keyword?.include);
    assert.deepEqual(companies.location.include,['Riyadh, SA']);assert.deepEqual(people.profileLocation.include,['Riyadh, SA']);
  }
  assert.notEqual(cursorKey(scopes[0]),cursorKey(scopes[1]),'overlapping provider categories must not share cursors across different niches');
  assert.equal(companiesQuery(audienceOf(JSON.stringify(form('عيادات الأسنان')))).keyword,undefined,'keep the established dental query');
});

test('web evidence must prove the requested service, not only a shared provider category',()=>{
  const scope=audienceOf(JSON.stringify(form('شركات المسابح')));
  const source=(url:string,service:string)=>({type:'url_citation',url_citation:{url,title:'Build Co',content:'Build Co in Riyadh, Saudi Arabia. '+service+'.'}});
  const select=(index:number)=>({index,name:'Build Co',industry:'Construction',evidence:1});
  const found=groundedCompanies([source('https://roof.example','We build residential roofs'),source('https://pool.example','We provide swimming pool construction')],{companies:[select(0),select(1)]},scope);
  assert.deepEqual(found.map(c=>c.website),['https://pool.example']);
});

test('shared industry-only inventory cannot bypass a specific activity filter',async t=>{
  process.env.CRM_ENABLED='true';process.env.CATALOG_REUSE_ENABLED='true';
  t.after(()=>{delete process.env.CRM_ENABLED;delete process.env.CATALOG_REUSE_ENABLED;});
  const store=await testStore();t.after(()=>store.close());
  const user=await store.addUser('Trial','trial@example.test','secure-password','member',5);
  await rememberCandidates(store,[{kind:'company',name:'General Practice',company:'General Practice',email:'info@general.example',title:'',sector:'Medical Practices',country:'السعودية',city:'Riyadh',website:'https://general.example',size:'12',source:'clowzy',email_status:'VERIFIED'}]);
  assert.equal((await catalogMatches(store,user.id,audienceOf(JSON.stringify(form('عيادات التجميل'))),50)).length,0);
  assert.equal((await catalogMatches(store,user.id,audienceOf(JSON.stringify(form('العيادات الخاصة'))),50)).length,1,'a general clinic request still uses matching inventory when sharing is explicitly enabled');
});
