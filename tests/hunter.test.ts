import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HunterClient,hunterEnabled} from '../src/lib/hunter';

const email=(value:string,type='generic',status='valid')=>({value,type,verification:{status}});
test('secondary discovery requests generic mail, protects the key, and picks one address owned by the company',async()=>{
  const calls:{url:URL;init?:RequestInit}[]=[];
  const client=new HunterClient('private-test-key',async(url,init)=>{calls.push({url:new URL(String(url)),init});return Response.json({data:{domain:'clinic.example',emails:[email('privacy@clinic.example'),email('name@clinic.example','personal'),email('info@other.example'),email('sales@clinic.example'),email('contact@mail.clinic.example')]}});});
  const result=await client.find('clinic.example');assert.equal(result.outcome,'found');assert.equal(result.email,'sales@clinic.example');
  assert.equal(calls[0].url.hostname,'api.hunter.io');assert.equal(calls[0].url.searchParams.get('type'),'generic');assert.equal(calls[0].url.searchParams.get('limit'),'10');assert(!calls[0].url.href.includes('private-test-key'));assert.equal(new Headers(calls[0].init?.headers).get('X-API-KEY'),'private-test-key');assert.equal(calls[0].init?.redirect,'error');
});
test('disabled or unconfigured secondary discovery never sends a request',async()=>{
  let calls=0;const client=new HunterClient('',async()=>{calls++;throw Error('must not send');});assert.equal((await client.find('clinic.example')).outcome,'unconfigured');assert.equal(calls,0);
  const flag=process.env.HUNTER_ENABLED,key=process.env.HUNTER_API_KEY;try{process.env.HUNTER_ENABLED='false';process.env.HUNTER_API_KEY='test';assert.equal(hunterEnabled(),false);process.env.HUNTER_ENABLED='true';process.env.HUNTER_API_KEY='';assert.equal(hunterEnabled(),false);}finally{if(flag===undefined)delete process.env.HUNTER_ENABLED;else process.env.HUNTER_ENABLED=flag;if(key===undefined)delete process.env.HUNTER_API_KEY;else process.env.HUNTER_API_KEY=key;}
});
test('secondary discovery rejects private mail, sibling domains, invalid mail and a substituted company domain',async()=>{
  for(const [domain,rows] of [['clinic.example',[email('personal@gmail.com'),email('info@clinic.other'),email('no-reply@clinic.example'),email('info@clinic.example','generic','invalid')]],['other.example',[email('info@clinic.example')]]] as const){const client=new HunterClient('test',async()=>Response.json({data:{domain,emails:rows}}));assert.deepEqual(await client.find('clinic.example'),{email:'',outcome:'rejected'});}
});
test('missing results and provider errors stay distinct, without exposing provider response text',async()=>{
  assert.equal((await new HunterClient('test',async()=>Response.json({data:{domain:null,emails:[]}})).find('clinic.example')).outcome,'empty');
  for(const status of [401,429,500])assert.deepEqual(await new HunterClient('test',async()=>new Response('secret provider diagnostics',{status})).find('clinic.example'),{email:'',outcome:'unavailable',status});
  assert.equal((await new HunterClient('test',async()=>Response.json({unexpected:[]})).find('clinic.example')).outcome,'unavailable');
  assert.equal((await new HunterClient('test',async()=>{throw Error('secret-key');}).find('clinic.example')).outcome,'unavailable');
});
