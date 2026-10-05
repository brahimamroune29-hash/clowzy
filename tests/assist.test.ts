import test from 'node:test';
import assert from 'node:assert/strict';
import { assist } from '../src/lib/ai';
import { assistRequestSchema } from '../src/lib/schemas';
import type { AssistContext } from '../src/lib/contracts';

const context:AssistContext={mode:'companies',sector:'عيادات الأسنان',countries:['AE'],city:'Dubai',title:'',size:'11-50',count:7};
test('clear listed niches and ambiguous transcription work without the model',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('A listed niche should not call a model');});
  for(const content of ['عيادة الاسنان','عيادات الأسنان','عيادات اسنان','Dental clinics']){
    const draft=await assist([{role:'user',content}],'ar',context);
    assert.equal(draft.action,'prepare');
    assert.deepEqual(draft.search,{mode:'companies',field:'الصحة والطب',specialty:'عيادات الأسنان',other:'',countries:['AE'],city:'Dubai',title:'',size:'11-50',count:7});
    assert.doesNotMatch(draft.reply,/companies|people/);
  }
  const question=await assist([{role:'user',content:'إعادة الأسنان'}],'ar',context);
  assert.equal(question.search,undefined);assert.equal(question.action,'clarify');assert.deepEqual(question.choices,['عيادات الأسنان']);
  const self=await assist([{role:'user',content:'أنا طبيب أسنان'}],'ar',context);
  assert.equal(self.search,undefined);assert.equal(self.action,'clarify');assert.doesNotMatch(JSON.stringify(self),/مرضى/);
  for (const [content,count] of [['أريد ١٠٠٠',50],['أريد 0',1]] as const) {
    const capped=await assist([{role:'user',content}],'ar',context);
    assert.equal(capped.search?.count,count);assert.match(capped.reply,/1 إلى 50/);
    assert.deepEqual(capped.search?.countries,['AE']);
  }
  const english=await assist([{role:'user',content:'Dental clinic'}],'en');
  assert.match(english.reply,/Dental clinics/);assert.doesNotMatch(english.reply,/[\u0600-\u06ff]/);
});
test('model patches preserve context, explanations do not mutate, and limits are explicit',async t=>{
  const answers:unknown[]=[
    {reply:'تم.',action:'prepare',choices:[],search:{countries:['SA']}},
    {reply:'تم.',action:'prepare',choices:[],search:{mode:'people',title:'المالك أو المؤسس'}},
    {reply:'تم.',action:'prepare',choices:[],search:{other:'محلات الساعات'}},
    {reply:'كريدت واحد لكل بريد جديد.',action:'answer',choices:[],search:{count:50}},
    {reply:'تم.',action:'prepare',choices:[],search:{count:1000}},
    {reply:'من تريد الوصول إليه؟',action:'clarify',choices:['أصحاب العيادات'],search:null},
  ];
  t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));assert.match(body.messages[0].content,/Current form/);
    return Response.json({choices:[{message:{content:JSON.stringify(answers.shift())}}]});
  });
  const old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test';
  t.after(()=>{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;});
  const country=(await assist([{role:'user',content:'في السعودية'}],'ar',context)).search!;
  assert.deepEqual([country.specialty,country.countries,country.city],['عيادات الأسنان',['SA'],'']);
  const owners=(await assist([{role:'user',content:'أريد المالكين'}],'ar',context)).search!;
  assert.equal(owners.mode,'people');assert.equal(owners.specialty,'عيادات الأسنان');assert.equal(owners.title,'المالك أو المؤسس');
  const niche=(await assist([{role:'user',content:'محلات الساعات'}],'ar',context)).search!;
  assert.deepEqual([niche.field,niche.specialty,niche.other],['','','محلات الساعات']);
  assert.equal((await assist([{role:'user',content:'كيف تحسبون رصيد عيادات الأسنان؟'}],'ar',context)).search,undefined);
  const large=await assist([{role:'user',content:'أريد 1000 بريد من العيادات'}],'ar',context);
  assert.equal(large.search?.count,50);assert.match(large.reply,/1 إلى 50/);
  const self=await assist([{role:'user',content:'أعمل طبيب أسنان'}],'ar',context);
  assert.equal(self.search,undefined);assert.equal(self.action,'clarify');
});
test('assistant context allows an empty audience but rejects invalid countries and counts',()=>{
  const messages=[{role:'user',content:'عيادة الاسنان'}];
  assert.ok(assistRequestSchema.safeParse({messages,context:{...context,sector:''}}).success);
  for(const patch of [{countries:['ZZ']},{count:1000},{sector:'x'.repeat(61)},{mode:'admin'}])
    assert.equal(assistRequestSchema.safeParse({messages,context:{...context,...patch}}).success,false);
});

test('new searches offer a choice, with separate manual and AI routes and compatible saved searches', async()=>{
  const {searchMethod}=await import('../src/lib/contracts');
  for(const [query,expected] of [['',null],['method=manual','manual'],['method=ai','ai'],['method=unknown',null],['ai=%7B%7D','ai'],['saved=%7B%7D','manual'],['from=previous','manual'],['method=choose&from=previous',null],['method=manual&ai=%7B%7D','manual']] as const)
    assert.equal(searchMethod(new URLSearchParams(query)),expected,query);
});
