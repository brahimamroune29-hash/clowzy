import {randomUUID} from 'node:crypto';
import type {Store} from './store';

export type CoverageCounts=Record<string,number>;
export async function recordCoverage(store:Store,userId:string,searchId:string,phase:'site'|'verification'|'delivery',counts:CoverageCounts){
  // Counts only: no addresses, source HTML, keys or private contact data in the audit trail.
  await store.db.run('INSERT INTO audit(id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)',randomUUID(),userId,'search-coverage',JSON.stringify({searchId,phase,counts}),new Date().toISOString());
}
export async function coverageReport(store:Store,ownerId:string,searchId:string){
  await store.admin(ownerId);
  const search=await store.db.get<{requested:number;delivered:number;status:string}>('SELECT requested,delivered,status FROM searches WHERE id=?',searchId);
  const rows=await store.db.all<{detail:string}>("SELECT detail FROM audit WHERE action='search-coverage' AND detail::jsonb->>'searchId'=? ORDER BY created_at,id",searchId);
  const phases:Record<string,CoverageCounts>={};
  for(const row of rows){const event=JSON.parse(row.detail);const counts=phases[event.phase]||={};for(const [key,value] of Object.entries(event.counts))if(typeof value==='number')counts[key]=(counts[key]||0)+value;}
  return {searchId,search:search||null,phases,events:rows.length};
}
