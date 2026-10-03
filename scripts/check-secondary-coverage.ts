// Explicit, bounded pilot only; not called by the application or its worker.
import {loadEnvConfig} from '@next/env';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {z} from 'zod';
import {HunterClient,hunterEnabled} from '../src/lib/hunter';
import {IcypeasClient,siteOf,type Lead} from '../src/lib/icypeas';

loadEnvConfig(process.cwd());
const schema=z.array(z.object({lastCompanyName:z.string().min(1),lastCompanyWebsite:z.string().min(1),address:z.string().min(1),lastCompanyIndustry:z.string().min(1)})).max(200);

async function main(){
  const [input,output]=process.argv.slice(2);
  if(!input||!output)throw Error('Usage: tsx scripts/check-secondary-coverage.ts grounded-missing-companies.json .data/private-coverage-proof.json');
  if(!hunterEnabled())throw Error('Hunter pilot disabled: requires HUNTER_API_KEY and explicit HUNTER_ENABLED=true. No request sent.');
  const path=resolve(output),privateRoot=resolve('.data')+sep;
  if(!path.startsWith(privateRoot))throw Error('Save private evidence under .data only.');
  const unique=new Map<string,Lead>();
  for(const row of schema.parse(JSON.parse(readFileSync(input,'utf8')))){
    const lead:Lead={...row,kind:'company',published:true,publicationPending:false,email:''};
    const domain=siteOf(lead);if(domain&&!unique.has(domain))unique.set(domain,lead);
  }
  const leads=[...unique.values()].slice(0,20);
  if(!leads.length)throw Error('No eligible official business domains in input.');
  const client=new IcypeasClient(),hunter=new HunterClient();
  const records:{lead:Lead;outcome:string;status?:number}[]=[];
  const proof:Record<string,unknown>={startedAt:new Date().toISOString(),scope:'Up to 20 previously grounded businesses missing an accepted email. This does not prove 50 leads or authorize application activation.',companies:leads.length,records};
  writeFileSync(path,JSON.stringify(proof,null,2),{mode:0o600,flag:'wx'});
  const save=()=>writeFileSync(path,JSON.stringify(proof,null,2),{mode:0o600});
  const health=await client.verify();if(health.credits<200)throw Error('Provider headroom below pilot limit.');
  proof.creditsBefore=health.credits;
  for(const lead of leads){
    // Persist before each possibly paid request. Never automatically replay an interrupted pilot.
    proof.state='discovering';proof.currentDomain=siteOf(lead);save();
    const result=await hunter.find(siteOf(lead));
    records.push({lead:{...lead,email:result.email},outcome:result.outcome,...(result.status?{status:result.status}:{})});save();
    await sleep(1100);
  }
  const found=records.filter(r=>r.outcome==='found').map(r=>r.lead);
  proof.discovered=found.length;proof.state='submitting-verification';save();
  if(found.length){
    const file=await client.submit(found,'clowzy-secondary-pilot-'+Date.now());proof.file=file;proof.state='waiting';save();
    for(let n=0;n<30;n++){
      await sleep(4000);const result=await client.results(file,found);proof.verification=result;save();
      if(result.done){proof.state='complete';proof.accepted=result.candidates.length;break;}
    }
  }else{proof.state='complete';proof.accepted=0;save();}
  proof.finishedAt=new Date().toISOString();proof.creditsAfter=(await client.verify()).credits;save();
  console.log(JSON.stringify({companies:leads.length,discovered:found.length,accepted:proof.accepted??null,state:proof.state}));
}
void main().catch(e=>{console.error(e instanceof Error?e.message:'Pilot failed');process.exitCode=1;});
