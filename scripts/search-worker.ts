import { loadEnvConfig } from '@next/env';
import { setTimeout as sleep } from 'node:timers/promises';
import { getStore } from '../src/lib/store';
import { crmEnabled } from '../src/lib/catalog';
import { searchTick } from '../src/lib/search-worker';
loadEnvConfig(process.cwd());
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function main(){
  if(!crmEnabled()) throw new Error('CRM_ENABLED=true is required after applying the migration.');
  const store=getStore();
  try{while(!stopping){await searchTick(store);if(!stopping)await sleep(5000);}}
  finally{await store.close();}
}
void main().catch(e=>{console.error(e instanceof Error?e.message:'Worker failed');process.exitCode=1;});
