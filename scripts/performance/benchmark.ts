import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir,cpus,release,platform,arch } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Store as StoreType } from '../../src/lib/store';
import { Store } from '../../src/lib/store';
import { contactsCsv } from '../../src/lib/csv';
import { weekBoundaries } from '../../src/lib/overview';
import { seedPerformanceFixture } from './fixture';

type Fixture=ReturnType<typeof seedPerformanceFixture>;
async function main() {
  const mode=process.argv[2];
  if(mode==='seed') {
    const dir=mkdtempSync(join(tmpdir(),'wasl-p1-')),db=join(dir,'synthetic.sqlite');
    const store=new Store(db),fixture=seedPerformanceFixture(store);store.close();
    writeFileSync(join(dir,'fixture.json'),JSON.stringify({db,...fixture},null,2));
    console.log(JSON.stringify({fixtureFile:join(dir,'fixture.json'),...fixture}));return;
  }
  if(mode!=='measure') throw new Error('Use: benchmark.ts seed | measure fixture.json store.ts output.json');
  const fixture=JSON.parse(readFileSync(process.argv[3],'utf8')) as Fixture&{db:string};
  if(!fixture.db.startsWith(join(tmpdir(),'wasl-p1-'))) throw new Error('Only a generated synthetic database is permitted');
  const loaded=await import(pathToFileURL(resolve(process.argv[4])).href);
  const store=new loaded.Store(fixture.db,false) as StoreType & {overview?:(id:string,days?:string[])=>unknown};
  const sample=(fn:()=>unknown)=>{
    for(let i=0;i<5;i++)fn();
    const timings:number[]=[];let value:unknown;
    for(let i=0;i<30;i++){const start=performance.now();value=fn();JSON.stringify(value);timings.push(performance.now()-start);}
    const sorted=[...timings].sort((a,b)=>a-b),json=JSON.stringify(value);
    return {samples:30,warmups:5,medianMs:sorted[15],p95Ms:sorted[28],minMs:sorted[0],maxMs:sorted[29],jsonBytes:Buffer.byteLength(json),gzipBytes:gzipSync(json).length,timingsMs:timings};
  };
  const overview=(id:string)=>store.overview?store.overview(id,weekBoundaries(new Date(fixture.created))):store.snapshot(id);
  const selected=store.snapshot(fixture.heavyId).contacts.slice(0,10).map(c=>c.id);
  const result={measuredAt:new Date().toISOString(),environment:{node:process.version,os:platform(),release:release(),arch:arch(),cpu:cpus()[0].model,logicalCpus:cpus().length},fixture,
    memberDashboard:sample(()=>overview(fixture.heavyId)),ownerDashboard:sample(()=>overview(fixture.ownerId)),
    legacyMemberList:sample(()=>store.snapshot(fixture.heavyId)),
    selectedExport:sample(()=>contactsCsv(store.contactsForExport(fixture.heavyId,selected))),
    queryPlan:store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC,id').all(fixture.heavyId),
    note:'Store reads plus JSON serialization. Warm serial samples; no HTTP, concurrency or production claim.'};
  store.db.prepare('DELETE FROM exports WHERE user_id=? AND created_at<>?').run(fixture.heavyId,fixture.created);
  store.close();writeFileSync(process.argv[5],JSON.stringify(result,null,2));
  console.log(JSON.stringify({member:result.memberDashboard,owner:result.ownerDashboard},(key,value)=>key==='timingsMs'?undefined:value));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
